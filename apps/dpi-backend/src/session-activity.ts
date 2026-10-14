import { DatabaseSync } from "node:sqlite";

/** Read durable message and task times, never the SQLite file's modification time. */
function recordTime(record: string): number | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(record) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const state = value.state && typeof value.state === "object" ? value.state as Record<string, unknown> : {};
  const messages = Array.isArray(value.model) ? value.model.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item)) : [];
  const times = [
    value.updatedAt, value.finishedAt, value.completedAt, value.startedAt, value.createdAt, value.timestamp, value.at,
    state.updatedAt, state.finishedAt, state.completedAt, state.startedAt, state.createdAt, state.timestamp, state.at,
    ...messages.map((message) => message.timestamp),
  ];
  return times.reduce<number | undefined>((latest, candidate) => {
    const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Date.parse(candidate) : NaN;
    // Reject logical sequence numbers and implausible future values.
    const time = parsed >= 946684800000 && parsed <= Date.now() + 86_400_000 ? parsed : undefined;
    return time === undefined ? latest : Math.max(latest ?? 0, time);
  }, undefined);
}

/** Opens only this session's agent.sqlite, without writing or consulting filesystem mtime. */
export function backfillSessionActivity(dbPath: string, createdAt: number): number {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    let latest = createdAt;
    for (const table of ["entries", "tasks"] as const) {
      // Entry IDs follow append order, but the policy uses the newest recorded message time.
      for (const row of db.prepare(`SELECT record FROM ${table} ORDER BY id DESC`).iterate() as Iterable<{ record: string }>) {
        const at = recordTime(row.record);
        if (at !== undefined) latest = Math.max(latest, at);
      }
    }
    return latest;
  } catch {
    return createdAt;
  } finally {
    db?.close();
  }
}
