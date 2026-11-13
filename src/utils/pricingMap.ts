import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredSiteId, SITE_ID_ENV } from './siteTime.js';

/**
 * Local pricing map: which stylist title each staff member holds, and which
 * single-visit service each title books for a session type. Read on every call,
 * so a CLI or another process editing the file takes effect immediately.
 *
 * File: `<MINDBODY_PRICING_MAP_DIR>/pricing.<siteId>.json`. Keep the directory
 * outside the repo; it holds staff IDs and pay-relevant titles.
 */
export const PRICING_MAP_DIR_ENV = 'MINDBODY_PRICING_MAP_DIR';

/** Titles in the catalogue. "Davy" is a stylist's personal price list, not a title. */
export const STYLIST_TIERS = ['emerging', 'stylist', 'senior', 'creative', 'director'] as const;
export type StylistTier = (typeof STYLIST_TIERS)[number];

export interface PricingMap {
  siteId: string;
  /** Staff ID (string key) -> title. Staff IDs are site-specific. */
  staff: Record<string, StylistTier>;
  /** Session type ID (string key) -> title -> single-visit service ID. */
  sessionTypeServices: Record<string, Partial<Record<StylistTier, number>>>;
}

export type PricingMapState =
  | { status: 'ok'; map: PricingMap; mapVersion: string; file: string }
  | { status: 'absent'; reason: string; file?: string }
  | { status: 'invalid'; reason: string; file?: string };

export class PricingMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingMapError';
  }
}

/** Thrown when the file changed since the caller read it. Re-read and retry. */
export class PricingMapConflictError extends PricingMapError {
  constructor(expected: string, actual: string) {
    super(`pricing map changed since it was read (expected version ${expected}, found ${actual}); re-read and retry`);
    this.name = 'PricingMapConflictError';
  }
}

export interface AuditEntry {
  kind: 'staff' | 'sessionType';
  key: string;
  tier?: StylistTier;
  old: unknown;
  new: unknown;
}

const VERSION_ABSENT = 'absent';

export function pricingMapFileName(siteId: string): string {
  return `pricing.${siteId}.json`;
}

function mapDir(): string | undefined {
  const value = process.env[PRICING_MAP_DIR_ENV]?.trim();
  return value ? value : undefined;
}

export function validatePricingMap(raw: unknown, siteId: string): PricingMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PricingMapError('pricing map must be a JSON object');
  }
  const { siteId: fileSiteId, staff, sessionTypeServices } = raw as Record<string, unknown>;
  if (String(fileSiteId) !== siteId) {
    throw new PricingMapError(`pricing map is for site ${String(fileSiteId)}, not the configured site ${siteId}`);
  }
  const staffOut: Record<string, StylistTier> = {};
  for (const [id, tier] of Object.entries((staff ?? {}) as Record<string, unknown>)) {
    if (!/^\d+$/.test(id)) throw new PricingMapError(`staff key "${id}" is not a numeric staff ID`);
    staffOut[id] = assertTier(tier, `staff ${id}`);
  }
  const sessionOut: PricingMap['sessionTypeServices'] = {};
  for (const [sessionTypeId, tiers] of Object.entries((sessionTypeServices ?? {}) as Record<string, unknown>)) {
    if (!/^\d+$/.test(sessionTypeId)) {
      throw new PricingMapError(`session type key "${sessionTypeId}" is not numeric`);
    }
    if (typeof tiers !== 'object' || tiers === null) {
      throw new PricingMapError(`session type ${sessionTypeId} must map titles to service IDs`);
    }
    const entry: Partial<Record<StylistTier, number>> = {};
    for (const [tier, serviceId] of Object.entries(tiers as Record<string, unknown>)) {
      assertTier(tier, `session type ${sessionTypeId}`);
      if (!Number.isInteger(serviceId) || (serviceId as number) <= 0) {
        throw new PricingMapError(`session type ${sessionTypeId} / ${tier}: service ID must be a positive integer`);
      }
      entry[tier as StylistTier] = serviceId as number;
    }
    sessionOut[sessionTypeId] = entry;
  }
  return { siteId, staff: staffOut, sessionTypeServices: sessionOut };
}

