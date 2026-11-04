// CFC Phase 3 (3.a-spec): the per-row label rule — builder helpers -> serialized
// AST on the table schema, AST validation (fail-closed at authoring), and the
// shared evaluator. Pure unit tests: no FFI, no server, no runner.
// Spec: docs/specs/sqlite-builtin/06-cfc.md ("Per-row labels": authoring
// surface, serialized spec + evaluator, fail-closed rules).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { dbNeedsColumnProvenance, tableDeclaresRowLabel } from "../v2.ts";
import { table } from "../v2/sqlite/schema.ts";
import {
  all,
  any,
  authoredBy,
  constant,
  dbOwner,
  endorsedBy,
  evaluateRowLabel,
  intersect,
  match,
  principal,
  type RowLabelSpec,
  ruleCommonAlternatives,
  ruleConstrainsConfidentiality,
  validateRowLabelSpec,
  whenMatches,
} from "../v2/sqlite/row-label.ts";

const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;

const EMAIL_COLUMNS = {
  id: "integer primary key",
  from: "text",
  to: "text",
  cc: "text",
  body: "text",
  auth: "text",
};

function emailRule(f: Record<string, { field: string }>) {
  return {
    confidentiality: all(
      principal("mailto", match(f.from, ADDR, { min: 1 })),
      principal("mailto", match(f.to, ADDR)),
      principal("mailto", match(f.cc, ADDR)),
      dbOwner(),
    ),
    integrity: whenMatches(
      f.auth,
      /dmarc=pass/,
      authoredBy(principal("mailto", match(f.from, ADDR, { min: 1 }))),
    ),
  };
}

function emailSpec(): RowLabelSpec {
  const schema = table(EMAIL_COLUMNS, emailRule);
  return schema.rowLabel as RowLabelSpec;
}

function expectError(
  spec: RowLabelSpec,
  row: Record<string, unknown>,
  ctx: { dbOwner?: string },
  needle: string,
) {
  const res = evaluateRowLabel(spec, row, ctx);
  assert("error" in res, `expected {error} for ${JSON.stringify(row)}`);
  assert(
    res.error.includes(needle),
    `error "${res.error}" should mention "${needle}"`,
  );
}

//
// Builder -> AST
//

Deno.test("table(columns, rule) serializes the rule to a plain-JSON rowLabel AST", () => {
  const schema = table(EMAIL_COLUMNS, emailRule);
  const spec = schema.rowLabel as RowLabelSpec;
  assert(spec, "rowLabel attached to the table schema");
  assertEquals(spec.version, 1);
  // Plain JSON: survives a stringify round-trip identically (RegExp lowered to
  // {source, flags}).
  assertEquals(JSON.parse(JSON.stringify(spec)), spec);
  assertEquals(spec.confidentiality, {
    allOf: [
      {
        principal: {
          protocol: "mailto",
          of: {
            match: { field: "from", source: ADDR.source, flags: "g", min: 1 },
          },
        },
      },
      {
        principal: {
          protocol: "mailto",
          of: { match: { field: "to", source: ADDR.source, flags: "g" } },
        },
      },
      {
        principal: {
          protocol: "mailto",
          of: { match: { field: "cc", source: ADDR.source, flags: "g" } },
        },
      },
      { dbOwner: true },
    ],
  });
  assertEquals(spec.integrity, {
    when: { match: { field: "auth", source: "dmarc=pass", flags: "" } },
    then: {
      authoredBy: {
        principal: {
          protocol: "mailto",
          of: {
            match: { field: "from", source: ADDR.source, flags: "g", min: 1 },
          },
        },
      },
    },
  });
});

Deno.test("a table without a rule gets no rowLabel (zero cost for unlabeled dbs)", () => {
  const schema = table({ id: "integer", body: "text" });
  assertEquals(schema.rowLabel, undefined);
});

Deno.test("match() forces the global flag so split-on-match works", () => {
  const schema = table(
    { from: "text" },
    (f) => ({
      confidentiality: all(principal("mailto", match(f.from, /\S+@\S+/))),
    }),
  );
  const spec = schema.rowLabel as RowLabelSpec;
  const node = (spec.confidentiality as { allOf: unknown[] })
    .allOf[0] as Record<
      string,
      { of: { match: { flags: string } } }
    >;
  assert(node.principal.of.match.flags.includes("g"));
});

//
// any(): the OR-clauses it authors, and the shape it refuses
//

