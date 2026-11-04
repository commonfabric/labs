// Entity projection scaling benchmark. The scheduled benchmark workflow stores
// its operation timings and additional resource diagnostics.

import type { CellScope } from "@commonfabric/api";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type PieceController,
  PiecesController,
} from "@commonfabric/piece/ops";
import {
  type EntityIdListOptions,
  type EntityIdListResult,
  type JSONSchema,
  Runtime,
  type Schema,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfcProjectionAnnotator } from "./annotations.ts";
import { CellBridge, type SpaceState } from "./cell-bridge.ts";
import {
  collectDirectorySnapshot,
  DirectoryHandleMap,
  type DirectorySnapshotEntry,
  prepareDirectoryForHandle,
} from "./directory-handles.ts";
import { encodeFuseComponent } from "./path-codec.ts";
import { FsTree } from "./tree.ts";

const encoder = new TextEncoder();
const PAGE_SIZE = 1_000;

declare const gc: (() => void) | undefined;

const benchmarkIdentity = await Identity.fromPassphrase(
  "fuse entity projection benchmark",
);
const benchmarkRuntime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: StorageManager.emulate({ as: benchmarkIdentity }),
});
const benchmarkSession = createSession({
  identity: benchmarkIdentity,
  spaceDid: await benchmarkRuntime.createSpace(),
});

class BenchmarkPiecesController extends PiecesController {
  readonly #ids: readonly string[];
  #entityGets = 0;
  #existenceRequests = 0;
  #listRequests = 0;
  #wireBytes = 0;

  constructor(ids: readonly string[]) {
    super(benchmarkSession, benchmarkRuntime, { deferSpaceCellSync: true });
    this.#ids = ids;
  }

  entityGetRequests(): number {
    return this.#entityGets;
  }

  existenceRequests(): number {
    return this.#existenceRequests;
  }

  listRequests(): number {
    return this.#listRequests;
  }

  wireBytes(): number {
    return this.#wireBytes;
  }

  override listEntityIdPage(
    options: EntityIdListOptions = {},
  ): Promise<EntityIdListResult> {
    this.#listRequests++;
    const start = firstIndexAfter(this.#ids, options.after);
    const pageIds = this.#ids.slice(
      start,
      start + (options.limit ?? PAGE_SIZE),
    );
    const hasMore = start + pageIds.length < this.#ids.length;
    const result: EntityIdListResult = {
      serverSeq: 1,
      ids: pageIds,
    };
    if (hasMore) {
      const nextAfter = pageIds.at(-1);
      if (nextAfter === undefined) {
        throw new Error("non-final entity page was empty");
      }
      result.nextAfter = nextAfter;
    }
    this.#wireBytes += encoder.encode(JSON.stringify(result)).length;
    return Promise.resolve(result);
  }

  override entityIdExists(id: string): Promise<boolean> {
    this.#existenceRequests++;
    const index = firstIndexAfter(this.#ids, id);
    const exists = index > 0 && this.#ids[index - 1] === id;
    this.#wireBytes += encoder.encode(JSON.stringify({ exists })).length;
    return Promise.resolve(exists);
  }

  override async get<S extends JSONSchema = JSONSchema>(
    pieceId: string,
    runIt: boolean,
    schema: S,
    scope?: CellScope,
  ): Promise<PieceController<Schema<S>>>;
  override async get<T = unknown>(
    pieceId: string,
    runIt?: boolean,
    schema?: JSONSchema,
    scope?: CellScope,
  ): Promise<PieceController<T>>;
  override async get(
    pieceId: string,
    runIt: boolean = false,
    schema?: JSONSchema,
    scope?: CellScope,
  ): Promise<PieceController> {
    this.#entityGets++;
    return await super.get(pieceId, runIt, schema, scope);
  }
}

interface ConnectedFixture {
  bridge: CellBridge;
  entityGetRequests: () => number;
  existenceRequests: () => number;
  ids: string[];
  listRequests: () => number;
  state: SpaceState;
  tree: FsTree;
  wireBytes: () => number;
}

interface Measurement {
  existenceRequests: number;
  heapMiB: number;
  inodes: number;
  listRequests: number;
  rssMiB: number;
  wallMs: number;
  wireMiB: number;
}

function entityIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `of:baedreifakebenchmark${index.toString().padStart(32, "0")}`,
  );
}

function forceGc(): void {
  if (typeof gc !== "function") return;
  for (let pass = 0; pass < 3; pass++) gc();
}

function mib(bytes: number): number {
  return Math.round(bytes / 104_857.6) / 10;
}

function diagnostic(
  label: string,
  invocation: number,
  value: object,
): void {
  const bytes = encoder.encode(`${
    JSON.stringify({
      label,
      invocation,
      phase: invocation === 0 ? "warmup" : "measured",
      ...value,
    })
  }\n`);
  const written = Deno.stderr.writeSync(bytes);
  if (written !== bytes.length) {
    throw new Error(`wrote ${written} of ${bytes.length} diagnostic bytes`);
  }
}