function assertTier(value: unknown, where: string): StylistTier {
  if (typeof value !== 'string' || !(STYLIST_TIERS as readonly string[]).includes(value)) {
    throw new PricingMapError(`${where}: "${String(value)}" is not one of ${STYLIST_TIERS.join(', ')}`);
  }
  return value as StylistTier;
}

/** Read and validate the map for the configured site. Never throws; reports why. */
export async function loadPricingMap(siteId: string | undefined = configuredSiteId()): Promise<PricingMapState> {
  if (siteId === undefined) {
    return { status: 'invalid', reason: `${SITE_ID_ENV} must be set so the pricing map can be matched to a site` };
  }
  const dir = mapDir();
  if (dir === undefined) {
    return { status: 'absent', reason: `${PRICING_MAP_DIR_ENV} is not set` };
  }
  const file = join(dir, pricingMapFileName(siteId));
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent', reason: `no ${pricingMapFileName(siteId)} in ${PRICING_MAP_DIR_ENV}`, file };
    }
    return { status: 'invalid', reason: `cannot read pricing map: ${(err as Error).message}`, file };
  }
  try {
    const map = validatePricingMap(JSON.parse(text), siteId);
    return { status: 'ok', map, mapVersion: versionOf(text), file };
  } catch (err) {
    return { status: 'invalid', reason: (err as Error).message, file };
  }
}

function versionOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// In-process queue: serialises read-modify-write within one MCP process. Separate
// processes are guarded only by the expected-version check, so a true race still
// fails loudly as a conflict rather than silently overwriting.
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Write a new map if the file is still at `expectedVersion` (`'absent'` for a
 * file that does not exist yet). Keeps the previous file as `.bak`, writes
 * through a temp file and rename, and appends one JSONL line per change.
 */
export function savePricingMap(
  siteId: string,
  next: PricingMap,
  expectedVersion: string,
  changes: AuditEntry[]
): Promise<{ mapVersion: string }> {
  const run = writeQueue.then(() => writeLocked(siteId, next, expectedVersion, changes));
  writeQueue = run.catch(() => undefined);
  return run;
}

async function writeLocked(
  siteId: string,
  next: PricingMap,
  expectedVersion: string,
  changes: AuditEntry[]
): Promise<{ mapVersion: string }> {
  const dir = mapDir();
  if (dir === undefined) throw new PricingMapError(`${PRICING_MAP_DIR_ENV} is not set; nothing can be saved`);

  const current = await loadPricingMap(siteId);
  if (current.status === 'invalid') {
    throw new PricingMapError(`refusing to overwrite an invalid pricing map: ${current.reason}`);
  }
  const actual = current.status === 'ok' ? current.mapVersion : VERSION_ABSENT;
  if (actual !== expectedVersion) throw new PricingMapConflictError(expectedVersion, actual);

  const file = join(dir, pricingMapFileName(siteId));
  const text = `${JSON.stringify(validatePricingMap(next, siteId), null, 2)}\n`;
  await mkdir(dir, { recursive: true });
  if (current.status === 'ok') await copyFile(file, `${file}.bak`);

  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await renameWithRetry(tmp, file);

  const ts = new Date().toISOString();
  const lines = changes.map((c) => JSON.stringify({ ts, siteId, actor: 'mcp', ...c })).join('\n');
  if (lines) await appendFile(join(dir, `pricing.${siteId}.audit.jsonl`), `${lines}\n`, 'utf8');

  return { mapVersion: versionOf(text) };
}

/** Windows can refuse a rename while an editor or antivirus holds the target. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY')) {
        await rm(from, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}

export function emptyPricingMap(siteId: string): PricingMap {
  return { siteId, staff: {}, sessionTypeServices: {} };
}
