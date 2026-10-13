// The environment every agent command starts from.
//
// pi-durable's NodeExecutionEnv builds a command's environment as `{...process.env, ...shellEnv, ...options.env}`:
// its `shellEnv` only adds. The backend's process.env holds everything loadConfig read from backend.env, including
// DPI_TOKEN (full control of this device) and provider keys such as TYPESAFE_API_KEY, so an agent's `env` could print
// them into its model context. This env starts each command from the allowlist instead. A caller that already opts
// out of inheritance (the claude_code tool passes its own login env) is left alone.
import type { Context } from "@earendil-works/chord";
import type { ShellExecOptions } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** Variables an agent's shell may inherit from the backend process. */
const COMMON_SHELL_VARS = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"] as const;
const WINDOWS_SHELL_VARS = [
  "SystemRoot", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH",
] as const;

function shellVars(platform: string) {
  return platform === "win32" ? [...COMMON_SHELL_VARS, ...WINDOWS_SHELL_VARS] : [...COMMON_SHELL_VARS];
}

export const AGENT_SHELL_VARS = shellVars(process.platform);

export function agentShellEnv(source: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Record<string, string> {
  return Object.fromEntries(shellVars(platform).flatMap((k) => (source[k] ? [[k, source[k]!]] : [])));
}

export class AgentExecutionEnv extends NodeExecutionEnv {
  private readonly allowed: Record<string, string>;

  constructor(options: { cwd: string; allowed?: Record<string, string> }) {
    const allowed = options.allowed ?? agentShellEnv();
    super({ cwd: options.cwd, shellEnv: allowed });
    this.allowed = allowed;
  }

  override exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
    if (options?.inheritEnv === false) return super.exec(command, options, context);
    return super.exec(command, { ...options, inheritEnv: false, env: { ...this.allowed, ...options?.env } }, context);
  }
}
