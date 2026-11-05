// CFC Phase 3 (3.a-write), pure half: the db.exec gate for rule-bearing
// tables. An attributable INSERT evaluates the rule over its bound values
// (prospective row label) and verifies no-laundering: every labeled input must
// be captured by the computed row label. Everything unattributable on a
// rule-bearing table fails closed (server-side commit evaluation, 3.c, is the
// follow-up that lifts this).
// Spec: docs/specs/sqlite-builtin/06-cfc.md ("Write — the runner gate").

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import {
  all,
  authoredBy,
  constant,
  dbOwner,
  match,
  principal,
  whenMatches,
} from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";

import { checkSqliteRowLabelWrite } from "../src/builtins/sqlite/row-label-write.ts";

const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;
const OWNER = "did:key:zOwner";

const tables = {
  emails: table(
    {
      id: "integer primary key",
      from_addr: "text",
      to_addrs: "text",
      auth: "text",
      body: "text",
    },
    (f) => ({
      confidentiality: all(
        principal("mailto", match(f.from_addr, ADDR, { min: 1 })),
        principal("mailto", match(f.to_addrs, ADDR)),
        dbOwner(),
      ),
      integrity: whenMatches(
        f.auth,
        /dmarc=pass/,
        authoredBy(principal("mailto", match(f.from_addr, ADDR, { min: 1 }))),
      ),
    }),
  ),
  notes: table({ id: "integer primary key", body: "text" }),
  // A mailbox-keyed table, for what a numeric-affinity column does to a bound
  // value on the way in.
  mailboxes: table(
    { id: "integer primary key", source_id: "integer", note: "text" },
    (f) => ({
      confidentiality: all(
        whenMatches(f.source_id, /^007$/, constant("did:mailbox:007")),
        whenMatches(f.source_id, /^7$/, constant("did:mailbox:seven")),
        dbOwner(),
      ),
    }),
  ),
};

const unlabeled = (_v: unknown): readonly unknown[] => [];

function expectError(
  res: ReturnType<typeof checkSqliteRowLabelWrite>,
  needle: string,
) {
  assert("error" in res, "expected {error}");
  assert(
    res.error.includes(needle),
    `error "${res.error}" should mention "${needle}"`,
  );
}

function expectOk(
  res: ReturnType<typeof checkSqliteRowLabelWrite>,
): Exclude<ReturnType<typeof checkSqliteRowLabelWrite>, { error: string }> {
  if ("error" in res) throw new Error(`unexpected error: ${res.error}`);
  return res;
}

