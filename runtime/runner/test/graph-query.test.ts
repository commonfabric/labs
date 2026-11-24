import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema, SchemaPathSelector } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { UNAVAILABLE_PENDING } from "@commonfabric/data-model/availability";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import {
  type BaseMemoryAddress,
  createGraphQueryWalkStats,
  createSchemaMemo,
  GraphQueryWalk,
  type GraphQueryWalkOptions,
  type IAttestation,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  schemaTrackerKey,
  trackedRecordKey,
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
    // A storage engine names every document it serves with its scope, so
    // that a link inside one resolves in that scope.
    return {
      address: { ...address, scope: address.scope ?? "space", path: [] },
      value: { value },
    };
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
    onTrackedDoc?: GraphQueryWalkOptions["onTrackedDoc"];
    onMissedDoc?: GraphQueryWalkOptions["onMissedDoc"];
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
    ...(overrides.onTrackedDoc === undefined
      ? {}
      : { onTrackedDoc: overrides.onTrackedDoc }),
    ...(overrides.onMissedDoc === undefined
      ? {}
      : { onMissedDoc: overrides.onMissedDoc }),
  });
  return { manager, schemaTracker, walk };
};

const trackedKeys = (tracker: MapSetStringToPathSelectors): string[] =>
  [...tracker].map(([key]) => key).toSorted();

/**
 * Two selectors of `of:list` that differ at its root, where the second also
 * reaches `note`, and agree on `properties`.
 */
const selectorPair = (
  properties: Record<string, JSONSchema>,
): [SchemaPathSelector, SchemaPathSelector] => [
  { path: ["value"], schema: { type: "object", properties } },
  {
    path: ["value"],
    schema: {
      type: "object",
      properties: { ...properties, note: { type: "string" } },
    },
  },
];

/** The key of `of:list`'s record under `selector`. */
const listRecord = (selector: SchemaPathSelector) =>
  trackedRecordKey(keyFor("of:list"), selector);

/**
 * Walks `of:list` under `first` and then under `second`, sharing a tracker
 * and a memo, calling `between` in between, and returns each walk with the
 * walked attributions it reported, as `key path referrer`, and the misses, as
 * `key referrer`.
 */