function firstIndexAfter(ids: readonly string[], after?: string): number {
  if (after === undefined) return 0;
  let low = 0;
  let high = ids.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ids[middle] <= after) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function connect(
  ids: string[],
  cfcAnnotations: boolean,
): Promise<ConnectedFixture> {
  const spacePieces = new BenchmarkPiecesController(ids);
  const tree = new FsTree(() => 0);
  const bridge = new CellBridge(tree, "", {
    cfcAnnotations,
    projectionGeneration: "entity-projection-review",
    loadPieces: () => Promise.resolve(spacePieces),
  });
  bridge.init({ apiUrl: "https://example.invalid", identity: "benchmark" });
  const state = await bridge.connectSpace("home");
  return {
    bridge,
    entityGetRequests: () => spacePieces.entityGetRequests(),
    existenceRequests: () => spacePieces.existenceRequests(),
    ids,
    listRequests: () => spacePieces.listRequests(),
    state,
    tree,
    wireBytes: () => spacePieces.wireBytes(),
  };
}

async function measureOperation<T>(
  benchmark: Deno.BenchContext,
  operation: () => Promise<T>,
): Promise<{ value: T; wallMs: number }> {
  const started = performance.now();
  benchmark.start();
  try {
    const value = await operation();
    return { value, wallMs: performance.now() - started };
  } finally {
    benchmark.end();
  }
}

async function measureConstruction(
  benchmark: Deno.BenchContext,
  ids: string[],
  cfcAnnotations: boolean,
): Promise<Measurement> {
  forceGc();
  const before = Deno.memoryUsage();
  const { value: fixture, wallMs } = await measureOperation(
    benchmark,
    async () => {
      const connected = await connect(ids, cfcAnnotations);
      for (const id of ids) {
        await connected.bridge.prepareLookup(
          connected.state.entitiesIno,
          encodeFuseComponent(id),
        );
      }
      return connected;
    },
  );
  forceGc();
  const after = Deno.memoryUsage();
  const expectedProjections = Math.min(ids.length, 128);
  if (
    fixture.state.entityIds.size !== expectedProjections ||
    fixture.listRequests() !== 0 ||
    fixture.existenceRequests() !== ids.length
  ) {
    throw new Error("targeted lookup did not keep a bounded projection cache");
  }
  return {
    existenceRequests: fixture.existenceRequests(),
    heapMiB: mib(after.heapUsed - before.heapUsed),
    inodes: fixture.tree.inodes.size,
    listRequests: fixture.listRequests(),
    rssMiB: mib(after.rss - before.rss),
    wallMs: Math.round(wallMs * 10) / 10,
    wireMiB: mib(fixture.wireBytes()),
  };
}

async function createEntityDirectorySnapshot(
  fixture: ConnectedFixture,
  handles: DirectoryHandleMap,
  fh: bigint,
): Promise<readonly DirectorySnapshotEntry[]> {
  const inode = fixture.state.entitiesIno;
  const prepared = await prepareDirectoryForHandle(
    handles,
    fh,
    inode,
    fixture.bridge,
  );
  return prepared ?? handles.snapshot(
    fh,
    inode,
    () => collectDirectorySnapshot(fixture.tree, inode),
  );
}

async function measureDirectoryOpen(
  benchmark: Deno.BenchContext,
  ids: string[],
): Promise<Measurement & { entries: number }> {
  const fixture = await connect(ids, false);
  const handles = new DirectoryHandleMap();
  const fh = handles.open(fixture.state.entitiesIno);
  forceGc();
  const before = Deno.memoryUsage();
  const { value: entries, wallMs } = await measureOperation(
    benchmark,
    () => createEntityDirectorySnapshot(fixture, handles, fh),
  );
  forceGc();
  const after = Deno.memoryUsage();
  if (entries.length !== ids.length + 2) {
    throw new Error("entity directory snapshot omitted identifiers");
  }
  if (handles.snapshot(fh, fixture.state.entitiesIno, () => []) !== entries) {
    throw new Error("directory handle did not retain its entry snapshot");
  }
  return {
    entries: entries.length,
    existenceRequests: fixture.existenceRequests(),
    heapMiB: mib(after.heapUsed - before.heapUsed),
    inodes: fixture.tree.inodes.size,
    listRequests: fixture.listRequests(),
    rssMiB: mib(after.rss - before.rss),
    wallMs: Math.round(wallMs * 10) / 10,
    wireMiB: mib(fixture.wireBytes()),
  };
}

for (const count of [1_000, 10_000, 100_000]) {
  let invocation = 0;
  Deno.bench({
    name: `stubs-${count}`,
    group: "entity projection cfc off",
    n: 1,
    fn: async (benchmark) => {
      diagnostic(
        `construction-cfc-off-${count}`,
        invocation++,
        await measureConstruction(benchmark, entityIds(count), false),
      );
    },
  });
}

