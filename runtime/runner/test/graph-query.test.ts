import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { SchemaPathSelector } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import {
  type BaseMemoryAddress,
  createGraphQueryWalkStats,
  createSchemaMemo,
  GraphQueryWalk,
  type IAttestation,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  schemaTrackerKey,
} from "../src/graph-query.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const SPACE = "did:key:graph-query-test" as MemorySpace;

// The acting identity a walk's tracker keys resolve scoped addresses
// against (key-vocabulary.md §1 sites 5-6); these fixtures use
// space-scoped docs, whose keys are identity-independent.
const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

/** Tracker key under the test identity. */
const keyFor = (id: string) =>
  schemaTrackerKey(SPACE, id, undefined, TEST_SCOPE_IDENTITY);

/**
 * Serves documents from a map keyed by tracker key, and records every address
 * a walk asked for.
 */
class StubObjectManager implements ObjectStorageManager {
  readonly requested: string[] = [];

  readonly #documents: Map<string, FabricValue>;

  constructor(documents: Map<string, FabricValue>) {
    this.#documents = documents;
  }

  load(address: BaseMemoryAddress): IAttestation | null {
    const key = schemaTrackerKey(
      SPACE,
      address.id,
      address.scope,
      TEST_SCOPE_IDENTITY,
    );
    this.requested.push(key);
    const value = this.#documents.get(key);
    if (value === undefined) {
      return null;
    }
    return { address: { ...address, path: [] }, value: { value } };
  }
}

const documentFor = (
  manager: StubObjectManager,
  id: string,
): IAttestation => {
  const loaded = manager.load({ id: id as URI, type: "application/json" });
  expect(loaded).not.toBe(null);
  return loaded!;
};

const linkTo = (id: string, path: string[] = []) => ({
  "/": { [LINK_V1_TAG]: { id, path } },
});

const walkOver = (
  documents: Map<string, FabricValue>,
  overrides: {
    schemaTracker?: MapSetStringToPathSelectors;
    memo?: ReturnType<typeof createSchemaMemo>;
    stats?: ReturnType<typeof createGraphQueryWalkStats>;
  } = {},
) => {
  const manager = new StubObjectManager(documents);
  const schemaTracker = overrides.schemaTracker ??
    new MapSetStringToPathSelectors(true);
  const walk = new GraphQueryWalk({
    manager,
    space: SPACE,
    schemaTracker,
    identity: TEST_SCOPE_IDENTITY,
    ...(overrides.memo === undefined ? {} : { memo: overrides.memo }),
    ...(overrides.stats === undefined ? {} : { stats: overrides.stats }),
  });
  return { manager, schemaTracker, walk };
};

const trackedKeys = (tracker: MapSetStringToPathSelectors): string[] =>
  [...tracker].map(([key]) => key).toSorted();