Deno.test("any() builds and validates an OR-clause (Epic E1)", () => {
  // any() no longer throws at table() time — it produces an authored OR-clause
  // the runner's clause-aware profile enforces by subsumption.

  const schema = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: any(
      principal("mailto", match(f.from, ADDR)),
      dbOwner(),
    ),
  }));
  const spec = schema.rowLabel as RowLabelSpec;
  assertEquals(
    validateRowLabelSpec(spec, Object.keys(EMAIL_COLUMNS)),
    undefined,
  );
  // An any() with no alternatives is rejected.
  assert(
    typeof validateRowLabelSpec(
      { version: 1, confidentiality: { anyOf: [] } } as RowLabelSpec,
      Object.keys(EMAIL_COLUMNS),
    ) === "string",
  );
});

Deno.test("any() rejects a conjunctive alternative — no (A∧B)∨C → A∨B∨C widening (Epic E1)", () => {
  // A direct all() as an any() alternative is rejected: union-flattening it
  // would make the row readable by A alone even though the author required
  // A AND B.
  assertThrows(
    () =>
      table(EMAIL_COLUMNS, (f) => ({
        confidentiality: any(
          all(
            principal("mailto", match(f.from, ADDR)),
            principal("mailto", match(f.to, ADDR)),
          ),
          dbOwner(),
        ),
      })),
    Error,
    "all()/any()",
  );
  // ...and a when() gating an all() is rejected too (recursive check).
  assertThrows(
    () =>
      table(EMAIL_COLUMNS, (f) => ({
        confidentiality: any(
          whenMatches(
            f.auth,
            /dmarc=pass/,
            all(
              principal("mailto", match(f.from, ADDR)),
              principal("mailto", match(f.to, ADDR)),
            ),
          ),
          dbOwner(),
        ),
      })),
    Error,
  );
});

//
// Static analysis of an authored rule (no row required)
//

Deno.test("ruleCommonAlternatives: the static readers of EVERY clause (Epic E2)", () => {
  const OWNER = "did:key:zOwner";
  // An unconditional dbOwner() in a single OR-clause → the owner is common.
  const orRule = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: any(
      dbOwner(),
      principal("mailto", match(f.from, ADDR)),
    ),
  })).rowLabel as RowLabelSpec;
  assertEquals(ruleCommonAlternatives(orRule, { dbOwner: OWNER }), [OWNER]);

  // dbOwner in every conjunct's OR-clause → still common.
  const cnfRule = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: all(
      any(dbOwner(), principal("mailto", match(f.from, ADDR))),
      any(dbOwner(), principal("mailto", match(f.to, ADDR))),
    ),
  })).rowLabel as RowLabelSpec;
  assertEquals(ruleCommonAlternatives(cnfRule, { dbOwner: OWNER }), [OWNER]);

  // The CONJUNCTIVE email rule (all(principal, …, dbOwner)) has NO common
  // reader — a principal() conjunct is data-dependent, so nobody reads every
  // row. This is why an aggregate over it must still refuse.
  assertEquals(ruleCommonAlternatives(emailSpec(), { dbOwner: OWNER }), []);

  // dbOwner unconditional as a top-level conjunct is NOT a common reader of
  // the OTHER conjuncts (a principal clause it doesn't satisfy).
  const mixed = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: all(
      principal("mailto", match(f.from, ADDR)),
      dbOwner(),
    ),
  })).rowLabel as RowLabelSpec;
  assertEquals(ruleCommonAlternatives(mixed, { dbOwner: OWNER }), []);

  // constant() is a static reader too.
  const constRule = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: any(
      constant("did:key:public"),
      principal("mailto", match(f.from, ADDR)),
    ),
  })).rowLabel as RowLabelSpec;
  assertEquals(ruleCommonAlternatives(constRule, { dbOwner: OWNER }), [
    "did:key:public",
  ]);

  // A NESTED all(...) must not hide a clause: all(all(anyA, anyB), anyC) has
  // dbOwner() in every leaf clause, so the owner is still common. A one-level
  // flatten would treat the inner all(...) as an opaque term with no static
  // reader and wrongly return [] (a false aggregate refusal).
  const nestedRule = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: all(
      all(
        any(dbOwner(), principal("mailto", match(f.from, ADDR))),
        any(dbOwner(), principal("mailto", match(f.to, ADDR))),
      ),
      any(dbOwner(), constant("did:key:public")),
    ),
  })).rowLabel as RowLabelSpec;
  assertEquals(ruleCommonAlternatives(nestedRule, { dbOwner: OWNER }), [OWNER]);

  // An integrity-only rule has no confidentiality clause → no common
  // alternative to compute (the aggregate is public, decided by the caller).
  const integrityOnly = table(EMAIL_COLUMNS, (f) => ({
    integrity: authoredBy(principal("mailto", match(f.from, ADDR))),
  })).rowLabel as RowLabelSpec;
  assertEquals(ruleCommonAlternatives(integrityOnly, { dbOwner: OWNER }), []);

  // Two conjuncts each with a DIFFERENT static reader → the running
  // intersection empties, so there is no reader of every row.
  const disjointConjuncts = table(EMAIL_COLUMNS, () => ({
    confidentiality: all(constant("did:key:A"), constant("did:key:B")),
  })).rowLabel as RowLabelSpec;
  assertEquals(
    ruleCommonAlternatives(disjointConjuncts, { dbOwner: OWNER }),
    [],
  );

  // Defensive: a degenerate empty conjunction (rejected at table() time, but
  // reachable via a hand-built wire spec) yields no common alternative.
  const emptyConjunction = {
    version: 1,
    confidentiality: { allOf: [] },
  } as unknown as RowLabelSpec;
  assertEquals(
    ruleCommonAlternatives(emptyConjunction, { dbOwner: OWNER }),
    [],
  );

  // Defensive: a non-record conjunct (malformed wire spec) contributes no
  // static reader rather than throwing — fail closed to no common alternative.
  const malformedConjunct = {
    version: 1,
    confidentiality: { allOf: ["not-a-node"] },
  } as unknown as RowLabelSpec;
  assertEquals(
    ruleCommonAlternatives(malformedConjunct, { dbOwner: OWNER }),
    [],
  );
});

