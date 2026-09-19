/**
 * Identity-shape benchmarks for value hashing and deep-freeze.
 *
 * Motivated by CPU profiles of the default-app integration test
 * (docs/history/development/performance/default-app-note-create.md): in
 * steady-state note creation, ~29% of runtime-worker busy CPU is value hashing
 * (`feedPlainObject` + wasm SHA-256) and ~12% is deep-freeze walks
 * (`deepFreeze()`/`isDeepFrozen()`).
 *
 * Both subsystems cache by OBJECT IDENTITY (`WeakMap`/`WeakSet`), so any
 * fresh-identity but structurally-equal value — e.g. query results, specs, or
 * vdom built anew on every render — pays a full O(tree) walk every time. These
 * benches separate the cache-hit identity path from the cache-defeating
 * fresh-identity path so the gap (and any future structural-caching fix) is
 * measurable in isolation.
 *
 * Run with:
 *
 *     deno bench --allow-read --allow-write --allow-net --allow-ffi \
 *       --allow-env --no-check bench/value-identity-shapes.bench.ts
 */

import { deepFreeze, hashOf, isDeepFrozen } from "@";
import { isObjectOrArray } from "@commonfabric/utils/types";

// Doc-shaped test data, mirroring the default-app integration:
// a note doc (~30 nodes) and a home-list doc holding N note entries.

function makeNoteDoc(i: number): Record<string, unknown> {
  return {
    title: `📝 New Note #${i.toString(36).padStart(6, "0")}`,
    content: `Note body ${i} — `.repeat(8),
    tags: ["#note", `#tag-${i % 7}`],
    createdAt: `2026-06-09T12:${(i % 60).toString().padStart(2, "0")}:00Z`,
    meta: {
      authorDid: `did:key:z6Mk${i.toString(16).padStart(8, "0")}`,
      revision: i,
      pinned: i % 5 === 0,
      layout: { width: 320, height: 200, theme: "default" },
    },
  };
}

function makeHomeDoc(noteCount: number): Record<string, unknown> {
  return {
    spaceName: "bench-space",
    activeTab: "spaces",
    items: Array.from({ length: noteCount }, (_, i) => makeNoteDoc(i)),
    counters: { notes: noteCount, pieces: noteCount + 3 },
  };
}

/** Recursively Object.freeze without populating the deep-frozen cache. */
function plainRecursiveFreeze(value: unknown): void {
  if (!isObjectOrArray(value)) return;
  for (const child of Object.values(value as object)) {
    plainRecursiveFreeze(child);
  }
  Object.freeze(value);
}

const COPIES_PER_ITERATION = 32;

function makeCopies<T>(make: () => T, freeze: "none" | "plain" | "deep"): T[] {
  const copies = Array.from({ length: COPIES_PER_ITERATION }, make);
  if (freeze === "plain") copies.forEach(plainRecursiveFreeze);
  if (freeze === "deep") copies.forEach(deepFreeze);
  return copies;
}

//
// `hashOf()`
//

const frozenNote = deepFreeze(makeNoteDoc(1));
const frozenHome128 = deepFreeze(makeHomeDoc(128));
hashOf(frozenNote);
hashOf(frozenHome128);

Deno.bench({
  name: "hashOf: deep-frozen note doc, same identity (cache hit)",
  group: "hashOf note",
  baseline: true,
}, () => {
  hashOf(frozenNote);
});

Deno.bench({
  name: "hashOf: fresh-identity note doc, not frozen (full walk)",
  group: "hashOf note",
}, (b) => {
  const copies = makeCopies(() => makeNoteDoc(1), "none");
  b.start();
  for (const copy of copies) hashOf(copy);
  b.end();
});

Deno.bench({
  name: "hashOf: fresh-identity note doc, deep-frozen (WeakMap miss)",
  group: "hashOf note",
}, (b) => {
  const copies = makeCopies(() => makeNoteDoc(1), "deep");
  b.start();
  for (const copy of copies) hashOf(copy);
  b.end();
});

Deno.bench({
  name: "hashOf: deep-frozen home doc @128 notes, same identity (cache hit)",
  group: "hashOf home",
  baseline: true,
}, () => {
  hashOf(frozenHome128);
});

Deno.bench({
  name: "hashOf: fresh-identity home doc @128 notes, not frozen (full walk)",
  group: "hashOf home",
}, (b) => {
  const copies = Array.from({ length: 4 }, () => makeHomeDoc(128));
  b.start();
  for (const copy of copies) hashOf(copy);
  b.end();
});

//
// `deepFreeze()`
//

Deno.bench({
  name: "isDeepFrozen: cached home doc @128 (cache hit)",
  group: "deep-freeze",
  baseline: true,
}, () => {
  isDeepFrozen(frozenHome128);
});

Deno.bench({
  name: "isDeepFrozen: fresh frozen-but-uncached note doc (full walk)",
  group: "deep-freeze",
}, (b) => {
  const copies = makeCopies(() => makeNoteDoc(1), "plain");
  b.start();
  for (const copy of copies) isDeepFrozen(copy);
  b.end();
});

Deno.bench({
  name: "isDeepFrozen: fresh unfrozen note doc (early exit at root)",
  group: "deep-freeze",
}, (b) => {
  const copies = makeCopies(() => makeNoteDoc(1), "none");
  b.start();
  for (const copy of copies) isDeepFrozen(copy);
  b.end();
});

Deno.bench({
  name: "deepFreeze: fresh note doc",
  group: "deep-freeze",
}, (b) => {
  const copies = makeCopies(() => makeNoteDoc(1), "none");
  b.start();
  for (const copy of copies) deepFreeze(copy);
  b.end();
});

Deno.bench({
  name: "deepFreeze: fresh home doc @128 notes",
  group: "deep-freeze",
}, (b) => {
  const copies = Array.from({ length: 4 }, () => makeHomeDoc(128));
  b.start();
  for (const copy of copies) deepFreeze(copy);
  b.end();
});
