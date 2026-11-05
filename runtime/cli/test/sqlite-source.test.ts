// Pure-helper unit tests for the Phase 7 `cf piece link ... sqlite:<absPath>`
// source parse + deterministic handle-id derivation.

import { assertEquals, assertThrows } from "@std/assert";
import {
  deriveDiskHandleId,
  diskHandleSeed,
  parseSqliteSource,
} from "../lib/sqlite-source.ts";

const SPACE = "did:key:z6MkSpaceA";
const SPACE_B = "did:key:z6MkSpaceB";

Deno.test("parseSqliteSource recognizes an absolute sqlite: source", () => {
  assertEquals(parseSqliteSource("sqlite:/abs/reference-data.db"), {
    path: "/abs/reference-data.db",
  });
});

Deno.test("parseSqliteSource returns null for a non-sqlite ref", () => {
  assertEquals(parseSqliteSource("bafypiece1/field"), null);
  assertEquals(parseSqliteSource("baedreiahv63wxwgaem"), null);
});

Deno.test("parseSqliteSource throws on a non-absolute path", () => {
  assertThrows(
    () => parseSqliteSource("sqlite:relative/path.db"),
    Error,
    "absolute",
  );
});

Deno.test("parseSqliteSource throws on an empty path", () => {
  assertThrows(() => parseSqliteSource("sqlite:"), Error, "missing a path");
});

Deno.test("deriveDiskHandleId is idempotent for the same (space, path)", () => {
  const a = deriveDiskHandleId(SPACE, "/data/ref.db");
  const b = deriveDiskHandleId(SPACE, "/data/ref.db");
  assertEquals(a, b);
  assertEquals(typeof a, "string");
});

Deno.test("deriveDiskHandleId differs by path", () => {
  const a = deriveDiskHandleId(SPACE, "/data/ref.db");
  const b = deriveDiskHandleId(SPACE, "/data/other.db");
  assertEquals(a === b, false);
});

Deno.test("deriveDiskHandleId differs by space", () => {
  const a = deriveDiskHandleId(SPACE, "/data/ref.db");
  const b = deriveDiskHandleId(SPACE_B, "/data/ref.db");
  assertEquals(a === b, false);
});

const ID = "fid1:handle";

Deno.test("diskHandleSeed seeds an empty contract on a first link", () => {
  assertEquals(diskHandleSeed(ID, undefined), { id: ID, tables: {}, rev: 0 });
});

Deno.test("diskHandleSeed leaves a declared contract alone on a re-link", () => {
  // The downgrade this guards: `tables[].ifc` carries the per-column read
  // labels, so re-seeding `{}` over a declared contract lowers every column's
  // label to nothing. A contract-less query still returns its rows, so nothing
  // reports the loss — same rows, no label, no error.
  const prior = {
    id: ID,
    tables: {
      records: {
        properties: { body: { ifc: { confidentiality: ["finance"] } } },
      },
    },
    rev: 7,
  };
  assertEquals(diskHandleSeed(ID, prior), undefined);
});

Deno.test("diskHandleSeed leaves the fixed handle properties alone too", () => {
  // `owner` resolves dbOwner() row admission, `scope` partitions the db, and
  // `rev` is what a handle hasher reads to decide a query has new inputs.
  const prior = {
    id: ID,
    tables: {},
    owner: "did:key:z6MkOwner",
    scope: "user",
    rev: 3,
  };
  assertEquals(diskHandleSeed(ID, prior), undefined);
});

Deno.test("diskHandleSeed leaves an already-committed empty contract alone", () => {
  // An empty-but-committed handle is still a committed handle: nothing about
  // it is weaker than a fresh seed, so leaving it alone is the same outcome
  // and keeps the rule one sentence long.
  assertEquals(diskHandleSeed(ID, { id: ID, tables: {}, rev: 0 }), undefined);
});

Deno.test("diskHandleSeed repairs a handle whose id is an empty string", () => {
  // `""` is a string, so a presence check on `id` reads this doc as committed.
  // It is not a handle any query can use — `readDbRef` needs an id that names
  // this source — so leaving it alone points the link at a handle that can
  // never resolve, and nothing would ever re-seed it.
  assertEquals(diskHandleSeed(ID, { id: "", tables: {}, rev: 0 }), {
    id: ID,
    tables: {},
    rev: 0,
  });
});

Deno.test("diskHandleSeed repairs an id that names a different source, carrying only the labels", () => {
  // A stored `id` that names another source means the value came from
  // somewhere else. `tables[].ifc` still travels: a store's effective label may
  // strengthen but never weaken, so carrying labels can only over-label, while
  // dropping them lowers every column's read label to nothing. The other
  // fields are NOT labels and carrying them is not the safe direction: `owner`
  // admits rows under whoever the foreign handle named, `scope` partitions the
  // db, and `rev` counts a source this handle never was. They start fresh.
  const declared = {
    records: {
      properties: { body: { ifc: { confidentiality: ["finance"] } } },
    },
  };
  assertEquals(
    diskHandleSeed(ID, {
      id: "fid1:another-source",
      tables: declared,
      owner: "did:key:z6MkOwner",
      scope: "user",
      rev: 7,
    }),
    { id: ID, tables: declared, rev: 0 },
  );
});

Deno.test("diskHandleSeed keeps every field of a handle that lost its id", () => {
  // No id at all names no other source: this is THIS path's handle with its
  // one derived field missing, so the repair rewrites that field and preserves
  // the rest — `owner`, `scope` and `rev` survive exactly as they do a re-link.
  const declared = {
    records: {
      properties: { body: { ifc: { confidentiality: ["finance"] } } },
    },
  };
  assertEquals(
    diskHandleSeed(ID, {
      tables: declared,
      owner: "did:key:z6MkOwner",
      scope: "user",
      rev: 7,
    } as never),
    {
      id: ID,
      tables: declared,
      owner: "did:key:z6MkOwner",
      scope: "user",
      rev: 7,
    },
  );
});

Deno.test("diskHandleSeed refuses a repair whose contract it cannot copy", () => {
  // The contract must be written inline, so the repair copies it. A copy that
  // fails is not an empty contract: writing `{}` in its place would lower every
  // column's read label to nothing, silently — the downgrade the whole
  // function exists to prevent. Refusing leaves the handle for a person.
  const uncopyable = { records: { properties: { n: { bad: 1n } } } };
  assertThrows(
    () => diskHandleSeed(ID, { id: "", tables: uncopyable as never }),
    Error,
    "cannot be copied",
  );
});

Deno.test("diskHandleSeed drops a malformed contract when it repairs", () => {
  // Only a well-formed contract is worth carrying: a `tables` that is not an
  // object declares no column labels, so keeping it would preserve nothing and
  // write back a value no query-side load can read.
  assertEquals(
    diskHandleSeed(ID, { id: "", tables: "not-a-contract" as never }),
    { id: ID, tables: {}, rev: 0 },
  );
});