Deno.test("ruleConstrainsConfidentiality: confidentiality present vs integrity-only (Epic E2)", () => {
  // An integrity-only rule imposes NO confidentiality constraint — an aggregate
  // over it is public, not a refusal. Distinguished from a rule that DOES
  // constrain (any nesting of at least one clause).

  const integrityOnly = table(EMAIL_COLUMNS, (f) => ({
    integrity: authoredBy(principal("mailto", match(f.from, ADDR))),
  })).rowLabel as RowLabelSpec;
  assertEquals(ruleConstrainsConfidentiality(integrityOnly), false);

  const withConf = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: any(dbOwner(), principal("mailto", match(f.from, ADDR))),
  })).rowLabel as RowLabelSpec;
  assertEquals(ruleConstrainsConfidentiality(withConf), true);

  // Nested all(all(...)) still counts as constraining.
  const nested = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: all(
      all(principal("mailto", match(f.from, ADDR))),
      dbOwner(),
    ),
  })).rowLabel as RowLabelSpec;
  assertEquals(ruleConstrainsConfidentiality(nested), true);
});

//
// Fail-closed at authoring, and again on a spec that arrives built
//

Deno.test("a rule referencing an unknown column throws", () => {
  assertThrows(
    () =>
      table({ from: "text" }, (f) => ({
        confidentiality: all(
          principal(
            "mailto",
            match(
              (f as Record<string, { field: string }>).nope ??
                { field: "nope" },
              ADDR,
            ),
          ),
        ),
      })),
    TypeError,
    "nope",
  );
});

Deno.test("an unknown op node in a hand-crafted rule throws", () => {
  assertThrows(
    () =>
      table({ from: "text" }, (_f) => ({
        confidentiality: { bogus: 1 } as never,
      })),
    TypeError,
  );
});

Deno.test("a bare field handle used as a term throws (only match/matches may name data)", () => {
  assertThrows(
    () =>
      table({ from: "text" }, (f) => ({
        confidentiality: all(f.from as never),
      })),
    TypeError,
  );
});

Deno.test("intersect() in a confidentiality position throws (integrity meets only)", () => {
  assertThrows(
    () =>
      table({ from: "text" }, (_f) => ({
        confidentiality: intersect(constant("a"), constant("b")) as never,
      })),
    TypeError,
    "intersect",
  );
});

Deno.test("endorsedBy()/authoredBy() in a confidentiality position throws", () => {
  assertThrows(
    () =>
      table({ from: "text" }, (f) => ({
        confidentiality: all(
          authoredBy(principal("mailto", match(f.from, ADDR))) as never,
        ),
      })),
    TypeError,
  );
});

