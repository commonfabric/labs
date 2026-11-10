import {
  cfSqlite,
  handler,
  pattern,
  resultOf,
  sqliteDatabase,
  type SqliteDb,
  table,
} from "commonfabric";

// FIXTURE (integration, CFC Phase 3): per-row DATA-DERIVED labels. Each email
// row's confidentiality is computed from its own from/to columns (regex over a
// dirty recipient line) plus the db owner; integrity (authored-by-sender) is
// gated on the row's auth column. The main query aliases `from_addr` to ALSO
// prove rule inputs resolve by TRUE column origin, not output name.
//
const seed = handler<Record<string, never>, { db: SqliteDb }>((_, { db }) => {
  db.exec(
    "INSERT INTO emails (from_addr, to_addrs, auth, body) VALUES (?, ?, ?, ?)",
    [
      "Alice Example <Alice@A.example>",
      "bob@example.com",
      "spf=pass dmarc=pass",
      "hello bob",
    ],
  );
  db.exec(
    "INSERT INTO emails (from_addr, to_addrs, auth, body) VALUES (?, ?, ?, ?)",
    [
      "carol@c.example",
      '"Dave D" <dave@d.example>, erin@e.example',
      "",
      "hi both",
    ],
  );
});

export default pattern(() => {
  // In-body authoring shape: destructuring is function-scoped (top-level
  // destructuring is rejected by the SES verifier), and the rule callback is
  // the recognized `table(columns, rule)` boundary (evaluated eagerly into a
  // serialized AST — never a reactive closure).
  const { all, principal, match, whenMatches, authoredBy, dbOwner } = cfSqlite;
  const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;

  const emails = table(
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
    // Phase 3.b: opt the table into read-time clearance.
    { allowReadClearance: true },
  );

  const db = sqliteDatabase({ tables: { emails } });

  // Rows, sender aliased: rule inputs must resolve by origin.
  const q = db.query<{ id: number; sender: string; body: string }>(
    "SELECT id, from_addr AS sender, to_addrs, auth, body FROM emails " +
      "ORDER BY id",
    { reactOn: db },
  );

  // An aggregate on a rule-bearing table must FAIL CLOSED.
  const qCount = db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM emails",
    { reactOn: db },
  );

  // Declared output ceiling + skip: only row 1's participants (+ owner) are
  // admitted, so row 2 is dropped — a declared, observable existence release.
  const qSkim = db.query<{ id: number; body: string }>(
    "SELECT id, from_addr, to_addrs, auth, body FROM emails ORDER BY id",
    {
      reactOn: db,
      maxConfidentiality: [
        "did:mailto:alice@a.example",
        "did:mailto:bob@example.com",
        { __ctDbOwner: true },
      ],
      onExceed: "skip",
    },
  );

  // Phase 3.b read-time clearance: the acting reader is the db owner (a
  // did:key), but every emails row's CONJUNCTIVE rule also requires the row's
  // did:mailto participants — which the owner is not — so the owner may read no
  // row. A cleared query therefore returns zero rows and reports withheld: 2 (a
  // declared, audited existence release). Proves the whole path end-to-end:
  // option -> reader resolution -> per-row reader test -> withheld surfaced.
  const qClear = db.query<{ id: number; body: string }>(
    "SELECT id, from_addr, to_addrs, auth, body FROM emails ORDER BY id",
    { reactOn: db, readClearance: true },
  );

  return {
    q: resultOf(q),
    qCount: resultOf(qCount),
    qSkim: resultOf(qSkim),
    qClear: resultOf(qClear),
    seed: seed({ db }),
  };
});