describe("checkSqliteRowLabelWrite — the value the column will store", () => {
  it("refuses a numeric string bound to a numeric-affinity rule input", () => {
    // The gate reads the BOUND value and the store re-derives from the
    // STORED one. INTEGER affinity turns "007" into 7, so the gate would
    // compute [did:mailbox:007, owner] for a row that reads back as
    // [did:mailbox:seven, owner] — and the no-laundering check, the one
    // thing the server cannot redo, would have run against a label the row
    // never carries.
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO mailboxes (source_id) VALUES (?)",
        params: ["007"],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "source_id",
    );
  });

  it("takes the number itself", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO mailboxes (source_id) VALUES (?)",
      params: [7],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies?.[0].label.confidentiality, [
      "did:mailbox:seven",
      OWNER,
    ]);
  });

  it("takes a string the column will store as it stands", () => {
    // Affinity only converts text that is a well-formed number, so "later"
    // reaches the row unchanged and the gate reads what the store will.
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO mailboxes (source_id) VALUES (?)",
      params: ["later"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies?.[0].label.confidentiality, [OWNER]);
  });

  it("binds the canonical text of an integer to an INTEGER column: same text either side", () => {
    // "7" stored under INTEGER affinity is 7, whose text is "7" again, so the
    // gate and the read side agree and nothing is refused.
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO mailboxes (source_id, note) VALUES (?, ?)",
      params: ["7", "n"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies?.[0].label.confidentiality, [
      "did:mailbox:seven",
      OWNER,
    ]);
  });

  it("refuses a spelling the column would store as another text", () => {
    for (const bound of ["007", "7.0", " 7", "-0", "7e0"]) {
      const res = checkSqliteRowLabelWrite({
        sql: "INSERT INTO mailboxes (source_id, note) VALUES (?, ?)",
        params: [bound, "n"],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      });
      assert("error" in res, `${JSON.stringify(bound)} was admitted`);
      assertStringIncludes(res.error, "another text");
    }
  });

  it("refuses a whole number too large to name one INTEGER exactly", () => {
    // Bound as a double, stored possibly wrapped; the commit read-back would
    // render the wrapped digits and accept what the evaluator refuses.
    const res = checkSqliteRowLabelWrite({
      sql: "INSERT INTO mailboxes (source_id, note) VALUES (?, ?)",
      params: [2 ** 53 + 2, "n"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    });
    assert("error" in res);
    assertStringIncludes(res.error, "bind a bigint");
  });

  it("refuses an object (a Cell, say) bound to a rule input before any conversion", () => {
    const res = checkSqliteRowLabelWrite({
      sql: "INSERT INTO mailboxes (source_id, note) VALUES (?, ?)",
      params: [{ get: () => "7" }, "n"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    });
    assert("error" in res);
    assertStringIncludes(res.error, "an object");
  });

  it("a number bound to a TEXT rule input renders the same text on both sides", () => {
    // TEXT affinity keeps a bound number as its text, which is what the
    // evaluator renders for it too; nothing to refuse. (The `note` column is
    // not a rule input, so the gate never inspects it — this test binds the
    // number where the rule reads.)
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO mailboxes (source_id, note) VALUES (?, ?)",
      params: [7, 7],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies?.[0].label.confidentiality, [
      "did:mailbox:seven",
      OWNER,
    ]);
  });
});

describe("checkSqliteRowLabelWrite — INSERT evaluates the rule", () => {
  it("computes the prospective row label from the bound values", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql:
        "INSERT INTO emails (from_addr, to_addrs, auth, body) VALUES (?, ?, ?, ?)",
      params: ["alice@a.example", "bob@example.com", "dmarc=pass", "hi"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies, [{
      table: "emails",
      label: {
        confidentiality: [
          "did:mailto:alice@a.example",
          "did:mailto:bob@example.com",
          OWNER,
        ],
        integrity: [
          {
            kind: "claimed-authored-by",
            subject: "did:mailto:alice@a.example",
          },
        ],
      },
    }]);
  });

  it("a column omitted from the INSERT evaluates as NULL (cc-only style)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO emails (from_addr, body) VALUES (?, ?)",
      params: ["alice@a.example", "hi"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies?.[0].label.confidentiality, [
      "did:mailto:alice@a.example",
      OWNER,
    ]);
  });

  it("a multi-row INSERT yields one policy per row, each with its own label", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO emails (from_addr, to_addrs) VALUES (?, ?), (?, ?)",
      params: [
        "alice@a.example",
        "bob@example.com",
        "carol@c.example",
        "dave@d.example",
      ],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies?.length, 2);
    assertEquals(res.policies?.[0].label.confidentiality, [
      "did:mailto:alice@a.example",
      "did:mailto:bob@example.com",
      OWNER,
    ]);
    assertEquals(res.policies?.[1].label.confidentiality, [
      "did:mailto:carol@c.example",
      "did:mailto:dave@d.example",
      OWNER,
    ]);
  });

  it("the rule's min anchor fails closed on a missing sender", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (to_addrs) VALUES (?)",
        params: ["bob@example.com"],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "from_addr",
    );
  });

  it("no-laundering: a labeled value captured by the row label passes", () => {
    const res = checkSqliteRowLabelWrite({
      sql: "INSERT INTO emails (from_addr, to_addrs, body) VALUES (?, ?, ?)",
      params: ["alice@a.example", "bob@example.com", "secret body"],
      tables,
      owner: OWNER,
      confidentialityOf: (v) =>
        v === "secret body" ? ["did:mailto:bob@example.com"] : [],
    });
    expectOk(res);
  });

  it("no-laundering: a labeled value NOT captured by the row label fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (from_addr, to_addrs, body) VALUES (?, ?, ?)",
        params: ["alice@a.example", "bob@example.com", "mallory's secret"],
        tables,
        owner: OWNER,
        confidentialityOf: (v) =>
          v === "mallory's secret" ? ["did:mailto:mallory@evil.example"] : [],
      }),
      "captured",
    );
  });

  it("a non-plain value bound to a rule input fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (from_addr, to_addrs) VALUES (?, ?)",
        params: [{ some: "cell-like" }, "bob@example.com"],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "from_addr",
    );
  });

  it("INSERT…SELECT (unattributable) on a rule-bearing table fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (from_addr) SELECT from_addr FROM emails",
        params: [],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "emails",
    );
  });
});

