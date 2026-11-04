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

/** Run `main` while capturing its output. */
function run(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => out.push(args.join(" "));
  console.error = (...args: unknown[]) => err.push(args.join(" "));
  try {
    const code = main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