describe("graph-query", () => {
  describe("schemaTrackerKey()", () => {
    it("keys a scoped address by its resolved scope INSTANCE", () => {
      expect(
        schemaTrackerKey(
          "did:key:space",
          "of:doc",
          "session",
          TEST_SCOPE_IDENTITY,
        ),
      ).toBe(
        "did:key:space/session:did%3Atest%3Aalice:session-1/of:doc",
      );
    });

    it("returns a space-scoped key when no scope is given", () => {
      expect(
        schemaTrackerKey("did:key:space", "of:doc", undefined, {
          principal: "did:test:someone-else",
        }),
      ).toBe(
        "did:key:space/space/of:doc",
      );
    });
  });

  describe("GraphQueryWalk", () => {
    describe("visit()", () => {
      it("records the visited document under its tracker key", () => {
        const documents = new Map<string, FabricValue>([
          [keyFor("of:root"), { title: "Glazed" }],
        ]);
        const { manager, schemaTracker, walk } = walkOver(documents);

        walk.visit(
          documentFor(manager, "of:root"),
          {
            path: ["value"],
            schema: true,
          } satisfies SchemaPathSelector,
        );

        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:root"),
        ]);
      });

      it("records under the caller's explicit instance key when one is given", () => {
        // A query root naming an explicit scope instance (protocol.md §2's
        // read row) records under THAT instance rather than one resolved
        // from the walk's own identity. Traversal beyond that entry still
        // resolves under the acting identity — including the traverser's
        // own read-track of the root document (per-run deep threading is
        // the Phase 2 fan-out work) — so both keys appear.
        const documents = new Map<string, FabricValue>([
          [keyFor("of:root"), { title: "Glazed" }],
        ]);
        const { manager, schemaTracker, walk } = walkOver(documents);
        const explicitKey = `${SPACE}/user:did%3Atest%3Abob/of:root` as const;

        walk.visit(
          documentFor(manager, "of:root"),
          {
            path: ["value"],
            schema: true,
          } satisfies SchemaPathSelector,
          explicitKey,
        );

        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:root"),
          explicitKey,
        ]);
      });

      it("records a linked document the schema reaches", () => {
        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:root"),
            { glaze: linkTo("of:glaze", ["value"]) },
          ],
          [keyFor("of:glaze"), { flavor: "maple" }],
        ]);
        const { manager, schemaTracker, walk } = walkOver(documents);

        walk.visit(
          documentFor(manager, "of:root"),
          {
            path: ["value"],
            schema: true,
          } satisfies SchemaPathSelector,
        );

        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:glaze"),
          keyFor("of:root"),
        ]);
      });

      describe("over an inline object held in an array", () => {
        // The object holds a link that names no document, so the link
        // resolves inside the document that stores it. The schema reaches
        // `shared` by that link alone, so the walk records the glaze document
        // only by following it.

        const glazeSchema = {
          type: "object",
          properties: { flavor: { type: "string" } },
          additionalProperties: false,
        } as const;
        const selector = {
          path: ["value"],
          schema: {
            type: "object",
            properties: {
              donuts: {
                type: "array",
                items: {
                  type: "object",
                  properties: { glaze: glazeSchema },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        } as const satisfies SchemaPathSelector;
        const documents = () =>
          new Map<string, FabricValue>([
            [
              keyFor("of:root"),
              {
                donuts: [{
                  glaze: { "/": { [LINK_V1_TAG]: { path: ["shared"] } } },
                }],
                shared: linkTo("of:glaze"),
              },
            ],
            [keyFor("of:glaze"), { flavor: "maple" }],
          ]);

        it("records a document reached by a path-only link inside the object", () => {
          const { manager, schemaTracker, walk } = walkOver(documents());

          walk.visit(documentFor(manager, "of:root"), selector);

          expect(trackedKeys(schemaTracker)).toEqual([
            keyFor("of:glaze"),
            keyFor("of:root"),
          ]);
        });

        it("names the stored document as the referrer of a missing document linked from inside the object", () => {
          // A miss is retired when its referrer is walked again without the
          // link, so the referrer has to be a document a walk can visit.
          const manager = new StubObjectManager(
            new Map<string, FabricValue>([
              [keyFor("of:root"), { donuts: [{ glaze: linkTo("of:absent") }] }],
            ]),
          );
          const misses: { missKey: string; referrerKey?: string }[] = [];
          const walk = new GraphQueryWalk({
            manager,
            space: SPACE,
            schemaTracker: new MapSetStringToPathSelectors(true),
            identity: TEST_SCOPE_IDENTITY,
            onMissedDoc: (missKey, _selector, referrerKey) => {
              misses.push({ missKey, referrerKey });
            },
          });

          walk.visit(documentFor(manager, "of:root"), selector);

          expect(misses).toEqual([
            { missKey: keyFor("of:absent"), referrerKey: keyFor("of:root") },
          ]);
        });
      });

      it("leaves a document the schema excludes out of the tracker", () => {
        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:root"),
            {
              flavor: "maple",
              glaze: linkTo("of:glaze", ["value"]),
            },
          ],
          [keyFor("of:glaze"), { flavor: "maple" }],
        ]);
        const { manager, schemaTracker, walk } = walkOver(documents);

        walk.visit(
          documentFor(manager, "of:root"),
          {
            path: ["value"],
            schema: {
              type: "object",
              properties: { flavor: { type: "string" } },
              additionalProperties: false,
            },
          } satisfies SchemaPathSelector,
        );

        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:root"),
        ]);
      });

      it("counts a skip and records nothing when the tracker already covers the selector", () => {
        const documents = new Map<string, FabricValue>([
          [keyFor("of:root"), { title: "Glazed" }],
        ]);
        const { manager, schemaTracker, walk } = walkOver(documents);
        const selector = {
          path: ["value"],
          schema: true,
        } satisfies SchemaPathSelector;
        const document = documentFor(manager, "of:root");

        walk.visit(document, selector);
        const afterFirst = manager.requested.length;
        walk.visit(document, selector);

        expect(walk.stats.coveredSelectorSkips).toBe(1);
        expect(manager.requested.length).toBe(afterFirst);
        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:root"),
        ]);
      });

      it("records a document whose value is absent without traversing it", () => {
        const documents = new Map<string, FabricValue>();
        const { schemaTracker, walk } = walkOver(documents);

        walk.visit(
          {
            address: {
              id: "of:missing" as URI,
              type: "application/json",
              path: [],
            },
            value: undefined,
          },
          { path: ["value"], schema: true } satisfies SchemaPathSelector,
        );

        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:missing"),
        ]);
        expect(walk.stats.schemaTraversals).toBe(0);
      });

      it("accumulates traversal counters into the caller's stats", () => {
        const documents = new Map<string, FabricValue>([
          [keyFor("of:one"), { title: "Glazed" }],
          [keyFor("of:two"), { title: "Jelly" }],
        ]);
        const stats = createGraphQueryWalkStats();
        const { manager, walk } = walkOver(documents, { stats });
        const selector = {
          path: ["value"],
          schema: true,
        } satisfies SchemaPathSelector;

        walk.visit(documentFor(manager, "of:one"), selector);
        const afterFirst = stats.schemaTraversals;
        walk.visit(documentFor(manager, "of:two"), selector);

        expect(walk.stats).toBe(stats);
        expect(afterFirst).toBeGreaterThan(0);
        expect(stats.schemaTraversals).toBeGreaterThan(afterFirst);
      });

      it("terminates on a cycle of documents that link to each other", () => {
        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:a"),
            { peer: linkTo("of:b", ["value"]) },
          ],
          [
            keyFor("of:b"),
            { peer: linkTo("of:a", ["value"]) },
          ],
        ]);
        const { manager, schemaTracker, walk } = walkOver(documents);

        walk.visit(
          documentFor(manager, "of:a"),
          { path: ["value"], schema: true } satisfies SchemaPathSelector,
        );

        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:a"),
          keyFor("of:b"),
        ]);
      });

      it("records the same reach whether two roots share one walk or take one each", () => {
        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:one"),
            { glaze: linkTo("of:glaze", ["value"]) },
          ],
          [
            keyFor("of:two"),
            { glaze: linkTo("of:glaze", ["value"]) },
          ],
          [keyFor("of:glaze"), { flavor: "maple" }],
        ]);
        const selector = {
          path: ["value"],
          schema: true,
        } satisfies SchemaPathSelector;

        const shared = walkOver(documents);
        shared.walk.visit(documentFor(shared.manager, "of:one"), selector);
        shared.walk.visit(documentFor(shared.manager, "of:two"), selector);

        const separateTracker = new MapSetStringToPathSelectors(true);
        const first = walkOver(documents, { schemaTracker: separateTracker });
        first.walk.visit(documentFor(first.manager, "of:one"), selector);
        const second = walkOver(documents, { schemaTracker: separateTracker });
        second.walk.visit(documentFor(second.manager, "of:two"), selector);

        expect(trackedKeys(shared.schemaTracker)).toEqual([
          keyFor("of:glaze"),
          keyFor("of:one"),
          keyFor("of:two"),
        ]);
        expect(trackedKeys(separateTracker)).toEqual(
          trackedKeys(shared.schemaTracker),
        );
      });

      it("adds to a schema tracker shared with an earlier walk", () => {
        const documents = new Map<string, FabricValue>([
          [keyFor("of:one"), { title: "Glazed" }],
          [keyFor("of:two"), { title: "Jelly" }],
        ]);
        const schemaTracker = new MapSetStringToPathSelectors(true);
        const selector = {
          path: ["value"],
          schema: true,
        } satisfies SchemaPathSelector;

        const first = walkOver(documents, { schemaTracker });
        first.walk.visit(documentFor(first.manager, "of:one"), selector);
        const second = walkOver(documents, { schemaTracker });
        second.walk.visit(documentFor(second.manager, "of:two"), selector);

        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:one"),
          keyFor("of:two"),
        ]);
      });

      it("reports a memo hit when a later walk sharing the memo re-reaches a document", () => {
        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:one"),
            { glaze: linkTo("of:glaze", ["value"]) },
          ],
          [
            keyFor("of:two"),
            { glaze: linkTo("of:glaze", ["value"]) },
          ],
          [keyFor("of:glaze"), { flavor: "maple" }],
        ]);
        const memo = createSchemaMemo();
        const selector = {
          path: ["value"],
          schema: {
            type: "object",
            properties: {
              glaze: {
                type: "object",
                properties: { flavor: { type: "string" } },
              },
            },
          },
        } satisfies SchemaPathSelector;

        const first = walkOver(documents, { memo });
        first.walk.visit(documentFor(first.manager, "of:one"), selector);
        const second = walkOver(documents, { memo });
        second.walk.visit(documentFor(second.manager, "of:two"), selector);

        expect(first.walk.stats.schemaMemoHits).toBe(0);
        expect(second.walk.stats.schemaMemoHits).toBeGreaterThan(0);
      });
    });
  });
});
