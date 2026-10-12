import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHA = /^[0-9a-f]{7,40}$/;

/** Git checkout SHA, or the SHA copied into VERSION by `just net deploy`. */
export function readBuildRevision(codeDir: string): string {
  if (existsSync(join(codeDir, ".git"))) {
    try {
      const revision = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
        cwd: codeDir,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (SHA.test(revision)) return revision;
    } catch {
      // A copied install may carry a VERSION file without a working Git checkout.
    }
  }
  try {
    const revision = readFileSync(join(codeDir, "VERSION"), "utf8").trim();
    if (SHA.test(revision)) return revision;
  } catch {
    // No version metadata was shipped with this install.
  }
  return "unknown";
}
