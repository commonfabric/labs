// `cf inspect churn` through the real CLI process.
//
// The query's semantics are pinned in packages/state-inspector/test/churn.test.ts;
// this suite covers the command surface — the rendered curve, the peak marker
// and its attribution, --json, and the two notices a reader must not miss (a
// window with no timed commits, and commits absent from every bucket).

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import { argv, cf, stripAnsi } from "./utils.ts";

/**
 * `CliResult` streams are line arrays; join before substring assertions.
 *
 * The escapes go too: the CLI colors help and error output whenever the
 * environment asks for color, so an assertion on raw text passes or fails by
 * where the developer ran it.
 */
const text = (lines: string[]): string => stripAnsi(lines.join("\n"));

const SESSION = "session:did%3Akey%3AzAlice:s1";

interface Commit {
  at: string;
  entities: string[];
}

function seed(path: string, commits: Commit[]): void {
  const db = new Database(path, { create: true });
  db.exec(`
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);`);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution, created_at)
     VALUES (?, ?, ?, '{}', '{"seq":0}', ?)`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, ?, 'set', '{}', ?)`,
  );
  commits.forEach((c, i) => {
    const seq = i + 1;
    commit.run(seq, SESSION, seq, c.at);
    c.entities.forEach((id, op) => rev.run(id, seq, op, seq));
  });
  db.close();
}

/** A quiet minute, a storm minute, a settled minute — the July shape. */
const STORM: Commit[] = [
  { at: "2026-07-22 10:00:00", entities: ["of:topic-1"] },
  ...Array.from({ length: 40 }, (_, i) => ({
    at: "2026-07-22 10:01:00",
    entities: i % 4 === 0 ? ["of:generated-0", "of:board"] : ["of:generated-0"],
  })),
  { at: "2026-07-22 10:02:00", entities: ["of:topic-2"] },
];

async function withStore(
  commits: Commit[],
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "cf-churn-test-" });
  try {
    const path = `${dir}/space.sqlite`;
    seed(path, commits);
    await run(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

describe("cf inspect churn", () => {
  it("renders the curve, marks the peak, and blames its drivers", async () => {
    await withStore(STORM, async (path) => {
      const result = await cf(argv`inspect churn ${path}`);
      expect(result.code).toBe(0);
      const output = text(result.stdout);

      // Every minute in the window appears, including the quiet ones.
      expect(output).toContain("2026-07-22 10:00:00");
      expect(output).toContain("2026-07-22 10:02:00");
      // The busiest bucket is marked, and reported in the incident record's unit.
      expect(output).toContain("←peak");
      expect(output).toContain("peak 2026-07-22 10:01:00: 40.0 commits/min");
      expect(output).toContain("42 commits / 52 revisions over 3 × 60s");
      // ...and attributed to what actually drove it, ranked.
      const generated = output.indexOf("of:generated-0");
      const board = output.indexOf("of:board");
      expect(generated).toBeGreaterThan(-1);
      expect(board).toBeGreaterThan(generated);
    });
  });

  it("bounds the window with --since/--until and widens with --bucket", async () => {
    await withStore(STORM, async (path) => {
      const zoomed = await cf(
        argv`inspect churn ${path} --since 2026-07-22T10:01:00 --until 2026-07-22T10:02:00`,
      );
      expect(zoomed.code).toBe(0);
      expect(text(zoomed.stdout)).toContain("40 commits / 50 revisions over 1");

      const coarse = await cf(argv`inspect churn ${path} --bucket 3600`);
      expect(coarse.code).toBe(0);
      // Same totals, one bucket.
      expect(text(coarse.stdout)).toContain("42 commits / 52 revisions over 1");
    });
  });

  it("shows a settle by reporting the quiet through --until", async () => {
    // Without an observation boundary the curve ends at the last write, which
    // for a storm that has just stopped is its busiest bucket — so it can show
    // a storm but never show one settling. The footer's two timestamps are what
    // make the gap between "stopped writing" and "stopped watching" readable.
    await withStore(STORM, async (path) => {
      const bare = text((await cf(argv`inspect churn ${path}`)).stdout);
      expect(bare).toContain("over 3 × 60s");
      expect(bare).toContain(
        "last commit 2026-07-22 10:02:00, observed through 2026-07-22 10:02:00",
      );

      const observed = await cf(
        argv`inspect churn ${path} --until ${"2026-07-22 10:06:00"}`,
      );
      expect(observed.code).toBe(0);
      const output = text(observed.stdout);
      expect(output).toContain("over 6 × 60s");
      // Writing stopped four minutes before watching did, and the totals did
      // not move — the trailing buckets are quiet, not new activity.
      expect(output).toContain(
        "last commit 2026-07-22 10:02:00, observed through 2026-07-22 10:05:00",
      );
      expect(output).toContain("42 commits / 52 revisions");
    });
  });

  it("refuses a window that would report as quiet rather than as wrong", async () => {
    await withStore(STORM, async (path) => {
      const unreadable = await cf(
        argv`inspect churn ${path} --since yesterday`,
      );
      expect(unreadable.code).not.toBe(0);
      expect(text(unreadable.stderr)).toContain("not a time SQLite can read");

      const backwards = await cf(
        argv`inspect churn ${path} --since ${"2026-07-22 11:00:00"}
          --until ${"2026-07-22 10:00:00"}`,
      );
      expect(backwards.code).not.toBe(0);
      expect(text(backwards.stderr)).toContain("is not before");
    });
  });

  it("emits machine-readable JSON", async () => {
    await withStore(STORM, async (path) => {
      const result = await cf(argv`inspect churn ${path} --json --top 1`);
      expect(result.code).toBe(0);
      const report = JSON.parse(text(result.stdout));
      expect(report.totals).toEqual({ commits: 42, revisions: 52 });
      expect(report.buckets.map((b: { commits: number }) => b.commits))
        .toEqual([1, 40, 1]);
      expect(report.peak.start).toBe("2026-07-22 10:01:00");
      expect(report.peakEntities).toHaveLength(1);
      expect(report.peakEntities[0].id).toBe("of:generated-0");
      expect(report.untimedCommits).toBe(0);
    });
  });

  it("says so when the window holds no timed commits", async () => {
    await withStore([], async (path) => {
      const result = await cf(argv`inspect churn ${path}`);
      expect(result.code).toBe(0);
      expect(text(result.stdout)).toContain("no timed commits in window");
    });
  });

  it("flags commits missing from every bucket rather than hiding them", async () => {
    // A curve silently missing rows reads as a quiet period — the one way this
    // command could actively mislead.
    await withStore([
      { at: "2026-07-22 10:00:00", entities: ["of:X"] },
      { at: "not-a-timestamp", entities: ["of:Y"] },
    ], async (path) => {
      const result = await cf(argv`inspect churn ${path}`);
      expect(result.code).toBe(0);
      expect(text(result.stdout)).toContain(
        "1 commit(s) have unparseable created_at",
      );
    });
  });

  it("refuses an over-wide span instead of truncating the curve", async () => {
    await withStore([
      { at: "2020-01-01 00:00:00", entities: ["of:X"] },
      { at: "2026-07-22 10:00:00", entities: ["of:X"] },
    ], async (path) => {
      const result = await cf(argv`inspect churn ${path} --bucket 1`);
      expect(result.code).not.toBe(0);
      expect(text(result.stderr)).toContain("--bucket");
    });
  });
});