describe("checkSqliteRowLabelWrite — UPDATE / DELETE / rule-less", () => {
  it("UPDATE of a non-input column with unlabeled values passes (label unchanged)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "UPDATE emails SET body = ? WHERE id = ?",
      params: ["new body", 1],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies, undefined);
  });

  it("UPDATE touching a rule INPUT column fails closed (needs 3.c)", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "UPDATE emails SET to_addrs = ? WHERE id = ?",
        params: ["eve@evil.example", 1],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "to_addrs",
    );
  });

  it("UPDATE with a labeled value fails closed (capture unverifiable without the row)", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "UPDATE emails SET body = ? WHERE id = ?",
        params: ["secret", 1],
        tables,
        owner: OWNER,
        confidentialityOf: (v) => (v === "secret" ? ["x"] : []),
      }),
      "labeled",
    );
  });

  it("DELETE passes (no stored values)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "DELETE FROM emails WHERE id = ?",
      params: [1],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies, undefined);
  });

  it("rule-less tables are untouched (Phase 2 behavior)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["x"],
      tables,
      owner: OWNER,
      confidentialityOf: unlabeled,
    }));
    assertEquals(res.policies, undefined);
  });

  it("an unattributable write in a db WITH rule-bearing tables fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO unknown_table (x) VALUES (?)",
        params: ["v"],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "fail closed",
    );
  });

  it("dbOwner() in the rule with no owner on the ref fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO emails (from_addr) VALUES (?)",
        params: ["alice@a.example"],
        tables,
        owner: undefined,
        confidentialityOf: unlabeled,
      }),
      "dbOwner",
    );
  });
});

describe("checkSqliteRowLabelWrite — review-round soundness fixes", () => {
  // A rule whose confidentiality is entirely data-dependent: rows that don't
  // match the gate compute an EMPTY label.
  const gatedTables = {
    drafts: table(
      { id: "integer primary key", flag: "text", body: "text" },
      (f) => ({
        confidentiality: whenMatches(f.flag, /locked/, constant("sealed")),
      }),
    ),
  };

  it("an EMPTY computed row label captures nothing — labeled inputs fail closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "INSERT INTO drafts (flag, body) VALUES (?, ?)",
        params: ["open", "secret payload"],
        tables: gatedTables,
        owner: OWNER,
        confidentialityOf: (v) => (v === "secret payload" ? ["x"] : []),
      }),
      "empty",
    );
  });

  it("the same labeled input passes when the gate fires (non-empty label captures it)", () => {
    const res = checkSqliteRowLabelWrite({
      sql: "INSERT INTO drafts (flag, body) VALUES (?, ?)",
      params: ["locked", "secret payload"],
      tables: gatedTables,
      owner: OWNER,
      confidentialityOf: (v) => (v === "secret payload" ? ["sealed"] : []),
    });
    expectOk(res);
  });

  it("a param-less LITERAL UPDATE of a rule input column fails closed", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "UPDATE emails SET to_addrs = 'eve@evil.example' WHERE id = 1",
        params: [],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "to_addrs",
    );
  });

  it("a param-less literal UPDATE of a NON-input column also fails closed (unattributable SET)", () => {
    expectError(
      checkSqliteRowLabelWrite({
        sql: "UPDATE emails SET body = 'plain' WHERE id = 1",
        params: [],
        tables,
        owner: OWNER,
        confidentialityOf: unlabeled,
      }),
      "fail closed",
    );
  });
});

