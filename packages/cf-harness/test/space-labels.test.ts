import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import type { FabricValue } from "@commonfabric/data-model";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";

import type { LinkWalkBounds } from "@commonfabric/state-inspector";

import {
  cellAddressOfRef,
  type LinkGraphBounds,
  openSpaceLabelReader,
  readSpaceCellLabels,
  type SpaceLabelReader,
} from "../src/space-labels.ts";
import { HARNESS_CELL_LABELS_TYPE } from "../src/contracts/cell-labels.ts";

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
INSERT INTO branch (name, head_seq, status) VALUES ('', 5, 'active');
`;

const TRANSFORMED_BY = "https://commonfabric.org/cfc/atom/TransformedBy";
const RESOURCE = "https://commonfabric.org/cfc/atom/Resource";
const SCHEMA_HASH = "fid1:C4ajDsLKcfdMDDs3lbNShZBcQCVA4qhVo5mRoBcgpB0";

/** An entity id in the store's own shape: `of:fid1:` and 44 base64url chars. */
const entity = (name: string) => `of:fid1:${name.padEnd(44, "0")}`;

const DECLARED = entity("declared");
const DERIVED = entity("derived");
const UNLABELLED = entity("unlabelled");
const DISJUNCTIVE = entity("disjunctive");
const COMMITTED = entity("committed");
const NEVER_WRITTEN = entity("neverWritten");

/**
 * The space the DID-named database holds. The store names its file after its
 * space, so a file named for {@link OWN_DID} is the only proof this reader has
 * of which space its ids belong to.
 */
const OWN_DID = "did:key:z6MkfrQ3tCDZgvJcLwPTvxNsFR8RgTsHTa5JzmnW9pQrUvNq";

/** A space this host never opened, for the cross-space cases below. */
const FOREIGN_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/**
 * An id the seeded space holds a label for, standing for the id collision a
 * cross-space reference invites: the same id in another space is another cell
 * entirely, and reading it here would answer with this one's label.
 */
const COLLIDING = entity("colliding");

/** A document whose links reach the colliding id in three spaces. */
const LINKER = entity("linker");

/**
 * A document holding no link at its top level: one sits inside an object, one
 * beside it reaches another space, and a third sits inside an array. Each is
 * one hop from this document however deep in its value it sits, so each is
 * either followed or recorded unread at the whole path it sits at.
 */
const NESTER = entity("nester");

/**
 * A document holding one link at its surface and one below it. A reader that
 * descends one level reaches the first and stops short of the second; a
 * reader with two nodes to spend stops before it has looked at either the
 * second link or the container holding it.
 */
const DEEPER = entity("deeper");

/**
 * A chain of three documents, each linking to the next at `next`. The cell a
 * run holds a reference to is the piece, and a pattern's results hang off it
 * with results of their own below them, so the label a reader is after sits
 * at the end of a chain like this one rather than one link from the piece.
 */
const CHAIN_TOP = entity("chainTop");
const CHAIN_MID = entity("chainMid");
const CHAIN_END = entity("chainEnd");

/**
 * Two documents that link to each other at `peer`. Following links until
 * there are none left never terminates on these, so what stops the walk is
 * recognizing the loop rather than running out of a budget.
 */
const LOOP_ONE = entity("loopOne");
const LOOP_TWO = entity("loopTwo");

/**
 * A document reaching {@link CHAIN_END} twice and at two distances: directly
 * at `right`, and at `left` through the cell above it in the chain. The label
 * sits at both paths, so a reader that recorded it at one of them would leave
 * the other reading as a path the space labels nothing at.
 */
const DIAMOND = entity("diamond");

/**
 * A document linking at `gone` to {@link NEVER_WRITTEN}, which the store holds
 * nothing for. The link addresses a cell; the store cannot speak for it.
 */
const DANGLING = entity("dangling");

/**
 * A document labelled at two of its paths, `account` and `other`, holding a
 * link at `other`, and one that links into it at `account` alone. A
 * pattern's result names the input value it was computed from by the path
 * inside the input cell that holds it, so the label a reader is after covers
 * exactly what the link addresses — and what sits elsewhere in the document,
 * label and link alike, is not reached through it.
 */
const ACCOUNTS = entity("accounts");
const SLOTTED = entity("slotted");

/** A document linking at `via` to {@link LINKER}, whose own links go unread. */
const VIA = entity("via");

/**
 * A version-2 envelope whose one entry holds its label by reference to
 * {@link LABEL_DOCUMENT}, a content-addressed label document the store holds.
 */
const REFERENCED = entity("referenced");
const LABEL_DOCUMENT = `cid:fid1:${"label".padEnd(43, "0")}`;

/**
 * A version-2 envelope referencing a label document the store holds nothing
 * for, so the entry's label cannot be read.
 */
const REFERENCED_MISSING = entity("referenced-missing");
const MISSING_LABEL_DOCUMENT = `cid:fid1:${"missing".padEnd(43, "0")}`;

/**
 * A version-2 envelope whose reference names an ordinary entity rather than
 * a `cid:` document, which no label document can be read from.
 */
const REFERENCED_ENTITY = entity("referenced-entity");

/** A document linking at `via` to {@link REFERENCED_MISSING}. */
const VIA_MISSING = entity("via-missing");

/** One stored link, in the at-rest sigil form the store holds. */
const link = (id: string, space?: string, path: string[] = []) => ({
  "/": {
    "link@1": { id, path, ...(space === undefined ? {} : { space }) },
  },
});

/** One `labelMap` entry, in the shape the space stores it. */
const stored = (
  path: string[],
  label: Record<string, unknown>,
  origin: string,
  observes?: string,
) => ({
  path,
  label,
  origin,
  ...(observes === undefined ? {} : { observes }),
});

const documents: Record<string, unknown> = {
  [LABEL_DOCUMENT]: {
    value: { confidentiality: ["shared-secret"] },
  },
  [REFERENCED]: {
    value: { secret: "held by reference" },
    cfc: {
      version: 2,
      schemaHash: SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [
          stored(["secret"], { $ref: LABEL_DOCUMENT }, "declared"),
          // An entry that is not a record is skipped rather than read.
          "bogus",
        ],
      },
    },
  },
  [REFERENCED_MISSING]: {
    value: { secret: "held by a reference nothing backs" },
    cfc: {
      version: 2,
      schemaHash: SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [
          stored(["secret"], { $ref: MISSING_LABEL_DOCUMENT }, "declared"),
        ],
      },
    },
  },
  [VIA_MISSING]: {
    value: { via: link(REFERENCED_MISSING) },
  },
  [REFERENCED_ENTITY]: {
    value: { secret: "held by a reference to an entity" },
    cfc: {
      version: 2,
      schemaHash: SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [stored(["secret"], { $ref: DECLARED }, "declared")],
      },
    },
  },
  [DECLARED]: {
    value: { secret: "the combination is 1234" },
    cfc: {
      version: 1,
      schemaHash: SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [
          stored([], {
            confidentiality: ["demo-secret"],
            integrity: ["cf-compiled-by:cf-compiler"],
          }, "declared"),
        ],
      },
    },
  },
  [DERIVED]: {
    value: { summary: "a redaction of the above" },
    cfc: {
      version: 1,
      schemaHash: SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [
          stored(
            ["summary"],
            {
              confidentiality: ["demo-secret"],
              integrity: [
                "cf-compiled-by:cf-compiler",
                {
                  type: TRANSFORMED_BY,
                  codeHash: "cf:module/abc",
                  operation: "__cfLift_2",
                  inputs: [],
                },
              ],
            },
            "derived",
            "members",
          ),
        ],
      },
    },
  },
  // Stored as plain JSON rather than through the codec: a durable file holds
  // both at-rest forms, and a reader that only decoded the tagged one would
  // report every legacy row as an entity with no document.
  [UNLABELLED]: { value: { title: "nothing is labelled here" } },
  [DISJUNCTIVE]: {
    value: { note: "reachable two ways" },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored([], {
            confidentiality: [
              { anyOf: [{ type: RESOURCE, class: "A", subject: "s" }, "b"] },
            ],
            integrity: [],
          }, "declared"),
        ],
      },
    },
  },
  [COLLIDING]: {
    value: { secret: "local, and labelled" },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored([], {
            confidentiality: ["foreign-secret"],
            integrity: [],
          }, "declared"),
        ],
      },
    },
  },
  [LINKER]: {
    value: {
      mine: link(COLLIDING),
      ours: link(COLLIDING, OWN_DID),
      theirs: link(COLLIDING, FOREIGN_DID),
    },
  },
  [NESTER]: {
    value: {
      nested: {
        mine: link(COLLIDING),
        theirs: link(COLLIDING, FOREIGN_DID),
      },
      list: [{ ours: link(COLLIDING, OWN_DID) }],
      plain: "no link here",
    },
  },
  [DEEPER]: {
    value: {
      shallow: link(COLLIDING),
      deep: { down: link(COLLIDING) },
    },
  },
  [CHAIN_TOP]: { value: { next: link(CHAIN_MID) } },
  [CHAIN_MID]: {
    value: { next: link(CHAIN_END) },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored(
            [],
            { confidentiality: ["mid-secret"], integrity: [] },
            "link",
          ),
        ],
      },
    },
  },
  [CHAIN_END]: {
    value: { leaf: "the end of the chain" },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored([], {
            confidentiality: ["end-secret"],
            integrity: [],
          }, "derived"),
        ],
      },
    },
  },
  [LOOP_ONE]: {
    value: { peer: link(LOOP_TWO) },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored(
            [],
            { confidentiality: ["one-secret"], integrity: [] },
            "link",
          ),
        ],
      },
    },
  },
  [LOOP_TWO]: {
    value: { peer: link(LOOP_ONE) },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored(
            [],
            { confidentiality: ["two-secret"], integrity: [] },
            "link",
          ),
        ],
      },
    },
  },
  [DIAMOND]: { value: { left: link(CHAIN_MID), right: link(CHAIN_END) } },
  [DANGLING]: { value: { gone: link(NEVER_WRITTEN) } },
  [ACCOUNTS]: {
    value: { account: { balance: 1 }, other: link(CHAIN_END) },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored(["account"], {
            confidentiality: ["account-secret"],
            integrity: [],
          }, "declared"),
          stored(["other"], {
            confidentiality: ["other-secret"],
            integrity: [],
          }, "declared"),
        ],
      },
    },
  },
  [SLOTTED]: {
    value: {
      slot: link(ACCOUNTS, undefined, ["account"]),
      leaf: link(CHAIN_END, undefined, ["leaf"]),
    },
  },
  [VIA]: { value: { via: link(LINKER) } },
  [COMMITTED]: {
    value: { attachment: "…" },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored([], {
            confidentiality: [
              {
                type: RESOURCE,
                class: "attachment",
                subject: { digestOf: SCHEMA_HASH },
              },
            ],
            integrity: [],
          }, "declared"),
        ],
      },
    },
  },
};

/**
 * Bounds narrower than the ones a run records under, stopping at a place
 * {@link DEEPER} reaches: {@link SHALLOW} descends one level, so the link
 * below that is a path it refuses.
 */
const SHALLOW: LinkWalkBounds = {
  maxDepth: 1,
  maxNodes: Number.POSITIVE_INFINITY,
};

/**
 * The other such bound: two values to spend, so it runs out with the rest of
 * the document unenumerated.
 */
const SPENT: LinkWalkBounds = { maxDepth: 64, maxNodes: 2 };

/** The documents written as plain JSON rather than through the codec. */
const PLAIN = new Set([
  LABEL_DOCUMENT,
  REFERENCED,
  REFERENCED_MISSING,
  REFERENCED_ENTITY,
  VIA_MISSING,
  UNLABELLED,
  LINKER,
  NESTER,
  DEEPER,
  CHAIN_TOP,
  CHAIN_MID,
  LOOP_ONE,
  LOOP_TWO,
  DIAMOND,
  DANGLING,
  ACCOUNTS,
  SLOTTED,
  VIA,
]);

/**
 * A stored `revision.data` payload. Most documents go in through the codec,
 * which tags their envelope (`fvj1:…`) the way the server writes one; the
 * {@link PLAIN} ones go in as plain JSON, which the store also holds — one to
 * show that a legacy row still reads, and one to keep its links in the sigil
 * form a reader meets them in.
 */
const payload = (id: string, document: unknown): string =>
  PLAIN.has(id)
    ? JSON.stringify(document)
    : jsonFromFabricValue(document as FabricValue);

const seed = (path: string) => {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did:key:zX:u', ?, '{}', '{}')`,
  );
  const revision = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  let seq = 0;
  for (const [id, document] of Object.entries(documents)) {
    seq += 1;
    commit.run(seq, seq);
    revision.run(id, seq, payload(id, document), seq);
  }
  db.close();
};

