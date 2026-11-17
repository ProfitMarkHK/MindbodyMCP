/**
 * The site's late-cancel windows. The Mindbody v6 spec exposes no such value
 * (`Program.CancelOffset` is undocumented: no unit, no meaning), so the operator
 * states it. Without it a `lateCancel: true` request is refused, never guessed.
 *
 * Two variables:
 * - `MINDBODY_LATE_CANCEL_WINDOW_HOURS`: the default window, in hours.
 * - `MINDBODY_LATE_CANCEL_WINDOW_RULES`: optional JSON array of rules, checked in
 *   order before the default, first match wins. Each rule is
 *   `{ serviceId?, programId?, sessionTypeId?, hours }` with at least one id;
 *   every id it names must equal the booking's. `serviceId` is the pricing
 *   option's id (`ProductId` on a visit), not the id of the client's purchase.
 *
 * With no rules configured, behaviour (and every message) is exactly the
 * single-window behaviour that predates the rules.
 */
export const LATE_CANCEL_WINDOW_ENV = 'MINDBODY_LATE_CANCEL_WINDOW_HOURS';
export const LATE_CANCEL_RULES_ENV = 'MINDBODY_LATE_CANCEL_WINDOW_RULES';

export const LATE_CANCEL_WINDOW_UNKNOWN =
  `late cancel refused: the site's late-cancel window is unknown. Set ${LATE_CANCEL_WINDOW_ENV} ` +
  'to the number of hours before the start within which a cancellation counts as late, or cancel without lateCancel';

const RULE_ID_KEYS = ['serviceId', 'programId', 'sessionTypeId'] as const;
type RuleIdKey = (typeof RULE_ID_KEYS)[number];

/** What a booking is, as far as the rules can tell. An undefined id is unknown, not "none". */
export type LateCancelContext = Partial<Record<RuleIdKey, number>>;

export interface LateCancelRule extends LateCancelContext {
  hours: number;
}

export interface LateCancelConfig {
  rules: LateCancelRule[];
  /** MINDBODY_LATE_CANCEL_WINDOW_HOURS; undefined when unset or not a positive number. */
  defaultHours?: number;
}

/** A resolved window and where it came from, so a receipt can say which rule applied. */
export interface LateCancelWindow {
  hours: number;
  /** `MINDBODY_LATE_CANCEL_WINDOW_HOURS`, or `MINDBODY_LATE_CANCEL_WINDOW_RULES[i]` plus the rule's ids. */
  source: string;
}

