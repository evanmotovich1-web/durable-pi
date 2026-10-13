import { execFile } from "node:child_process";
import { claudeLoginEnv } from "./claude-code.js";

/** Probe once during backend startup. A working CLI without a signed-in login is not an available harness. */
export function claudeCodeAvailable(sourceEnv: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["auth", "status"],
      { env: claudeLoginEnv(sourceEnv), timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(false);
        try {
          resolve((JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true);
        } catch {
          resolve(false);
        }
      },
    );
  });
}