Deno.test("an acting-principal node is rejected even when hand-crafted (no currentUser in rules)", () => {
  assertThrows(
    () =>
      table({ from: "text" }, (_f) => ({
        confidentiality: { allOf: [{ currentPrincipal: true }] } as never,
      })),
    TypeError,
  );
});

Deno.test("a ReDoS-shaped regex (nested quantifier) fails the safety lint", () => {
  assertThrows(
    () =>
      table({ from: "text" }, (f) => ({
        confidentiality: all(principal("mailto", match(f.from, /(a+)+b/g))),
      })),
    TypeError,
    "regex",
  );
});

Deno.test("validateRowLabelSpec re-validates a wire-supplied spec (fail closed)", () => {
  const good = emailSpec();
  assertEquals(
    validateRowLabelSpec(good, Object.keys(EMAIL_COLUMNS)),
    undefined,
  );
  // A well-formed anyOf over the wire now validates (Epic E1)...
  const withClause = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: any(
      dbOwner(),
      principal("mailto", match(f.from, ADDR)),
    ),
  })).rowLabel as RowLabelSpec;
  assertEquals(
    validateRowLabelSpec(
      JSON.parse(JSON.stringify(withClause)) as RowLabelSpec,
      Object.keys(EMAIL_COLUMNS),
    ),
    undefined,
  );
  // ...but a malformed alternative (unknown column) is still rejected.
  const badClause = {
    version: 1,
    confidentiality: {
      anyOf: [{
        principal: {
          protocol: "mailto",
          of: { match: { field: "nonesuch", source: ADDR.source, flags: "g" } },
        },
      }],
    },
  } as unknown as RowLabelSpec;
  assert(
    typeof validateRowLabelSpec(badClause, Object.keys(EMAIL_COLUMNS)) ===
      "string",
  );
  // Unknown column in a wire spec is rejected.
  const wrongCols = validateRowLabelSpec(good, ["id", "body"]);
  assert(typeof wrongCols === "string");
});

//
// evaluateRowLabel — happy paths
//

const OWNER = "did:key:zOwner";

function evalEmail(
  row: Record<string, unknown>,
): { confidentiality: unknown[]; integrity: unknown[] } {
  const res = evaluateRowLabel(emailSpec(), row, { dbOwner: OWNER });
  if ("error" in res) throw new Error(`unexpected error: ${res.error}`);
  return res;
}

Deno.test("splits a dirty RFC-5322 To line and normalizes mailto principals", () => {
  const { confidentiality, integrity } = evalEmail({
    from: "Alice Example <Alice@A.example>",
    to: '"John Smith" <john@smith.com>, bob@example.com',
    cc: "",
    auth: "",
  });
  assertEquals(confidentiality, [
    "did:mailto:alice@a.example",
    "did:mailto:john@smith.com",
    "did:mailto:bob@example.com",
    OWNER,
  ]);
  assertEquals(integrity, []);
});

Deno.test("structural dedup: a principal appearing in two columns contributes once", () => {
  const { confidentiality } = evalEmail({
    from: "alice@a.example",
    to: "alice@a.example, bob@example.com",
    cc: "",
    auth: "",
  });
  assertEquals(confidentiality, [
    "did:mailto:alice@a.example",
    "did:mailto:bob@example.com",
    OWNER,
  ]);
});

Deno.test("when(dmarc=pass) gates the authored-by claim; the minted atom is a self-describing claim", () => {
  const passed = evalEmail({
    from: "alice@a.example",
    to: "bob@example.com",
    cc: "",
    auth: "spf=pass dmarc=pass dkim=pass",
  });
  assertEquals(passed.integrity, [
    { kind: "claimed-authored-by", subject: "did:mailto:alice@a.example" },
  ]);
  const failed = evalEmail({
    from: "alice@a.example",
    to: "bob@example.com",
    cc: "",
    auth: "dmarc=fail",
  });
  assertEquals(failed.integrity, []);
});

Deno.test("capture group + did:web: derive the org domain from the sender", () => {
  const schema = table(
    { from: "text" },
    (f) => ({
      confidentiality: all(
        principal("web", match(f.from, /@([\w.-]+)/, { group: 1 })),
      ),
    }),
  );
  const res = evaluateRowLabel(
    schema.rowLabel as RowLabelSpec,
    { from: "alice@Acme.example" },
    {},
  );
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.confidentiality, ["did:web:acme.example"]);
});