for (const count of [1_000, 5_000, 10_000, 20_000]) {
  let invocation = 0;
  Deno.bench({
    name: `stubs-${count}`,
    group: "entity projection cfc on",
    n: 1,
    fn: async (benchmark) => {
      diagnostic(
        `construction-cfc-on-${count}`,
        invocation++,
        await measureConstruction(benchmark, entityIds(count), true),
      );
    },
  });
}

for (const count of [1_000, 10_000, 100_000]) {
  let invocation = 0;
  Deno.bench({
    name: `ids-${count}`,
    group: "entity projection directory open",
    n: 1,
    fn: async (benchmark) => {
      diagnostic(
        `directory-open-${count}`,
        invocation++,
        await measureDirectoryOpen(benchmark, entityIds(count)),
      );
    },
  });
}

for (
  const { count, refreshes } of [
    { count: 10_000, refreshes: 10 },
    { count: 100_000, refreshes: 3 },
  ]
) {
  let invocation = 0;
  Deno.bench({
    name: `${count}-ids-${refreshes}-refreshes`,
    group: "entity projection refresh",
    n: 1,
    fn: async (benchmark) => {
      const fixture = await connect(entityIds(count), false);
      forceGc();
      const before = Deno.memoryUsage();
      const { wallMs } = await measureOperation(benchmark, async () => {
        for (let iteration = 0; iteration < refreshes; iteration++) {
          await fixture.bridge.prepareDirectorySnapshot(
            fixture.state.entitiesIno,
          );
        }
      });
      forceGc();
      const after = Deno.memoryUsage();
      diagnostic(`refresh-${count}-${refreshes}`, invocation++, {
        heapMiB: mib(after.heapUsed - before.heapUsed),
        listRequests: fixture.listRequests(),
        rssMiB: mib(after.rss - before.rss),
        wallMs: Math.round(wallMs * 10) / 10,
        wireMiB: mib(fixture.wireBytes()),
      });
    },
  });
}

let hydrationInvocation = 0;
Deno.bench({
  name: "1000-entity-recursive-walk",
  group: "entity projection hydration",
  n: 1,
  fn: async (benchmark) => {
    const count = 1_000;
    const fixture = await connect(entityIds(count), false);
    forceGc();
    const before = Deno.memoryUsage();
    const { wallMs } = await measureOperation(benchmark, async () => {
      const entries = await fixture.bridge.prepareDirectorySnapshot(
        fixture.state.entitiesIno,
      );
      for (const { name } of entries?.slice(2) ?? []) {
        await fixture.bridge.prepareLookup(fixture.state.entitiesIno, name);
        const ino = fixture.tree.lookup(fixture.state.entitiesIno, name);
        if (ino === undefined) {
          throw new Error(`entity projection was missing for ${name}`);
        }
        await fixture.bridge.prepareDirectorySnapshot(ino);
      }
    });
    forceGc();
    const after = Deno.memoryUsage();
    if (fixture.entityGetRequests() !== 0) {
      throw new Error("recursive directory walk hydrated entity values");
    }
    diagnostic("recursive-hydration-1000", hydrationInvocation++, {
      entityGets: fixture.entityGetRequests(),
      existenceRequests: fixture.existenceRequests(),
      heapMiB: mib(after.heapUsed - before.heapUsed),
      inodes: fixture.tree.inodes.size,
      listRequests: fixture.listRequests(),
      rssMiB: mib(after.rss - before.rss),
      wallMs: Math.round(wallMs * 10) / 10,
    });
  },
});

for (const count of [1_000, 5_000, 10_000]) {
  let invocation = 0;
  Deno.bench({
    name: `entries-${count}`,
    group: "CFC directory annotation batching",
    n: 1,
    fn: async (benchmark) => {
      const tree = new FsTree(() => 0);
      const parentIno = tree.addDir(tree.rootIno, "entities");
      const annotator = new CfcProjectionAnnotator(tree, {
        space: "did:key:zFuseEntityProjectionBenchmark",
        generation: "entity-projection-review",
        labelView: { version: 1, entries: [] },
      });
      annotator.annotateJsonDirectory(parentIno, [], {});
      forceGc();
      const before = Deno.memoryUsage();
      const { wallMs } = await measureOperation(benchmark, () => {
        for (let index = 0; index < count; index++) {
          const name = `entity-${index.toString().padStart(8, "0")}`;
          const childIno = tree.addDir(parentIno, name);
          annotator.annotateJsonDirectory(childIno, [name], {});
          annotator.annotateEntry(parentIno, name, childIno);
        }
        tree.getCfcAnnotation(parentIno);
        return Promise.resolve();
      });
      forceGc();
      const after = Deno.memoryUsage();
      diagnostic(`cfc-entry-batch-${count}`, invocation++, {
        heapMiB: mib(after.heapUsed - before.heapUsed),
        inodes: tree.inodes.size,
        rssMiB: mib(after.rss - before.rss),
        wallMs: Math.round(wallMs * 10) / 10,
      });
    },
  });
}
