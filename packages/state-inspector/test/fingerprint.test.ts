// The fingerprint's contract is one sentence: a legitimate pattern update must
// not move it, and a content change must. Everything here pins one half of that.
//
// The load-bearing case is `generated cells are excluded`: compiler-generated
// internal cells rotate their identities on every pattern update by design
// (labs#4916), so a fingerprint that counted them would change on every clean
// migration and answer no question at all. Verified against the real Estuary
// Topics store, where all 20 write-storm cells are `$generated` and none is
// authored content.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace, type SpaceDb } from "../db.ts";
import { listEntityModels } from "../model.ts";
import {
  contentFingerprint,
  diffFingerprints,
  entityAddressKey,
  generatedInternalCellIds,
  hashEntityValue,
} from "../fingerprint.ts";

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
`;

const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";
const SESSION = "session:did:key:zSpaceAAAA:11111111-2222-3333";

const link = (id: string) => ({ "/": { "link@1": { id, path: [] } } });

interface Doc {
  id: string;
  doc: Record<string, unknown>;
  scope?: string;
}

/**
 * A space holding one piece whose manifest names `of:named` as authored
 * (`partialCause: "entries"`) and `of:generated` as compiler-generated
 * (`partialCause: { $generated: 0 }`) — the exact shape observed in a real
 * store — plus whatever extra docs a case needs.
 */
function seed(path: string, extra: Doc[] = []): void {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, ?, 0, 'set', ?, ?)`,
  );
  let seq = 0;
  const write = (id: string, doc: unknown, scope = "space") => {
    const s = ++seq;
    commit.run(s, SESSION, s);
    rev.run(id, scope, s, JSON.stringify(doc), s);
  };

  write("of:piece", {
    value: { $NAME: "Board" },
    argument: link("of:input"),
    internal: [
      { partialCause: "entries", link: link("of:named") },
      { partialCause: { $generated: 0 }, link: link("of:generated") },
    ],
    patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
    schema: { type: "object", properties: {}, $defs: {} },
  });
  write("of:input", { value: { title: "untitled" } });
  write("of:named", { value: "named-v1", result: link("of:piece") });
  write("of:generated", { value: "generated-v1", result: link("of:piece") });

  for (const e of extra) write(e.id, e.doc, e.scope ?? "space");
  db.close();
}

