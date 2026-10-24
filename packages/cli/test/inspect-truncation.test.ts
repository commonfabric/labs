// The capped-listing surface of `cf inspect`, through the real CLI process.
//
// A capped result is a subset that renders exactly like a complete one, so
// these tests pin where the cap becomes visible: on stderr for every command
// that scans a space, in BOTH modes, while `--json` keeps writing the same
// bare array to stdout that its consumers parse. The scan semantics themselves
// are pinned in packages/state-inspector/test/scan-extent.test.ts.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { argv, cf, type CliResult, stripAnsi } from "./utils.ts";

const SESSION = "session:did%3Akey%3AzAlice:s1";
const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

/** Six busy free cells, one module, three quiet pieces. */
const ENTITIES = [
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `of:cell-${i + 1}`,
    document: { value: `cell ${i + 1}` },
    revisions: 5,
  })),
  {
    id: "of:mod",
    document: {
      value: {
        kind: "source",
        identity: MODULE_IDENTITY,
        code: "export default () => null;\n",
        filename: "/api/patterns/notes/notebook.tsx",
        imports: [],
      },
    },
    revisions: 2,
  },
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `of:piece-${i + 1}`,
    document: {
      value: { $NAME: `Topic ${i + 1}` },
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
    },
    revisions: 1,
  })),
];

const TOTAL = ENTITIES.length;

