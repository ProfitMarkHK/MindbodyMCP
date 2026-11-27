#!/usr/bin/env bun
/**
 * Local MCP launcher: reads the 1Password SAT from the OS store, resolves the
 * op:// reference file with one short-lived `op inject`, then starts the server
 * itself with the resolved MINDBODY_* values.
 *
 * The SAT is set ONLY in the `op inject` child's environment, and that child exits
 * before the server starts. The server is never a child of `op`, so it never
 * inherits the SAT; an SAT inherited from the MCP host is removed from the
 * server's environment as well. No credential is logged. Production never calls
 * this script: hosted platforms inject plain MINDBODY_* variables and run
 * `bun run src/index.ts` directly.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAT_ENV_VAR,
  defaultSatContext,
  profileConfig,
  readSat,
  type CommandSpec,
  type Profile,
  type SatContext,
} from "./op-sat.js";

/** Optional override for the op:// reference file (useful for MCP clients). */
export const REF_FILE_ENV = "MINDBODY_OP_REF_FILE";

/** MCP hosts do not guarantee a cwd; child commands always run at the repo root. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface LaunchContext extends SatContext {
  env: NodeJS.ProcessEnv;
}

export function defaultLaunchContext(): LaunchContext {
  return { ...defaultSatContext(), env: process.env };
}

/** Pure resolution of the reference file path; the override wins. */
export function refFilePath(profile: Profile, env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return env[REF_FILE_ENV] || profileConfig(profile, home).refFile;
}

/** Parse a hand-written ref file: `KEY=value` lines; comments and blank lines are ignored. */
export function parseRefFile(text: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^["']/, "").replace(/["']$/, "");
    if (/^MINDBODY_[A-Z0-9_]+$/.test(key)) refs[key] = value;
  }
  return refs;
}

/**
 * Pure `op inject` command: one `KEY={{ op://... }}` line per reference, on stdin.
 * The SAT is in this child's environment only; no reference or value is in `args`.
 */
export function buildInjectSpec(refs: Record<string, string>, sat: string): CommandSpec {
  const template = Object.entries(refs)
    .map(([key, ref]) => `${key}={{ ${ref} }}\n`)
    .join("");
  return { command: "op", args: ["inject"], input: template, env: { [SAT_ENV_VAR]: sat }, cwd: REPO_ROOT };
}

/** Resolve every reference with one `op inject`. op's stderr names the failing ref, never a value. */
export async function resolveRefs(
  refs: Record<string, string>,
  sat: string,
  runner: SatContext["runner"]
): Promise<Record<string, string>> {
  const result = await runner.run(buildInjectSpec(refs, sat));
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "op inject failed");
  // Not parseRefFile: a secret may begin or end with a space or a quote, so pass it through as is.
  const lines = result.stdout.split(/\r?\n/);
  return Object.fromEntries(
    Object.keys(refs).flatMap((key) => {
      const line = lines.find((candidate) => candidate.startsWith(`${key}=`));
      return line === undefined ? [] : [[key, line.slice(key.length + 1)]];
    })
  );
}

/** Pure server plan: resolved values in the environment, never in `args`, and no SAT. */
export function buildLaunchPlan(profile: Profile, values: Record<string, string>, home?: string): CommandSpec {
  return {
    command: process.execPath,
    args: ["run", profileConfig(profile, home).entry],
    env: { ...values, [SAT_ENV_VAR]: undefined },
    stdio: "inherit",
    cwd: REPO_ROOT,
  };
}

export async function launch(profile: Profile, ctx: LaunchContext = defaultLaunchContext()): Promise<number> {
  const refs = parseRefFile(readFileSync(refFilePath(profile, ctx.env, ctx.home), "utf8"));
  const values = await resolveRefs(refs, await readSat(profile, ctx), ctx.runner);
  return (await ctx.runner.run(buildLaunchPlan(profile, values, ctx.home))).exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await launch(process.argv[2] as Profile);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
