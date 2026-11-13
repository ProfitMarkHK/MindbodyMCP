// Cross-platform entry point for `bun run check`.
//
// The gate runner is a bash script. Which `bash` a plain `bash scripts/...`
// finds depends on the host: on Windows, C:\Windows\System32\bash.exe is the
// WSL launcher, which runs the script inside a Linux distro that has no bun
// and none of this checkout's node_modules. This launcher picks the right one:
//
//   Windows (PowerShell/cmd)  Git Bash, found by well-known path, then via git
//   Linux / macOS / WSL       the `bash` on PATH (inside WSL, bun must be
//                             installed in WSL and run from there)
//
// Override with CHECK_BASH=/path/to/bash if yours lives somewhere unusual.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findGitBash(): string | undefined {
  const env = process.env;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")];
  for (const root of roots) {
    if (!root) continue;
    const candidate = join(root, "Git", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  // git.exe sits in <Git>\cmd or <Git>\bin; bash.exe is in <Git>\bin.
  const where = spawnSync("where", ["git"], { encoding: "utf8" });
  for (const gitExe of where.stdout?.split(/\r?\n/).filter(Boolean) ?? []) {
    const candidate = join(dirname(dirname(gitExe)), "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const bash = process.env.CHECK_BASH || (process.platform === "win32" ? findGitBash() : "bash");
if (!bash) {
  console.error(
    "check: Git Bash not found. Install Git for Windows, or set CHECK_BASH to a bash.exe " +
      "(not C:\\Windows\\System32\\bash.exe: that is WSL, which has no bun).",
  );
  process.exit(1);
}

const script = resolve(import.meta.dir, "check-gates.sh");
const result = spawnSync(bash, [script, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error(`check: could not start ${bash}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
