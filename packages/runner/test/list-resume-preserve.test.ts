import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

// Resume preservation guard for the list builtins (filter/flatMap).
//
// On a reload the result container of a `filter` can already hold its durable
// non-empty value while the per-element predicate result cells are still
// streaming in from storage. While a predicate cell reads `undefined` (its
// value not yet arrived), the coordinator's reconcile treats the element as
// excluded and republishes a shrunk aggregate, overwriting the durable list
// with a partial/empty array — the user-visible reload flicker where a
// populated list blinks to empty and refills (e.g. the Lunch Poll vote swatches
// going 35 -> 0 -> refill). The correct behavior: do not let a per-element run
// whose result is still pending clobber a known durable aggregate; preserve the
// prior value until the children settle, then reconcile normally (so a child
// that genuinely settles falsy/undefined is still excluded — convergence, not
// freeze).
//
// The reload is staged in the transport rather than timed. A resume asks
// storage for two batches of documents: the aggregate's own container together
// with the input list, and, behind it, the per-element runs. Both are held. The
// test lets the coordinator run once against nothing, releases the container
// batch, lets it reconcile while the per-element batch is still withheld, and
// only then releases that. Each step waits on an edge the transport reports, so
// the sequence is the same on every run.
//
// Delaying the second batch on a timer instead cannot promise that sequence.
// The coordinator's resume work and the delivery are then ordered by whatever
// the event loop did on that run, so the window is wide, narrow or closed by
// luck and the assertions below check a different scenario each time.

const signer = await Identity.fromPassphrase("list resume preserve");
const space = signer.did();

// Which batch a sync belongs to, read off the schemas it carries. The
// per-element batch carries the run argument's schema, whose sole required
// property is `element`; it is recognized first, because it also mentions the
// aggregate. The top-level batch carries the pattern's own result schema, whose
// required property is the aggregate's key.
const PER_ELEMENT_BATCH = /"required":\["element"\]/;
const TOP_LEVEL_BATCH = /"required":\["(?:kept|values)"\]/;

/**
 * A transport gate that holds the two resume batches and releases them on the
 * test's word, in the order a reload delivers them.
 *
 * Each stage exposes a promise that resolves the first time a document of that
 * stage is held back. That is the edge the test waits on: the storage layer has
 * answered, so the batch is known to exist and to be withheld, rather than the
 * test guessing at when it might turn up.
 */
class ResumeBatchGate {
  readonly #held: [string[], string[]] = [[], []];
  readonly #open: [boolean, boolean] = [false, false];
  readonly #resolve: [(() => void) | undefined, (() => void) | undefined];
  #deliver: (payload: string) => void = () => {};

  /** Resolves once a top-level document has been held back. */
  readonly topHeld: Promise<void>;

  /** Resolves once a per-element document has been held back. */
  readonly elementsHeld: Promise<void>;

  constructor() {
    let resolveTop!: () => void;
    let resolveElements!: () => void;
    this.topHeld = new Promise<void>((resolve) => {
      resolveTop = resolve;
    });
    this.elementsHeld = new Promise<void>((resolve) => {
      resolveElements = resolve;
    });
    this.#resolve = [resolveTop, resolveElements];
  }
  #stageOf(payload: string): 0 | 1 | undefined {
    if (PER_ELEMENT_BATCH.test(payload)) return 1;
    if (TOP_LEVEL_BATCH.test(payload)) return 0;
    return undefined;
  }
  wrap(inner: MemoryV2Client.Transport): MemoryV2Client.Transport {
    return {
      send: (payload: string) => inner.send(payload),
      close: () => inner.close(),
      setReceiver: (receive: (payload: string) => void) => {
        this.#deliver = receive;
        inner.setReceiver((payload: string) => {
          const stage = this.#stageOf(payload);
          if (stage === undefined || this.#open[stage]) {
            receive(payload);
            return;
          }
          this.#held[stage].push(payload);
          this.#resolve[stage]?.();
          this.#resolve[stage] = undefined;
        });
      },
      setCloseReceiver: (r: (e?: Error) => void) => inner.setCloseReceiver?.(r),
    };
  }

  /** How many documents of a stage are currently held back. */
  heldCount(stage: 0 | 1): number {
    return this.#held[stage].length;
  }

  /** Open a stage and flush every document it holds. */
  release(stage: 0 | 1): void {
    this.#open[stage] = true;
    for (const payload of this.#held[stage].splice(0)) this.#deliver(payload);
  }
}

class GatedSessionFactory implements SessionFactory {
  readonly #getServer: () => MemoryV2Server.Server;
  readonly #gate?: ResumeBatchGate;

