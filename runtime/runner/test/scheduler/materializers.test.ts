import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { entityNameKey } from "../../src/scheduler/keys.ts";
import {
  collectMaterializerWritersForLog,
  type MaterializerIndexState,
  SchedulerMaterializers,
} from "../../src/scheduler/materializers.ts";
import { readsOverlapWrites } from "../../src/scheduler/scheduling-writes.ts";
import type {
  Action,
  ReactivityLog,
  SpaceScopeAndURI,
} from "../../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../../src/storage/interface.ts";

const SPACE = "did:key:materializer-writers";

// The index keys addresses by scope name, so no identity is consulted.
const identityThunk = () => ({
  principal: "did:test:alice",
  sessionId: "session-1",
});

function address(
  id: string,
  ...path: string[]
): IMemorySpaceAddress {
  return { space: SPACE, scope: "space", id: `of:${id}`, path };
}

function action(name: string): Action {
  const named = { [name]: () => {} };
  return named[name];
}

function log(
  reads: IMemorySpaceAddress[],
  shallowReads: IMemorySpaceAddress[] = [],
): ReactivityLog {
  return { reads, shallowReads, writes: [] };
}

function names(writers: Iterable<Action>): string[] {
  return [...writers].map((writer) => writer.name);
}

/**
 * An index holding one materializer per entry of `envelopes`, registered in
 * that order, with the entries named in `effects` marked as effects.
 */
function createIndex(
  envelopes: Record<string, IMemorySpaceAddress[]>,
  effects: readonly string[] = [],
): { index: SchedulerMaterializers; actions: Map<string, Action> } {
  const actions = new Map<string, Action>();
  const effectSet = new Set<Action>();
  const index = new SchedulerMaterializers(effectSet, identityThunk);
  for (const [name, writes] of Object.entries(envelopes)) {
    const materializer = action(name);
    actions.set(name, materializer);
    if (effects.includes(name)) effectSet.add(materializer);
    index.registerAddresses(materializer, writes);
  }
  return { index, actions };
}

/**
 * The definition the function implements: every non-excluded, non-effect
 * materializer indexed on some read's entity whose envelopes overlap the log
 * as a whole, in the order the reads, deep then shallow, first reach it.
 */
function referenceWriters(
  state: MaterializerIndexState,
  reactivityLog: ReactivityLog,
  exclude?: Action,
): Action[] {
  const writers = new Set<Action>();
  for (const read of [...reactivityLog.reads, ...reactivityLog.shallowReads]) {
    for (
      const candidate of state.materializersByEntity.get(entityNameKey(read)) ??
        []
    ) {
      if (candidate === exclude || state.effects.has(candidate)) continue;
      if (
        readsOverlapWrites(
          reactivityLog.reads,
          reactivityLog.shallowReads,
          state.getMaterializerWriteEnvelopes(candidate) ?? [],
        )
      ) {
        writers.add(candidate);
      }
    }
  }
  return [...writers];
}

/** Deterministic xorshift, so a failing sequence is reproducible. */
function createRandom(seed: number) {
  let value = seed;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    value >>>= 0;
    return value / 0x100000000;
  };
}