Deno.test("did:key protocol does NOT normalize case (base58 is case-sensitive)", () => {
  const schema = table(
    { owner: "text" },
    (f) => ({
      confidentiality: all(principal("key", match(f.owner, /z[\w]+/g))),
    }),
  );
  const res = evaluateRowLabel(
    schema.rowLabel as RowLabelSpec,
    { owner: "z6MkExAmPlE" },
    {},
  );
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.confidentiality, ["did:key:z6MkExAmPlE"]);
});

Deno.test("empty optional field contributes nothing (cc-only / bcc-only mail is legal)", () => {
  const { confidentiality } = evalEmail({
    from: "alice@a.example",
    to: "",
    cc: "bob@example.com",
    auth: "",
  });
  assertEquals(confidentiality, [
    "did:mailto:alice@a.example",
    "did:mailto:bob@example.com",
    OWNER,
  ]);
});

Deno.test("null field value behaves like empty (SQLite NULL)", () => {
  const { confidentiality } = evalEmail({
    from: "alice@a.example",
    to: null,
    cc: null,
    auth: null,
  });
  assertEquals(confidentiality, ["did:mailto:alice@a.example", OWNER]);
});

Deno.test("constant() injects a literal atom; intersect() meets integrity atom sets", () => {
  const spec: RowLabelSpec = {
    version: 1,
    confidentiality: { allOf: [{ constant: "pii" }] },
    integrity: {
      intersect: [
        { allOf: [{ constant: "a" }, { constant: "b" }] },
        { allOf: [{ constant: "b" }, { constant: "c" }] },
      ],
    },
  };
  const res = evaluateRowLabel(spec, {}, {});
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.confidentiality, ["pii"]);
  assertEquals(res.integrity, ["b"]);
});

//
// evaluateRowLabel — fail-closed on the row and the context
//
// Each returns {error}, never a partial label.
//

Deno.test("a referenced field absent from the row fails closed", () => {
  expectError(
    emailSpec(),
    { from: "a@b.c", to: "", cc: "" }, // auth key missing entirely
    { dbOwner: OWNER },
    "auth",
  );
});

Deno.test("a non-string value where a regex needs one fails closed", () => {
  expectError(
    emailSpec(),
    { from: 42, to: "", cc: "", auth: "" },
    { dbOwner: OWNER },
    "from",
  );
});

Deno.test("min:1 — an empty required field fails closed (sender is the anchor)", () => {
  expectError(
    emailSpec(),
    { from: "", to: "bob@example.com", cc: "", auth: "" },
    { dbOwner: OWNER },
    "from",
  );
});

Deno.test("strict-if-present: a non-empty field with zero matches fails closed (no silent under-label)", () => {
  expectError(
    emailSpec(),
    {
      from: "alice@a.example",
      to: "totally mangled garbage with no address",
      cc: "",
      auth: "",
    },
    { dbOwner: OWNER },
    "to",
  );
});

Deno.test("more than one match in an integrity-bearing position fails closed (display-name bait)", () => {
  expectError(
    emailSpec(),
    {
      from: '"Mallory <bait@evil.example>" <real@x.example>',
      to: "bob@example.com",
      cc: "",
      auth: "dmarc=pass",
    },
    { dbOwner: OWNER },
    "integrity",
  );
});

Deno.test("dbOwner() with no owner in ctx fails closed", () => {
  expectError(
    emailSpec(),
    { from: "alice@a.example", to: "", cc: "", auth: "" },
    {},
    "dbOwner",
  );
});

//
// evaluateRowLabel — OR-clause evaluation (Epic E1)
//
// An anyOf node evaluates to one structural OR-clause rather than to flattened
// atoms, a conjunction smuggled in as an alternative fails closed instead of
// widening into one, and an all() of any()-clauses composes into proper CNF.
//

Deno.test("an anyOf node evaluates to a structural OR-clause (Epic E1)", () => {
  // any(dbOwner ∨ from-participants): the row is readable by the owner OR any
  // sender — ONE OR-clause, not flattened into bare atoms.

  const spec = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: any(dbOwner(), principal("mailto", match(f.from, ADDR))),
  })).rowLabel as RowLabelSpec;
  const res = evaluateRowLabel(spec, { from: "alice@a.example" }, {
    dbOwner: OWNER,
  });
  if ("error" in res) throw new Error(`unexpected error: ${res.error}`);
  assertEquals(res.confidentiality, [
    { anyOf: [OWNER, "did:mailto:alice@a.example"] },
  ]);
});