  constructor(
    getServer: () => MemoryV2Server.Server,
    gate?: ResumeBatchGate,
  ) {
    this.#getServer = getServer;
    this.#gate = gate;
  }
  async create(spaceId: string, sgnr?: Signer) {
    const base = MemoryV2Client.loopback(this.#getServer());
    const client = await MemoryV2Client.connect({
      transport: this.#gate ? this.#gate.wrap(base) : base,
    });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(sgnr),
    );
    return { client, session };
  }
}

class GatedStorageManager extends StorageManager {
  static make(
    as: Identity,
    server: MemoryV2Server.Server,
    gate?: ResumeBatchGate,
  ): GatedStorageManager {
    return new GatedStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
      gate,
    );
  }
  private constructor(
    options: Options,
    server: MemoryV2Server.Server,
    gate?: ResumeBatchGate,
  ) {
    super(options, new GatedSessionFactory(() => server, gate));
  }
  override registerSpaceHostDetailed() {
    return { accepted: false, reason: "no-remote-resolution" } as const;
  }
}

function makeServer(): MemoryV2Server.Server {
  return newSharedServer();
}

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; label: string }[] }>(({ items }) => {",
      "  return { kept: items.filter((item) => item.keep) };",
      "});",
    ].join("\n"),
  }],
};

const ITEMS = [
  { keep: true, label: "a" },
  { keep: true, label: "b" },
  { keep: false, label: "c" },
  { keep: true, label: "d" },
  { keep: true, label: "e" },
  { keep: false, label: "f" },
  { keep: true, label: "g" },
  { keep: true, label: "h" },
];
const EXPECTED = ["a", "b", "d", "e", "g", "h"];

const labelsOf = (v: unknown): string[] | null =>
  Array.isArray(v)
    ? (v as { label?: string }[]).map((x) => x?.label as string)
    : v == null
    ? null
    : ["<non-array>"];

/**
 * Build the aggregate in a first runtime, then resume in a second runtime
 * behind the batch gate: release the container and input list, let the
 * coordinator reconcile while the per-element runs are still held, then
 * release those and let it converge. Asserts that the aggregate converges to
 * the durable value and was never observed empty or shrunk on the way, and that
 * the window was genuinely open — a run that never held a batch back fails
 * rather than passing vacuously.
 */
async function runResumePreservation<T>(
  program: RuntimeProgram,
  items: readonly unknown[],
  cellId: string,
  resultKey: string,
  shapeOf: (value: unknown) => T[] | null,
  expected: T[],
): Promise<void> {
  const server = makeServer();
  const sm1 = GatedStorageManager.make(signer, server);
  const gate = new ResumeBatchGate();
  const sm2 = GatedStorageManager.make(signer, server, gate);

  // CREATE (runtime A): build the durable, non-empty aggregate.
  const rt1 = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm1,
  });
  const compiled = await rt1.patternManager.compilePattern(program, { space });
  const tx0 = rt1.edit();
  const rc1 = rt1.getCell<Record<string, unknown>>(
    space,
    cellId,
    compiled.resultSchema,
    tx0,
  );
  rt1.run(tx0, compiled, { items }, rc1);
  await tx0.commit();
  // pull() reads to quiescence and settled() waits for the scheduler, storage
  // sync and any async builtin work; both converge internally, so no pump loop.
  await rc1.pull();
  await rt1.settled();
  await rt1.patternManager.flushCompileCacheWrites();
  await sm1.synced();
  expect(shapeOf(rc1.key(resultKey).getAsQueryResult())).toEqual(expected);
  // The second runtime reads what this one wrote, and the test closes the
  // store itself once both are done.
  await rt1.dispose({ closeStorage: false });

  // RELOAD (runtime B): cold cache, both resume batches held.
  const rt2 = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm2,
  });
  const trajectory: (T[] | null)[] = [];
  try {
    await rt2.patternManager.compilePattern(program, { space });
    const tx = rt2.edit();
    const rc2 = rt2.getCell<Record<string, unknown>>(
      space,
      cellId,
      compiled.resultSchema,
      tx,
    );
    await tx.commit();

    const cancel = rc2.key(resultKey).sink((v) => {
      trajectory.push(shapeOf(v));
    });
    try {
      // Start reads documents from both batches, so it is kicked off here and
      // awaited at the end: the window has to be open while it runs.
      const starting = rt2.start(rc2);

      // Let the coordinator run once against a container that has not loaded
      // at all, which is the state a reload starts from, before handing it the
      // top-level batch.
      await gate.topHeld;
      expect(gate.heldCount(0)).toBeGreaterThan(0);
      await rt2.idle();
      gate.release(0);

      // The window. The container now holds its durable value and the
      // coordinator reconciles against it while the per-element runs are still
      // withheld. idle() drives the scheduler to quiescence without blocking on
      // those documents the way pull() would.
      await gate.elementsHeld;
      await rt2.idle();
      expect(gate.heldCount(1)).toBeGreaterThan(0);
      trajectory.push(shapeOf(rc2.key(resultKey).get()));

      gate.release(1);
      expect(await starting).toBe(true);

      // Converge: pull() re-reads to quiescence now that the children have
      // landed, and settled() flushes the reconcile their arrival triggers.
      await rc2.pull();
      await rt2.settled();
      trajectory.push(shapeOf(rc2.key(resultKey).get()));
    } finally {
      await rt2.idle();
      cancel();
    }

    // Converges to the durable value.
    expect(shapeOf(rc2.key(resultKey).getAsQueryResult())).toEqual(expected);

    // Never transiently emptied or shrunk during the resume window. On failure
    // the offending values (the empty/partial snapshots) are shown; the full
    // trajectory is logged for context.
    const observed = trajectory.filter((t): t is T[] => t !== null);
    const shrank = observed.filter(
      (t) => t.length > 0 && t.length < expected.length,
    );
    const empties = observed.filter((t) => t.length === 0);
    if (shrank.length > 0 || empties.length > 0) {
      console.log(`${resultKey} trajectory:`, JSON.stringify(trajectory));
    }
    expect(empties).toEqual([]);
    expect(shrank).toEqual([]);
  } finally {
    await rt2.dispose({ closeStorage: false });
    await sm1.close();
    await sm2.close();
    await server.close();
  }
}

