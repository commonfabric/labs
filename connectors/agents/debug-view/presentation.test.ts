import { assertEquals } from "@std/assert";
import {
  conversationState,
  formatIdleFor,
  sortSessionRows,
  trailingPath,
  WORKTREE_TAIL_CHARACTER_COUNT,
} from "./presentation.ts";

Deno.test("conversation state keeps provider lifecycle separate from sync", () => {
  assertEquals(
    conversationState({
      archived: true,
      active: false,
    }),
    "archived",
  );
  assertEquals(
    conversationState({
      archived: false,
      active: true,
    }),
    "active",
  );
  assertEquals(
    conversationState({
      archived: false,
      active: false,
    }),
    "inactive",
  );
  assertEquals(
    conversationState({
      archived: null,
      active: null,
    }),
    "unknown",
  );
  assertEquals(
    conversationState({ archived: false, active: null }),
    "unarchived",
  );
});

Deno.test("idle time uses compact relative units", () => {
  const now = new Date("2026-07-21T12:00:00.000Z").getTime();
  assertEquals(formatIdleFor("2026-07-21T11:59:30.000Z", now), "<1m");
  assertEquals(formatIdleFor("2026-07-21T11:15:00.000Z", now), "45m");
  assertEquals(formatIdleFor("2026-07-21T09:00:00.000Z", now), "3h");
  assertEquals(formatIdleFor("2026-07-18T12:00:00.000Z", now), "3d");
  assertEquals(formatIdleFor("2026-06-30T12:00:00.000Z", now), "3w");
  assertEquals(formatIdleFor(null, now), "—");
  assertEquals(formatIdleFor("not-a-date", now), "—");
});

Deno.test("worktree paths show a stable trailing segment", () => {
  assertEquals(WORKTREE_TAIL_CHARACTER_COUNT, 10);
  assertEquals(trailingPath("/work", 8), "/work");
  assertEquals(trailingPath("/very/long/worktree/path", 8), "…ree/path");
  assertEquals(trailingPath("/very/long/worktree/path"), "…ktree/path");
  assertEquals(trailingPath(null, 8), "—");
});

Deno.test("session rows sort by title, idle time, and worktree", () => {
  const rows = [
    {
      title: "Session 10",
      updatedAt: "2026-07-21T09:00:00.000Z",
      gitWorktreeRoot: "/work/zeta",
    },
    {
      title: "session 2",
      updatedAt: "2026-07-21T11:00:00.000Z",
      gitWorktreeRoot: "/work/alpha",
    },
    {
      title: null,
      updatedAt: null,
      gitWorktreeRoot: null,
    },
  ];

  assertEquals(
    sortSessionRows(rows, "title", "ascending").map((row) => row.title),
    ["session 2", "Session 10", null],
  );
  assertEquals(
    sortSessionRows(rows, "title", "descending").map((row) => row.title),
    ["Session 10", "session 2", null],
  );
  assertEquals(
    sortSessionRows(rows, "idleFor", "ascending").map((row) => row.title),
    ["session 2", "Session 10", null],
  );
  assertEquals(
    sortSessionRows(rows, "idleFor", "descending").map((row) => row.title),
    ["Session 10", "session 2", null],
  );
  assertEquals(
    sortSessionRows(rows, "worktree", "ascending").map((row) => row.title),
    ["session 2", "Session 10", null],
  );
});