function seed(path: string): void {
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
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq, status) VALUES ('', 39, 'active');`);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{"seq":0}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  let seq = 0;
  for (const entity of ENTITIES) {
    for (let n = 0; n < entity.revisions; n++) {
      seq++;
      commit.run(seq, SESSION, seq);
      rev.run(entity.id, seq, JSON.stringify(entity.document), seq);
    }
  }
  db.close();
}

async function withStore(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "cf-inspect-truncation-" });
  try {
    const path = `${dir}/space.sqlite`;
    seed(path);
    await run(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * The cap notices among the process's stderr, which also carries the task
 * runner's own echo and whatever Deno warns about on the day.
 */
const notices = (result: CliResult): string[] =>
  result.stderr.map(stripAnsi).filter((line) => line.includes("NOTE:"));

describe("cf inspect capped listings", () => {
  it("names the cap, the space's size, and the flag that lifts it", async () => {
    await withStore(async (path) => {
      const result = await cf(argv`inspect entities ${path} --limit 3`);
      expect(result.code).toBe(0);
      expect(notices(result)).toEqual([
        `NOTE: capped at --limit 3 entities; the space holds ${TOTAL} ` +
        `entities in all — raise --limit for the rest.`,
      ]);
    });
  });

  it("says nothing when the limit covers the whole space", async () => {
    await withStore(async (path) => {
      const result = await cf(argv`inspect entities ${path} --limit ${TOTAL}`);
      expect(result.code).toBe(0);
      expect(notices(result)).toEqual([]);
      // The whole space is there to be silent about.
      expect(stripAnsi(result.stdout.join("\n"))).toContain("of:piece-1");
    });
  });

  it("writes the same bare array to stdout under `--json` while noting the cap", async () => {
    await withStore(async (path) => {
      const result = await cf(argv`inspect entities ${path} --limit 3 --json`);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout.join("\n"));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
      expect(notices(result).length).toBe(1);
    });
  });

  it("returns every piece under `--kind piece` where the limit reaches only cells", async () => {
    await withStore(async (path) => {
      // Six cells outrank every piece, so the same limit without `--kind`
      // reaches no piece at all — which is what this composition has to beat.
      const cellsOnly = await cf(
        argv`inspect entities ${path} --limit 6 --json`,
      );
      const scanned = JSON.parse(cellsOnly.stdout.join("\n")) as {
        kind: string;
      }[];
      expect(scanned.filter((e) => e.kind === "piece")).toEqual([]);

      const result = await cf(
        argv`inspect entities ${path} --kind piece --limit 6 --json`,
      );
      expect(result.code).toBe(0);
      const pieces = JSON.parse(result.stdout.join("\n")) as { kind: string }[];
      expect(pieces.map((p) => p.kind)).toEqual(["piece", "piece", "piece"]);
      expect(notices(result)).toEqual([]);
    });
  });

  it("names the kind in the notice when a kind outruns the limit", async () => {
    await withStore(async (path) => {
      const result = await cf(
        argv`inspect entities ${path} --kind piece --limit 2`,
      );
      expect(result.code).toBe(0);
      expect(notices(result)).toEqual([
        `NOTE: capped at --limit 2 piece entities; the space holds ${TOTAL} ` +
        `entities in all — raise --limit for the rest.`,
      ]);
    });
  });

  it("rejects a `--kind` no entity classifies as, before opening the space", async () => {
    await withStore(async (path) => {
      const result = await cf(argv`inspect entities ${path} --kind pieces`);
      expect(result.code).not.toBe(0);
      const stderr = stripAnsi(result.stderr.join("\n"));
      expect(stderr).toContain('Unknown --kind "pieces"');
      expect(stderr).toContain("owned-cell");
    });
  });

  it("notes the cap on a capped graph, rendered or as DOT", async () => {
    await withStore(async (path) => {
      const rendered = await cf(argv`inspect graph ${path} --limit 3`);
      expect(rendered.code).toBe(0);
      expect(notices(rendered).length).toBe(1);

      const dot = await cf(argv`inspect graph ${path} --limit 3 --dot`);
      expect(dot.code).toBe(0);
      expect(dot.stdout.join("\n")).toContain("digraph");
      expect(notices(dot).length).toBe(1);

      const whole = await cf(argv`inspect graph ${path} --limit ${TOTAL}`);
      expect(whole.code).toBe(0);
      expect(notices(whole)).toEqual([]);
    });
  });

  it("carries the cap into the graph's `--json`, where the shape can hold it", async () => {
    await withStore(async (path) => {
      const result = await cf(argv`inspect graph ${path} --limit 3 --json`);
      expect(result.code).toBe(0);
      const graph = JSON.parse(result.stdout.join("\n")) as {
        extent: {
          limit: number;
          total: number;
          truncated: boolean;
          unreadable: number;
        };
      };
      expect(graph.extent).toEqual({
        limit: 3,
        total: TOTAL,
        truncated: true,
        unreadable: 0,
      });
    });
  });

  it("refuses a capped result under `--require-complete`, with nothing on stdout", async () => {
    await withStore(async (path) => {
      const result = await cf(
        argv`inspect entities ${path} --limit 3 --json --require-complete`,
      );
      expect(result.code).not.toBe(0);
      // A partial payload written before the failure is the whole hazard: a
      // pipeline that redirects stdout would keep the subset it was refused.
      expect(result.stdout.join("").trim()).toBe("");
      expect(stripAnsi(result.stderr.join("\n"))).toContain(
        "--require-complete refuses a partial result",
      );
    });
  });

  it("returns the whole listing under `--require-complete` when the limit covers the space", async () => {
    await withStore(async (path) => {
      const result = await cf(
        argv`inspect entities ${path} --limit ${TOTAL} --json --require-complete`,
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.join("\n")).length).toBe(TOTAL);
    });
  });

  it("refuses a capped graph and a capped HTML explorer under `--require-complete`", async () => {
    await withStore(async (path) => {
      const graph = await cf(
        argv`inspect graph ${path} --limit 3 --require-complete`,
      );
      expect(graph.code).not.toBe(0);
      expect(graph.stdout.join("").trim()).toBe("");

      const html = await cf(
        argv`inspect html ${path} --limit 3 --require-complete`,
      );
      expect(html.code).not.toBe(0);
      expect(html.stdout.join("").trim()).toBe("");
    });
  });

  it("refuses a result missing an entity it could not read, which no higher limit recovers", async () => {
    await withStore(async (path) => {
      // A payload that will not decode is dropped by the graph pass, and the
      // cap was never reached — so without its own count the scan would report
      // itself complete over a smaller set.
      const db = new Database(path);
      db.prepare(
        `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
         VALUES ('of:corrupt', 9001, 0, 'set', '<<<not a document>>>', 1)`,
      ).run();
      db.close();

      const noted = await cf(argv`inspect graph ${path}`);
      expect(noted.code).toBe(0);
      expect(notices(noted).join("")).toContain(
        "could not be reconstructed and are absent",
      );
      // Not the cap notice: the remedies differ, and a raised limit recovers
      // nothing here.
      expect(notices(noted).join("")).not.toContain("capped at --limit");

      const refused = await cf(argv`inspect graph ${path} --require-complete`);
      expect(refused.code).not.toBe(0);
      expect(refused.stdout.join("").trim()).toBe("");
      expect(stripAnsi(refused.stderr.join("\n"))).toContain(
        "--require-complete refuses a partial result",
      );
    });
  });

  it("refuses a `--kind` scan that dropped a row it could not classify", async () => {
    await withStore(async (path) => {
      const db = new Database(path);
      db.prepare(
        `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
         VALUES ('of:corrupt', 9002, 0, 'set', '<<<not a document>>>', 1)`,
      ).run();
      db.close();

      // A filtered scan drops what it cannot classify, so the omission has to
      // reach the exit code: the notice goes to stderr, and a `--json`
      // consumer reads stdout, where a subset parses exactly like the whole
      // set.
      const refused = await cf(
        argv`inspect entities ${path} --kind piece --require-complete --json`,
      );
      expect(refused.code).not.toBe(0);
      expect(refused.stdout.join("").trim()).toBe("");
      expect(stripAnsi(refused.stderr.join("\n"))).toContain(
        "could not be reconstructed",
      );

      // Unfiltered, the same store is complete: the row is returned `unknown`.
      const kept = await cf(
        argv`inspect entities ${path} --require-complete --json`,
      );
      expect(kept.code).toBe(0);
      expect(
        (JSON.parse(kept.stdout.join("\n")) as { id: string }[])
          .some((e) => e.id === "of:corrupt"),
      ).toBe(true);
    });
  });

  it("rejects a fractional `--limit` rather than applying a cap no count can reach", async () => {
    await withStore(async (path) => {
      const result = await cf(argv`inspect entities ${path} --limit 1.5`);
      expect(result.code).not.toBe(0);
      expect(stripAnsi(result.stderr.join("\n"))).toContain("--limit");
    });
  });

  it("rejects a fractional `--limit` on the row listings, and lets a negative mean every row", async () => {
    await withStore(async (path) => {
      // `conflicts` reports an entity only with TWO writer sessions, and the
      // seed uses one — without this the negative-limit half of the assertion
      // compares zero against zero and cannot fail.
      const db = new Database(path);
      const other = "session:did%3Akey%3AzBob:s9";
      for (const [i, id] of ["of:cell-1", "of:cell-2"].entries()) {
        db.prepare(
          `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
           VALUES (?, ?, 1, '{}', '{"seq":0}')`,
        ).run(9100 + i, other);
        db.prepare(
          `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
           VALUES (?, ?, 0, 'set', '{"value":"bob"}', ?)`,
        ).run(id, 9100 + i, 9100 + i);
      }
      db.close();

      // These were SQL `LIMIT ?` clauses: SQLite answered a fractional or
      // non-finite limit with a datatype mismatch and read a NEGATIVE as
      // unlimited. Moving the bound into a JS `slice` silently turned the first
      // into a rounded row count and the second into "drop the last".
      const rows = (out: string[]) => JSON.parse(out.join("\n")).length;
      for (const command of ["hot", "conflicts"]) {
        const bad = await cf(argv`inspect ${command} ${path} --limit 1.5`);
        expect(bad.code).not.toBe(0);
        // The CLI's own message, not the library's fallback — the guard has to
        // fire before the space is opened, or the failure arrives as a stack.
        expect(stripAnsi(bad.stderr.join("\n"))).toContain(
          "`--limit` must be a whole number of rows",
        );

        const capped = await cf(
          argv`inspect ${command} ${path} --limit 1 --json`,
        );
        expect(capped.code).toBe(0);
        expect(rows(capped.stdout)).toBe(1);

        const unlimited = await cf(
          argv`inspect ${command} ${path} --limit -1 --json`,
        );
        expect(unlimited.code).toBe(0);
        // Strictly more than the cap — `slice(0, -1)` would give one FEWER
        // than uncapped, and both stores hold more than one row here.
        expect(rows(unlimited.stdout)).toBeGreaterThan(1);
      }
    });
  });

  it("notes the cap on a capped HTML explorer and marks the page itself", async () => {
    await withStore(async (path) => {
      const result = await cf(argv`inspect html ${path} --limit 3`);
      expect(result.code).toBe(0);
      expect(notices(result).length).toBe(1);
      expect(result.stdout.join("\n")).toContain(
        `capped at 3 of ${TOTAL} entities`,
      );
    });
  });
});