describe("list builtin resume preservation", () => {
  it("preserves a durable filter result while per-element children resync", async () => {
    await runResumePreservation(
      PROGRAM,
      ITEMS,
      "lr-result",
      "kept",
      labelsOf,
      EXPECTED,
    );
  });
});

// The flatMap mirror. Each element carries a distinct `n` so the skip test can
// assert exactly which element is omitted.
const FLATMAP_ITEMS = [
  { keep: true, n: 1, label: "a" },
  { keep: true, n: 2, label: "b" },
  { keep: false, n: 3, label: "c" },
  { keep: true, n: 4, label: "d" },
  { keep: true, n: 5, label: "e" },
  { keep: false, n: 6, label: "f" },
  { keep: true, n: 7, label: "g" },
  { keep: true, n: 8, label: "h" },
];

const FLATMAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; n: number; label: string }[] }>(({ items }) => {",
      "  return { values: items.flatMap((item) => item.n) };",
      "});",
    ].join("\n"),
  }],
};
const FLATMAP_EXPECTED = [1, 2, 3, 4, 5, 6, 7, 8];

// As above but the op returns undefined for non-`keep` elements, which flatMap
// treats as a skip. The aggregate omits exactly those elements, and must do so
// by convergence (settled undefined is honored) rather than by ever republishing
// a transient shrink while the kept elements' results are still resyncing.
const FLATMAP_SKIP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; n: number; label: string }[] }>(({ items }) => {",
      "  return { values: items.flatMap((item) => item.keep ? item.n : undefined) };",
      "});",
    ].join("\n"),
  }],
};
const FLATMAP_SKIP_EXPECTED = [1, 2, 4, 5, 7, 8]; // omits 3 and 6 (non-keep)

// As above but the op returns an array, which flatMap flattens one level into
// the aggregate. This drives the array-spread branch of the flatMap
// contribution that the scalar cases above do not reach.
const FLATMAP_SPREAD_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; n: number; label: string }[] }>(({ items }) => {",
      "  return { values: items.flatMap((item) => [item.n, item.n + 100]) };",
      "});",
    ].join("\n"),
  }],
};
const FLATMAP_SPREAD_EXPECTED = [
  1,
  101,
  2,
  102,
  3,
  103,
  4,
  104,
  5,
  105,
  6,
  106,
  7,
  107,
  8,
  108,
];

const numbersOf = (v: unknown): number[] | null =>
  Array.isArray(v) ? (v as number[]) : v == null ? null : [NaN];

describe("flatMap builtin resume preservation", () => {
  it("preserves a durable flatMap result while per-element children resync", async () => {
    await runResumePreservation(
      FLATMAP_PROGRAM,
      FLATMAP_ITEMS,
      "fm-result",
      "values",
      numbersOf,
      FLATMAP_EXPECTED,
    );
  });

  it("skips a flatMap element that settles undefined without dropping the list", async () => {
    await runResumePreservation(
      FLATMAP_SKIP_PROGRAM,
      FLATMAP_ITEMS,
      "fm-skip-result",
      "values",
      numbersOf,
      FLATMAP_SKIP_EXPECTED,
    );
  });

  it("spreads a flatMap element whose op returns an array across a resume", async () => {
    await runResumePreservation(
      FLATMAP_SPREAD_PROGRAM,
      FLATMAP_ITEMS,
      "fm-spread-result",
      "values",
      numbersOf,
      FLATMAP_SPREAD_EXPECTED,
    );
  });
});