Deno.test("evalConf fails closed on a conjunctive any() alternative that bypassed validation (Epic E1)", () => {
  // A raw wire spec (not built through table(), so validation was skipped)
  // with a conjunction as an any() alternative must fail closed at eval —
  // never union-flatten (A∧B)∨C into A∨B∨C. Both the direct all() and the
  // when()-wrapped all() shapes are rejected.

  const direct: RowLabelSpec = {
    version: 1,
    confidentiality: {
      anyOf: [
        { allOf: [{ dbOwner: true }, { constant: "x" }] },
        { dbOwner: true },
      ],
    } as never,
  };
  const dRes = evaluateRowLabel(direct, {}, { dbOwner: OWNER });
  assert("error" in dRes && dRes.error.includes("conjunction"));

  const gated: RowLabelSpec = {
    version: 1,
    confidentiality: {
      anyOf: [
        {
          when: { match: { field: "from", source: ADDR.source, flags: "" } },
          then: { allOf: [{ dbOwner: true }, { constant: "x" }] },
        },
        { dbOwner: true },
      ],
    } as never,
  };
  const gRes = evaluateRowLabel(gated, { from: "a@b.example" }, {
    dbOwner: OWNER,
  });
  assert("error" in gRes && gRes.error.includes("conjunction"));
});

Deno.test("an all() of any()-clauses is proper CNF (Epic E1)", () => {
  // all(any(owner ∨ from), to-participants) → (owner∨from) ∧ to.

  const spec = table(EMAIL_COLUMNS, (f) => ({
    confidentiality: all(
      any(dbOwner(), principal("mailto", match(f.from, ADDR))),
      principal("mailto", match(f.to, ADDR)),
    ),
  })).rowLabel as RowLabelSpec;
  const res = evaluateRowLabel(
    spec,
    { from: "alice@a.example", to: "bob@example.com" },
    { dbOwner: OWNER },
  );
  if ("error" in res) throw new Error(`unexpected error: ${res.error}`);
  assertEquals(res.confidentiality, [
    { anyOf: [OWNER, "did:mailto:alice@a.example"] },
    "did:mailto:bob@example.com",
  ]);
});

//
// evaluateRowLabel — fail-closed on the spec itself
//

Deno.test("an unknown op reaching the evaluator fails closed", () => {
  const spec: RowLabelSpec = {
    version: 1,
    confidentiality: { allOf: [{ mystery: true }] } as never,
  };
  expectError(spec, {}, { dbOwner: OWNER }, "op");
});

Deno.test("an unsupported spec version fails closed", () => {
  const spec = { ...emailSpec(), version: 2 } as unknown as RowLabelSpec;
  expectError(
    spec,
    { from: "a@b.c", to: "", cc: "", auth: "" },
    { dbOwner: OWNER },
    "version",
  );
});

//
// Claim minting variants
//
// What the evaluator mints when it does not fail closed: the endorsed-by kind,
// and the no-claim answer that zero matches gives where more than one would
// have been an error.
//

Deno.test("endorsedBy mints claimed-endorsed-by", () => {
  const schema = table(
    { reviewer: "text" },
    (f) => ({
      integrity: endorsedBy(principal("mailto", match(f.reviewer, ADDR))),
    }),
  );
  const res = evaluateRowLabel(
    schema.rowLabel as RowLabelSpec,
    { reviewer: "rev@example.com" },
    {},
  );
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.integrity, [
    { kind: "claimed-endorsed-by", subject: "did:mailto:rev@example.com" },
  ]);
});

Deno.test("zero matches in an integrity position mints no claim", () => {
  // Zero matches in an integrity position mints nothing (the claim simply is
  // not made) — distinct from >1 which is an error.

  const schema = table(
    { reviewer: "text" },
    (f) => ({
      integrity: endorsedBy(principal("mailto", match(f.reviewer, ADDR))),
    }),
  );
  const res = evaluateRowLabel(
    schema.rowLabel as RowLabelSpec,
    { reviewer: "" },
    {},
  );
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.integrity, []);
});

//
// Provenance gate predicates (shared server/runner — v2.ts)
//

