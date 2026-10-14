import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSummary, NetworkDevice, SessionSummary } from "../../dpi-sdk/src/api.ts";
import {
  groupLabel,
  groupedDeviceTree,
  lastActiveLabel,
  rowOpen,
  sessionStatusLabel,
  type SidebarNode,
} from "../apps/dpi-playground-fe/src/client/session-groups.ts";

const now = 1_800_000_000_000;
const minute = 60_000;
const agent: AgentSummary = {
  id: 1,
  name: "Main",
  named: false,
  kind: "root",
  busy: false,
  background: 0,
};

function session(
  id: string,
  name: string,
  lastActivityAt: number,
  extra: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    name,
    cwd: `/work/${id}`,
    model: "echo",
    createdAt: lastActivityAt,
    lastActivityAt,
    live: false,
    pinned: false,
    dbPath: `/d/${id}`,
    busy: false,
    agents: [{ ...agent, busy: extra.busy ?? false }],
    ...extra,
  };
}

function device(status: NetworkDevice["status"], sessions: SessionSummary[]): NetworkDevice {
  return {
    id: "box",
    name: "Box",
    kind: "url",
    url: "http://box:4780",
    source: "config",
    hasToken: true,
    status,
    tree: { uid: "u", name: "box", at: now, sessions },
  };
}

function visible(nodes: readonly SidebarNode[], expanded: ReadonlySet<string>): SidebarNode[] {
  const out: SidebarNode[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.children.length && rowOpen(node, expanded)) out.push(...visible(node.children, expanded));
  }
  return out;
}

function excerpt(nodes: readonly SidebarNode[], expanded: ReadonlySet<string>, online: boolean): string {
  return visible(nodes, expanded)
    .map((node) => {
      if (node.type === "group")
        return `<div class="tree-row group" data-key="${node.key}" aria-expanded="${rowOpen(node, expanded)}">${groupLabel(node.kind, node.count)}</div>`;
      if (node.type === "session")
        return `<div class="tree-row session${node.stale ? " stale" : ""}" data-key="${node.key}">${node.session.name} <span class="meta activity">${sessionStatusLabel(node.session, online, now)}</span>${online && node.session.busy ? '<i class="dot work" title="Working"></i>' : ""}</div>`;
      if (node.type === "device") return `<div class="tree-row device" data-key="${node.key}">${node.device.id}</div>`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

test("device tree splits active and inactive sessions and hides running state offline", () => {
  const sessions = [
    session("old", "Planout", now - 90 * minute),
    session("recent", "live-check", now - 12 * minute),
    session("running", "still-going", now - 3 * 60 * minute, { live: true, busy: true }),
    session("kept", "Pinned", now - 5 * 60 * minute, { pinned: true }),
  ];
  const online = groupedDeviceTree([device("online", sessions)], now);
  const box = online[0];
  assert.equal(box.type, "device");
  if (box.type !== "device") return;
  assert.deepEqual(
    box.children.map((child) => (child.type === "group" ? groupLabel(child.kind, child.count) : child.type)),
    ["Active", "Inactive (1)"],
  );
  const active = box.children[0];
  const inactive = box.children[1];
  assert.equal(active.type, "group");
  assert.equal(inactive.type, "group");
  if (active.type !== "group" || inactive.type !== "group") return;
  assert.deepEqual(
    active.children.map((child) => (child.type === "session" ? child.session.name : "")),
    ["live-check", "still-going", "Pinned"],
  );
  assert.equal(lastActiveLabel(now - 12 * minute, now), "last active 12 min ago");
  assert.equal(inactive.children.length, 1);
  assert.equal(rowOpen(inactive, new Set()), false);
  const opened = excerpt(online, new Set(["box", "box/inactive"]), true);
  assert.match(opened, /Inactive \(1\)/);
  assert.match(opened, /Planout <span class="meta activity">last active 90 min ago<\/span>/);
  assert.match(opened, /still-going <span class="meta activity">last active 180 min ago<\/span><i class="dot work"/);
  assert.equal(opened.includes("box/s/old") && opened.includes("Planout"), true);

  const offline = groupedDeviceTree([device("offline", sessions)], now);
  const cached = offline[0];
  assert.equal(cached.type, "device");
  if (cached.type !== "device") return;
  assert.equal(cached.children.some((child) => child.type === "group"), false);
  assert.equal(cached.stale, true);
  const offlineHtml = excerpt(offline, new Set(["box", "box/s/running"]), false);
  assert.equal(offlineHtml.includes("Active"), false);
  assert.equal(offlineHtml.includes("device offline"), true);
  assert.equal(offlineHtml.includes("dot work"), false);
  assert.match(offlineHtml, /class="tree-row session stale"/);
  console.log("DOM excerpt\n" + opened + "\n" + offlineHtml);
});