/** The configured default window in hours, or undefined when unset or not a positive number. */
export function lateCancelWindowHours(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[LATE_CANCEL_WINDOW_ENV]?.trim();
  if (!raw) return undefined;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

function invalid(detail: string): { error: string } {
  return { error: `late cancel refused: ${LATE_CANCEL_RULES_ENV} is invalid: ${detail}; fix it, or cancel without lateCancel` };
}

function describeEntry(entry: unknown): string {
  const text = JSON.stringify(entry) ?? String(entry);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * Parse both variables. Any malformed rule fails the whole configuration (fail
 * closed), naming the offending entry. An empty or unset rules variable is no rules.
 */
export function lateCancelConfig(env: NodeJS.ProcessEnv = process.env): { config: LateCancelConfig } | { error: string } {
  const defaultHours = lateCancelWindowHours(env);
  const raw = env[LATE_CANCEL_RULES_ENV]?.trim();
  if (!raw) return { config: { rules: [], defaultHours } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    return invalid(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(parsed)) return invalid('it must be a JSON array of rules');

  const rules: LateCancelRule[] = [];
  for (const [i, entry] of parsed.entries()) {
    const at = `rule ${i} ${describeEntry(entry)}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return invalid(`${at} is not an object`);
    const record = entry as Record<string, unknown>;
    const unknownKey = Object.keys(record).find((key) => key !== 'hours' && !(RULE_ID_KEYS as readonly string[]).includes(key));
    if (unknownKey) return invalid(`${at} has unknown key "${unknownKey}" (allowed: ${RULE_ID_KEYS.join(', ')}, hours)`);
    const hours = record.hours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
      return invalid(`${at} needs "hours" as a positive number`);
    }
    const rule: LateCancelRule = { hours };
    for (const key of RULE_ID_KEYS) {
      if (!(key in record)) continue;
      const id = record[key];
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return invalid(`${at} needs "${key}" as a positive integer`);
      rule[key] = id;
    }
    if (!RULE_ID_KEYS.some((key) => rule[key] !== undefined)) {
      return invalid(`${at} names no ${RULE_ID_KEYS.join(', ')}; a rule with no id would match everything, use ${LATE_CANCEL_WINDOW_ENV} instead`);
    }
    rules.push(rule);
  }
  return { config: { rules, defaultHours } };
}

/**
 * The refusal for a `lateCancel: true` request that can be given before any
 * lookup: invalid rules, or neither rules nor a default. Null when the window
 * can only be decided per booking (or is the default).
 */
export function lateCancelConfigRefusal(loaded: { config: LateCancelConfig } | { error: string }): string | null {
  if ('error' in loaded) return loaded.error;
  const { rules, defaultHours } = loaded.config;
  return rules.length === 0 && defaultHours === undefined ? LATE_CANCEL_WINDOW_UNKNOWN : null;
}

function idsOf(source: LateCancelContext): string {
  return RULE_ID_KEYS.filter((key) => source[key] !== undefined).map((key) => `${key} ${source[key]}`).join(', ');
}

/**
 * The window for one booking: the first rule whose ids all equal the booking's,
 * else the default. Refused when no rule matches and there is no default, or
 * when a rule before the match names an id the booking's lookup did not reveal
 * (the rule might apply, so the next one cannot be trusted). `unmatched` marks
 * the first case: no window applies at all, as when nothing is configured.
 */
export function resolveLateCancelWindow(
  context: LateCancelContext,
  config: LateCancelConfig
): { window: LateCancelWindow } | { refusal: string; unmatched?: true } {
  for (const [i, rule] of config.rules.entries()) {
    const keys = RULE_ID_KEYS.filter((key) => rule[key] !== undefined);
    if (keys.some((key) => context[key] !== undefined && context[key] !== rule[key])) continue;
    const unknown = keys.find((key) => context[key] === undefined);
    if (unknown) {
      return {
        refusal:
          `late cancel refused: cannot tell whether ${LATE_CANCEL_RULES_ENV}[${i}] (${idsOf(rule)}) applies, ` +
          `because the booking's ${unknown} is not known; cancel without lateCancel`,
      };
    }
    return { window: { hours: rule.hours, source: `${LATE_CANCEL_RULES_ENV}[${i}] (${idsOf(rule)})` } };
  }
  if (config.defaultHours !== undefined) return { window: { hours: config.defaultHours, source: LATE_CANCEL_WINDOW_ENV } };
  const ids = idsOf(context);
  return {
    unmatched: true,
    refusal:
      `late cancel refused: the booking${ids ? ` (${ids})` : ''} matches no rule in ${LATE_CANCEL_RULES_ENV} ` +
      `and ${LATE_CANCEL_WINDOW_ENV} is unset; add a rule or a default, or cancel without lateCancel`,
  };
}

/**
 * Why a late cancel of something starting at `startMs` is refused, or null if it
 * is inside the window. The default window keeps its original message, byte for byte.
 */
export function lateCancelWindowRefusal(
  startMs: number,
  nowMs: number,
  windowHours: number,
  source: string = LATE_CANCEL_WINDOW_ENV
): string | null {
  if (startMs - nowMs <= windowHours * 3_600_000) return null;
  if (source === LATE_CANCEL_WINDOW_ENV) {
    return `late cancel refused: it starts more than ${windowHours} hour(s) from now, outside the site's late-cancel window; cancel without lateCancel`;
  }
  return `late cancel refused: it starts more than ${windowHours} hour(s) from now, outside the late-cancel window of ${source}; cancel without lateCancel`;
}

/** Resolve the window for `context` and check `startMs` against it: the refusal, or null. */
export function lateCancelRefusalFor(
  context: LateCancelContext,
  config: LateCancelConfig,
  startMs: number,
  nowMs: number
): string | null {
  const resolved = resolveLateCancelWindow(context, config);
  if ('refusal' in resolved) return resolved.refusal;
  return lateCancelWindowRefusal(startMs, nowMs, resolved.window.hours, resolved.window.source);
}

/** True when some rule keys on `key`, so a call site must look it up to decide. */
export function rulesNeed(config: LateCancelConfig, key: RuleIdKey): boolean {
  return config.rules.some((rule) => rule[key] !== undefined);
}

/** A Mindbody id as a rule context value: a positive integer, else unknown. */
export function positiveIdOrUndefined(value: unknown): number | undefined {
  const id = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * Rule context for a class or enrollment session: program and session type
 * from the class's ClassDescription, service from the client's visit
 * (`ProductId`, the pricing option; `ServiceId` is the client's purchase).
 */
export function classLateCancelContext(cls: any, visit?: any): LateCancelContext {
  return {
    serviceId: positiveIdOrUndefined(visit?.ProductId),
    programId: positiveIdOrUndefined(cls?.ClassDescription?.Program?.Id),
    sessionTypeId: positiveIdOrUndefined(cls?.ClassDescription?.SessionType?.Id),
  };
}