Deno.test("dbNeedsColumnProvenance: rowLabel-only tables need origin capture too", () => {
  const ruleOnly = {
    emails: table(
      { from: "text" },
      (f) => ({
        confidentiality: all(principal("mailto", match(f.from, ADDR))),
      }),
    ),
  };
  assert(tableDeclaresRowLabel(ruleOnly.emails));
  assert(dbNeedsColumnProvenance(ruleOnly));

  const columnOnly = {
    notes: {
      properties: { body: { ifc: { confidentiality: ["secret"] } } },
    },
  };
  assert(dbNeedsColumnProvenance(columnOnly));

  const unlabeled = { notes: table({ body: "text" }) };
  assert(!tableDeclaresRowLabel(unlabeled.notes));
  assert(!tableDeclaresRowLabel(null));
  assert(!dbNeedsColumnProvenance(unlabeled));
  assert(!dbNeedsColumnProvenance({ notes: {} }));
  assert(!dbNeedsColumnProvenance(undefined));
});

//
// Review-round fixes: validator/evaluator robustness on hostile wire specs
//

Deno.test("an unbalanced regex in a wire spec returns a reason (no lint crash)", () => {
  const spec: RowLabelSpec = {
    version: 1,
    confidentiality: {
      allOf: [{
        principal: {
          protocol: "mailto",
          of: { match: { field: "from", source: "a)b", flags: "g" } },
        },
      }],
    },
  };
  const reason = validateRowLabelSpec(spec, ["from"]);
  assert(typeof reason === "string");
});

// Ambiguous dual-op nodes: a node carrying TWO recognized op keys must refuse
// everywhere. The validator, the evaluator, and the static common-alternative
// analysis each dispatch by their own key precedence, so a hand-crafted
// {principal, dbOwner} node used to validate as a principal, evaluate to only
// the principal, and STATICALLY count the owner as a common reader — labeling
// a COUNT(*) [owner] although the owner is not an alternative in any row's
// label (CFC spec §8.17.4 violation).

const DUAL_PRINCIPAL_OWNER: RowLabelSpec = {
  version: 1,
  confidentiality: {
    principal: {
      protocol: "mailto",
      of: { match: { field: "from", source: ADDR.source, flags: "g" } },
    },
    dbOwner: true,
  } as never,
};

Deno.test("a dual-op confidentiality node in a wire spec is rejected (ambiguous, fail closed)", () => {
  // The probe from the report: {principal, dbOwner}.
  const reason = validateRowLabelSpec(DUAL_PRINCIPAL_OWNER, ["from"]);
  assert(typeof reason === "string", "a dual-op node must not validate");
  assert(reason.includes("ambiguous"), `unexpected reason: ${reason}`);

  // The other class: {constant, principal} (eval picks the principal, static
  // analysis used to count the constant).
  const constantPrincipal = {
    version: 1,
    confidentiality: {
      constant: "did:key:public",
      principal: {
        protocol: "mailto",
        of: { match: { field: "from", source: ADDR.source, flags: "g" } },
      },
    },
  } as unknown as RowLabelSpec;
  assert(
    typeof validateRowLabelSpec(constantPrincipal, ["from"]) === "string",
  );

  // The validateConfExpr entry point (top level / under all()): an allOf node
  // smuggling a sibling op key is just as ambiguous.
  const allOfConstant = {
    version: 1,
    confidentiality: { allOf: [{ dbOwner: true }], constant: "x" },
  } as unknown as RowLabelSpec;
  assert(typeof validateRowLabelSpec(allOfConstant, ["from"]) === "string");

  // The anyOf-alternative entry point: a when-gated alternative that ALSO
  // carries a principal key — the validator used to follow the when gate
  // while the evaluator dispatches on the principal.
  const whenPrincipalAlt = {
    version: 1,
    confidentiality: {
      anyOf: [{
        when: { match: { field: "from", source: ADDR.source, flags: "" } },
        then: { dbOwner: true },
        principal: {
          protocol: "mailto",
          of: { match: { field: "from", source: ADDR.source, flags: "g" } },
        },
      }],
    },
  } as unknown as RowLabelSpec;
  assert(typeof validateRowLabelSpec(whenPrincipalAlt, ["from"]) === "string");
});

