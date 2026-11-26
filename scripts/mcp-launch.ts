#!/usr/bin/env bun
/**
 * Local MCP launcher: resolves the 1Password SAT from the OS store, then lets
 * `op run` resolve the non-secret op:// reference file into the child process.
 *
 * The SAT is set ONLY in the spawned child's environment. No credential is
 * logged. Production never calls this script: hosted platforms inject plain
 * MINDBODY_* variables and run `bun run src/index.ts` directly.
 */
import { existsSync, readFileSync } from "node:fs";
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

export const REQUIRED_REFS: Record<Profile, string[]> = {
  prod: ["MINDBODY_API_KEY", "MINDBODY_SITE_ID", "MINDBODY_SOURCE_NAME", "MINDBODY_SOURCE_PASSWORD"],
  // The sandbox site is pinned to -99 by scripts/dev-sandbox.ts, not read from 1Password.
  sandbox: ["MINDBODY_API_KEY", "MINDBODY_SOURCE_NAME", "MINDBODY_SOURCE_PASSWORD"],
};

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

/** Parse `KEY=op://...` lines. Comments and blank lines are ignored. */
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

/** Fail closed with names only: a missing ref would degrade to an empty variable. */
export function validateRefFile(text: string, profile: Profile): void {
  const refs = parseRefFile(text);
  const missing = REQUIRED_REFS[profile].filter((key) => !refs[key]?.startsWith("op://"));
  if (missing.length > 0) {
    throw new Error(`Reference file is missing op:// references for ${missing.join(", ")}`);
  }
}

export interface LaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  refFile: string;
  entry: string;
  stdio: "inherit";
  cwd: string;
}

/** Pure plan: no execution, no file reads, and no value in `args`. */
export function buildLaunchPlan(
  profile: Profile,
  sat: string,
  options: { refFile?: string; home?: string; env?: NodeJS.ProcessEnv } = {}
): LaunchPlan {
  const config = profileConfig(profile, options.home);
  const refFile = options.refFile ?? options.env?.[REF_FILE_ENV] ?? config.refFile;
  return {
    command: "op",
    args: ["run", `--env-file=${refFile}`, "--", "bun", "run", config.entry],
    env: { [SAT_ENV_VAR]: sat },
    refFile,
    entry: config.entry,
    stdio: "inherit",
    cwd: REPO_ROOT,
  };
}

export async function launch(profile: Profile, ctx: LaunchContext = defaultLaunchContext()): Promise<number> {
  profileConfig(profile, ctx.home);
  const refFile = refFilePath(profile, ctx.env, ctx.home);
  if (!existsSync(refFile)) {
    throw new Error(`Missing 1Password reference file for ${profile}: ${refFile}`);
  }
  validateRefFile(readFileSync(refFile, "utf8"), profile);
  const sat = await readSat(profile, ctx);
  const plan = buildLaunchPlan(profile, sat, { refFile, home: ctx.home, env: ctx.env });
  const spec: CommandSpec = {
    command: plan.command,
    args: plan.args,
    env: plan.env,
    stdio: plan.stdio,
    cwd: plan.cwd,
  };
  const result = await ctx.runner.run(spec);
  return result.exitCode;
}

export async function main(argv: string[], ctx: LaunchContext = defaultLaunchContext()): Promise<number> {
  const [profileArg] = argv;
  if (profileArg !== "prod" && profileArg !== "sandbox") {
    console.error("usage: bun run scripts/mcp-launch.ts <prod|sandbox>");
    return 2;
  }
  return launch(profileArg, ctx);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
