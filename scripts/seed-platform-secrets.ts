#!/usr/bin/env bun
/**
 * LOCAL admin/rotation tool only. Never shipped in the Docker image: the image
 * copies src + tsconfig and has no `op` binary. Production runtime contains no
 * secret-fetch logic; it reads plain MINDBODY_* variables injected by Railway
 * or Azure Key Vault.
 *
 * This script reads op:// pointers from the same ref files as mcp-launch.ts,
 * resolves them with the launcher's `op inject` using the SAT from the OS store,
 * and writes each variable to the chosen platform. It prints variable NAMES only.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSatContext, readSat, type CommandSpec, type Profile, type SatContext } from "./op-sat.js";
import { parseRefFile, refFilePath, resolveRefs } from "./mcp-launch.js";

export type PlatformTarget = "railway" | "azure";

/** Sandbox ref files omit the site id: scripts/dev-sandbox.ts pins it locally. */
export const SANDBOX_SITE_ID = "-99";

export interface SeedContext extends SatContext {
  env: NodeJS.ProcessEnv;
  tempRoot: string;
}

export function defaultSeedContext(): SeedContext {
  return { ...defaultSatContext(), env: process.env, tempRoot: tmpdir() };
}

/** Map a platform environment name to a 1Password profile. */
export function profileForEnvironment(environment: string): Profile {
  if (environment === "prod" || environment === "production") return "prod";
  if (environment === "sandbox") return "sandbox";
  throw new Error(`Cannot map environment ${environment} to a 1Password profile; expected prod, production or sandbox`);
}

/** Pure builders: the secret value is only ever `input`, never an argument. */
export function buildRailwaySetCommand(key: string, service: string, environment: string, value: string): CommandSpec {
  return {
    command: "railway",
    args: ["variable", "set", key, "--stdin", "-s", service, "-e", environment, "--skip-deploys"],
    input: value,
  };
}

export function buildAzureSetCommand(secretName: string, vault: string, file: string): CommandSpec {
  return {
    command: "az",
    args: ["keyvault", "secret", "set", "--vault-name", vault, "--name", secretName, "--file", file],
  };
}

export function azureSecretName(key: string, environment: string, prefix?: string): string {
  const base = prefix ?? environment;
  return `${base}-${key.toLowerCase().replace(/_/g, "-")}`;
}

export async function seed(
  platformArg: string,
  environment: string,
  ctx: SeedContext = defaultSeedContext()
): Promise<number> {
  if (platformArg !== "railway" && platformArg !== "azure") {
    throw new Error(`Unknown platform: ${platformArg}; expected railway or azure`);
  }
  const profile = profileForEnvironment(environment);
  const service = ctx.env.RAILWAY_SERVICE;
  const vault = ctx.env.AZURE_KEYVAULT;
  if (platformArg === "railway" && !service) {
    throw new Error("RAILWAY_SERVICE is required to seed Railway variables");
  }
  if (platformArg === "azure" && !vault) {
    throw new Error("AZURE_KEYVAULT is required to seed Azure Key Vault secrets");
  }

  const refs = parseRefFile(readFileSync(refFilePath(profile, ctx.env, ctx.home), "utf8"));
  const values = Object.entries({
    ...(profile === "sandbox" && { MINDBODY_SITE_ID: SANDBOX_SITE_ID }),
    ...(await resolveRefs(refs, await readSat(profile, ctx), ctx.runner)),
  });

  const tempDir = platformArg === "azure" ? mkdtempSync(join(ctx.tempRoot, "mindbody-seed-")) : undefined;
  try {
    for (const [key, value] of values) {
      if (platformArg === "railway") {
        const result = await ctx.runner.run(buildRailwaySetCommand(key, service!, environment, value));
        if (result.exitCode !== 0) throw new Error(`Failed to seed ${key} to Railway`);
      } else {
        const file = join(tempDir!, `${key}.txt`);
        writeFileSync(file, value, { mode: 0o600 });
        const name = azureSecretName(key, environment, ctx.env.AZURE_SECRET_PREFIX);
        const result = await ctx.runner.run(buildAzureSetCommand(name, vault!, file));
        if (result.exitCode !== 0) throw new Error(`Failed to seed ${key} to Azure Key Vault`);
      }
      // Name only. Never echo the value, the ref, or the SAT.
      console.log(`seeded ${key}`);
    }
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
  return 0;
}

export async function main(argv: string[], ctx: SeedContext = defaultSeedContext()): Promise<number> {
  const [platformArg, environment] = argv;
  if (!platformArg || !environment) {
    console.error("usage: bun run scripts/seed-platform-secrets.ts <railway|azure> <environment>");
    return 2;
  }
  return seed(platformArg, environment, ctx);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
