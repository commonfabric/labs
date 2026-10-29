export interface SessionPresentationState {
  archived: boolean | null;
  active: boolean | null;
}

export interface SortableSessionRow {
  title: string | null;
  updatedAt: string | null;
  gitWorktreeRoot: string | null;
}

export type SessionSortColumn = "title" | "idleFor" | "worktree";
export type SessionSortDirection = "ascending" | "descending";

export const WORKTREE_TAIL_CHARACTER_COUNT = 10;
export const SESSION_PAGE_SIZE = 20;

export function conversationState(session: SessionPresentationState): string {
  if (session.archived === true) return "archived";
  if (session.active === true) return "active";
  if (session.active === false) return "inactive";
  if (session.archived === false) return "unarchived";
  return "unknown";
}

export function formatIdleFor(
  updatedAt: string | null,
  nowMs: number | null,
): string {
  if (!updatedAt || nowMs === null || !Number.isFinite(nowMs)) return "—";
  const updatedAtMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) return "—";

  const elapsedMs = Math.max(0, nowMs - updatedAtMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(elapsedMs / 3_600_000);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(elapsedMs / 86_400_000);
  if (days < 14) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (days < 60) return `${weeks}w`;

  const months = Math.floor(days / 30);
  if (days < 730) return `${months}mo`;

  return `${Math.floor(days / 365)}y`;
}

export function trailingPath(
  path: string | null,
  characterCount = WORKTREE_TAIL_CHARACTER_COUNT,
): string {
  if (!path) return "—";
  const count = Math.max(0, Math.trunc(characterCount));
  if (path.length <= count) return path;
  return `…${path.slice(-count)}`;
}

function optionalText(value: string | null): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function optionalTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareOptional<T>(
  left: T | null,
  right: T | null,
  direction: SessionSortDirection,
  compareValues: (left: T, right: T) => number,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const comparison = compareValues(left, right);
  return direction === "ascending" ? comparison : -comparison;
}

export function sortSessionRows<T extends SortableSessionRow>(
  rows: T[],
  column: SessionSortColumn | null,
  direction: SessionSortDirection,
): T[] {
  if (column === null) return [...rows];
  return [...rows].sort((left, right) => {
    switch (column) {
      case "title":
        return compareOptional(
          optionalText(left.title),
          optionalText(right.title),
          direction,
          (leftTitle, rightTitle) =>
            leftTitle.localeCompare(rightTitle, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
        );
      case "idleFor":
        return compareOptional(
          optionalTimestamp(left.updatedAt),
          optionalTimestamp(right.updatedAt),
          direction,
          (leftTimestamp, rightTimestamp) => rightTimestamp - leftTimestamp,
        );
      case "worktree":
        return compareOptional(
          optionalText(left.gitWorktreeRoot),
          optionalText(right.gitWorktreeRoot),
          direction,
          (leftWorktree, rightWorktree) =>
            leftWorktree.localeCompare(rightWorktree, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
        );
    }
  });
}
