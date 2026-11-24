// CLI dispatch test: drives `main(argv)` over a seeded DB and asserts the
// single-space commands return success and emit parseable `--json`. Also guards
// the flag-parsing fix — a boolean flag (`--json`) before the <db> positional
// must not swallow the path.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import type { FabricValue } from "@commonfabric/data-model";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import { applyCommit, close, open } from "@commonfabric/memory/v2/engine";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "@commonfabric/memory/v2/operation-codec";
import { toValuePath } from "@commonfabric/memory/v2";
import { toFileUrl } from "@std/path";

import { main } from "../cli.ts";

const SCHEMA = `
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
INSERT INTO branch (name, head_seq, status) VALUES ('', 2, 'active');
`;

const STACK_SAFE_DEPTH = 20_000;

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  let deep: FabricValue = { leaf: "complete" };
  for (let depth = 0; depth < 12; depth++) deep = { child: deep };
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did:key:zX:u', ?, '{"reads":{"confirmed":[],"pending":[]}}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, ?, ?, ?)`,
  );
  commit.run(1, 1);
  rev.run(
    "of:a",
    1,
    "set",
    jsonFromFabricValue({
      value: {
        n: 1,
        deep,
        "a/b": "literal slash key",
        a: { b: "nested key" },
        "": "empty key",
        storedUndefined: undefined,
      },
    }),
    1,
  );
  commit.run(2, 2);
  rev.run(
    "of:a",
    2,
    "patch",
    JSON.stringify([{ op: "replace", path: "/value/n", value: 2 }]),
    2,
  );
  db.close();
}

/** Run `main`, capturing what it writes. */
function run(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    log: (text) => out.push(text),
    error: (text) => err.push(text),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

Deno.test("cli: single-space commands dispatch over a seeded DB", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-cli-" });
  const db = `${dir}/space.sqlite`;
  try {
    seed(db);

    await t.step("summary --json returns structured output", () => {
      const { code, out } = run(["summary", db, "--json"]);
      assertEquals(code, 0);
      const s = JSON.parse(out);
      assertEquals(s.entities, 1);
      assertEquals(s.commits, 2);
    });

    await t.step(
      "operations reports older stores without operation tables",
      () => {
        const { code, out } = run(["operations", db, "--json"]);
        assertEquals(code, 0);
        assertEquals(JSON.parse(out), {
          available: false,
          fieldLimit: 50,
          fieldsTruncated: false,
          fields: [],
        });
        const human = run(["operations", db]);
        assertStringIncludes(human.out, "operation tables are absent");
      },
    );

    await t.step(
      "operations renders active fields and truncation",
      async () => {
        const operationDb = `${dir}/operations.sqlite`;
        const engine = await open({ url: toFileUrl(operationDb) });
        try {
          applyCommit(engine, {
            sessionId: "session:setup",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: ["a", "b"].map((id) => ({
                op: "set" as const,
                id: `of:${id}`,
                value: { value: { body: "x" } },
              })),
            },
          });
          applyCommit(engine, {
            sessionId: "session:writer",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: ["a", "b"].map((id) => ({
                op: "apply-op" as const,
                id: `of:${id}`,
                path: toValuePath(["body"]),
                codec: CODEMIRROR_CHANGESET_CODEC,
                submissionId: `${id}:1`,
                base: null,
                baselineHash: operationBaselineHash("x"),
                payload: {
                  updates: [{ clientId: id, changes: [1, [0, "y"]] }],
                },
              })),
            },
          });
        } finally {
          close(engine);
        }

        const result = run(["operations", operationDb, "--limit", "1"]);
        assertEquals(result.code, 0);
        assertStringIncludes(result.out, "active\tof:a");
        assertStringIncludes(result.out, "submissions=1 integrated=1");
        assertStringIncludes(result.out, "field list truncated at 1");
      },
    );

    await t.step("operations rejects zero and oversized limits", () => {
      const zero = run(["operations", db, "--limit", "0"]);
      assertEquals(zero.code, 1);
      assert(zero.err.includes("integer from 1 to 1000"));

      const oversized = run([
        "operations",
        db,
        "--history-limit",
        "1001",
      ]);
      assertEquals(oversized.code, 1);
      assert(oversized.err.includes("integer from 1 to 1000"));
    });

    await t.step("--json BEFORE <db> still works (flag-order fix)", () => {
      const { code, out } = run(["summary", "--json", db]);
      assertEquals(code, 0);
      assert(JSON.parse(out).entities === 1, "db path not swallowed by --json");
    });

    await t.step("value-at reconstructs the latest value", () => {
      const { code, out } = run(["value-at", db, "of:a", "--json"]);
      assertEquals(code, 0);
      const r = JSON.parse(out);
      // the patch took n to 2
      assertEquals((r.value as { n: number }).n, 2);
    });

    await t.step("value-at --doc returns the reconstructed document", () => {
      const result = run(["value-at", db, "of:a", "--doc", "--json"]);
      assertEquals(result.code, 0);
      assertEquals(JSON.parse(result.out).pathExists, true);
      assertEquals(JSON.parse(result.out).value.value.n, 2);
    });

    await t.step("an empty path selects the root value", () => {
      const result = run([
        "value-at",
        db,
        "of:a",
        "--path",
        "",
        "--json",
      ]);
      assertEquals(result.code, 0);
      assertEquals(JSON.parse(result.out).pathExists, true);
      assertEquals(JSON.parse(result.out).value.n, 2);
    });

    await t.step("an empty branch selects the default branch", () => {
      const result = run([
        "value-at",
        db,
        "of:a",
        "--branch",
        "",
        "--json",
      ]);
      assertEquals(result.code, 0);
      assertEquals(JSON.parse(result.out).value.n, 2);
    });

    await t.step("an empty scope remains available for raw inspection", () => {
      const result = run([
        "value-at",
        db,
        "of:a",
        "--scope",
        "",
        "--json",
      ]);
      assertEquals(result.code, 0);
      assertEquals(JSON.parse(result.out).exists, false);
    });

    await t.step("value-at preserves exact path segments", () => {
      const slash = run([
        "value-at",
        db,
        "of:a",
        "--path-json",
        '["a/b"]',
        "--json",
      ]);
      assertEquals(slash.code, 0);
      assertEquals(JSON.parse(slash.out).pathExists, true);
      assertEquals(JSON.parse(slash.out).value, "literal slash key");

      const empty = run([
        "value-at",
        db,
        "of:a",
        "--path-json",
        '[""]',
        "--json",
      ]);
      assertEquals(empty.code, 0);
      assertEquals(JSON.parse(empty.out).pathExists, true);
      assertEquals(JSON.parse(empty.out).value, "empty key");

      const missing = run([
        "value-at",
        db,
        "of:a",
        "--path-json",
        '["missing"]',
        "--json",
      ]);
      assertEquals(missing.code, 0);
      assertEquals(JSON.parse(missing.out).pathExists, false);

      const storedUndefined = run([
        "value-at",
        db,
        "of:a",
        "--path-json",
        '["storedUndefined"]',
        "--json",
      ]);
      assertEquals(storedUndefined.code, 0);
      assertEquals(JSON.parse(storedUndefined.out), {
        exists: true,
        pathExists: true,
        value: { $undefined: true },
      });
    });

    await t.step("converge preserves exact path segments", () => {
      const result = run([
        "converge",
        "of:a",
        "--spaces",
        db,
        "--path-json",
        '["a/b"]',
        "--json",
      ]);
      assertEquals(result.code, 0);
      const parsed = JSON.parse(result.out);
      assertEquals(parsed.path, ["a/b"]);
      assertEquals(parsed.views[0].value, "literal slash key");

      const exactHuman = run([
        "converge",
        "of:a",
        "--spaces",
        db,
        "--path-json",
        '["a/b"]',
      ]);
      assertStringIncludes(exactHuman.out, 'path=["a/b"]');

      const legacyHuman = run([
        "converge",
        "of:a",
        "--spaces",
        db,
        "--path",
        "a/b",
      ]);
      assertStringIncludes(legacyHuman.out, "path=/a/b");
    });

    await t.step("path options reject ambiguous and invalid input", () => {
      const conflict = run([
        "value-at",
        db,
        "of:a",
        "--path",
        "a/b",
        "--path-json",
        '["a/b"]',
      ]);
      assertEquals(conflict.code, 1);
      assertStringIncludes(
        conflict.err,
        "either `--path` or `--path-json`",
      );

      const invalid = run([
        "value-at",
        db,
        "of:a",
        "--path-json",
        '["a/b",0]',
      ]);
      assertEquals(invalid.code, 1);
      assertStringIncludes(invalid.err, "JSON array of string segments");

      const documentPath = run([
        "value-at",
        db,
        "of:a",
        "--doc",
        "--path-json",
        '["a/b"]',
      ]);
      assertEquals(documentPath.code, 1);
      assertStringIncludes(
        documentPath.err,
        "`--doc` without `--path` or `--path-json`",
      );

      const missingDb = `${dir}/missing.sqlite`;
      const earlyConflict = run([
        "value-at",
        missingDb,
        "of:a",
        "--doc",
        "--path",
        "n",
      ]);
      assertEquals(earlyConflict.code, 1);
      assertStringIncludes(
        earlyConflict.err,
        "`--doc` without `--path` or `--path-json`",
      );

      const convergeConflict = run([
        "converge",
        "of:a",
        "--spaces",
        missingDb,
        "--path",
        "a/b",
        "--path-json",
        '["a/b"]',
      ]);
      assertEquals(convergeConflict.code, 1);
      assertStringIncludes(
        convergeConflict.err,
        "either `--path` or `--path-json`",
      );

      const convergeDocument = run([
        "converge",
        "of:a",
        "--spaces",
        missingDb,
        "--doc",
      ]);
      assertEquals(convergeDocument.code, 1);
      assertStringIncludes(
        convergeDocument.err,
        "`--doc` is not valid for converge",
      );
    });

    await t.step("value-taking flags reject missing values", () => {
      const missingDb = `${dir}/missing.sqlite`;
      const result = run([
        "value-at",
        missingDb,
        "of:a",
        "--scope",
      ]);
      assertEquals(result.code, 1);
      assertStringIncludes(result.err, "`--scope` requires a value");
    });

    await t.step("meaningless empty flag values are rejected", () => {
      const missingDb = `${dir}/missing.sqlite`;
      for (
        const [argv, flag] of [
          [["commits", missingDb, "--session", ""], "--session"],
          [["value-at", missingDb, "of:a", "--seq", ""], "--seq"],
          [
            ["value-at", missingDb, "of:a", "--path-json", ""],
            "--path-json",
          ],
        ] as const
      ) {
        const result = run([...argv]);
        assertEquals(result.code, 1);
        assertStringIncludes(result.err, `\`${flag}\` requires a value`);
      }
    });

    await t.step(
      "unknown and inapplicable flags are rejected before I/O",
      () => {
        const missingDb = `${dir}/missing.sqlite`;
        const typo = run([
          "value-at",
          missingDb,
          "of:a",
          "--path-josn",
          '["a/b"]',
        ]);
        assertEquals(typo.code, 1);
        assertStringIncludes(
          typo.err,
          "`--path-josn` is not valid for value-at",
        );

        const inapplicable = run(["summary", missingDb, "--scope", "space"]);
        assertEquals(inapplicable.code, 1);
        assertStringIncludes(
          inapplicable.err,
          "`--scope` is not valid for summary",
        );

        const emptyInapplicable = run([
          "summary",
          missingDb,
          "--session",
          "",
        ]);
        assertEquals(emptyInapplicable.code, 1);
        assertStringIncludes(
          emptyInapplicable.err,
          "`--session` is not valid for summary",
        );

        const prototypeFlag = run([
          "summary",
          missingDb,
          "--__proto__",
          "value",
        ]);
        assertEquals(prototypeFlag.code, 1);
        assertStringIncludes(
          prototypeFlag.err,
          "`--__proto__` is not valid for summary",
        );

        const prototypeCommand = run(["toString", "--json"]);
        assertEquals(prototypeCommand.code, 1);
        assertStringIncludes(prototypeCommand.err, "unknown command: toString");
      },
    );

    await t.step("numeric flags are validated before I/O", () => {
      const missingDb = `${dir}/missing.sqlite`;
      for (
        const [argv, flag] of [
          [["value-at", missingDb, "of:a", "--seq", "NaN"], "--seq"],
          [["commits", missingDb, "--limit", "Infinity"], "--limit"],
          [["hot", missingDb, "--limit", "1.5"], "--limit"],
          [["history", missingDb, "of:a", "--limit", "-1"], "--limit"],
          [["history", missingDb, "of:a", "--limit", "   "], "--limit"],
        ] as const
      ) {
        const result = run([...argv]);
        assertEquals(result.code, 1);
        assertStringIncludes(
          result.err,
          `\`${flag}\` must be a non-negative integer`,
        );
      }
    });

    await t.step("multi-space selectors are mutually exclusive", () => {
      const result = run([
        "converge",
        "of:a",
        "--spaces",
        `${dir}/missing.sqlite`,
        "--dir",
        `${dir}/missing`,
      ]);
      assertEquals(result.code, 1);
      assertStringIncludes(result.err, "either `--dir` or `--spaces`");
    });

    await t.step("empty multi-space selectors are rejected", () => {
      const result = run([
        "converge",
        "of:a",
        "--spaces",
        " , ",
      ]);
      assertEquals(result.code, 1);
      assertStringIncludes(
        result.err,
        "must contain at least one space",
      );
    });

    await t.step("unsafe convergence paths use escaped exact output", () => {
      const result = run([
        "converge",
        "of:a",
        "--spaces",
        db,
        "--path",
        "line\nforged",
      ]);
      assertEquals(result.code, 0);
      assertStringIncludes(result.out, 'path=["line\\nforged"]');
      assertEquals(result.out.includes("path=/line\nforged"), false);
    });

    await t.step("required entity arguments are checked before I/O", () => {
      const missingDb = `${dir}/missing.sqlite`;
      const valueAt = run(["value-at", missingDb]);
      assertEquals(valueAt.code, 1);
      assertStringIncludes(valueAt.err, "value-at needs <entity-id>");

      const history = run(["history", missingDb]);
      assertEquals(history.code, 1);
      assertStringIncludes(history.err, "history needs <entity-id>");
    });

    await t.step("--help exits successfully without a command", () => {
      assertEquals(run(["--help"]).code, 0);
    });

    await t.step(
      "preserves every nested value with `value-at --full-depth`",
      () => {
        const shallow = JSON.parse(
          run(["value-at", db, "of:a", "--json"]).out,
        );
        expect(JSON.stringify(shallow.value.deep)).toContain('"…"');
        const full = JSON.parse(
          run(["value-at", db, "of:a", "--full-depth", "--json"]).out,
        );
        let nested = full.value.deep;
        for (let depth = 0; depth < 12; depth++) nested = nested.child;
        expect(nested).toEqual({ leaf: "complete" });
      },
    );

    await t.step(
      "full-depth output survives deeply nested stored values",
      () => {
        const deeplyNested = `${
          '{"child":'.repeat(STACK_SAFE_DEPTH)
        }{"leaf":"complete"}${"}".repeat(STACK_SAFE_DEPTH)}`;
        const writable = new Database(db);
        try {
          writable.prepare(
            `INSERT INTO revision
               (id, seq, op_index, op, data, commit_seq)
             VALUES ('of:deep', 1, 0, 'set', ?, 1)`,
          ).run(`{"value":${deeplyNested}}`);
        } finally {
          writable.close();
        }

        const result = run([
          "value-at",
          db,
          "of:deep",
          "--full-depth",
          "--json",
        ]);
        expect(result.code).toBe(0);
        let nested = JSON.parse(result.out).value;
        for (let depth = 0; depth < STACK_SAFE_DEPTH; depth++) {
          nested = nested.child;
        }
        expect(nested).toEqual({ leaf: "complete" });
      },
    );

    await t.step("hot + history + commits succeed", () => {
      for (
        const argv of [["hot", db], ["history", db, "of:a"], ["commits", db]]
      ) {
        assertEquals(run([...argv, "--json"]).code, 0, argv.join(" "));
      }
    });

    await t.step("missing <db> is a usage error (exit 1)", () => {
      assertEquals(run(["summary"]).code, 1);
    });

    await t.step("summary renders a human-readable report", () => {
      const result = run(["summary", db]);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`space: ${db}`);
      expect(result.out).toContain("commits: 2 (seq 1–2)");
      expect(result.out).toContain("entities: 2  revisions: 3");
      expect(result.out).toContain("ops: patch=1 set=2");
      expect(result.out).toContain("scopes: space=3");
      expect(result.out).toContain("branches: (default)@2");
      expect(result.out).toContain("scheduler basis table: no");
      expect(result.out.trimStart().startsWith("{")).toBe(false);
    });

    await t.step("commits, hot and history render one line per row", () => {
      const commits = run(["commits", db]).out.split("\n");
      expect(commits).toHaveLength(2);
      expect(
        commits.every((line) =>
          /^#[12]\tsession:did:ke\tlocal=[12]\t/.test(line)
        ),
      )
        .toBe(true);

      const hot = run(["hot", db, "--limit", "1"]).out.split("\n");
      expect(hot).toEqual(["2\twrites\t1 sessions\tof:a\t(space)"]);

      const history = run(["history", db, "of:a"]).out.split("\n");
      expect(history).toHaveLength(2);
      expect(history[0]).toMatch(
        /^seq=1\tcommit=1\tset\tsession:did:ke\tlocal=1\t/,
      );
      expect(history[1]).toMatch(/^seq=2\tcommit=2\tpatch\t/);
    });

    await t.step(
      "value-at renders the value, an absence, or a missing path",
      () => {
        const present = run(["value-at", db, "of:a", "--path", "a"]);
        expect(present.code).toBe(0);
        expect(JSON.parse(present.out)).toEqual({ b: "nested key" });

        const fullDepth = run([
          "value-at",
          db,
          "of:a",
          "--path",
          "a",
          "--full-depth",
        ]);
        expect(JSON.parse(fullDepth.out)).toEqual({ b: "nested key" });

        const earlier = run([
          "value-at",
          db,
          "of:a",
          "--seq",
          "1",
          "--path",
          "n",
        ]);
        expect(earlier.out).toBe("1");

        expect(run(["value-at", db, "of:missing"]).out).toBe(
          "(absent at this seq)",
        );
        expect(run(["value-at", db, "of:a", "--path", "nowhere"]).out).toBe(
          "(entity present, but nothing at that path)",
        );
      },
    );

    await t.step("--path-json rejects text that is not JSON", () => {
      const result = run(["value-at", db, "of:a", "--path-json", "[oops"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("JSON array of string segments");
      expect(result.out).toBe("");
    });

    await t.step("multi-space commands check their arguments", () => {
      const noId = run(["converge", "--spaces", db]);
      expect(noId.code).toBe(1);
      expect(noId.err).toBe("error: converge needs <entity-id>");

      const noSelector = run(["converge-scan"]);
      expect(noSelector.code).toBe(1);
      expect(noSelector.err).toBe(
        "error: provide --spaces a,b,… or --dir <dir>",
      );
    });

    await t.step("an empty --dir resolves no spaces", async () => {
      const empty = `${dir}/empty`;
      await Deno.mkdir(empty);
      const result = run(["converge-scan", "--dir", empty]);
      expect(result.code).toBe(1);
      expect(result.err).toBe("error: no space DBs resolved");
    });

    await t.step(
      "converge and converge-scan render each space's view",
      async () => {
        // Five spaces seeded with `of:a`: two agreeing on the seeded value,
        // one that moved on, one whose revisions of it are deleted, and one
        // whose payload cannot be decoded.
        const multi = `${dir}/multi`;
        await Deno.mkdir(multi);
        for (const name of ["a", "b", "c", "d", "e"]) {
          seed(`${multi}/${name}.sqlite`);
        }
        const edit = (name: string, sql: string) => {
          const writable = new Database(`${multi}/${name}.sqlite`);
          try {
            writable.exec(sql);
          } finally {
            writable.close();
          }
        };
        edit(
          "c",
          `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
           VALUES (3, 'session:other', 1, '{}', '{}');
         INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
           VALUES ('of:a', 3, 0, 'patch',
             '[{"op":"replace","path":"/value/n","value":3}]', 3);`,
        );
        edit("d", `DELETE FROM revision WHERE id = 'of:a'`);
        edit("e", `UPDATE revision SET data = '{not json' WHERE id = 'of:a'`);

        const converge = run([
          "converge",
          "of:a",
          "--dir",
          multi,
          "--path",
          "n",
        ]);
        expect(converge.code).toBe(0);
        const lines = converge.out.split("\n");
        expect(lines[0]).toBe("verdict: UNKNOWN");
        expect(lines[1]).toBe(
          "entity:  of:a  scope=space  branch=(default)  path=/n",
        );
        expect(lines[2]).toMatch(
          /^ {2}a\.sqlite\thead=2\trevs=2\tlast=session:did:ke@.+\tcluster#1$/,
        );
        expect(lines[3]).toMatch(
          /^ {2}b\.sqlite\thead=2\trevs=2\t.*\tcluster#1$/,
        );
        expect(lines[4]).toMatch(
          /^ {2}c\.sqlite\thead=3\trevs=3\tlast=session:other@.+\tcluster#2$/,
        );
        expect(lines[5]).toBe("  d.sqlite\tABSENT");
        expect(lines[6]).toMatch(/^ {2}e\.sqlite\tERROR\t/);
        expect(lines.slice(7, 10)).toEqual([
          "clusters:",
          "  #1 [2]\t2",
          "  #2 [1]\t3",
        ]);
        expect(lines[10]).toMatch(/^note: /);

        const missingPath = run([
          "converge",
          "of:a",
          "--spaces",
          `${multi}/a.sqlite,${multi}/c.sqlite`,
          "--path",
          "a/b",
        ]);
        expect(missingPath.out).toContain("verdict: CONVERGED");
        expect(missingPath.out).not.toContain("path=MISSING");
        expect(missingPath.out).not.toContain("clusters:");

        const diverged = run([
          "converge",
          "of:a",
          "--spaces",
          `${multi}/a.sqlite,${multi}/c.sqlite`,
        ]);
        expect(diverged.out.split("\n")[0]).toBe(
          "verdict: DIVERGED  [no-cross-space-link]",
        );

        const absentPath = run([
          "converge",
          "of:a",
          "--spaces",
          `${multi}/a.sqlite,${multi}/b.sqlite`,
          "--path",
          "nowhere",
        ]);
        expect(absentPath.out).toContain("\tpath=MISSING");

        const scan = run(["converge-scan", "--dir", multi]);
        expect(scan.code).toBe(0);
        expect(scan.out.split("\n")).toEqual([
          "shared entities (in >=2 spaces): 1  examined: 1",
          "cross-space link edges: 0  (0 real-drift / 0 likely-independent-instances / 1 unknown)",
          "findings (diverged/partial/unknown): 1",
          "  UNKNOWN\t?\tof:a\tpresent=4\tmissing=1\tclusters=2",
        ]);

        const pair = run([
          "converge-scan",
          "--spaces",
          `${multi}/a.sqlite,${multi}/c.sqlite`,
          "--json",
        ]);
        const parsed = JSON.parse(pair.out);
        expect(parsed.findings.map((f: { id: string }) => f.id)).toEqual([
          "of:a",
        ]);
        expect(parsed.unlinkedFindings).toBe(1);
        const pairHuman = run([
          "converge-scan",
          "--spaces",
          `${multi}/a.sqlite,${multi}/c.sqlite`,
        ]);
        expect(pairHuman.out).toContain(
          "  DIVERGED\tinstance?\tof:a\tpresent=2\tclusters=2",
        );

        const agreeing = run([
          "converge-scan",
          "--spaces",
          `${multi}/a.sqlite,${multi}/b.sqlite`,
        ]);
        expect(agreeing.out).toContain(
          "findings (diverged/partial/unknown): 0",
        );
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