describe("materializers", () => {
  describe("collectMaterializerWritersForLog()", () => {
    it("returns a materializer whose envelope a deep read reaches from above or below", () => {
      const { index } = createIndex({
        below: [address("doc", "items", "0", "title")],
        above: [address("doc")],
        exact: [address("doc", "items")],
      });

      expect(
        names(collectMaterializerWritersForLog(
          index,
          log([address("doc", "items")]),
        )),
      ).toEqual(["below", "above", "exact"]);
    });

    it("returns a shallow read's writers at the same path, above it, and one level below it", () => {
      const { index } = createIndex({
        child: [address("doc", "items", "0")],
        grandchild: [address("doc", "items", "0", "title")],
        parent: [address("doc")],
      });

      expect(
        names(collectMaterializerWritersForLog(
          index,
          log([], [address("doc", "items")]),
        )),
      ).toEqual(["child", "parent"]);
    });

    it("returns a deep read's grandchild writer that the same path read shallowly misses", () => {
      const { index } = createIndex({
        grandchild: [address("doc", "items", "0", "title")],
      });

      expect(
        names(collectMaterializerWritersForLog(
          index,
          log([address("doc", "items")], [address("doc", "items")]),
        )),
      ).toEqual(["grandchild"]);
      expect(
        names(collectMaterializerWritersForLog(
          index,
          log([], [address("doc", "items")]),
        )),
      ).toEqual([]);
    });

    it("returns nothing for a materializer on the read's entity at a disjoint path", () => {
      const { index } = createIndex({
        sibling: [address("doc", "summary")],
      });

      expect(
        names(collectMaterializerWritersForLog(
          index,
          log([address("doc", "items")], [address("doc", "count")]),
        )),
      ).toEqual([]);
    });

    it("returns nothing for a materializer indexed only on another entity", () => {
      const { index } = createIndex({
        elsewhere: [address("other", "items")],
      });

      expect(
        names(collectMaterializerWritersForLog(
          index,
          log([address("doc", "items")]),
        )),
      ).toEqual([]);
    });

    it("returns a materializer once when several reads overlap it", () => {
      const { index } = createIndex({
        wide: [address("doc"), address("list")],
      });

      expect(
        names(collectMaterializerWritersForLog(
          index,
          log(
            [address("doc", "a"), address("list", "b")],
            [address("doc", "c")],
          ),
        )),
      ).toEqual(["wide"]);
    });

    it("returns writers in the order the reads first reach them through the index", () => {
      // `late` is indexed on the first read's entity but overlaps only the
      // second read; it still precedes `early`, which the first read reaches
      // after it and overlaps.

      const { index } = createIndex({
        late: [address("doc", "summary"), address("list", "items")],
        early: [address("doc", "items")],
      });

      expect(
        names(collectMaterializerWritersForLog(
          index,
          log([address("doc", "items"), address("list", "items", "0")]),
        )),
      ).toEqual(["late", "early"]);
    });

    it("omits the excluded action", () => {
      const { index, actions } = createIndex({
        self: [address("doc", "items")],
        other: [address("doc")],
      });

      expect(
        names(collectMaterializerWritersForLog(
          index,
          log([address("doc", "items")]),
          { exclude: actions.get("self") },
        )),
      ).toEqual(["other"]);
    });

    it("omits effects", () => {
      const { index } = createIndex({
        effect: [address("doc", "items")],
        computation: [address("doc")],
      }, ["effect"]);

      expect(
        names(collectMaterializerWritersForLog(
          index,
          log([address("doc", "items")]),
        )),
      ).toEqual(["computation"]);
    });

    it("returns the same writers, in the same order, as testing each reached materializer against the whole log", () => {
      const random = createRandom(0x5eed);
      const pick = <T>(choices: readonly T[]): T =>
        choices[Math.floor(random() * choices.length)];
      const ids = ["a", "b", "c"];
      const keys = ["x", "y", "z"];
      const randomAddress = () => {
        const path: string[] = [];
        const depth = Math.floor(random() * 4);
        for (let i = 0; i < depth; i++) path.push(pick(keys));
        return address(pick(ids), ...path);
      };

      for (let round = 0; round < 200; round++) {
        const envelopes: Record<string, IMemorySpaceAddress[]> = {};
        for (let m = 0; m < 6; m++) {
          envelopes[`m${m}`] = Array.from(
            { length: 1 + Math.floor(random() * 3) },
            randomAddress,
          );
        }
        const effects = Object.keys(envelopes).filter(() => random() < 0.2);
        const { index, actions } = createIndex(envelopes, effects);
        const reactivityLog = log(
          Array.from({ length: Math.floor(random() * 6) }, randomAddress),
          Array.from({ length: Math.floor(random() * 6) }, randomAddress),
        );
        const exclude = random() < 0.3 ? actions.get("m0") : undefined;

        expect(
          names(collectMaterializerWritersForLog(index, reactivityLog, {
            exclude,
          })),
          `round ${round}`,
        ).toEqual(names(referenceWriters(index, reactivityLog, exclude)));
      }
    });

    describe("work per call", () => {
      // Each read-against-envelope comparison reads the envelope's `space`
      // first, so a counting getter there counts the comparisons made.

      const READ_COUNT = 64;

      function countingIndex(
        envelopes: Record<string, IMemorySpaceAddress[]>,
      ): { index: MaterializerIndexState; comparisons: () => number } {
        let comparisons = 0;
        const materializersByEntity = new Map<SpaceScopeAndURI, Set<Action>>();
        const writes = new Map<Action, IMemorySpaceAddress[]>();
        for (const [name, addresses] of Object.entries(envelopes)) {
          const materializer = action(name);
          writes.set(
            materializer,
            addresses.map((plain) => ({
              ...plain,
              get space() {
                comparisons++;
                return plain.space;
              },
            })),
          );
          for (const plain of addresses) {
            const key = entityNameKey(plain);
            let indexed = materializersByEntity.get(key);
            if (!indexed) {
              indexed = new Set();
              materializersByEntity.set(key, indexed);
            }
            indexed.add(materializer);
          }
        }
        const index: MaterializerIndexState = {
          scopeKeyIdentity: identityThunk,
          materializersByEntity,
          effects: new Set(),
          getMaterializerWriteEnvelopes: (materializer) =>
            writes.get(materializer),
          isMaterializer: (materializer) => writes.has(materializer),
        };
        return { index, comparisons: () => comparisons };
      }

      const manyReads = () =>
        log(
          Array.from(
            { length: READ_COUNT },
            (_, i) => address("doc", "items", String(i)),
          ),
        );

      it("compares each read once against a materializer that none of them overlaps", () => {
        const { index, comparisons } = countingIndex({
          summary: [address("doc", "summary")],
        });

        expect(names(collectMaterializerWritersForLog(index, manyReads())))
          .toEqual([]);
        expect(comparisons()).toBe(READ_COUNT);
      });

      it("stops comparing reads against a materializer once one overlaps it", () => {
        const { index, comparisons } = countingIndex({
          first: [address("doc", "items", "0")],
        });

        expect(names(collectMaterializerWritersForLog(index, manyReads())))
          .toEqual(["first"]);
        expect(comparisons()).toBe(1);
      });
    });
  });
});
