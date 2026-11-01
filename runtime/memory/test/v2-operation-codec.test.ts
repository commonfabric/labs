import { rebaseUpdates, type Update } from "@codemirror/collab";
import { ChangeSet, Text } from "@codemirror/state";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import {
  CODEMIRROR_CHANGESET_CODEC,
  createDefaultOperationCodecRegistry,
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
      anchors: [{ id: "b", from: 0, to: 1 }],
    });
    expect(result.materialized).toBe("EEB");
    expect(result.operations).toEqual(library.map(payload));
    expect(result.anchors).toEqual([{ id: "b", from: 2, to: 3 }]);
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
      mapAnchors: ({ anchors }) => [...anchors],
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

  describe("integrate() with anchors", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const edit = (
      clientId: string,
      length: number,
      from: number,
      to: number,
      insert: string,
    ) => ({
      updates: [{
        clientId,
        changes: ChangeSet.of({ from, to, insert }, length).toJSON(),
      }],
    });
    const slices = (
      text: unknown,
      anchors: readonly { id: string; from: number; to: number }[] | undefined,
    ) =>
      anchors?.map((
        { id, from, to },
      ) => [id, (text as string).slice(from, to)]);

    it("keeps an anchor on the text the submitted update inserts, after an edit integrated before it", () => {
      const result = codec.integrate({
        materialized: ">> world",
        submitted: edit("alice", 5, 0, 0, "hello "),
        intervening: [edit("bob", 5, 0, 0, ">> ")],
        anchors: [{ id: "greeting", from: 0, to: 6 }, {
          id: "w",
          from: 6,
          to: 11,
        }],
      });
      expect(result.materialized).toBe(">> hello world");
      expect(slices(result.materialized, result.anchors)).toEqual([
        ["greeting", "hello "],
        ["w", "world"],
      ]);
    });

    it("maps anchors stated against the base when nothing is submitted", () => {
      const result = codec.integrate({
        materialized: ">> world",
        submitted: { updates: [] },
        intervening: [edit("bob", 5, 0, 0, ">> ")],
        anchors: [{ id: "w", from: 0, to: 5 }],
      });
      expect(result.operations).toEqual([]);
      expect(result.anchors).toEqual([{ id: "w", from: 3, to: 8 }]);
    });

    it("returns the anchors as given with nothing submitted and nothing intervening", () => {
      expect(
        codec.integrate({
          materialized: "world",
          submitted: { updates: [] },
          intervening: [],
          anchors: [{ id: "w", from: 0, to: 5 }],
        }).anchors,
      ).toEqual([{ id: "w", from: 0, to: 5 }]);
    });

    it("omits anchors from the result when the input carried none", () => {
      expect(codec.integrate({
        materialized: "world",
        submitted: edit("alice", 5, 5, 5, "!"),
        intervening: [],
      })).not.toHaveProperty("anchors");
    });

    it("empties an anchor whose text an intervening edit deleted", () => {
      const result = codec.integrate({
        materialized: "hello ",
        submitted: edit("alice", 11, 11, 11, "!"),
        intervening: [edit("bob", 11, 6, 11, "")],
        anchors: [{ id: "w", from: 6, to: 11 }],
      });
      expect(result.materialized).toBe("hello !");
      expect(result.anchors).toEqual([{ id: "w", from: 6, to: 6 }]);
    });

    it("maps anchors past the client's already-integrated prefix", () => {
      // Alice's first update landed; she resends it with a second one and an
      // anchor on the text the second inserts, while Bob's edit came between.
      const own = edit("alice", 2, 0, 0, "X");
      const result = codec.integrate({
        materialized: "--Xab",
        submitted: {
          updates: [...own.updates, ...edit("alice", 3, 3, 3, "Y").updates],
        },
        intervening: [own, edit("bob", 3, 0, 0, "--")],
        anchors: [{ id: "y", from: 3, to: 4 }, { id: "x", from: 0, to: 1 }],
      });
      expect(result.materialized).toBe("--XabY");
      expect(result.operations).toHaveLength(1);
      expect(slices(result.materialized, result.anchors)).toEqual([
        ["y", "Y"],
        ["x", "X"],
      ]);
    });

    it("maps anchors to the kept document when a submitted rewrite is deduplicated", () => {
      const rewrite = replacement("alice", 5, 1, 4, "new", "title:old:new");
      const first = codec.integrate({
        materialized: "aoldb",
        submitted: rewrite,
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
        // Stated against Bob's document, "Xanewb!".
        anchors: [{ id: "x", from: 0, to: 1 }, { id: "bang", from: 6, to: 7 }, {
          id: "rewrite",
          from: 2,
          to: 5,
        }],
      });
      expect(result.materialized).toBe("Xanewb!");
      expect(slices(result.materialized, result.anchors)).toEqual([
        ["x", "X"],
        ["bang", "!"],
        ["rewrite", ""],
      ]);
      // The dropped copy of the rewrite leaves its anchor a point where that
      // copy was, after the kept one.
      expect(result.anchors?.[2]).toEqual({ id: "rewrite", from: 5, to: 5 });
    });

    it("throws for a range beyond the document the submitted updates yield", () => {
      expect(() =>
        codec.integrate({
          materialized: "world",
          submitted: edit("alice", 5, 0, 0, "hello "),
          intervening: [],
          anchors: [{ id: "a", from: 0, to: 12 }],
        })
      ).toThrow("outside the field's 11 code units");
    });
  });

  describe("mapAnchors()", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const anchor = (from: number, to: number) => ({ id: "a", from, to });
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

    it("keeps text inserted at either end outside the range", () => {
      expect(codec.mapAnchors({
        anchors: [anchor(2, 4)],
        materialized: "abXcdYef",
        operations: [edit(6, 2, 2, "X"), edit(7, 5, 5, "Y")],
      })).toEqual([anchor(3, 5)]);
    });

    it("grows the range around text inserted inside it", () => {
      expect(codec.mapAnchors({
        anchors: [anchor(1, 3)],
        materialized: "abXYcd",
        operations: [edit(4, 2, 2, "XY")],
      })).toEqual([anchor(1, 5)]);
    });

    it("empties a range a deletion covers to the deletion's start", () => {
      expect(codec.mapAnchors({
        anchors: [anchor(2, 4)],
        materialized: "af",
        operations: [edit(6, 1, 5, "")],
      })).toEqual([anchor(1, 1)]);
    });

    it("keeps the range over a replacement of its text", () => {
      expect(codec.mapAnchors({
        anchors: [anchor(1, 3)],
        materialized: "aXYZd",
        operations: [edit(4, 1, 3, "XYZ")],
      })).toEqual([anchor(1, 4)]);
    });

    it("keeps an empty range before text inserted at it", () => {
      expect(codec.mapAnchors({
        anchors: [anchor(2, 2)],
        materialized: "abXcd",
        operations: [edit(4, 2, 2, "X")],
      })).toEqual([anchor(2, 2)]);
    });

    it("returns the anchors as given with nothing to map through", () => {
      expect(codec.mapAnchors({
        anchors: [anchor(0, 3)],
        materialized: "abc",
        operations: [],
      })).toEqual([anchor(0, 3)]);
    });

    it("throws for a field that is not a string", () => {
      expect(() =>
        codec.mapAnchors({
          anchors: [anchor(0, 1)],
          materialized: 5,
          operations: [],
        })
      ).toThrow("require a string field");
    });

    it("throws for a range beyond the value the anchors are stated against", () => {
      expect(() =>
        codec.mapAnchors({
          anchors: [anchor(0, 7)],
          materialized: "abcdef",
          operations: [edit(3, 3, 3, "def")],
        })
      ).toThrow("outside the field's 3 code units");
      expect(() =>
        codec.mapAnchors({
          anchors: [anchor(0, 4)],
          materialized: "abc",
          operations: [],
        })
      ).toThrow("outside the field's 3 code units");
    });
  });
});
