import { rebaseUpdates, type Update } from "@codemirror/collab";
import { ChangeSet, Text } from "@codemirror/state";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import {
  CODEMIRROR_CHANGESET_CODEC,
  createDefaultOperationCodecRegistry,
  mapAnchor,
  type OperationCodec,
  OperationCodecRegistry,
} from "../v2/operation-codec.ts";

const update = (
  clientId: string,
  length: number,
  from: number,
  insert: string,
  dedupeId?: string,
) => ({
  updates: [{
    clientId,
    changes: ChangeSet.of({ from, insert }, length).toJSON(),
    ...(dedupeId === undefined ? {} : { dedupeId }),
  }],
});

const replacement = (
  clientId: string,
  documentLength: number,
  from: number,
  to: number,
  insert: string,
  dedupeId: string,
) => ({
  updates: [{
    clientId,
    changes: ChangeSet.of({ from, to, insert }, documentLength).toJSON(),
    dedupeId,
  }],
});

describe("v2-operation-codec", () => {
  it("integrates same-base CodeMirror updates in either canonical order", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const alice = update("alice", 3, 1, "X");
    const bob = update("bob", 3, 1, "Y");

    const aliceFirst = codec.integrate({
      materialized: "abc",
      submitted: alice,
      intervening: [],
    });
    const thenBob = codec.integrate({
      materialized: aliceFirst.materialized,
      submitted: bob,
      intervening: aliceFirst.operations,
    });
    expect(thenBob.materialized).toBe("aXYbc");

    const bobFirst = codec.integrate({
      materialized: "abc",
      submitted: bob,
      intervening: [],
    });
    const thenAlice = codec.integrate({
      materialized: bobFirst.materialized,
      submitted: alice,
      intervening: bobFirst.operations,
    });
    expect(thenAlice.materialized).toBe("aYXbc");
  });

  it("rebases an ordered local batch over the complete canonical suffix", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const remoteOne = codec.integrate({
      materialized: "ab",
      submitted: update("bob", 2, 1, "X"),
      intervening: [],
    });
    const remoteTwo = codec.integrate({
      materialized: remoteOne.materialized,
      submitted: update("carol", 3, 2, "Y"),
      intervening: [],
    });
    const localBatch = {
      updates: [{
        clientId: "alice",
        changes: ChangeSet.of({ from: 1, insert: "A" }, 2).toJSON(),
      }, {
        clientId: "alice",
        changes: ChangeSet.of({ from: 2, insert: "B" }, 3).toJSON(),
      }],
    };

    const integrated = codec.integrate({
      materialized: remoteTwo.materialized,
      submitted: localBatch,
      intervening: [...remoteOne.operations, ...remoteTwo.operations],
    });

    expect(integrated.materialized).toBe("aXYABb");
    expect(integrated.operations).toHaveLength(2);
  });

  it("integrates one copy of a concurrent idempotent rewrite", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const alice = replacement("alice", 5, 1, 4, "new", "title:old:new");
    const bob = replacement("bob", 5, 1, 4, "new", "title:old:new");

    const first = codec.integrate({
      materialized: "aoldb",
      submitted: alice,
      intervening: [],
    });
    const second = codec.integrate({
      materialized: first.materialized,
      submitted: bob,
      intervening: first.operations,
    });

    expect(first.materialized).toBe("anewb");
    expect(second.materialized).toBe("anewb");
    expect(second.operations).toEqual([]);
  });

  it("keeps edits around a deduplicated rewrite in one stale batch", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const rewrite = replacement(
      "alice",
      5,
      1,
      4,
      "new",
      "title:old:new",
    );
    const first = codec.integrate({
      materialized: "aoldb",
      submitted: rewrite,
      intervening: [],
    });
    const staleBatch = {
      updates: [{
        clientId: "bob",
        changes: ChangeSet.of({ from: 0, insert: "X" }, 5).toJSON(),
      }, {
        clientId: "bob",
        changes: ChangeSet.of(
          { from: 2, to: 5, insert: "new" },
          6,
        ).toJSON(),
        dedupeId: "title:old:new",
      }, {
        clientId: "bob",
        changes: ChangeSet.of({ from: 6, insert: "!" }, 6).toJSON(),
      }],
    };

    const integrated = codec.integrate({
      materialized: first.materialized,
      submitted: staleBatch,
      intervening: first.operations,
    });

    expect(integrated.materialized).toBe("Xanewb!");
    expect(integrated.operations).toHaveLength(2);
    expect(integrated.operations).not.toContainEqual(rewrite);
  });

  it("keeps a new edit after an already-integrated client prefix", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const firstUpdate = update("alice", 3, 1, "X");
    const first = codec.integrate({
      materialized: "abc",
      submitted: firstUpdate,
      intervening: [],
    });
    const staleBatch = {
      updates: [
        firstUpdate.updates[0],
        {
          clientId: "alice",
          changes: ChangeSet.of({ from: 2, insert: "Y" }, 4).toJSON(),
        },
      ],
    };

    const integrated = codec.integrate({
      materialized: first.materialized,
      submitted: staleBatch,
      intervening: first.operations,
    });

    expect(integrated.materialized).toBe("aXYbc");
    expect(integrated.operations).toHaveLength(1);
  });

  it("rebases a stale batch past its integrated prefix as the library does, under overlapping remote edits", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const own = (changes: ChangeSet): Update => ({
      clientID: "alice",
      changes,
    });
    const remote = (changes: ChangeSet): Update => ({
      clientID: "bob",
      changes,
    });
    const apply = (text: string, updates: readonly Update[]) => {
      let document = Text.of([text]);
      for (const update of updates) document = update.changes.apply(document);
      return document.toString();
    };
    const payload = (update: Update) => ({
      updates: [{
        clientId: update.clientID,
        changes: update.changes.toJSON(),
      }],
    });
    // Alice's batch over "abcdef": "aAdef", then "B".
    const batch = [
      own(ChangeSet.of({ from: 1, to: 3, insert: "A" }, 6)),
      own(ChangeSet.of({ from: 0, to: 5, insert: "B" }, 5)),
    ];
    // The field integrated Bob's overlapping replacements around the first
    // update of the batch: "abCCCf", "DDDCf", "DDDCAf", "EEAf".
    const integrated = [
      remote(ChangeSet.of({ from: 2, to: 5, insert: "CCC" }, 6)),
      remote(ChangeSet.of({ from: 0, to: 4, insert: "DDD" }, 6)),
      own(ChangeSet.of({ from: 4, insert: "A" }, 5)),
      remote(ChangeSet.of({ from: 0, to: 4, insert: "EE" }, 6)),
    ];
    const head = apply("abcdef", integrated);
    expect(head).toBe("EEAf");
    const library = rebaseUpdates(batch, integrated);
    expect(apply(head, library)).toBe("EEB");

    const result = codec.integrate({
      materialized: head,
      submitted: { updates: batch.map((update) => payload(update).updates[0]) },
      intervening: integrated.map(payload),
    });
    expect(result.materialized).toBe("EEB");
    expect(result.operations).toEqual(library.map(payload));
  });

  it("accepts a later rewrite after its earlier dedupe horizon", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const first = codec.integrate({
      materialized: "aoldb",
      submitted: replacement(
        "alice",
        5,
        1,
        4,
        "new",
        "title:old:new",
      ),
      intervening: [],
    });
    const back = codec.integrate({
      materialized: first.materialized,
      submitted: replacement(
        "alice",
        5,
        1,
        4,
        "old",
        "title:new:old",
      ),
      intervening: [],
    });
    const again = codec.integrate({
      materialized: back.materialized,
      submitted: replacement(
        "alice",
        5,
        1,
        4,
        "new",
        "title:old:new",
      ),
      intervening: [],
    });

    expect(again.materialized).toBe("anewb");
  });

  it("rejects malformed CodeMirror payloads before returning output", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const malformed = [
      { materialized: 1, submitted: update("alice", 1, 0, "x") },
      { materialized: "a", submitted: null },
      { materialized: "a", submitted: { updates: "not-an-array" } },
      { materialized: "a", submitted: { updates: [], extra: true } },
      {
        materialized: "a",
        submitted: { updates: [{ clientId: "", changes: [1] }] },
      },
      {
        materialized: "a",
        submitted: {
          updates: [{ clientId: "alice", changes: [999] }],
        },
      },
      {
        materialized: "a",
        submitted: {
          updates: [{ clientId: "alice", changes: [1], effects: [] }],
        },
      },
      {
        materialized: "a",
        submitted: {
          updates: [{ clientId: "alice", changes: [1], dedupeId: "" }],
        },
      },
    ] as const;

    for (const input of malformed) {
      expect(() =>
        codec.integrate({
          materialized: input.materialized,
          submitted: input.submitted,
          intervening: [],
        })
      ).toThrow();
    }
  });

  it("is deterministic and does not retain mutable submitted objects", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const submitted = update("alice", 3, 1, "X");
    const first = codec.integrate({
      materialized: "abc",
      submitted,
      intervening: [],
    });
    const second = codec.integrate({
      materialized: "abc",
      submitted,
      intervening: [],
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    submitted.updates[0].clientId = "mutated";
    expect(first.operations).toEqual([update("alice", 3, 1, "X")]);
  });

  it("enforces versioned unique ids for editor-neutral codecs", () => {
    const counter: OperationCodec = {
      id: "test-counter@1",
      mapAnchors: ({ anchors }) => anchors,
      integrate({ materialized, submitted }) {
        if (
          typeof materialized !== "number" || !isObjectNotArray(submitted) ||
          typeof (submitted as { by?: unknown }).by !== "number"
        ) {
          throw new Error("counter values must be numeric");
        }
        const by = (submitted as { by: number }).by;
        return { materialized: materialized + by, operations: [{ by }] };
      },
    };
    const registry = new OperationCodecRegistry([counter]);
    expect(
      registry.require("test-counter@1").integrate({
        materialized: 2,
        submitted: { by: 3 },
        intervening: [],
      }),
    ).toEqual({ materialized: 5, operations: [{ by: 3 }] });
    expect(() => registry.register(counter)).toThrow(
      "operation codec already registered",
    );
    expect(() => registry.register({ ...counter, id: "test-counter" })).toThrow(
      "requires a version suffix",
    );
  });

  describe("mapAnchors()", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const edit = (
      length: number,
      from: number,
      to: number,
      insert: string,
    ) => ({
      updates: [{
        clientId: "alice",
        changes: ChangeSet.of({ from, to, insert }, length).toJSON(),
      }],
    });

    it("keeps an anchor ahead of text inserted at it", () => {
      expect(codec.mapAnchors({
        anchors: { a: 2 },
        operations: [edit(4, 2, 2, "X")],
      })).toEqual({ a: 2 });
    });

    it("moves an anchor past text inserted before it", () => {
      expect(codec.mapAnchors({
        anchors: { a: 2 },
        operations: [edit(4, 1, 1, "XY")],
      })).toEqual({ a: 4 });
    });

    it("leaves an anchor before an edit where it was", () => {
      expect(codec.mapAnchors({
        anchors: { a: 1 },
        operations: [edit(4, 2, 4, "XYZ")],
      })).toEqual({ a: 1 });
    });

    it("brings an anchor inside deleted text to where the deletion began", () => {
      expect(codec.mapAnchors({
        anchors: { before: 1, inside: 3, end: 5, after: 6 },
        operations: [edit(6, 1, 5, "")],
      })).toEqual({ before: 1, inside: 1, end: 1, after: 2 });
    });

    it("keeps a pair of anchors around a replacement of the text between them", () => {
      expect(codec.mapAnchors({
        anchors: { from: 1, inside: 2, to: 3 },
        operations: [edit(4, 1, 3, "XYZ")],
      })).toEqual({ from: 1, inside: 1, to: 4 });
    });

    it("maps an anchor through each operation in order", () => {
      // `abcdef` becomes `abXcdef`, then `abXcdYef`, then `bXcdYef`.

      expect(codec.mapAnchors({
        anchors: { c: 2, e: 4 },
        operations: [edit(6, 2, 2, "X"), edit(7, 5, 5, "Y"), edit(8, 0, 1, "")],
      })).toEqual({ c: 1, e: 4 });
    });

    it("maps an offset past the end of the text as the end", () => {
      expect(codec.mapAnchors({
        anchors: { end: 3, far: 99 },
        operations: [edit(3, 0, 0, "def")],
      })).toEqual({ end: 6, far: 6 });
    });

    it("returns the anchors under the ids given", () => {
      expect(codec.mapAnchors({
        anchors: { z: 4, a: 0, m: 2 },
        operations: [edit(4, 1, 1, "X")],
      })).toEqual({ z: 5, a: 0, m: 3 });
    });

    it("returns the anchors as given with nothing to map through", () => {
      expect(codec.mapAnchors({
        anchors: { a: 0, b: 3 },
        operations: [],
      })).toEqual({ a: 0, b: 3 });
    });

    it("throws for an operation that is not a CodeMirror payload", () => {
      expect(() =>
        codec.mapAnchors({
          anchors: { a: 0 },
          operations: [{ changes: [4] }],
        })
      ).toThrow("requires an updates array");
    });

    it("maps anchors through what a stale batch integrates as, past its integrated prefix", () => {
      // Alice's first update landed as `Xab`, and Bob's `--` came after it.
      // She sends that update again with a second one made over `Xab`.

      const own = edit(2, 0, 0, "X");
      const result = codec.integrate({
        materialized: "--Xab",
        submitted: {
          updates: [...own.updates, ...edit(3, 3, 3, "Y").updates],
        },
        intervening: [own, {
          updates: [{
            clientId: "bob",
            changes: ChangeSet.of({ from: 0, insert: "--" }, 3).toJSON(),
          }],
        }],
      });
      expect(result.materialized).toBe("--XabY");
      expect(result.operations).toHaveLength(1);

      // Stated against `--Xab`, where the second update lands at the end.
      expect(codec.mapAnchors({
        anchors: { x: 2, b: 4, end: 5 },
        operations: result.operations,
      })).toEqual({ x: 2, b: 4, end: 5 });
    });

    it("maps anchors through the operations a deduplicated rewrite leaves", () => {
      // Alice's rewrite of `old` landed first. Bob's batch, made over `aoldb`,
      // carries the same rewrite between an insert at the start and one at
      // the end, and integrates as the two inserts alone.

      const first = codec.integrate({
        materialized: "aoldb",
        submitted: replacement("alice", 5, 1, 4, "new", "title:old:new"),
        intervening: [],
      });
      const result = codec.integrate({
        materialized: first.materialized,
        submitted: {
          updates: [{
            clientId: "bob",
            changes: ChangeSet.of({ from: 0, insert: "X" }, 5).toJSON(),
          }, {
            clientId: "bob",
            changes: ChangeSet.of({ from: 2, to: 5, insert: "new" }, 6)
              .toJSON(),
            dedupeId: "title:old:new",
          }, {
            clientId: "bob",
            changes: ChangeSet.of({ from: 6, insert: "!" }, 6).toJSON(),
          }],
        },
        intervening: first.operations,
      });
      expect(result.materialized).toBe("Xanewb!");
      expect(result.operations).toHaveLength(2);

      // Stated against `anewb`: an anchor inside the rewritten text stays
      // inside it, where a second copy of the rewrite would have collapsed it
      // to the rewrite's start.
      expect(codec.mapAnchors({
        anchors: { a: 0, inside: 2, b: 4, end: 5 },
        operations: result.operations,
      })).toEqual({ a: 0, inside: 3, b: 5, end: 6 });
    });
  });

  describe("mapAnchor()", () => {
    const insertion = (length: number, from: number, insert: string) =>
      ChangeSet.of({ from, insert }, length).desc;

    it("returns the offset of an anchor that text is inserted at", () => {
      expect(mapAnchor(2, insertion(4, 2, "XY"))).toBe(2);
    });

    it("returns the offset moved by the text inserted before it", () => {
      expect(mapAnchor(3, insertion(4, 2, "XY"))).toBe(5);
    });

    it("returns where a deletion began for an offset inside it", () => {
      expect(mapAnchor(3, ChangeSet.of({ from: 1, to: 4 }, 6).desc)).toBe(1);
    });

    it("returns the end of the changed text for an offset past the end of the text", () => {
      expect(mapAnchor(9, insertion(4, 0, "XY"))).toBe(6);
    });
  });
});