Deno.test("a dual-op integrity node in a wire spec is rejected (ambiguous, fail closed)", () => {
  const authoredConstant = {
    version: 1,
    integrity: {
      authoredBy: {
        principal: {
          protocol: "mailto",
          of: { match: { field: "from", source: ADDR.source, flags: "g" } },
        },
      },
      constant: "x",
    },
  } as unknown as RowLabelSpec;
  assert(typeof validateRowLabelSpec(authoredConstant, ["from"]) === "string");

  const authoredEndorsed = {
    version: 1,
    integrity: {
      authoredBy: {
        principal: {
          protocol: "mailto",
          of: { match: { field: "from", source: ADDR.source, flags: "g" } },
        },
      },
      endorsedBy: {
        principal: {
          protocol: "mailto",
          of: { match: { field: "to", source: ADDR.source, flags: "g" } },
        },
      },
    },
  } as unknown as RowLabelSpec;
  assert(
    typeof validateRowLabelSpec(authoredEndorsed, ["from", "to"]) === "string",
  );

  const intersectAllOf = {
    version: 1,
    integrity: {
      intersect: [{ constant: "a" }],
      allOf: [{ constant: "b" }],
    },
  } as unknown as RowLabelSpec;
  assert(typeof validateRowLabelSpec(intersectAllOf, ["from"]) === "string");
});

Deno.test("ruleCommonAlternatives never counts a dual-op node's owner as a common reader", () => {
  // The exact unsoundness: eval labels each row with ONLY the extracted
  // principal, so the owner is not an alternative in ANY row's label — the
  // static analysis must not report it (an ambiguous node contributes no
  // static reader; the aggregate refuses).

  assertEquals(
    ruleCommonAlternatives(DUAL_PRINCIPAL_OWNER, { dbOwner: OWNER }),
    [],
  );
  // Same for a smuggled constant.
  const constantPrincipal = {
    version: 1,
    confidentiality: {
      constant: "did:key:public",
      principal: {
        protocol: "mailto",
        of: { match: { field: "from", source: ADDR.source, flags: "g" } },
      },
    },
  } as unknown as RowLabelSpec;
  assertEquals(
    ruleCommonAlternatives(constantPrincipal, { dbOwner: OWNER }),
    [],
  );
});

Deno.test("an ambiguous allOf wrapper is opaque to the static analysis (no unwrap past the guard)", () => {
  // {allOf: [...], constant: X} — flattenConfConjuncts must NOT dispatch on
  // the allOf key alone and unwrap it: that silently drops the smuggled
  // sibling op and hands the inner conjuncts to the static analysis, which
  // would report a guaranteed reader for a node the evaluator refuses.

  const ambiguousWrapper = {
    version: 1,
    confidentiality: { allOf: [{ dbOwner: true }], constant: "x" },
  } as unknown as RowLabelSpec;
  assertEquals(
    ruleCommonAlternatives(ambiguousWrapper, { dbOwner: OWNER }),
    [],
  );
  // ...and the wrapper still COUNTS as a confidentiality constraint: an
  // ambiguous {allOf: [], constant} must not read as the degenerate empty
  // conjunction (which would make the aggregate public).
  const emptyAllOfConstant = {
    version: 1,
    confidentiality: { allOf: [], constant: "x" },
  } as unknown as RowLabelSpec;
  assertEquals(ruleConstrainsConfidentiality(emptyAllOfConstant), true);
  assertEquals(
    ruleCommonAlternatives(emptyAllOfConstant, { dbOwner: OWNER }),
    [],
  );
});

Deno.test("evaluateRowLabel fails closed on a dual-op node that bypassed validation", () => {
  // Defense in depth (like the conjunctive-anyOf-alternative check): a wire
  // spec that skipped validation must refuse at eval, never silently pick one
  // op by precedence.

  expectError(
    DUAL_PRINCIPAL_OWNER,
    { from: "alice@a.example" },
    { dbOwner: OWNER },
    "ambiguous",
  );
  const authoredConstant = {
    version: 1,
    integrity: {
      authoredBy: {
        principal: {
          protocol: "mailto",
          of: { match: { field: "from", source: ADDR.source, flags: "g" } },
        },
      },
      constant: "x",
    },
  } as unknown as RowLabelSpec;
  expectError(
    authoredConstant,
    { from: "alice@a.example" },
    { dbOwner: OWNER },
    "ambiguous",
  );
});

Deno.test("a wire match without the global flag still evaluates (forced, no throw)", () => {
  const spec: RowLabelSpec = {
    version: 1,
    confidentiality: {
      allOf: [{
        principal: {
          protocol: "mailto",
          // flags deliberately non-global: a hostile/legacy wire form must not
          // crash matchAll — evaluation forces the global flag like match().
          of: {
            match: { field: "from", source: "[^\\s]+@[^\\s]+", flags: "" },
          },
        },
      }],
    },
  };
  const res = evaluateRowLabel(spec, { from: "a@b.example" }, {});
  if ("error" in res) throw new Error(res.error);
  assertEquals(res.confidentiality, ["did:mailto:a@b.example"]);
});
