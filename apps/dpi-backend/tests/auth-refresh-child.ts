// Child process for the cross-process credential-lock test. All credentials here are fake.
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { PiAuthStore } from "../src/pi-auth-store.js";

const [kind, authPath, countPath] = process.argv.slice(2);
if (!kind || !authPath || !countPath) throw Error("Missing test arguments");
const resolveModule = resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-ai/dist/auth/resolve.js");
const { refreshStoredOAuthCredential } = await import(pathToFileURL(resolveModule).href);
let store;
if (kind === "pi") {
  const cli = realpathSync(process.env.DPI_TEST_PI_BIN ?? join(homedir(), ".local/bin/pi"));
  const piDist = dirname(dirname(cli));
  const { AuthStorage } = await import(pathToFileURL(join(piDist, "core/auth-storage.js")).href);
  store = AuthStorage.create(authPath);
} else {
  store = new PiAuthStore(authPath);
}
const oauth = {
  refresh: async (current: { access: string }) => {
    const count = Number(readFileSync(countPath, "utf8"));
    writeFileSync(countPath, String(count + 1));
    await sleep(120);
    return { type: "oauth", access: `${current.access}-renewed`, refresh: "new-refresh", expires: Date.now() + 3600_000 };
  },
};
await refreshStoredOAuthCredential(store, "openai-codex", oauth,
  (credential: { expires: number }) => credential.expires < Date.now() + 300_000, new AbortController().signal);
process.stdout.write("done\n");
