import { ChangeSet } from "@codemirror/state";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { isObjectNotArray } from "@commonfabric/utils/types";
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
});