const walkListTwice = (
  documents: Map<string, FabricValue>,
  first: SchemaPathSelector,
  second: SchemaPathSelector,
  between: (tracker: MapSetStringToPathSelectors) => void = () => {},
) => {
  const schemaTracker = new MapSetStringToPathSelectors(true);
  const memo = createSchemaMemo();
  const walkUnder = (selector: SchemaPathSelector) => {
    const reports: string[] = [];
    const misses: string[] = [];
    const walked = walkOver(documents, {
      schemaTracker,
      memo,
      onTrackedDoc: (key, selector, referrer, kind) => {
        if (kind === "walked") {
          reports.push(`${key} ${selector.path.join("/")} ${referrer}`);
        }
      },
      onMissedDoc: (key, _selector, referrer) => {
        misses.push(`${key} ${referrer}`);
      },
    });
    walked.walk.visit(
      documentFor(walked.manager, "of:list"),
      selector,
      undefined,
      "root",
    );
    return { ...walked, reports, misses };
  };
  const one = walkUnder(first);
  between(schemaTracker);
  const two = walkUnder(second);
  return { one, two };
};

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
      it("tracks a child query while an unavailable ancestor stands in for it", () => {
        const { manager, schemaTracker, walk } = walkOver(
          new Map([
            [keyFor("of:root"), UNAVAILABLE_PENDING],
          ]),
        );
        walk.visit(documentFor(manager, "of:root"), {
          path: ["value", "files", "length"],
          schema: { type: "number" },
        });
        expect(trackedKeys(schemaTracker)).toEqual([keyFor("of:root")]);
      });

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
        // from the walk's own identity. Traversal beyond that entry
        // resolves under the acting identity, including the traverser's own
        // read-track of the root document, so both keys appear.
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

      it("follows no link whose scope the walk's identity resolves no instance of", () => {
        // The walk acts as a principal with no session. `of:root` links to
        // `of:draft` in the session scope, and to `of:glaze` in its own.

        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:root"),
            {
              draft: {
                "/": {
                  [LINK_V1_TAG]: { id: "of:draft", path: [], scope: "session" },
                },
              },
              glaze: linkTo("of:glaze"),
            },
          ],
          [keyFor("of:glaze"), { flavor: "maple" }],
        ]);
        const manager = new StubObjectManager(documents);
        const schemaTracker = new MapSetStringToPathSelectors(true);
        const misses: string[] = [];
        const walk = new GraphQueryWalk({
          manager,
          space: SPACE,
          schemaTracker,
          identity: { principal: TEST_SCOPE_IDENTITY.principal },
          onMissedDoc: (key) => misses.push(key),
        });

        walk.visit(
          documentFor(manager, "of:root"),
          {
            path: ["value"],
            schema: {
              type: "object",
              properties: {
                draft: { type: "object" },
                glaze: { type: "object" },
              },
            },
          } satisfies SchemaPathSelector,
        );

        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:glaze"),
          keyFor("of:root"),
        ]);
        expect(misses).toEqual([]);
        expect(manager.requested.filter((key) => key.endsWith("/of:draft")))
          .toEqual([]);
      });

      it("follows no such link under a selector that reaches everything, in a walk that attributes what it records", () => {
        // As above, under `schema: true`, which the traversal walks without
        // a schema, and with `onTrackedDoc`, which has it attribute each
        // position to the record walking it.

        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:root"),
            {
              draft: {
                "/": {
                  [LINK_V1_TAG]: { id: "of:draft", path: [], scope: "session" },
                },
              },
              glaze: linkTo("of:glaze"),
            },
          ],
          [keyFor("of:glaze"), { flavor: "maple" }],
        ]);
        const manager = new StubObjectManager(documents);
        const schemaTracker = new MapSetStringToPathSelectors(true);
        const misses: string[] = [];
        const walk = new GraphQueryWalk({
          manager,
          space: SPACE,
          schemaTracker,
          identity: { principal: TEST_SCOPE_IDENTITY.principal },
          onMissedDoc: (key) => misses.push(key),
          onTrackedDoc: () => {},
        });

        walk.visit(
          documentFor(manager, "of:root"),
          { path: ["value"], schema: true } satisfies SchemaPathSelector,
        );

        expect(trackedKeys(schemaTracker)).toEqual([
          keyFor("of:glaze"),
          keyFor("of:root"),
        ]);
        expect(misses).toEqual([]);
        expect(manager.requested.filter((key) => key.endsWith("/of:draft")))
          .toEqual([]);
      });

      it("throws at a user-scoped link for a walk whose identity names no principal", () => {
        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:root"),
            {
              prefs: {
                "/": {
                  [LINK_V1_TAG]: { id: "of:prefs", path: [], scope: "user" },
                },
              },
            },
          ],
        ]);
        const manager = new StubObjectManager(documents);
        const walk = new GraphQueryWalk({
          manager,
          space: SPACE,
          schemaTracker: new MapSetStringToPathSelectors(true),
          identity: {},
        });

        expect(() =>
          walk.visit(
            documentFor(manager, "of:root"),
            {
              path: ["value"],
              schema: {
                type: "object",
                properties: { prefs: { type: "object" } },
              },
            } satisfies SchemaPathSelector,
          )
        ).toThrow("user scoped memory operations require a principal");
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
          // link, so the referrer has to be a record of a document a walk
          // can visit: the stored document under the visit's selector.
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
            {
              missKey: keyFor("of:absent"),
              referrerKey: trackedRecordKey(keyFor("of:root"), selector),
            },
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

      describe("attributing by record", () => {
        // `of:x` links first to `of:y`, which links back to `of:x`, and
        // then to `of:z`. The root's schema reaches back into `of:x` under
        // a selector of its own, so `of:x` is entered under a second
        // record while its first is still being walked.

        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:x"),
            { first: linkTo("of:y"), last: linkTo("of:z"), tag: "x" },
          ],
          [keyFor("of:y"), { back: linkTo("of:x") }],
          [keyFor("of:z"), { n: 1 }],
        ]);
        const selector = {
          path: ["value"],
          schema: {
            type: "object",
            properties: {
              first: {
                type: "object",
                properties: {
                  back: {
                    type: "object",
                    properties: { tag: { type: "string" } },
                  },
                },
              },
              last: { type: "object", properties: { n: { type: "number" } } },
            },
          },
        } satisfies SchemaPathSelector;

        /** Visits `of:x` under `selector`, and returns each document's
         * referrers other than itself. */
        const referrers = () => {
          const recorded = new Map<string, Set<string>>();
          const { manager, walk } = walkOver(documents, {
            onTrackedDoc: (key, _selector, referrer, kind) => {
              if (
                referrer === undefined || referrer === "root" ||
                kind !== "walked" || referrer.startsWith(`${key}\0`)
              ) {
                return;
              }
              let set = recorded.get(key);
              if (set === undefined) {
                set = new Set();
                recorded.set(key, set);
              }
              set.add(referrer);
            },
          });
          walk.visit(documentFor(manager, "of:x"), selector, undefined, "root");
          return recorded;
        };

        it("attributes a linked document to the record whose walk followed the link", () => {
          expect([...referrers().get(keyFor("of:y")) ?? []]).toEqual([
            trackedRecordKey(keyFor("of:x"), selector),
          ]);
        });

        it("attributes to the outer record what its walk reaches after a walk of another record of the document ends", () => {
          const recorded = referrers();
          const inner = [...recorded.get(keyFor("of:x")) ?? []];

          // `of:x` is entered again under a record of its own, through
          // `of:y`, before the outer walk reaches `of:z`.
          expect(inner).toHaveLength(1);
          expect(inner[0].startsWith(`${keyFor("of:y")}\0`)).toBe(true);
          expect([...recorded.get(keyFor("of:z")) ?? []]).toEqual([
            trackedRecordKey(keyFor("of:x"), selector),
          ]);
        });

        it("attributes what a document entered again reaches to that record when the root names an explicit instance", () => {
          // The root's own record is kept under the instance's key, and the
          // record a link enters under the key the tracker resolves, so a
          // lookup by either key finds the record walking the document.

          const explicitKey = `${SPACE}/user:did%3Atest%3Abob/of:x` as const;
          const inner = {
            type: "object",
            properties: {
              last: { type: "object", properties: { n: { type: "number" } } },
            },
          } as const;
          const outer = {
            path: ["value"],
            schema: {
              type: "object",
              properties: {
                first: { type: "object", properties: { back: inner } },
              },
            },
          } satisfies SchemaPathSelector;
          const reports: [string, SchemaPathSelector, string | undefined][] =
            [];
          const { manager, walk } = walkOver(documents, {
            onTrackedDoc: (key, selector, referrer, kind) => {
              if (kind === "walked") reports.push([key, selector, referrer]);
            },
          });

          walk.visit(documentFor(manager, "of:x"), outer, explicitKey, "root");

          const entered = reports.filter(([key, , referrer]) =>
            key === keyFor("of:x") &&
            referrer?.startsWith(`${keyFor("of:y")}\0`)
          );
          expect(entered).toHaveLength(1);
          expect(
            reports.filter(([key]) => key === keyFor("of:z")).map((
              [, , referrer],
            ) => referrer),
          ).toEqual([trackedRecordKey(keyFor("of:x"), entered[0][1])]);
        });
      });

      describe("over a document two documents link to", () => {
        // `of:one` and `of:two` each link to `of:glaze`, which links on to
        // `of:sprinkles`. The walks share a tracker and nothing else, so
        // only the tracker can spare the second walk the shared documents.

        const documents = new Map<string, FabricValue>([
          [keyFor("of:one"), { glaze: linkTo("of:glaze") }],
          [keyFor("of:two"), { glaze: linkTo("of:glaze") }],
          [
            keyFor("of:glaze"),
            { flavor: "maple", topping: linkTo("of:sprinkles") },
          ],
          [keyFor("of:sprinkles"), { color: "rainbow" }],
        ]);
        const flavor = { flavor: { type: "string" } } as const;
        const topping = {
          topping: {
            type: "object",
            properties: { color: { type: "string" } },
          },
        } as const;
        /** A schema reaching `of:glaze`'s flavor, and its topping's color
         * with `withTopping`. */
        const glazeSchema = (
          withTopping: boolean,
        ): SchemaPathSelector["schema"] => ({
          type: "object",
          properties: {
            glaze: {
              type: "object",
              properties: withTopping ? { ...flavor, ...topping } : flavor,
            },
          },
        });

        /** Walks `of:one` and then `of:two` under `linkSelector` over one
         * tracker, after `of:glaze` under `glazeSelector` when one is given,
         * and returns the distinct attributions of `of:glaze` to other
         * documents, and the loads the second walk made. */
        const walkBoth = (
          linkSelector: SchemaPathSelector,
          glazeSelector?: SchemaPathSelector,
        ) => {
          const schemaTracker = new MapSetStringToPathSelectors(true);
          const attributions = new Set<string>();
          const onTrackedDoc: GraphQueryWalkOptions["onTrackedDoc"] = (
            key,
            _selector,
            referrer,
            kind,
          ) => {
            // A referrer is a record; its key leads with its document's.
            const document = referrer?.split("\0")[0];
            if (
              key === keyFor("of:glaze") && document !== undefined &&
              document !== key
            ) {
              attributions.add(`${kind} ${document}`);
            }
          };
          if (glazeSelector !== undefined) {
            const root = walkOver(documents, { schemaTracker, onTrackedDoc });
            root.walk.visit(
              documentFor(root.manager, "of:glaze"),
              glazeSelector,
            );
          }
          const first = walkOver(documents, { schemaTracker, onTrackedDoc });
          first.walk.visit(documentFor(first.manager, "of:one"), linkSelector);
          const second = walkOver(documents, { schemaTracker, onTrackedDoc });
          second.walk.visit(
            documentFor(second.manager, "of:two"),
            linkSelector,
          );
          return {
            attributions: [...attributions].toSorted(),
            secondLoads: second.manager.requested,
            schemaTracker,
          };
        };

        it("attributes the shared document to each linking document as a walker, and loads it once", () => {
          const { attributions, secondLoads, schemaTracker } = walkBoth({
            path: ["value"],
            schema: glazeSchema(true),
          });

          expect(attributions).toEqual([
            `walked ${keyFor("of:one")}`,
            `walked ${keyFor("of:two")}`,
          ]);
          expect(secondLoads).not.toContain(keyFor("of:glaze"));
          expect(secondLoads).not.toContain(keyFor("of:sprinkles"));
          expect(trackedKeys(schemaTracker)).toEqual([
            keyFor("of:glaze"),
            keyFor("of:one"),
            keyFor("of:sprinkles"),
            keyFor("of:two"),
          ]);
        });

        it("attributes the shared document to a linking document as covered when a wider record covers it", () => {
          // The linking walks need `of:glaze`'s flavor alone; a walk of
          // `of:glaze` itself made a record under `true`, which covers that.
          const { attributions, secondLoads } = walkBoth(
            { path: ["value"], schema: glazeSchema(false) },
            { path: ["value"], schema: true },
          );

          expect(attributions).toEqual([
            `covered ${keyFor("of:one")}`,
            `covered ${keyFor("of:two")}`,
          ]);
          expect(secondLoads).not.toContain(keyFor("of:glaze"));
        });
      });

      describe("over a position two records of one document traverse", () => {
        // `of:list` is walked under two selectors that differ at its root
        // and agree at `row` and `lost`, so the walk of the second record
        // meets those positions memoized by the walk of the first. `row`
        // links to `of:row`, which links on to `of:child`; `lost` links to
        // a document that does not exist.

        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:list"),
            { row: linkTo("of:row"), lost: linkTo("of:absent"), note: "n" },
          ],
          [keyFor("of:row"), { label: "a", child: linkTo("of:child") }],
          [keyFor("of:child"), { n: 1 }],
        ]);
        const properties = {
          row: {
            type: "object",
            properties: {
              label: { type: "string" },
              child: { type: "object", properties: { n: { type: "number" } } },
            },
          },
          lost: { type: "object" },
        } as const;
        const [first, second] = selectorPair(properties);

        it("attributes the reach of a memoized position to the second record", () => {
          const { one, two } = walkListTwice(documents, first, second);

          expect(one.reports).toContain(
            `${keyFor("of:row")} value ${listRecord(first)}`,
          );
          expect(two.reports).toContain(
            `${keyFor("of:row")} value ${listRecord(second)}`,
          );
          expect(two.walk.stats.schemaMemoHits).toBeGreaterThan(0);
        });

        it("attributes a miss inside a memoized position to the second record", () => {
          const { one, two } = walkListTwice(documents, first, second);

          expect(one.misses).toEqual([
            `${keyFor("of:absent")} ${listRecord(first)}`,
          ]);
          expect(two.misses).toEqual([
            `${keyFor("of:absent")} ${listRecord(second)}`,
          ]);
        });

        it("walks a memoized position again when a record it reached has left the tracker", () => {
          // The record of `of:row` leaves the tracker between the walks, as
          // a retired record does, taking with it what its walk reached, so
          // only walking `of:row` again restores the attribution of
          // `of:child`.

          const { two } = walkListTwice(
            documents,
            first,
            second,
            (tracker) => {
              for (const selector of [...tracker.values(keyFor("of:row"))]) {
                tracker.deleteValue(keyFor("of:row"), selector);
              }
            },
          );

          expect(two.manager.requested).toContain(keyFor("of:row"));
          expect(two.schemaTracker.has(keyFor("of:row"))).toBe(true);
          expect(
            two.reports.filter((report) =>
              report.startsWith(
                `${keyFor("of:child")} value ${keyFor("of:row")}\0`,
              )
            ),
          ).toHaveLength(1);
        });
      });

      it("attributes a record of the document a memoized position links back into, and what follows it, to the second record", () => {
        // `box.self` links back into `of:list` itself, at `inner`, so the
        // walk of each record of `of:list` enters a record of its own
        // document there, and what `inner` reaches is that record's.
        // `box.z`, after it, is the walking record's own again.

        const documents = new Map<string, FabricValue>([
          [
            keyFor("of:list"),
            {
              box: { self: linkTo("of:list", ["inner"]), z: linkTo("of:z") },
              inner: { k: linkTo("of:x") },
              note: "n",
            },
          ],
          [keyFor("of:x"), { n: 1 }],
          [keyFor("of:z"), { n: 2 }],
        ]);
        const n = {
          type: "object",
          properties: { n: { type: "number" } },
        } as const;
        const [first, second] = selectorPair({
          box: {
            type: "object",
            properties: {
              self: { type: "object", properties: { k: n } },
              z: n,
            },
          },
        });

        const { two } = walkListTwice(documents, first, second);

        expect(
          two.reports.filter((report) =>
            report.startsWith(`${keyFor("of:list")} value/inner `) ||
            report.startsWith(`${keyFor("of:z")} `)
          ).toSorted(),
        ).toEqual([
          `${keyFor("of:list")} value/inner ${listRecord(second)}`,
          `${keyFor("of:z")} value ${listRecord(second)}`,
        ].toSorted());
        expect(
          two.reports.filter((report) => report.startsWith(keyFor("of:x"))),
        ).toEqual([]);
      });

      it("attributes a record a memoized position names itself through to the second record", () => {
        // `self` links to the whole of `of:list`, so the first record's walk
        // of `self` reaches that record itself. The second record's walk of
        // `self` reaches the first record.

        const documents = new Map<string, FabricValue>([
          [keyFor("of:list"), { self: linkTo("of:list"), note: "n" }],
        ]);
        const $defs = {
          Node: {
            type: "object",
            properties: { self: { $ref: "#/$defs/Node" } },
          },
        } as const;
        const first = {
          path: ["value"],
          schema: { $ref: "#/$defs/Node", $defs },
        } satisfies SchemaPathSelector;
        const second = {
          path: ["value"],
          schema: {
            type: "object",
            properties: {
              self: { $ref: "#/$defs/Node" },
              note: { type: "string" },
            },
            $defs,
          },
        } satisfies SchemaPathSelector;

        const schemaTracker = new MapSetStringToPathSelectors(true);
        const memo = createSchemaMemo();
        const walkUnder = (selector: SchemaPathSelector) => {
          const attributed = new Set<string>();
          const { manager, walk } = walkOver(documents, {
            schemaTracker,
            memo,
            onTrackedDoc: (key, reported, referrer) => {
              attributed.add(`${trackedRecordKey(key, reported)} ${referrer}`);
            },
          });
          walk.visit(
            documentFor(manager, "of:list"),
            selector,
            undefined,
            "root",
          );
          return attributed;
        };
        walkUnder(first);
        const attributed = walkUnder(second);

        expect([...attributed]).toContain(
          `${listRecord(first)} ${listRecord(second)}`,
        );
      });

      it("attributes the reach of a position memoized under another record of the document in the same walk", () => {
        // The root reaches `of:e` twice, through `p` and `q`, under two
        // selectors, so the walk enters two records of `of:e`. Both reach
        // `x` under schemas that accept anything, which differ and so share
        // no schema memo entry, and are traversed as a plain value, whose
        // memo the second record meets.

        const documents = new Map<string, FabricValue>([
          [keyFor("of:root"), { p: linkTo("of:e"), q: linkTo("of:e") }],
          [keyFor("of:e"), { x: { y: linkTo("of:f") } }],
          [keyFor("of:f"), { n: 1 }],
        ]);
        const reports: [string, SchemaPathSelector, string | undefined][] = [];
        const { manager, walk } = walkOver(documents, {
          onTrackedDoc: (key, selector, referrer, kind) => {
            if (kind === "walked") reports.push([key, selector, referrer]);
          },
        });

        walk.visit(
          documentFor(manager, "of:root"),
          {
            path: ["value"],
            schema: {
              type: "object",
              properties: {
                p: { type: "object", properties: { x: true } },
                q: { type: "object", properties: { x: {} } },
              },
            },
          },
          undefined,
          "root",
        );

        const records = reports.filter(([key]) => key === keyFor("of:e"))
          .map(([key, selector]) => trackedRecordKey(key, selector));
        expect(records).toHaveLength(2);
        expect(
          reports.filter(([key]) => key === keyFor("of:f")).map((
            [, , referrer],
          ) => referrer).toSorted(),
        ).toEqual(records.toSorted());
      });

      it("makes attributions linear in depth over a tree a recursive union walks twice at every node", () => {
        // Both branches of `Node` walk `ref` and `kids` under one schema, so
        // the second branch at every node meets the subtree the first
        // memoized, for the record that memoized it.

        const leaf: JSONSchema = {
          type: "object",
          properties: { n: { type: "number" } },
        };
        const branch = (
          tag: string,
          type: "string" | "number",
        ): JSONSchema => ({
          type: "object",
          properties: {
            ref: leaf,
            kids: { type: "array", items: { $ref: "#/$defs/Node" } },
            [tag]: { type },
          },
        });
        const tree = (depth: number): FabricValue => ({
          ref: linkTo("of:leaf"),
          kids: depth === 0 ? [] : [tree(depth - 1)],
        });
        const depth = 16;
        const documents = new Map<string, FabricValue>([
          [keyFor("of:tree"), tree(depth)],
          [keyFor("of:leaf"), { n: 1 }],
        ]);
        let attributions = 0;
        const { manager, walk } = walkOver(documents, {
          onTrackedDoc: () => {
            attributions++;
          },
        });

        walk.visit(
          documentFor(manager, "of:tree"),
          {
            path: ["value"],
            schema: {
              $ref: "#/$defs/Node",
              $defs: {
                Node: {
                  anyOf: [branch("a", "string"), branch("b", "number")],
                },
              },
            },
          },
          undefined,
          "root",
        );

        expect(attributions).toBeLessThan(2 * depth);
      });

      it("reaches the same documents from each root whether the walks share a memo or not", () => {
        // Five documents linking to one another, cycles included, walked from
        // four roots in turn over one tracker. The first root's walk meets
        // `of:d0.f2` while a walk through `of:d4` and `of:d0` is in progress
        // around it, which cuts that walk short; the last root's walk reaches
        // `of:d0.f2` from `of:d0` itself, where nothing is in progress.

        const at = (id: string, path: string[] = []) => linkTo(id, path);
        const documents = new Map<string, FabricValue>([
          [keyFor("of:d0"), {
            f0: { f1: at("of:d3") },
            f1: 0,
            f2: { f0: at("of:d4", ["f2"]), f2: at("of:d4") },
          }],
          [keyFor("of:d1"), { f0: 2, f1: at("of:d0", ["f0"]), f2: 0 }],
          [keyFor("of:d2"), {
            f0: {
              f0: 2,
              f1: { f0: 1, f1: at("of:d4") },
              f2: { f0: at("of:d3"), f1: at("of:d2"), f2: 0 },
            },
            f1: at("of:d0"),
            f2: 0,
          }],
          [keyFor("of:d3"), {
            f0: { f1: at("of:d3", ["f2"]), f2: at("of:d0", ["f2"]) },
            f1: { f2: 1 },
            f2: at("of:d4", ["f1"]),
          }],
          [keyFor("of:d4"), {
            f0: { f1: { f1: 2, f2: at("of:d0") } },
            f1: 0,
            f2: at("of:d1"),
          }],
        ]);
        const node = (properties: string[], ref: string): JSONSchema => ({
          type: "object",
          properties: Object.fromEntries(
            properties.map((property) => [property, { $ref: ref }]),
          ),
        });
        const $defs = {
          A: node(["f0", "f1", "f2"], "#/$defs/A"),
          B: node(["f0", "f1"], "#/$defs/B"),
          C: {
            anyOf: [
              node(["f0", "f2"], "#/$defs/C"),
              node(["f1", "f2"], "#/$defs/C"),
            ],
          },
          D: node(["f1", "f2"], "#/$defs/A"),
        };
        const roots = [
          ["root0", "of:d2", "D"],
          ["root1", "of:d3", "C"],
          ["root2", "of:d3", "B"],
          ["root3", "of:d0", "C"],
        ] as const;

        /** Walks every root, then the first two again, over one tracker,
         * and returns the documents each root reaches. */
        const reaches = (memo?: ReturnType<typeof createSchemaMemo>) => {
          const schemaTracker = new MapSetStringToPathSelectors(true);
          const edges = new Map<string, Set<string>>();
          const documentOf = new Map<string, string>();
          for (const [name, id, def] of [...roots, ...roots.slice(0, 2)]) {
            const { manager, walk } = walkOver(documents, {
              schemaTracker,
              ...(memo === undefined ? {} : { memo }),
              onTrackedDoc: (key, selector, referrer) => {
                const record = trackedRecordKey(key, selector);
                documentOf.set(record, key);
                let reached = edges.get(referrer ?? "");
                if (reached === undefined) {
                  reached = new Set();
                  edges.set(referrer ?? "", reached);
                }
                reached.add(record);
              },
            });
            walk.visit(
              documentFor(manager, id),
              {
                path: ["value"],
                schema: { $ref: `#/$defs/${def}`, $defs },
              },
              undefined,
              name,
            );
          }
          return roots.map(([name]) => {
            const seen = new Set<string>([name]);
            const pending: string[] = [name];
            for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
              for (const record of edges.get(at) ?? []) {
                if (!seen.has(record)) {
                  seen.add(record);
                  pending.push(record);
                }
              }
            }
            return [
              ...new Set(
                [...seen].flatMap((record) => documentOf.get(record) ?? []),
              ),
            ].toSorted();
          });
        };

        // Each walk given no memo takes a memo of its own.
        expect(reaches(createSchemaMemo())).toEqual(reaches());
      });

      it("traverses a tree whose nodes link back to its root, under a recursive union, in work linear in its depth", () => {
        // Every node's `up` links back to the root, which is being traversed
        // throughout, so the cycle tracker cuts every walk through `up` short
        // at the root. Both branches of `Node` walk `kids` under one schema,
        // so the second branch at every node meets the subtree the first
        // memoized for the same record in the same visit.

        const leaf: JSONSchema = {
          type: "object",
          properties: { n: { type: "number" } },
        };
        const branch = (
          tag: string,
          type: "string" | "number",
        ): JSONSchema => ({
          type: "object",
          properties: {
            ref: leaf,
            up: { $ref: "#/$defs/Node" },
            kids: { type: "array", items: { $ref: "#/$defs/Node" } },
            [tag]: { type },
          },
        });
        const tree = (depth: number): FabricValue => ({
          ref: linkTo("of:leaf"),
          up: linkTo("of:tree"),
          kids: depth === 0 ? [] : [tree(depth - 1)],
        });
        const depth = 12;
        const stats = createGraphQueryWalkStats();
        const { manager, walk } = walkOver(
          new Map<string, FabricValue>([
            [keyFor("of:tree"), tree(depth)],
            [keyFor("of:leaf"), { n: 1 }],
          ]),
          { stats, onTrackedDoc: () => {} },
        );

        walk.visit(
          documentFor(manager, "of:tree"),
          {
            path: ["value"],
            schema: {
              $ref: "#/$defs/Node",
              $defs: {
                Node: {
                  anyOf: [branch("a", "string"), branch("b", "number")],
                },
              },
            },
          },
          undefined,
          "root",
        );

        expect(stats.schemaTraversals).toBeLessThan(40 * depth);
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

      describe("over data deeper than the stack", () => {
        // A walk that took stack frames for each level of the data would run
        // out of stack long before a chain this long, or a document nested
        // this deep.
        const chainLength = 10_000;
        const nestingDepth = 3_000;

        /**
         * `length` documents `of:chain-0` onward, each linking to the next
         * through `next`.
         */
        const chainOf = (length: number) => {
          const documents = new Map<string, FabricValue>();
          for (let i = 0; i < length; i++) {
            documents.set(
              keyFor(`of:chain-${i}`),
              i + 1 < length
                ? { label: i, next: linkTo(`of:chain-${i + 1}`) }
                : { label: i },
            );
          }
          return documents;
        };

        /**
         * A value nested `nestingDepth` levels through `child`, alternating
         * between `unionTree`'s two shapes, whose deepest level is `leaf`.
         */
        const nestedOf = (leaf: FabricValue) => {
          let value: FabricValue = leaf;
          for (let i = nestingDepth - 1; i >= 0; i--) {
            value = i % 2 === 0
              ? { a: `${i}`, child: value }
              : { b: `${i}`, child: value };
          }
          return value;
        };

        /**
         * Every level an object of one of two shapes, both reaching the next
         * level through `child`.
         */
        const unionTree: JSONSchema = {
          $defs: {
            Tree: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    a: { type: "string" },
                    child: { $ref: "#/$defs/Tree" },
                  },
                  required: ["a"],
                },
                {
                  type: "object",
                  properties: {
                    b: { type: "string" },
                    child: { $ref: "#/$defs/Tree" },
                  },
                  required: ["b"],
                },
              ],
            },
          },
          $ref: "#/$defs/Tree",
        };

        /**
         * Walks `id` of `documents` under `schema`, attributing to a root,
         * and returns the keys the walk tracked.
         */
        const walkFrom = (
          documents: Map<string, FabricValue>,
          id: string,
          schema: JSONSchema,
        ) => {
          const { manager, schemaTracker, walk } = walkOver(documents, {
            onTrackedDoc: () => {},
          });
          walk.visit(
            documentFor(manager, id),
            { path: ["value"], schema },
            undefined,
            "root",
          );
          return trackedKeys(schemaTracker);
        };

        it("tracks every document of a long chain under a recursive schema", () => {
          const documents = chainOf(chainLength);

          const tracked = walkFrom(documents, "of:chain-0", {
            $defs: {
              Node: {
                type: "object",
                properties: { next: { $ref: "#/$defs/Node" } },
              },
            },
            $ref: "#/$defs/Node",
          });

          expect(tracked).toEqual([...documents.keys()].toSorted());
        });

        it("tracks every document of a long chain whose last document links back to the first", () => {
          const documents = chainOf(chainLength);
          documents.set(keyFor(`of:chain-${chainLength - 1}`), {
            label: chainLength - 1,
            next: linkTo("of:chain-0"),
          });

          const tracked = walkFrom(documents, "of:chain-0", {
            $defs: {
              Node: {
                type: "object",
                properties: { next: { $ref: "#/$defs/Node" } },
              },
            },
            $ref: "#/$defs/Node",
          });

          expect(tracked).toEqual([...documents.keys()].toSorted());
        });

        it("tracks every document of a long chain under a schema that takes anything", () => {
          const documents = chainOf(chainLength);

          const tracked = walkFrom(documents, "of:chain-0", true);

          expect(tracked).toEqual([...documents.keys()].toSorted());
        });

        it("tracks every document of a long chain through array elements under a schema that takes anything", () => {
          const documents = new Map<string, FabricValue>();
          for (let i = 0; i < chainLength; i++) {
            documents.set(
              keyFor(`of:chain-${i}`),
              i + 1 < chainLength
                ? { label: i, rest: [linkTo(`of:chain-${i + 1}`)] }
                : { label: i, rest: [] },
            );
          }

          const tracked = walkFrom(documents, "of:chain-0", true);

          expect(tracked).toEqual([...documents.keys()].toSorted());
        });

        it("tracks every document of a long chain of links carrying their own schema under a schema that takes anything", () => {
          const node = {
            $defs: {
              Node: {
                type: "object",
                properties: { next: { $ref: "#/$defs/Node" } },
              },
            },
            $ref: "#/$defs/Node",
          } satisfies JSONSchema;
          const documents = new Map<string, FabricValue>();
          for (let i = 0; i < chainLength; i++) {
            documents.set(
              keyFor(`of:chain-${i}`),
              i + 1 < chainLength
                ? {
                  label: i,
                  next: {
                    "/": {
                      [LINK_V1_TAG]: {
                        id: `of:chain-${i + 1}`,
                        path: [],
                        schema: node,
                      },
                    },
                  },
                }
                : { label: i },
            );
          }

          const tracked = walkFrom(documents, "of:chain-0", true);

          expect(tracked).toEqual([...documents.keys()].toSorted());
        });

        it("tracks the document linked from the deepest level of a recursive union", () => {
          const documents = new Map<string, FabricValue>([
            [
              keyFor("of:tree"),
              nestedOf({ a: "leaf", child: linkTo("of:far") }),
            ],
            [keyFor("of:far"), { b: "far" }],
          ]);

          const tracked = walkFrom(documents, "of:tree", unionTree);

          expect(tracked).toEqual([keyFor("of:far"), keyFor("of:tree")]);
        });

        it("tracks the document linked from the deepest level of a recursive record", () => {
          const documents = new Map<string, FabricValue>([
            [
              keyFor("of:tree"),
              nestedOf({ a: "leaf", child: linkTo("of:far") }),
            ],
            [keyFor("of:far"), { b: "far" }],
          ]);

          const tracked = walkFrom(documents, "of:tree", {
            $defs: {
              Tree: {
                type: "object",
                properties: { child: { $ref: "#/$defs/Tree" } },
              },
            },
            $ref: "#/$defs/Tree",
          });

          expect(tracked).toEqual([keyFor("of:far"), keyFor("of:tree")]);
        });

        it("does not track a document linked from a deepest level that matches no branch", () => {
          const documents = new Map<string, FabricValue>([
            [
              keyFor("of:tree"),
              nestedOf({ c: "leaf", child: linkTo("of:far") }),
            ],
            [keyFor("of:far"), { b: "far" }],
          ]);

          const tracked = walkFrom(documents, "of:tree", unionTree);

          expect(tracked).toEqual([keyFor("of:tree")]);
        });

        it("tracks the document linked from the deepest level of nesting under a schema that takes anything", () => {
          const documents = new Map<string, FabricValue>([
            [
              keyFor("of:tree"),
              nestedOf({ a: "leaf", child: linkTo("of:far") }),
            ],
            [keyFor("of:far"), { b: "far" }],
          ]);

          const tracked = walkFrom(documents, "of:tree", true);

          expect(tracked).toEqual([keyFor("of:far"), keyFor("of:tree")]);
        });

        it("counts in its statistics the positions it hands to the traversal's own stack", () => {
          const shallow = new Map<string, FabricValue>([
            [keyFor("of:tree"), { a: "0", child: { b: "1" } }],
          ]);
          const deep = new Map<string, FabricValue>([
            [keyFor("of:tree"), nestedOf({ a: "leaf" })],
          ]);
          const handoffsOver = (documents: Map<string, FabricValue>) => {
            const { manager, walk } = walkOver(documents);
            walk.visit(
              documentFor(manager, "of:tree"),
              { path: ["value"], schema: unionTree },
              undefined,
              "root",
            );
            return walk.stats.nativeDepthHandoffs;
          };

          expect(handoffsOver(shallow)).toBe(0);
          expect(handoffsOver(deep)).toBeGreaterThan(0);
        });
      });
    });
  });
});
