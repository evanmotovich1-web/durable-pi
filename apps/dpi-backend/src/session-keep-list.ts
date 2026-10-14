import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** References written by the factory adapter map, or by a small JSON keep-list file. */
export function readSessionKeepList(path: string, required = false): Set<string> {
  if (!existsSync(path)) {
    if (required) throw Error(`Session keep-list is missing: ${path}`);
    return new Set();
  }
  if (extname(path) === ".sqlite") {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const refs = new Set<string>();
      for (const row of db.prepare("SELECT session_id,session_name FROM handoffs").all() as {
        session_id: string | null; session_name: string | null;
      }[]) {
        if (row.session_id) refs.add(row.session_id);
        if (row.session_name) refs.add(row.session_name);
      }
      return refs;
    } finally {
      db.close();
    }
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const sessions = Array.isArray(value) ? value : value && typeof value === "object" && "sessions" in value
    ? (value as { sessions: unknown }).sessions : undefined;
  if (!Array.isArray(sessions) || !sessions.every((item) => typeof item === "string" && item.length > 0))
    throw Error(`Invalid session keep-list: ${path}`);
  return new Set(sessions);
}
