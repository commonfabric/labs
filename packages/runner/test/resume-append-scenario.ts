import { expect } from "@std/expect";
import type { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
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

// Shared, edge-triggered harness for the "update during the resume-await window"
// regression tests (filter/flatMap).
//
// A resumed list builtin's per-element result documents are named by the
// resume pre-sync, so they stream in while `start()` is still pending. The
// window under test is an input update that lands during that stream: the
// first reconcile after the start then runs over warm results and must fold
// the update in. A wall-clock delay on those documents cannot guarantee the
// ordering: on a slow or loaded CI host they can arrive before the update, the
// window never opens, and the test passes vacuously. Instead this harness HOLDS
// the per-element documents in the transport until the test explicitly
// releases them, so the update lands inside the window on every run, and
// asserts the window was genuinely open.

// The per-element run documents are matched specifically: each element's op is a
// projection of `element.<field>`, so its result document carries a link whose
// path starts `["element", ...]`. The container/input sync (which carries the
// input array and the aggregate schema) does not, so it lands while the start is
// pending and the input update can be written and read through the result cell
// inside the window.
export const PER_ELEMENT_RESULT_DOC = /"path":\["element"/;

// A transport gate that holds inbound messages matching a pattern until the test
// opens it, rather than releasing them on a timer.
class Gate {
  #open = false;
  #held: string[] = [];
  #deliver: (payload: string) => void = () => {};
  #firstHeldResolve: (() => void) | undefined;

  /**
   * Resolves the first time a matching document is held back — the edge that the
   * resume pre-sync has requested the per-element result documents, so the
   * start is pending on them. The test awaits this instead of polling.
   */
  readonly firstHeld: Promise<void>;

  readonly #match: RegExp;

  constructor(match: RegExp) {
    this.#match = match;
    this.firstHeld = new Promise((resolve) => {
      this.#firstHeldResolve = resolve;
    });
  }
  wrap(inner: MemoryV2Client.Transport): MemoryV2Client.Transport {
    return {
      send: (payload: string) => inner.send(payload),
      close: () => inner.close(),
      setReceiver: (receive: (payload: string) => void) => {
        this.#deliver = receive;
        inner.setReceiver((payload: string) => {
          if (!this.#open && this.#match.test(payload)) {
            this.#held.push(payload);
            this.#firstHeldResolve?.();
            this.#firstHeldResolve = undefined;
          } else receive(payload);
        });
      },
      setCloseReceiver: (r: (e?: Error) => void) => inner.setCloseReceiver?.(r),
    };
  }

  /** How many matching documents are currently held back. */
  get heldCount(): number {
    return this.#held.length;
  }

  /** Open the gate and flush every held document to the client. */
  release(): void {
    this.#open = true;
    const queued = this.#held.splice(0);
    for (const payload of queued) this.#deliver(payload);
  }
}

class GatedSessionFactory implements SessionFactory {
  #getServer: () => MemoryV2Server.Server;
  #gate?: Gate;

  constructor(
    getServer: () => MemoryV2Server.Server,
    gate?: Gate,
  ) {
    this.#getServer = getServer;
    this.#gate = gate;
  }
  async create(id: string, signer?: Signer) {
    const base = MemoryV2Client.loopback(this.#getServer());
    const transport = this.#gate ? this.#gate.wrap(base) : base;
    const client = await MemoryV2Client.connect({ transport });
    const session = await client.mount(
      id,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

class GatedStorageManager extends StorageManager {
  static make(as: Identity, server: MemoryV2Server.Server, gate?: Gate) {
    return new GatedStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
      gate,
    );
  }
  private constructor(o: Options, server: MemoryV2Server.Server, gate?: Gate) {
    super(o, new GatedSessionFactory(() => server, gate));
  }
  override registerSpaceHostDetailed() {
    return { accepted: false, reason: "no-remote-resolution" } as const;
  }
}

export function makeServer(): MemoryV2Server.Server {
  return newSharedServer();
}

export interface AppendScenario {
  readonly signer: Identity;
  readonly space: MemorySpace;
  readonly server: MemoryV2Server.Server;
  readonly program: RuntimeProgram;

  /** Result cell id in the space. */
  readonly cellId: string;

  /** Result field the aggregate is published under (e.g. "kept"/"values"). */
  readonly resultKey: string;

  /** Initial input list. */
  readonly items: readonly unknown[];

  /** Element appended during the resume window. */
  readonly appended: unknown;

  /** Replace the default append with another input-list update. */
  readonly updateItems?: (current: unknown[]) => unknown[];

  /** Extract the comparable aggregate from the result cell for assertions. */
  readonly read: (
    rc: { key: (k: string) => { getAsQueryResult: () => unknown } },
  ) => unknown[];

  /** Expected aggregate after the first-runtime build. */
  readonly buildExpected: unknown[];
}

async function build(scenario: AppendScenario): Promise<void> {
  const { signer, space, server, program, cellId, items } = scenario;
  const sm = GatedStorageManager.make(signer, server);
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm,
  });
  const compiled = await rt.patternManager.compilePattern(program, { space });
  const tx0 = rt.edit();
  const rc = rt.getCell<Record<string, unknown>>(
    space,
    cellId,
    compiled.resultSchema,
    tx0,
  );
  rt.run(tx0, compiled, { items }, rc);
  await tx0.commit();
  // Drive the aggregate to convergence: pull() reads to quiescence and settled()
  // waits for the scheduler, storage sync, and any async builtin work — both
  // converge internally, so no pump loop here.
  await rc.pull();
  await rt.settled();
  await rt.patternManager.flushCompileCacheWrites();
  await sm.synced();
  expect(scenario.read(rc)).toEqual(scenario.buildExpected);
  await rt.dispose();
}

/**
 * Build the aggregate in a first runtime, then resume in a second runtime behind
 * a gate that holds the per-element result documents the resume pre-sync names.
 * Update the input list while they are held — the start is pending, so nothing
 * has reconciled yet and the durable aggregate stands untouched — then release
 * the documents, let the start complete, and let the aggregate converge over
 * warm results. Returns the final aggregate, the aggregate as read inside the
 * window before the update, and how many documents were held when the update
 * landed — the caller
 * asserts on those, so a run that never opened the window fails loudly rather
 * than passing vacuously.
 */
export async function runResumeAppendScenario(
  scenario: AppendScenario,
): Promise<{
  output: unknown[];
  outputWhileHeld: unknown[];
  heldCount: number;
}> {
  await build(scenario);

  const gate = new Gate(PER_ELEMENT_RESULT_DOC);
  const sm2 = GatedStorageManager.make(scenario.signer, scenario.server, gate);
  const rt2 = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm2,
  });
  try {
    const compiled = await rt2.patternManager.compilePattern(scenario.program, {
      space: scenario.space,
    });
    const tx = rt2.edit();
    const rc2 = rt2.getCell<Record<string, unknown>>(
      scenario.space,
      scenario.cellId,
      compiled.resultSchema,
      tx,
    );
    await tx.commit();

    // Not awaited yet: the resume pre-sync names the per-element result
    // documents and the gate holds them, so the start stays pending for the
    // whole window. The result and input documents are already local (the
    // pre-sync's first wave), which is what lets the update below be written
    // and read through the result cell while the start waits.
    const starting = rt2.start(rc2);

    // A standing effect keeps the coordinator pulled once it exists, so the
    // scheduler drives it to reconcile on its own as inputs load — the test
    // awaits real edges rather than pumping idle() in a loop.
    const cancel = rc2.key(scenario.resultKey).sink(() => {});
    let heldCount = 0;
    let outputWhileHeld: unknown[] = [];
    try {
      // Wait for the edge that the pre-sync has requested the per-element
      // result documents: the gate holds the first one, and the start is now
      // pending on the release.
      await gate.firstHeld;
      expect(gate.heldCount).toBeGreaterThan(0);
      // The aggregate as read inside the window, before the update lands:
      // nothing has reconciled yet, so this is the durable aggregate as
      // built. (Read before the update — an update that removes items leaves
      // the container's rows naming them until the first reconcile.)
      outputWhileHeld = scenario.read(rc2);

      // Update the input list while the per-element results are held; the
      // first reconcile after the release folds this update in over warm
      // results.
      const tx1 = rt2.edit();
      const cur = (rc2.key("items").get() ?? []) as unknown[];
      const nextItems = scenario.updateItems?.(cur) ??
        [...cur, scenario.appended];
      rc2.withTx(tx1).key("items").set(nextItems);
      await tx1.commit();
      // idle() drives whatever the scheduler holds to quiescence without
      // blocking on the held documents the way pull() would.
      await rt2.idle();

      // The window was genuinely open: per-element documents were held while the
      // input update landed.
      heldCount = gate.heldCount;

      // Release the held documents. The pre-sync completes, the start
      // instantiates the coordinator, and its first reconcile runs over warm
      // results with the updated input.
      gate.release();
      expect(await starting).toBe(true);

      // Converge: pull() re-reads to quiescence; settled() then flushes the
      // reconciles the update triggers. Both converge internally, so no loop
      // here.
      await rc2.pull();
      await rt2.settled();
    } finally {
      cancel();
    }

    return { output: scenario.read(rc2), outputWhileHeld, heldCount };
  } finally {
    await rt2.dispose();
  }
}
