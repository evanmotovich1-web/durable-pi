// Groups a device's sessions the same way `GET /v1/sessions?state=active` does.
import type { NetworkDevice, SessionSummary } from "../../../../../dpi-sdk/src/api.ts";
import { networkTree, type TreeNode } from "../../../../../dpi-sdk/src/models.ts";

/** Live work, a pin, or use within this window stays in Active. */
export const SESSION_HIDE_MS = 60 * 60_000;

export type SessionGroupNode = {
  type: "group";
  key: string;
  deviceId: string;
  kind: "active" | "inactive";
  count: number;
  stale: boolean;
  children: TreeNode[];
};

export type SidebarDeviceNode = Omit<Extract<TreeNode, { type: "device" }>, "children"> & {
  children: SidebarNode[];
};

export type SidebarNode =
  | SidebarDeviceNode
  | SessionGroupNode
  | Exclude<TreeNode, { type: "device" }>;

export function activityAt(session: Pick<SessionSummary, "lastActivityAt" | "createdAt">): number {
  return session.lastActivityAt || session.createdAt || 0;
}

/** True for the Active group: live work, a pin, or activity inside 60 minutes. */
export function sessionIsActive(
  session: Pick<SessionSummary, "live" | "pinned" | "lastActivityAt" | "createdAt">,
  now = Date.now(),
): boolean {
  return Boolean(session.live || session.pinned || activityAt(session) >= now - SESSION_HIDE_MS);
}

export function lastActiveLabel(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  return `last active ${min} min ago`;
}

/** Offline sessions never read as running or recently active. */
export function sessionStatusLabel(
  session: Pick<SessionSummary, "lastActivityAt" | "createdAt">,
  online: boolean,
  now = Date.now(),
): string {
  return online ? lastActiveLabel(activityAt(session), now) : "device offline";
}

export function groupLabel(kind: "active" | "inactive", count: number): string {
  return kind === "active" ? "Active" : `Inactive (${count})`;
}

/** Active stays open unless the user collapsed it. Inactive stays closed unless opened. */
export function rowOpen(node: SidebarNode, expanded: ReadonlySet<string>): boolean {
  if (node.type === "group" && node.kind === "active") return !expanded.has(`hide:${node.key}`);
  return expanded.has(node.key);
}

export function toggleKey(node: SidebarNode): string {
  return node.type === "group" && node.kind === "active" ? `hide:${node.key}` : node.key;
}

function byNewest(
  a: Extract<TreeNode, { type: "session" }>,
  b: Extract<TreeNode, { type: "session" }>,
): number {
  return activityAt(b.session) - activityAt(a.session) || a.session.name.localeCompare(b.session.name);
}

/**
 * Online devices split sessions into Active and Inactive. Offline devices keep the cached
 * sessions as direct children so they can be labeled offline instead of active.
 */
export function groupSessions(nodes: readonly TreeNode[], now = Date.now()): SidebarNode[] {
  return nodes.map((node): SidebarNode => {
    if (node.type !== "device" || node.status !== "online") return node;
    const sessions = node.children.filter(
      (child): child is Extract<TreeNode, { type: "session" }> => child.type === "session",
    );
    if (!sessions.length) return node;
    const active = sessions.filter((row) => sessionIsActive(row.session, now)).sort(byNewest);
    const inactive = sessions.filter((row) => !sessionIsActive(row.session, now)).sort(byNewest);
    const children: SidebarNode[] = [
      {
        type: "group",
        key: `${node.device.id}/active`,
        deviceId: node.device.id,
        kind: "active",
        count: active.length,
        stale: false,
        children: active,
      },
    ];
    if (inactive.length)
      children.push({
        type: "group",
        key: `${node.device.id}/inactive`,
        deviceId: node.device.id,
        kind: "inactive",
        count: inactive.length,
        stale: false,
        children: inactive,
      });
    return { ...node, children };
  });
}

export function groupedDeviceTree(devices: readonly NetworkDevice[], now = Date.now()): SidebarNode[] {
  return groupSessions(networkTree(devices), now);
}
