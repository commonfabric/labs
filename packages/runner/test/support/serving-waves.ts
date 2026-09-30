import type { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import type { Cell } from "../../src/cell.ts";
import { effectCompletionKeyOf } from "../../src/executor/effect-completion.ts";
import { EngineWaveCommitSink } from "../../src/executor/engine-wave-sink.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  type WaveRunContext,
  waveRunContextOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

/**
 * A runtime in serving posture whose transactions seal into real waves that
 * the test commits or abandons itself, so that a wave withdraws a contribution
 * at a point the test chooses.
 *
 * The runtime holds the execution lease on the signer's space, as a serving
 * host does. Once `serve()` installs the seal destination, a seal joins the
 * open wave, and opens one on the store as it stands when none is open. Seals
 * queue in the order the runtime issues them, one at a time, as a serving loop
 * runs one action at a time per space. Every wave commits under the lease
 * holder's session, so their sinks share one commit counter, as a serving
 * host's do.
 *
 * An effect's completion writeback joins the open wave like any other seal,
 * stamped as bookkeeping. A serving host commits one outside the wave instead,
 * which is a difference the tests using this class do not observe.
 */
export class ServingWaves {
  #signer: Identity;
  #space: MemorySpace;
  #server: ReturnType<typeof newSharedServer>;
  #storageManager: EmulatedStorageManager;
  #runtime: Runtime;
  #engine: Engine.Engine;
  #lease: ExecutionLeaseCycle;
  #waves: WaveAccumulator[] = [];
  #current: WaveAccumulator | undefined;
  #peer: Runtime | undefined;
  #localSeqRef = { value: 0 };

  /** Holds what `open()` built. */
  private constructor(
    signer: Identity,
    server: ReturnType<typeof newSharedServer>,
    storageManager: EmulatedStorageManager,
    runtime: Runtime,
    engine: Engine.Engine,
    lease: ExecutionLeaseCycle,
  ) {
    this.#signer = signer;
    this.#space = signer.did() as MemorySpace;
    this.#server = server;
    this.#storageManager = storageManager;
    this.#runtime = runtime;
    this.#engine = engine;
    this.#lease = lease;
  }

  //
  // Instance members
  //

  /** The serving runtime. */
  get runtime(): Runtime {
    return this.#runtime;
  }

  /** The serving runtime's storage manager. */
  get storageManager(): EmulatedStorageManager {
    return this.#storageManager;
  }

  /** The space the runtime serves, which is the signer's own. */
  get space(): MemorySpace {
    return this.#space;
  }

  /** The wave the next seal joins, if one is open. */
  get current(): WaveAccumulator | undefined {
    return this.#current;
  }

  /**
   * Opens a wave on the store as it stands now, for a test that has to move
   * the store on behind the wave's back before anything seals into it.
   */
  openWave(): WaveAccumulator {
    const wave = new WaveAccumulator({
      space: this.#space,
      basisSeq: Engine.serverSeq(this.#engine),
      lease: this.#lease,
      foreignWrites: "accept",
      foreignWriteGrant: () => true,
      scopeKeyIdentity: {
        principal: this.#signer.did(),
        sessionId: "wave-test",
      },
      replicaFor: (target) => this.#storageManager.open(target).replica,
    });
    this.#waves.push(wave);
    this.#current = wave;
    return wave;
  }

  /**
   * Installs the seal destination. Every scheduler run is stamped with its
   * action and kind, and with `acting` as the identity it runs as.
   */
  serve(acting?: WaveRunContext["acting"]): void {
    let sealing: Promise<unknown> = Promise.resolve();
    this.#runtime.installSealDestination({
      seal: (tx) => {
        if (
          effectCompletionKeyOf(tx) !== undefined &&
          waveRunContextOf(tx) === undefined
        ) {
          stampWaveRunContext(tx, {
            actionId: "effect-completion",
            kind: "bookkeeping",
            ...(acting === undefined ? {} : { acting }),
          });
        }
        const sealed = sealing.then(() =>
          (this.#current ?? this.openWave()).seal(tx)
        );
        sealing = sealed.catch(() => {});
        return sealed;
      },
    }, {
      runStamper: (tx, info) =>
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
          ...(acting === undefined ? {} : { acting }),
        }),
    });
  }

  /** Commits the open wave, and waits for the runtime to settle after it. */
  async commitWave(): Promise<void> {
    const wave = this.#take();
    await wave.commitWave(
      new EngineWaveCommitSink({
        engineFor: () => this.#engine,
        sessionId: executionLeaseHolder(`service:${this.#space}`),
        localSeqRef: this.#localSeqRef,
      }),
    );
    await wave.settled();
    await this.#runtime.scheduler.idleWithPendingCommits();
  }

  /**
   * Commits waves until the runtime is idle with no wave open, which is when
   * everything the waves set in motion, the effects they released included,
   * has landed.
   */
  async commitAll(): Promise<void> {
    while (true) {
      await this.#runtime.idle();
      await this.#storageManager.inputSynced();
      await this.#runtime.idle();
      if (this.#current === undefined) return;
      await this.commitWave();
    }
  }

  /**
   * Abandons the open wave, as a serving loop that lost its lease does, and
   * waits for the runtime to settle after it.
   */
  async abandonWave(): Promise<void> {
    const wave = this.#take();
    wave.abandon("the serving loop lost its lease");
    await wave.settled();
    await this.#runtime.scheduler.idleWithPendingCommits();
  }

  /**
   * Has another client of the same space write to `cell`, and waits for the
   * serving runtime to see the write and settle after it. Waiting for the
   * storage manager to settle would wait on the open wave, which settles only
   * when it commits.
   */
  async writeAsPeer<T>(
    cell: Cell<T>,
    write: (peerCell: Cell<T>) => void,
  ): Promise<void> {
    this.#peer ??= new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(this.#server, {
        as: this.#signer,
        id: "peer",
      }),
    });
    const peerCell = this.#peer.getCellFromLink<T>(
      cell.getAsNormalizedFullLink(),
    );
    await peerCell.sync();
    const tx = this.#peer.edit();
    write(peerCell.withTx(tx));
    const { error } = await tx.commit();
    if (error !== undefined) throw error;
    await cell.sync();
    await this.#runtime.scheduler.idleWithPendingCommits();
  }

  /** Abandons every wave still open, and releases everything this holds. */
  async dispose(): Promise<void> {
    this.#runtime.clearSealDestination();
    for (const wave of this.#waves) wave.abandon("test cleanup");
    await Promise.all(this.#waves.map((wave) => wave.settled()));
    this.#lease.release();
    await this.#storageManager.synced();
    await this.#runtime.dispose();
    await this.#peer?.dispose();
    await this.#server.close();
  }

  /**
   * Helper for `commitWave()` and `abandonWave()`, which returns the open wave
   * and leaves none open, so that the next seal opens a new one.
   */
  #take(): WaveAccumulator {
    const wave = this.#current;
    if (wave === undefined) throw new Error("No wave is open");
    this.#current = undefined;
    return wave;
  }

  //
  // Static members
  //

  /**
   * Returns a serving runtime over a fresh in-memory server, holding the
   * execution lease on `signer`'s space.
   */
  static async open(signer: Identity): Promise<ServingWaves> {
    const space = signer.did() as MemorySpace;
    const server = newSharedServer();
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
      id: executionLeaseHolder(`service:${space}`),
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);
    const lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(`service:${space}`),
    });
    if (!lease.acquire()) throw new Error("Could not acquire the lease");
    return new ServingWaves(
      signer,
      server,
      storageManager,
      runtime,
      engine,
      lease,
    );
  }
}