describe("space-labels", () => {
  let directory: string;
  let dbPath: string;
  let didDbPath: string;
  let reader: SpaceLabelReader;
  let didReader: SpaceLabelReader;

  beforeAll(async () => {
    directory = await Deno.makeTempDir({ prefix: "cf-harness-space-labels-" });
    dbPath = `${directory}/space.sqlite`;
    seed(dbPath);
    reader = await openSpaceLabelReader("demo-space", { dbPath });
    // The same store under the name the server gives one, so the reader can
    // prove which space its ids belong to. Every space-naming reference is
    // answerable only against this one.
    didDbPath = `${directory}/${OWN_DID}.sqlite`;
    seed(didDbPath);
    didReader = await openSpaceLabelReader("demo-space", {
      dbPath: didDbPath,
    });
  });

  afterAll(async () => {
    reader.close();
    didReader.close();
    await Deno.remove(directory, { recursive: true });
  });

  /** Reads the DID-named store under bounds narrower than a run's own. */
  const withBoundedReader = async (
    linkWalk: LinkWalkBounds,
    body: (bounded: SpaceLabelReader) => void,
  ): Promise<void> => {
    const bounded = await openSpaceLabelReader("demo-space", {
      dbPath: didDbPath,
      linkWalk,
    });
    try {
      body(bounded);
    } finally {
      bounded.close();
    }
  };

  const withGraphBoundedReader = async (
    linkGraph: LinkGraphBounds,
    body: (bounded: SpaceLabelReader) => void,
  ): Promise<void> => {
    const bounded = await openSpaceLabelReader("demo-space", {
      dbPath: didDbPath,
      linkGraph,
    });
    try {
      body(bounded);
    } finally {
      bounded.close();
    }
  };

  /** What `body` warned, alongside what it returned. */
  const collectWarningsOf = async <T>(
    body: () => Promise<T>,
  ): Promise<[T, string[]]> => {
    const warned: string[] = [];
    const printed = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      return [await body(), warned];
    } finally {
      console.warn = printed;
    }
  };

  const collectWarnings = async (
    body: () => Promise<unknown>,
  ): Promise<string[]> => (await collectWarningsOf(body))[1];

  describe("cellAddressOfRef()", () => {
    it("returns the entity at the space scope for a bare `of:` id", () => {
      expect(cellAddressOfRef(DECLARED)).toEqual({
        id: DECLARED,
        scope: "space",
      });
    });

    it("returns the document for a link naming a path inside it", () => {
      expect(cellAddressOfRef(`/${DECLARED}/value/secret`)).toEqual({
        id: DECLARED,
        scope: "space",
      });
    });

    it("returns the entity and the space a cross-space link names", () => {
      expect(cellAddressOfRef(`/@${FOREIGN_DID}/${DECLARED}/title`)).toEqual({
        id: DECLARED,
        space: FOREIGN_DID,
        scope: "space",
      });
    });

    it("returns the scope of a scoped id, which a label map is stored at", () => {
      expect(cellAddressOfRef(`/${DECLARED}@user`)).toEqual({
        id: DECLARED,
        scope: "user",
      });
    });

    it("returns `undefined` for a string that is not a link", () => {
      expect(cellAddressOfRef("my notebook")).toBe(undefined);
    });
  });

  describe("openSpaceLabelReader()", () => {
    it("returns the atoms, origin and schema hash of a declared label", () => {
      const read = reader.read({ id: DECLARED, scope: "space" });
      expect(read.schemaHash).toBe(SCHEMA_HASH);
      expect(read.entries).toEqual([{
        path: [],
        confidentiality: [{ type: "demo-secret", name: "demo-secret" }],
        integrity: [{
          type: "cf-compiled-by:cf-compiler",
          name: "cf-compiled-by:cf-compiler",
        }],
        origin: "declared",
      }]);
    });

    it("lifts a `TransformedBy` atom out of `integrity` and leaves it there", () => {
      const [entry] = reader.read({ id: DERIVED, scope: "space" }).entries;
      const provenance = {
        type: TRANSFORMED_BY,
        name: "TransformedBy",
        fields: {
          codeHash: "cf:module/abc",
          operation: "__cfLift_2",
          inputs: [],
        },
      };
      expect(entry.path).toEqual(["summary"]);
      expect(entry.origin).toBe("derived");
      expect(entry.observes).toBe("members");
      expect(entry.transformedBy).toEqual(provenance);
      expect(entry.integrity).toEqual([
        {
          type: "cf-compiled-by:cf-compiler",
          name: "cf-compiled-by:cf-compiler",
        },
        provenance,
      ]);
    });

    it("reads a label held by reference out of its label document", () => {
      const read = reader.read({ id: REFERENCED, scope: "space" });
      expect(read.entries).toEqual([{
        path: ["secret"],
        confidentiality: [{ type: "shared-secret", name: "shared-secret" }],
        integrity: [],
        origin: "declared",
      }]);
      expect(read.unreadPaths).toBeUndefined();
    });

    it("records a label whose document the store lacks as an unread path", () => {
      const read = reader.read({ id: REFERENCED_MISSING, scope: "space" });
      expect(read.entries).toEqual([]);
      expect(read.unreadPaths).toEqual([
        { path: ["secret"], reason: "no-document" },
      ]);
    });

    it("carries an unread label through the link that reaches it", () => {
      const read = reader.read({ id: VIA_MISSING, scope: "space" });
      expect(read.entries).toEqual([]);
      expect(read.unreadPaths).toEqual([
        { path: ["via", "secret"], reason: "no-document" },
      ]);
    });

    it("does not follow a reference outside the cid: namespace", () => {
      const read = reader.read({ id: REFERENCED_ENTITY, scope: "space" });
      expect(read.entries).toEqual([]);
      expect(read.unreadPaths).toEqual([
        { path: ["secret"], reason: "no-document" },
      ]);
    });

    it("returns an empty entry list for a document with no `cfc` path", () => {
      const read = reader.read({ id: UNLABELLED, scope: "space" });
      expect(read.entries).toEqual([]);
      expect(read.schemaHash).toBe(undefined);
    });

    it("returns an entity the store holds no document for as unread", () => {
      expect(reader.read({ id: NEVER_WRITTEN, scope: "space" })).toEqual({
        entries: [],
        linked: [],
        unread: "no-document",
      });
    });

    it("returns the path of a link to an entity the store holds no document for as unread", () => {
      const read = didReader.read({ id: DANGLING, scope: "space" });
      expect(read.unreadPaths).toEqual([
        { path: ["gone"], reason: "no-document" },
      ]);
      expect(read.unread).toBe(undefined);
    });

    it("returns a disjunctive confidentiality clause as one atom carrying its alternatives", () => {
      const [entry] = reader.read({ id: DISJUNCTIVE, scope: "space" }).entries;
      expect(entry.confidentiality).toEqual([{
        type: "anyOf",
        name: "Resource or b",
        anyOf: [
          {
            type: RESOURCE,
            name: "Resource",
            fields: { class: "A", subject: "s" },
          },
          { type: "b", name: "b" },
        ],
      }]);
    });

    it("keeps an object atom's non-`type` fields, including a committed one", () => {
      const [entry] = reader.read({ id: COMMITTED, scope: "space" }).entries;
      expect(entry.confidentiality).toEqual([{
        type: RESOURCE,
        name: "Resource",
        fields: {
          class: "attachment",
          subject: { digestOf: SCHEMA_HASH },
        },
      }]);
    });

    it("returns the space DID the opened file is named for", () => {
      expect(didReader.did).toBe(OWN_DID);
    });

    it("returns no space DID for an opened file whose name is not one", () => {
      expect(reader.did).toBe(undefined);
    });

    it("returns the labels of an address naming the space that was opened", () => {
      const read = didReader.read({
        id: COLLIDING,
        space: OWN_DID,
        scope: "space",
      });
      expect(read.unread).toBe(undefined);
      expect(read.entries.map((entry) => entry.confidentiality)).toEqual([
        [{ type: "foreign-secret", name: "foreign-secret" }],
      ]);
    });

    it("returns no labels and `cross-space` for an address in another space holding an id this space also holds", () => {
      const read = didReader.read({
        id: COLLIDING,
        space: FOREIGN_DID,
        scope: "space",
      });
      expect(read.unread).toBe("cross-space");
      expect(read.entries).toEqual([]);
    });

    it("returns no labels and `space-unproven` for an address naming any space when the opened file proves none", () => {
      const read = reader.read({
        id: COLLIDING,
        space: OWN_DID,
        scope: "space",
      });
      expect(read.unread).toBe("space-unproven");
      expect(read.entries).toEqual([]);
    });

    it("returns the labels of the linked cells naming no space and naming the opened one", () => {
      const read = didReader.read({ id: LINKER, scope: "space" });
      expect(read.linked).toEqual([
        { path: ["mine"], id: COLLIDING, into: [] },
        { path: ["ours"], id: COLLIDING, into: [] },
      ]);
      expect(read.entries).toEqual([
        {
          path: ["mine"],
          confidentiality: [{ type: "foreign-secret", name: "foreign-secret" }],
          integrity: [],
          origin: "declared",
          source: COLLIDING,
        },
        {
          path: ["ours"],
          confidentiality: [{ type: "foreign-secret", name: "foreign-secret" }],
          integrity: [],
          origin: "declared",
          source: COLLIDING,
        },
      ]);
    });

    it("returns no entry under a link into another space holding an id this space also holds", () => {
      const read = didReader.read({ id: LINKER, scope: "space" });
      expect(read.linked.map((cell) => cell.path)).not.toContainEqual([
        "theirs",
      ]);
      expect(read.entries.map((entry) => entry.path[0])).not.toContain(
        "theirs",
      );
    });

    it("returns the path of a link into another space as unread rather than dropping it", () => {
      const read = didReader.read({ id: LINKER, scope: "space" });
      expect(read.unreadPaths).toEqual([
        { path: ["theirs"], reason: "cross-space" },
      ]);
    });

    it("returns only the link naming no space when the opened file proves no DID", () => {
      const read = reader.read({ id: LINKER, scope: "space" });
      expect(read.linked).toEqual([{
        path: ["mine"],
        id: COLLIDING,
        into: [],
      }]);
      expect(read.entries.map((entry) => entry.path)).toEqual([["mine"]]);
    });

    it("returns every spaced link as unread when the opened file proves no DID", () => {
      const read = reader.read({ id: LINKER, scope: "space" });
      expect(read.unreadPaths).toEqual([
        { path: ["ours"], reason: "space-unproven" },
        { path: ["theirs"], reason: "space-unproven" },
      ]);
    });

    it("returns the labels of a link nested inside the value under its whole path", () => {
      const read = didReader.read({ id: NESTER, scope: "space" });
      expect(read.entries).toEqual([
        {
          path: ["nested", "mine"],
          confidentiality: [{ type: "foreign-secret", name: "foreign-secret" }],
          integrity: [],
          origin: "declared",
          source: COLLIDING,
        },
        {
          path: ["list", "0", "ours"],
          confidentiality: [{ type: "foreign-secret", name: "foreign-secret" }],
          integrity: [],
          origin: "declared",
          source: COLLIDING,
        },
      ]);
    });

    it("returns an array index as a path segment of a link held in an array", () => {
      const read = didReader.read({ id: NESTER, scope: "space" });
      expect(read.linked).toEqual([
        { path: ["nested", "mine"], id: COLLIDING, into: [] },
        { path: ["list", "0", "ours"], id: COLLIDING, into: [] },
      ]);
    });

    it("returns the whole path of a nested link into another space as unread", () => {
      const read = didReader.read({ id: NESTER, scope: "space" });
      expect(read.unreadPaths).toEqual([
        { path: ["nested", "theirs"], reason: "cross-space" },
      ]);
    });

    it("returns no unread path for a document whose links were all followed", () => {
      expect(didReader.read({ id: DECLARED, scope: "space" }).unreadPaths)
        .toBe(undefined);
    });

    it("returns no truncation for a document the walk reached the end of", () => {
      expect(didReader.read({ id: DEEPER, scope: "space" }).truncation)
        .toBe(undefined);
    });

    it("returns the labels of every link of a document both bounds reach", () => {
      const read = didReader.read({ id: DEEPER, scope: "space" });
      expect(read.linked.map((cell) => cell.path)).toEqual([
        ["shallow"],
        ["deep", "down"],
      ]);
    });

    it("returns the label of a cell two links out under the path that reached it", () => {
      const read = didReader.read({ id: CHAIN_TOP, scope: "space" });
      expect(read.entries).toEqual([
        {
          path: ["next"],
          confidentiality: [{ type: "mid-secret", name: "mid-secret" }],
          integrity: [],
          origin: "link",
          source: CHAIN_MID,
        },
        {
          path: ["next", "next"],
          confidentiality: [{ type: "end-secret", name: "end-secret" }],
          integrity: [],
          origin: "derived",
          source: CHAIN_END,
        },
      ]);
    });

    it("returns the label at the path a link addresses at the link itself", () => {
      const read = didReader.read({ id: SLOTTED, scope: "space" });
      expect(read.entries).toEqual([
        {
          path: ["slot"],
          confidentiality: [{ type: "account-secret", name: "account-secret" }],
          integrity: [],
          origin: "declared",
          source: ACCOUNTS,
        },
        {
          path: ["leaf"],
          confidentiality: [{ type: "end-secret", name: "end-secret" }],
          integrity: [],
          origin: "derived",
          source: CHAIN_END,
        },
      ]);
    });

    it("returns no cell reached through a link elsewhere in the document a link addresses part of", () => {
      const read = didReader.read({ id: SLOTTED, scope: "space" });
      expect(read.linked).toEqual([
        { path: ["slot"], id: ACCOUNTS, into: ["account"] },
        { path: ["leaf"], id: CHAIN_END, into: ["leaf"] },
      ]);
      expect(read.entries.map((entry) => entry.path)).toEqual([
        ["slot"],
        ["leaf"],
      ]);
    });

    it("returns the unread path of a linked cell under the path that reached it", () => {
      const read = didReader.read({ id: VIA, scope: "space" });
      expect(read.unreadPaths).toEqual([
        { path: ["via", "theirs"], reason: "cross-space" },
      ]);
      expect(read.entries.map((entry) => entry.path)).toEqual([
        ["via", "mine"],
        ["via", "ours"],
      ]);
    });

    it("returns the label of a cell reached two ways under each path that reached it", () => {
      const read = didReader.read({ id: DIAMOND, scope: "space" });
      expect(read.entries.map((entry) => [entry.source, entry.path])).toEqual([
        [CHAIN_MID, ["left"]],
        [CHAIN_END, ["right"]],
        [CHAIN_END, ["left", "next"]],
      ]);
    });

    it("unfolds a loop once, holding the label of each cell on it", () => {
      const read = didReader.read({ id: LOOP_ONE, scope: "space" });
      expect(read.entries).toEqual([
        {
          path: [],
          confidentiality: [{ type: "one-secret", name: "one-secret" }],
          integrity: [],
          origin: "link",
        },
        {
          path: ["peer"],
          confidentiality: [{ type: "two-secret", name: "two-secret" }],
          integrity: [],
          origin: "link",
          source: LOOP_TWO,
        },
        {
          path: ["peer", "peer"],
          confidentiality: [{ type: "one-secret", name: "one-secret" }],
          integrity: [],
          origin: "link",
          source: LOOP_ONE,
        },
      ]);
      expect(read.truncation).toBe(undefined);
    });

    it("returns the path of a link further out than the read follows links as unread", async () => {
      await withGraphBoundedReader({ maxHops: 1, maxDocuments: 64 }, (b) => {
        const read = b.read({ id: CHAIN_TOP, scope: "space" });
        expect(read.unreadPaths).toEqual([
          { path: ["next", "next"], reason: "beyond-link-hops" },
        ]);
        expect(read.truncation).toBe(undefined);
      });
    });

    it("returns the label of the cell a hop-bounded read did reach", async () => {
      await withGraphBoundedReader({ maxHops: 1, maxDocuments: 64 }, (b) => {
        const read = b.read({ id: CHAIN_TOP, scope: "space" });
        expect(read.entries.map((entry) => entry.source)).toEqual([CHAIN_MID]);
      });
    });

    it("returns the whole cell truncated when the read runs out of documents", async () => {
      await collectWarnings(async () => {
        await withGraphBoundedReader({ maxHops: 8, maxDocuments: 1 }, (b) => {
          const read = b.read({ id: CHAIN_TOP, scope: "space" });
          expect(read.truncation).toBe("document-budget-exhausted");
          expect(read.entries.map((entry) => entry.source)).toEqual([
            CHAIN_MID,
          ]);
        });
      });
    });

    it("returns no truncation for a cell whose graph fits the document budget", async () => {
      await withGraphBoundedReader({ maxHops: 8, maxDocuments: 64 }, (b) => {
        expect(b.read({ id: CHAIN_TOP, scope: "space" }).truncation)
          .toBe(undefined);
      });
    });

    it("returns the path a shallower walk stopped short of as unread", async () => {
      await withBoundedReader(SHALLOW, (bounded) => {
        const read = bounded.read({ id: DEEPER, scope: "space" });
        expect(read.unreadPaths).toEqual([
          { path: ["deep", "down"], reason: "below-read-depth" },
        ]);
        expect(read.truncation).toBe(undefined);
      });
    });

    it("returns the labels of the link a shallower walk did reach", async () => {
      await withBoundedReader(SHALLOW, (bounded) => {
        const read = bounded.read({ id: DEEPER, scope: "space" });
        expect(read.linked).toEqual([{
          path: ["shallow"],
          id: COLLIDING,
          into: [],
        }]);
        expect(read.entries.map((entry) => entry.path)).toEqual([["shallow"]]);
      });
    });

    it("returns the whole document truncated when the walk runs out of nodes", async () => {
      await collectWarnings(() =>
        withBoundedReader(SPENT, (bounded) => {
          const read = bounded.read({ id: DEEPER, scope: "space" });
          expect(read.truncation).toBe("node-budget-exhausted");
          // No path for what it missed: it stopped before enumerating what
          // it had left, so the statement is about the document as a whole.
          expect(read.unreadPaths).toBe(undefined);
          expect(read.entries.map((entry) => entry.path)).toEqual([
            ["shallow"],
          ]);
        })
      );
    });

    it("warns naming the document when the walk runs out of nodes", async () => {
      const warnings = await collectWarnings(() =>
        withBoundedReader(SPENT, (bounded) => {
          bounded.read({ id: DEEPER, scope: "space" });
        })
      );
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain(DEEPER);
      expect(warnings[0]).toContain(didDbPath);
    });

    it("warns for no document the walk reached the end of", async () => {
      const warnings = await collectWarnings(() =>
        withBoundedReader(SHALLOW, (bounded) => {
          bounded.read({ id: DEEPER, scope: "space" });
        })
      );
      expect(warnings).toEqual([]);
    });
  });

  describe("readSpaceCellLabels()", () => {
    const read = (refs: readonly string[]) =>
      readSpaceCellLabels({
        space: "demo-space",
        dbPath,
        refs,
        generatedAt: "2026-01-01T00:00:00.000Z",
      });

    it("records one cell per entity, naming the reference the run held", async () => {
      const snapshot = await read([`/${DECLARED}`, `/${UNLABELLED}`]);
      expect(snapshot.type).toBe(HARNESS_CELL_LABELS_TYPE);
      expect(snapshot.status).toBe("read");
      expect(snapshot.space).toEqual({ configured: "demo-space", dbPath });
      expect(snapshot.cells.map((cell) => cell.entityId)).toEqual([
        DECLARED,
        UNLABELLED,
      ]);
      expect(snapshot.cells[0].ref).toBe(`/${DECLARED}`);
      expect(snapshot.cells[0].schemaHash).toBe(SCHEMA_HASH);
      expect(snapshot.cells[1].entries).toEqual([]);
    });

    it("records one cell for a reference the run held more than once", async () => {
      const snapshot = await read([`/${DECLARED}`, `/${DECLARED}`]);
      expect(snapshot.cells.length).toBe(1);
    });

    it("resolves a reference naming a path inside a document to the document", async () => {
      const snapshot = await read([`/${DECLARED}/value/secret`]);
      expect(snapshot.cells.map((cell) => cell.entityId)).toEqual([DECLARED]);
      expect(snapshot.cells[0].ref).toBe(`/${DECLARED}/value/secret`);
    });

    it("drops a reference that names no document", async () => {
      const snapshot = await read(["my notebook", `/${DECLARED}`]);
      expect(snapshot.cells.map((cell) => cell.entityId)).toEqual([DECLARED]);
    });

    it("records a reference the store holds no document for as unread", async () => {
      const [snapshot, warnings] = await collectWarningsOf(() =>
        read([`/${NEVER_WRITTEN}`, `/${DECLARED}`])
      );
      expect(snapshot.status).toBe("read");
      expect(snapshot.cells.map((cell) => cell.unreadReason)).toEqual([
        "no-document",
        undefined,
      ]);
      expect(warnings).toEqual([]);
    });

    it("warns that the store is a different one when it holds none of the cells the run held", async () => {
      const [snapshot, warnings] = await collectWarningsOf(() =>
        read([`/${NEVER_WRITTEN}`, `/${entity("neverEither")}`])
      );
      expect(snapshot.status).toBe("read");
      expect(snapshot.cells.map((cell) => cell.unreadReason)).toEqual([
        "no-document",
        "no-document",
      ]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain(dbPath);
      expect(warnings[0]).toContain("--space-db");
    });

    const readAgainstDid = (refs: readonly string[]) =>
      readSpaceCellLabels({
        space: "demo-space",
        dbPath: didDbPath,
        refs,
        generatedAt: "2026-01-01T00:00:00.000Z",
      });

    it("names the space DID of a database named for its space", async () => {
      const snapshot = await readAgainstDid([`/${DECLARED}`]);
      expect(snapshot.space).toEqual({
        configured: "demo-space",
        did: OWN_DID,
        dbPath: didDbPath,
      });
    });

    it("records a reference into another space as unread rather than reading its id here", async () => {
      const ref = `/@${FOREIGN_DID}/${COLLIDING}`;
      const snapshot = await readAgainstDid([ref]);
      expect(snapshot.cells).toEqual([{
        entityId: COLLIDING,
        ref,
        space: FOREIGN_DID,
        unreadReason: "cross-space",
        entries: [],
      }]);
    });

    it("records one cell per space for an id referenced in two", async () => {
      const snapshot = await readAgainstDid([
        `/${COLLIDING}`,
        `/@${FOREIGN_DID}/${COLLIDING}`,
      ]);
      expect(snapshot.cells.map((cell) => cell.unreadReason)).toEqual([
        undefined,
        "cross-space",
      ]);
      expect(snapshot.cells[0].entries.map((entry) => entry.confidentiality))
        .toEqual([[{ type: "foreign-secret", name: "foreign-secret" }]]);
    });

    it("records the path of a link the walk could not follow", async () => {
      const snapshot = await readAgainstDid([`/${LINKER}`]);
      expect(snapshot.cells[0].unreadPaths).toEqual([
        { path: ["theirs"], reason: "cross-space" },
      ]);
      expect(snapshot.cells[0].unreadReason).toBe(undefined);
    });

    it("records the whole path of a nested link the walk could not follow", async () => {
      const snapshot = await readAgainstDid([`/${NESTER}`]);
      expect(snapshot.cells[0].unreadPaths).toEqual([
        { path: ["nested", "theirs"], reason: "cross-space" },
      ]);
      expect(snapshot.cells[0].entries.map((entry) => entry.path)).toEqual([
        ["nested", "mine"],
        ["list", "0", "ours"],
      ]);
    });

    it("records every spaced link of a cell as unread against a database naming no space", async () => {
      const snapshot = await read([`/${LINKER}`]);
      expect(snapshot.cells[0].unreadPaths).toEqual([
        { path: ["ours"], reason: "space-unproven" },
        { path: ["theirs"], reason: "space-unproven" },
      ]);
    });

    it("records no unread path for a cell whose links were all followed", async () => {
      const snapshot = await readAgainstDid([`/${DECLARED}`]);
      expect(snapshot.cells[0].unreadPaths).toBe(undefined);
    });

    it("records the path of a link below the depth the read descends to", async () => {
      const snapshot = await readSpaceCellLabels({
        space: "demo-space",
        dbPath: didDbPath,
        linkWalk: SHALLOW,
        refs: [`/${DEEPER}`],
        generatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(snapshot.cells[0].unreadPaths).toEqual([
        { path: ["deep", "down"], reason: "below-read-depth" },
      ]);
      expect(snapshot.cells[0].truncationReason).toBe(undefined);
    });

    it("records the cell as truncated when the read runs out of nodes", async () => {
      const [snapshot, warnings] = await collectWarningsOf(() =>
        readSpaceCellLabels({
          space: "demo-space",
          dbPath: didDbPath,
          linkWalk: SPENT,
          refs: [`/${DEEPER}`],
          generatedAt: "2026-01-01T00:00:00.000Z",
        })
      );
      expect(snapshot.cells[0].truncationReason).toBe("node-budget-exhausted");
      expect(snapshot.cells[0].unreadPaths).toBe(undefined);
      expect(warnings.length).toBe(1);
    });

    it("records no truncation for a cell the read reached the end of", async () => {
      const snapshot = await readAgainstDid([`/${DEEPER}`]);
      expect(snapshot.cells[0].truncationReason).toBe(undefined);
    });

    it("returns an unavailable snapshot naming the space when no database is found", async () => {
      const snapshot = await readSpaceCellLabels({
        space: "demo-space",
        dbPath: `${directory}/absent.sqlite`,
        refs: [`/${DECLARED}`],
        generatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(snapshot.status).toBe("unavailable");
      expect(snapshot.unavailableReason).toBe("space-not-found");
      expect(snapshot.space).toEqual({ configured: "demo-space" });
      expect(snapshot.cells).toEqual([]);
      expect(typeof snapshot.unavailableDetail).toBe("string");
    });
  });
});