function withSpace(extra: Doc[], run: (s: SpaceDb) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "fingerprint-test-" });
  try {
    const path = `${dir}/space.sqlite`;
    seed(path, extra);
    const space = openSpace(path);
    try {
      run(space);
    } finally {
      space.close();
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/** The fingerprint of the base space, plus one extra/overriding document. */
function hashWith(extra: Doc[]): string {
  let hash = "";
  withSpace(extra, (s) => {
    hash = contentFingerprint(s).hash;
  });
  return hash;
}

Deno.test("the manifest classifies generated vs authored internal cells", () => {
  withSpace([], (space) => {
    const { generated, named } = generatedInternalCellIds(space);
    assert(generated.has("of:generated"));
    assert(named.has("of:named"));
    assert(!generated.has("of:named"));
  });
});

Deno.test("a generated cell's value does not move the fingerprint", () => {
  // THE contract. A pattern update rewrites generated cells by design; if that
  // moved the fingerprint, every clean migration would look like data loss.
  const base = hashWith([]);
  const generatedChanged = hashWith([
    {
      id: "of:generated",
      doc: { value: "generated-v2", result: link("of:piece") },
    },
  ]);
  assertEquals(generatedChanged, base);
});

Deno.test("an authored cell's value does move the fingerprint", () => {
  // The other half: excluding generated cells must not blind the check to real
  // content. A named internal cell is intentional durable state.
  const base = hashWith([]);
  const namedChanged = hashWith([
    { id: "of:named", doc: { value: "named-v2", result: link("of:piece") } },
  ]);
  assert(namedChanged !== base, "a named cell change must be visible");

  const inputChanged = hashWith([
    { id: "of:input", doc: { value: { title: "renamed" } } },
  ]);
  assert(inputChanged !== base, "an input cell change must be visible");
});

Deno.test("includeGenerated makes generated churn visible on purpose", () => {
  withSpace([], (a) => {
    const strict = contentFingerprint(a);
    const loose = contentFingerprint(a, { includeGenerated: true });
    assert(loose.hash !== strict.hash);
    assertEquals(strict.excludedGenerated, 1);
    assertEquals(loose.excludedGenerated, 0);
    assertEquals(loose.entities, strict.entities + 1);
  });
});

Deno.test("per-user and per-session state is covered, not silently skipped", () => {
  // listEntityModels defaults to scope "space"; on the real Estuary store that
  // omits 579 entities. A fingerprint that ignored them would call a migration
  // clean while PerUser state was destroyed.
  const base = hashWith([
    {
      id: "of:peruser",
      doc: { value: "u1" },
      scope: "user:did%3Akey%3AzAlice",
    },
  ]);
  const changed = hashWith([
    {
      id: "of:peruser",
      doc: { value: "u2" },
      scope: "user:did%3Akey%3AzAlice",
    },
  ]);
  assert(changed !== base, "a per-user value change must move the fingerprint");
});

Deno.test("the same id in two scopes is fingerprinted separately", () => {
  withSpace([
    { id: "of:shared", doc: { value: "space-value" } },
    {
      id: "of:shared",
      doc: { value: "alice-value" },
      scope: "user:did%3Akey%3AzAlice",
    },
  ], (space) => {
    const fp = contentFingerprint(space);
    const rows = fp.perEntity.filter((e) => e.id === "of:shared");
    assertEquals(rows.length, 2);
    assert(rows[0].hash !== rows[1].hash, "distinct scopes, distinct content");
  });
});

Deno.test("an entity address key never aliases a different address", () => {
  // The key decides which entity is which: `diffFingerprints` pairs rows by it,
  // and `verifyClone` subtracts generated exclusions by it — where an alias
  // clears a removal that really happened rather than merely misattributing a
  // count. Nothing the runtime mints carries a separator byte (ids are
  // `of:fid1:<base64url>` or DIDs; scope keys percent-encode their segments,
  // and the admission predicate refuses one that does not), so this pins the
  // key itself rather than a store shape: the tool reads stores it did not
  // write, where both columns are opaque TEXT.
  assert(
    entityAddressKey({ id: "of:a", scope: "b c" }) !==
      entityAddressKey({ id: "of:a b", scope: "c" }),
    "a printable separator would run these two addresses together",
  );
  assertEquals(
    entityAddressKey({ id: "of:a", scope: "space" }),
    entityAddressKey({ id: "of:a", scope: "space" }),
    "and one address always keys the same",
  );
});

Deno.test("the fingerprint is deterministic and order-independent", () => {
  withSpace([{ id: "of:z", doc: { value: 1 } }, {
    id: "of:a",
    doc: { value: 2 },
  }], (s) => {
    assertEquals(contentFingerprint(s).hash, contentFingerprint(s).hash);
    const fp = contentFingerprint(s);
    const ids = fp.perEntity.map((e) => `${e.id} ${e.scope}`);
    assertEquals([...ids].sort(), ids, "per-entity rows are sorted");
  });
});

Deno.test("diff names what moved, not merely that something did", () => {
  // The point of per-entity hashes: a rehearsal needs "these two cells changed",
  // not "the number differs".
  let before = null as ReturnType<typeof contentFingerprint> | null;
  let after = null as ReturnType<typeof contentFingerprint> | null;
  withSpace([], (s) => before = contentFingerprint(s));
  withSpace([
    { id: "of:named", doc: { value: "named-v2", result: link("of:piece") } },
    { id: "of:newcomer", doc: { value: "hello" } },
  ], (s) => after = contentFingerprint(s));

  const d = diffFingerprints(before!, after!);
  assert(!d.equal);
  // Addresses, not bare ids: an id is not unique across scopes, so the diff
  // reports the (id, scope) pair it actually compared by.
  assertEquals(d.changed, [{ id: "of:named", scope: "space" }]);
  assertEquals(d.added, [{ id: "of:newcomer", scope: "space" }]);
  assertEquals(d.removed, []);

  assert(
    diffFingerprints(before!, before!).equal,
    "a diff with itself is equal",
  );

  // The reverse direction names the disappearance. A migration that DROPS an
  // entity is the failure this must catch, and it reads as `removed`, never as
  // a bare "the fingerprints differ".
  const reverse = diffFingerprints(after!, before!);
  assertEquals(reverse.removed, [{ id: "of:newcomer", scope: "space" }]);
  assertEquals(reverse.changed, [{ id: "of:named", scope: "space" }]);
  assertEquals(reverse.added, []);
});

Deno.test("a value the canonical hasher rejects is reported, not skipped", () => {
  // Nothing stored decodes to one of these today, but `decodeStored` spans
  // several at-rest formats. Silently treating a rejected value as empty would
  // let real content drift read as "unchanged" — the one lie this must not tell.
  const ok = hashEntityValue({ title: "a topic" });
  assert("hash" in ok);

  const rejected = hashEntityValue(new Map([["a", 1]]));
  assert("error" in rejected, "an unsupported object type must be reported");
  assert(rejected.error.length > 0, "and must carry a reason");
});

Deno.test("one unhashable entity is reported without aborting the space", () => {
  // A ~5,000-deep value stores and parses fine but overflows the canonical
  // hasher's recursion. The whole-space fingerprint must survive it: report the
  // entity as unhashable, keep hashing the rest. Aborting would leave a
  // rehearsal with no verification at all; silently skipping would let that
  // entity's content drift read as "unchanged".
  let deep: unknown = null;
  for (let i = 0; i < 5000; i++) deep = { a: deep };

  withSpace([{ id: "of:pathological", doc: { value: deep } }], (space) => {
    const fp = contentFingerprint(space);
    assertEquals(fp.unhashable.length, 1);
    assertEquals(fp.unhashable[0].id, "of:pathological");
    assert(fp.unhashable[0].reason.length > 0, "carries a reason");
    // The rest of the space still produced a fingerprint.
    assert(fp.entities >= 3);
    assert(fp.perEntity.every((e) => e.id !== "of:pathological"));
  });
});

Deno.test("a possibly truncated enumeration is refused, not fingerprinted", () => {
  // A hash over part of a space is worse than no hash: it looks authoritative.
  withSpace([], (space) => {
    assertThrows(
      () => contentFingerprint(space, { enumerationCap: 1 }),
      Error,
      "truncated enumeration",
    );
  });
});

Deno.test("a scope holding exactly the cap is complete, and is fingerprinted", () => {
  // The refusal boundary is EXCLUSIVE, which `FingerprintOptions.enumerationCap`
  // states and nothing pinned: a scope of exactly `cap` entities was enumerated
  // whole, so refusing it would withhold a hash over a complete reading. One
  // below the count refuses; at it and above, the same hash comes back.
  withSpace([], (space) => {
    // The cap is compared against what the scan ENUMERATES, which is not
    // `report.entities` — that is the post-exclusion count, smaller by the
    // generated internal cells the fingerprint drops. Take the number the
    // refusal actually reads.
    const enumerated = listEntityModels(space).extent.total;
    assert(enumerated > 1, "the fixture must hold enough to have a boundary");

    assertThrows(
      () => contentFingerprint(space, { enumerationCap: enumerated - 1 }),
      Error,
      "truncated enumeration",
    );

    const atCap = contentFingerprint(space, { enumerationCap: enumerated });
    assertEquals(atCap.hash, contentFingerprint(space).hash);
    assertEquals(atCap.entities, contentFingerprint(space).entities);
  });
});

Deno.test("malformed internal manifests are skipped, not fatal", () => {
  // A piece whose manifest is the wrong shape must not abort a whole-space
  // fingerprint; its cells simply go unclassified (and so are fingerprinted).
  withSpace([
    {
      id: "of:bad-manifest",
      doc: {
        value: {},
        internal: "not-an-array",
        patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
        schema: {},
        argument: link("of:input"),
      },
    },
    {
      id: "of:odd-entries",
      doc: {
        value: {},
        internal: [
          "not-an-object",
          { partialCause: "x" },
          { partialCause: "x", link: "not-an-object" },
          { partialCause: "x", link: {} },
          { partialCause: "x", link: { "/": {} } },
          { partialCause: "x", link: { "/": { "link@1": { id: 42 } } } },
        ],
        patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
        schema: {},
        argument: link("of:input"),
      },
    },
  ], (space) => {
    const { generated, named } = generatedInternalCellIds(space);
    // Only the well-formed fixture piece contributed classifications.
    assert(generated.has("of:generated"));
    assert(named.has("of:named"));
    const fp = contentFingerprint(space);
    assertEquals(fp.unhashable, []);
    assert(fp.entities > 0);
  });
});

Deno.test("an entity with no value is recorded, not dropped", () => {
  withSpace(
    [{ id: "of:novalue", doc: { result: link("of:piece") } }],
    (space) => {
      const fp = contentFingerprint(space);
      const row = fp.perEntity.find((e) => e.id === "of:novalue");
      assert(row !== undefined, "present in the report");
      assertEquals(row.hash, null);
      assertEquals(fp.unhashable, []);
    },
  );
});

/** Seeds the base space and adds `count` documents in one transaction. */
function seedBulk(path: string, count: number): void {
  seed(path);
  const db = new Database(path);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES (?, 'space', ?, 0, 'set', ?, ?)`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    const seq = 100 + i;
    commit.run(seq, SESSION, seq);
    rev.run(`of:bulk${i}`, seq, JSON.stringify({ value: i }), seq);
  }
  db.exec("COMMIT");
  db.close();
}

Deno.test("enumerates a store past the spread-argument ceiling", () => {
  // `200_000` entities exceed V8's default spread-argument limit while staying
  // below `ENUMERATION_CAP`. The margin accommodates variations in stack size.

  const dir = Deno.makeTempDirSync({ prefix: "fingerprint-bulk-" });
  try {
    const path = `${dir}/space.sqlite`;
    seedBulk(path, 200_000);
    const space = openSpace(path);
    try {
      // `.extent.total` includes rows beyond the listing's display cap.
      assertEquals(listEntityModels(space).extent.total, 200_004);

      // This exercises `allEntities()` without hashing every document.
      const { generated, named } = generatedInternalCellIds(space);
      assertEquals([...generated], ["of:generated"]);
      assertEquals([...named], ["of:named"]);
    } finally {
      space.close();
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