describe("checkSqliteRowLabelWrite — 3.c relaxation (serverCommitEval)", () => {
  const base = {
    tables,
    owner: OWNER,
    confidentialityOf: unlabeled,
    serverCommitEval: true,
  };

  it("admits INSERT…SELECT with unlabeled inputs (server derives; no policies)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails (from_addr) SELECT from_addr FROM emails",
      params: [],
    }));
    assertEquals(res.policies, undefined);
  });

  it("admits an upsert with unlabeled bound values", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails (id, from_addr) VALUES (?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET from_addr = excluded.from_addr",
      params: [1, "alice@a.example"],
    }));
    assertEquals(res.policies, undefined);
  });

  it("admits a columnless INSERT (VALUES and DEFAULT VALUES forms)", () => {
    expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails VALUES (?, ?, ?, ?, ?)",
      params: [1, "alice@a.example", "bob@example.com", "", "hi"],
    }));
    expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails DEFAULT VALUES",
      params: [],
    }));
  });

  it("admits an UPDATE that writes a rule-input column (post-image is the server's)", () => {
    const res = expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "UPDATE emails SET to_addrs = ? WHERE id = ?",
      params: ["carol@c.example", 1],
    }));
    assertEquals(res.policies, undefined);
  });

  it("no-laundering STAYS runner-side: a labeled value on a relaxed shape fails closed", () => {
    // The server never sees input-value labels, so the runner cannot defer
    // the capture check — a labeled bound value on a shape the runner cannot
    // evaluate keeps failing closed even with the capability.
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "INSERT INTO emails (from_addr, body) SELECT ?, ? FROM emails",
        params: ["alice@a.example", "secret"],
        confidentialityOf: (v) => (v === "secret" ? ["x"] : []),
      }),
      "labeled",
    );
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "UPDATE emails SET to_addrs = ? WHERE id = ?",
        params: ["secret", 1],
        confidentialityOf: (v) => (v === "secret" ? ["x"] : []),
      }),
      "labeled",
    );
  });

  it("shapes 3.c does NOT cover keep failing closed with the capability on", () => {
    // Named params: bound values can't be attributed for the laundering check.
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "INSERT INTO emails (from_addr) VALUES (:f)",
        params: { f: "alice@a.example" },
      }),
      "named params",
    );
    // Literal/expression SET stays unattributable.
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "UPDATE emails SET to_addrs = 'eve@evil.example' WHERE id = 1",
        params: [],
      }),
      "fail closed",
    );
    // Undeclared target table.
    expectError(
      checkSqliteRowLabelWrite({
        ...base,
        sql: "INSERT INTO unknown_table (x) VALUES (?)",
        params: ["v"],
      }),
      "undeclared",
    );
  });

  it("an attributable INSERT still evaluates runner-side (policies recorded)", () => {
    // The relaxation must not disable the 3.a fast path: evaluable shapes
    // keep computing prospective labels for the sink-request seam.
    const res = expectOk(checkSqliteRowLabelWrite({
      ...base,
      sql: "INSERT INTO emails (from_addr, to_addrs) VALUES (?, ?)",
      params: ["alice@a.example", "bob@example.com"],
    }));
    assertEquals(res.policies?.length, 1);
  });
});
