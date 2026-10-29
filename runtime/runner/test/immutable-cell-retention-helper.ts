/** GC ownership checks for native snapshots, run with the real event loop. */
import { linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { deepFreeze } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { yieldToEventLoop } from "@commonfabric/utils/sleep";
import { convertCellsToLinks } from "../src/cell.ts";
import { immutableCellsFor, immutableSnapshot } from "../src/immutable-cell.ts";
import { createSigilLinkFromParsedLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("Requires --expose-gc");
const signer = await Identity.fromPassphrase("immutable retention policy");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});
const store = immutableCellsFor(runtime);
const base = {
  id: "of:source" as const,
  space: signer.did(),
  scope: "space" as const,
  path: [],
};
const discarded: WeakRef<object>[] = [];
const distinctIds = new Set<string>();
const sources: object[] = [];
function makeVersions(): void {
  for (let version = 0; version < 100; version++) {
    const value = deepFreeze({ version });
    const snapshot = store.createElement(value, base);
    sources.push(value);
    discarded.push(new WeakRef(snapshot));
    distinctIds.add(snapshot.id);
  }
}
makeVersions();
const retainedBefore =
  discarded.filter((ref) => ref.deref() !== undefined).length;
const equalSources = Array.from(
  { length: 100 },
  () => deepFreeze({ equal: true }),
);
const equalSnapshots = new Set(
  equalSources.map((value) => store.createElement(value, base)),
);
const heldSource = deepFreeze({ held: "source" });
const sourceId = store.createElement(heldSource, base).id;
const cell = runtime.getCellFromLink({
  ...base,
  id: store.createElement(deepFreeze({ held: "cell" }), base).id,
});
const link = runtime.getCellFromLink({
  ...base,
  id: store.createElement(deepFreeze({ held: "link" }), base).id,
}).getAsLink();
const queued = convertCellsToLinks({
  link: runtime.getCellFromLink({
    ...base,
    id: store.createElement(deepFreeze({ held: "queued" }), base).id,
  }).getAsLink(),
}) as { link: ReturnType<typeof cell.getAsLink> };
const parsed = parseLink(
  runtime.getCellFromLink({
    ...base,
    id: store.createElement(deepFreeze({ held: "parsed" }), base).id,
  }).getAsLink(),
);
function relativeHandle() {
  const snapshot = store.createElement(deepFreeze({ held: "relative" }), base);
  const link = { ...base, id: snapshot.id };
  return {
    id: snapshot.id,
    handle: createSigilLinkFromParsedLink(link, { base: link }),
  };
}
const relative = relativeHandle();
if (linkRefPayload(relative.handle).id !== undefined) {
  throw new Error("Expected a relative link without an explicit id");
}
function failedReaderSchema() {
  const snapshot = store.createElement(
    deepFreeze({ held: "failed-schema" }),
    base,
  );
  const weak = new WeakRef(snapshot);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  let threw = false;
  try {
    runtime.getImmutableCell(signer.did(), cyclic, {
      default: { "/": { "link@1": { id: snapshot.id } } },
    });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("Cyclic snapshot must fail");
  return weak;
}
const failedSchema = failedReaderSchema();
const explicitId = store.create({ held: "explicit" }).id;
sources.length = 0;
// WeakRef targets survive the job that created them; collection follows a turn.
await yieldToEventLoop();
gc();
await yieldToEventLoop();
gc();
const report = {
  retainedBefore,
  distinctIds: distinctIds.size,
  equalSnapshots: equalSnapshots.size,
  discardedAlive: discarded.filter((ref) => ref.deref() !== undefined).length,
  source: immutableSnapshot(sourceId).value === heldSource,
  cell: cell.getRaw(),
  link: runtime.getCellFromLink(link).getRaw(),
  parsed: runtime.getCellFromLink(parsed).getRaw(),
  relative: immutableSnapshot(relative.id).value,
  failedSchemaRetained: failedSchema.deref() !== undefined,
  queued: runtime.getCellFromLink(queued.link).getRaw(),
  explicit: immutableSnapshot(explicitId).value,
};
// Keep both the runtime and source keys live through the collection above.
if (relative.handle === undefined) throw new Error("Lost relative handle");
if (equalSources.length !== 100) throw new Error("Lost source keys");
await runtime.dispose();
console.log(JSON.stringify(report));
