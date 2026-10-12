// Share pi's auth.json without copying credentials. The lock parameters and in-place write match
// pi-coding-agent's FileAuthStorageBackend so an OAuth refresh is serialized across both processes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export function piAuthPath(env = process.env): string {
  return resolve(env.DPI_PI_AUTH_FILE ?? join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json"));
}

const readCredentials = (path: string): Record<string, Credential> => {
  if (!existsSync(path)) return {};
  const data: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("Invalid pi auth store");
  return data as Record<string, Credential>;
};

// Match pi's stored API-key references. A key may be literal, contain environment
// references, or start with "!" to read a local command's stdout.
const commandCache = new Map<string, string | undefined>();
function resolveKey(value: string, env?: Record<string, string>): string | undefined {
  if (value.startsWith("!")) {
    if (commandCache.has(value)) return commandCache.get(value);
    let resolved: string | undefined;
    try {
      resolved = execSync(value.slice(1), {
        encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined;
    } catch {
      resolved = undefined;
    }
    commandCache.set(value, resolved);
    return resolved;
  }
  let resolved = "";
  for (let i = 0; i < value.length;) {
    if (value[i] !== "$") { resolved += value[i++]; continue; }
    const next = value[i + 1];
    if (next === "$" || next === "!") { resolved += next; i += 2; continue; }
    let name: string | undefined;
    if (next === "{") {
      const end = value.indexOf("}", i + 2);
      if (end < 0) { resolved += "$"; i++; continue; }
      const candidate = value.slice(i + 2, end);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
        resolved += value.slice(i, end + 1); i = end + 1; continue;
      }
      name = candidate;
      i = end + 1;
    } else {
      const match = value.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) { resolved += "$"; i++; continue; }
      name = match[0];
      i += name.length + 1;
    }
    const replacement = env?.[name] || process.env[name];
    if (!replacement) return undefined;
    resolved += replacement;
  }
  return resolved;
}

export class PiAuthStore implements CredentialStore {
  constructor(readonly path = piAuthPath()) {}

  private async locked<T>(fn: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    options?.signal?.throwIfAborted();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) writeFileSync(this.path, "{}", { mode: 0o600 });
    const deadline = Date.now() + 30_000;
    let retry = 0;
    let compromised: unknown;
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      options?.signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.path, {
          realpath: false,
          retries: 0,
          stale: 30_000,
          onCompromised: (error) => { compromised = error; },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
        const base = Math.min(10 * 2 ** retry++, 1000);
        await sleep(Math.min(Math.round(base * (1 + Math.random())), deadline - Date.now()), undefined, {
          signal: options?.signal,
        });
      }
    }
    try {
      if (compromised) throw compromised;
      options?.signal?.throwIfAborted();
      const result = await fn();
      if (compromised) throw compromised;
      options?.signal?.throwIfAborted();
      return result;
    } finally {
      await release();
    }
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.locked(async () => {
      const credential = readCredentials(this.path)[providerId];
      if (credential?.type !== "api_key") return credential;
      if (!credential.key) return undefined;
      const key = resolveKey(credential.key, credential.env);
      return key === undefined ? undefined : { ...credential, key };
    }, options);
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.locked(async () =>
      Object.entries(readCredentials(this.path)).map(([providerId, credential]) => ({ providerId, type: credential.type })), options);
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.locked(async () => {
      const current = readCredentials(this.path);
      const next = await fn(current[providerId]);
      if (next === undefined) return current[providerId];
      if (next.type !== "oauth" || current[providerId]?.type !== "oauth")
        throw Error("Durable Pi may only refresh an existing OAuth login");
      const merged = { ...current, [providerId]: next };
      writeFileSync(this.path, JSON.stringify(merged, null, 2), { mode: 0o600 });
      return next;
    }, options);
  }

  async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
    throw Error("Durable Pi cannot log out pi credentials");
  }
}
