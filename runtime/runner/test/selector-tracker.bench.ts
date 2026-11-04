/**
 * SelectorTracker.getSupersetSelector benchmarks.
 *
 * CPU profiles of the default-app integration flow
 * (docs/history/development/performance/default-app-note-create.md) show schema
 * standardization under getSupersetSelector as the single largest hashing
 * seam (~210ms of 574ms attributable hash/freeze time per 3 note creates):
 * getStandardSchema re-walks (isDeepFrozen + rebuild + intern-hash) every
 * fresh-identity selector schema on every superset lookup, and
 * cfc.schemaAtPath re-derives sub-schemas per tracked selector.
 *
 * The cases separate identity stability:
 * - same-identity schema (should be pure cache hits),
 * - fresh-identity structurally-equal schema (the integration shape: at most
 *   one content hash should be paid),
 * - subset path lookups that exercise the schemaAtPath derivation.
 *
 * Run with:
 *   deno bench --allow-read --allow-write --allow-net --allow-ffi \
 *     --allow-env --no-check test/selector-tracker.bench.ts
 */

import type { SchemaPathSelector } from "@commonfabric/api";
import type { JSONSchema } from "../src/builder/types.ts";
import { SelectorTracker } from "../src/storage/selector-tracker.ts";
import type { BaseMemoryAddress } from "../src/traverse.ts";

const address: BaseMemoryAddress = {
  id: "of:bench-entity" as BaseMemoryAddress["id"],
  type: "application/json",
};

/** A note-doc-like schema, structurally rebuilt per call when `fresh`. */
function noteSchema(variant: number): JSONSchema {
  return {
    type: "object",
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      meta: {
        type: "object",
        properties: {
          pinned: { type: "boolean" },
          revision: { type: "number" },
          [`extra${variant}`]: { type: "string" },
        },
      },
    },
    required: ["title"],
  };
}

function homeSchema(): JSONSchema {
  return {
    type: "object",
    properties: {
      spaceName: { type: "string" },
      items: { type: "array", items: noteSchema(0) },
      counters: {
        type: "object",
        properties: {
          notes: { type: "number" },
          pieces: { type: "number" },
        },
      },
    },
  };
}

const TRACKED_SELECTORS = 24;

function setupTracker(): SelectorTracker<void> {
  const tracker = new SelectorTracker<void>(() => ({
    principal: "did:bench:user",
    sessionId: "bench-session",
  }));
  for (let i = 0; i < TRACKED_SELECTORS; i++) {
    const selector: SchemaPathSelector = {
      path: [],
      schema: noteSchema(i) as SchemaPathSelector["schema"],
    };
    tracker.add(address, selector, Promise.resolve());
  }
  // One root selector wide enough to cover subset lookups.
  tracker.add(
    address,
    { path: [], schema: homeSchema() as SchemaPathSelector["schema"] },
    Promise.resolve(),
  );
  return tracker;
}

const tracker = setupTracker();
const stableSelector: SchemaPathSelector = {
  path: [],
  schema: noteSchema(0) as SchemaPathSelector["schema"],
};
// Warm any caches for the stable-identity case.
tracker.getSupersetSelector(address, stableSelector);

const ROUNDS = 32;

Deno.bench({
  name: "getSupersetSelector: same-identity schema (warm)",
  group: "superset selector",
  baseline: true,
}, () => {
  for (let i = 0; i < ROUNDS; i++) {
    tracker.getSupersetSelector(address, stableSelector);
  }
});

Deno.bench({
  name: "getSupersetSelector: fresh-identity equal schema",
  group: "superset selector",
}, (b) => {
  const selectors: SchemaPathSelector[] = Array.from(
    { length: ROUNDS },
    () => ({ path: [], schema: noteSchema(0) as SchemaPathSelector["schema"] }),
  );
  b.start();
  for (const selector of selectors) {
    tracker.getSupersetSelector(address, selector);
  }
  b.end();
});

Deno.bench({
  name: "getSupersetSelector: fresh subset path under tracked root",
  group: "superset selector",
}, (b) => {
  const selectors: SchemaPathSelector[] = Array.from(
    { length: ROUNDS },
    () => ({
      path: ["items"],
      schema: {
        type: "array",
        items: noteSchema(0),
      } as SchemaPathSelector["schema"],
    }),
  );
  b.start();
  for (const selector of selectors) {
    tracker.getSupersetSelector(address, selector);
  }
  b.end();
});

Deno.bench({
  name: "getSupersetSelector: no match (fresh disjoint schema)",
  group: "superset selector",
}, (b) => {
  let n = 0;
  const selectors: SchemaPathSelector[] = Array.from(
    { length: ROUNDS },
    () => ({
      path: ["unrelated"],
      schema: {
        type: "object",
        properties: { [`q${n++}`]: { type: "number" } },
      } as SchemaPathSelector["schema"],
    }),
  );
  b.start();
  for (const selector of selectors) {
    tracker.getSupersetSelector(address, selector);
  }
  b.end();
});
