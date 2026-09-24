/**
 * Multi-runtime pattern test harness.
 *
 * Runs the same piece in SEVERAL runtimes — one per (identity, session) pair,
 * each in its own Deno Worker realm — all backed by one shared storage
 * server. This is the headless equivalent of multiple users (or multiple
 * tabs of one user) having the same piece open simultaneously, and is the
 * only way to meaningfully exercise `PerUser` / `PerSession` scoped state
 * and cross-client reactivity in a pattern test:
 *
 * - distinct identities → distinct `user:<did>` storage partitions
 * - distinct harness sessions → distinct `session:<did>:<id>` partitions
 * - `PerSpace` state is shared and propagates via subscription push
 *
 * Workers are essential, not an optimization: one JS realm cannot host two
 * runtimes (verified-load registries, frame stacks and similar module-level
 * state cross-talk), and production never does — every browser tab or CLI
 * process is its own realm. The storage server is self-hosted in-process
 * (@commonfabric/memory/v2/standalone), and serves the authored patterns tree
 * beside it, so no toolshed is needed; pass `apiUrl` to target a running
 * toolshed instead. Serving that tree is what lets a session resolve a
 * `system:` origin, and so what lets a `#profile` wish open its real create
 * surface rather than an account of why it could not.
 *
 * POSTURE (server-execution v2): the self-hosted standalone server has no
 * serving host — no ExecutorHost, no serving loop — and its engine reads
 * this realm's ambient flag, which nothing here enables. Under the ON
 * posture that combination is a MIXED topology no deployment produces:
 * the worker clients resolve `EXPERIMENTAL_SERVER_EXECUTION=true` from
 * env and send event appends, and the in-process engine's OFF-arm
 * admission refuses them deterministically ("the OFF arm has no
 * event-append admission"), so every cross-session consequence silently
 * never happens (first observed on the first CI run of the ON pattern
 * lanes, 2026-08-21). So when the environment resolves the ON posture
 * (the first session's explicit override, then the canonical env mapping,
 * then the first-party default) and no explicit `apiUrl` was passed, the
 * harness targets the integration environment's toolshed (`env.API_URL`) —
 * the real ON topology, serving loop included — instead of self-hosting.
 * An explicitly OFF first session keeps the in-process standalone server.
 */

import { fromFileUrl } from "@std/path/from-file-url";
import { join } from "@std/path/join";

import type { FabricValue } from "@commonfabric/data-model";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import {
  experimentalOptionsFromEnv,
  type PatternCoverageData,
  writePatternCoverageLcov,
} from "@commonfabric/runner";
import {
  patternCoverageCollector,
  patternCoverageDir,
  PATTERNS_ROOT,
} from "@commonfabric/integration/pattern-coverage";
import type { CfcWriteFloorMode } from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  type CommitRejection,
  type RuntimeDiagnosticsSnapshot,
  type TrustedUiDescriptor,
  type WorkerRequest,
  type WorkerResponse,
} from "./multi-runtime-ipc.ts";

import type { initializePiecesController } from "./pieces-controller.ts";

/** Host CFC settings carried into each independent test runtime. */
export type MultiRuntimeCfcOptions = Pick<
  Parameters<typeof initializePiecesController>[0],
  | "cfcEnforcementMode"
  | "cfcFlowLabels"
  | "cfcReadMaxConfidentiality"
  | "experimental"
>;

export type { TrustedUiDescriptor };
export type { CommitRejection, RuntimeDiagnosticsSnapshot };

export interface MultiRuntimeSessionSpec {
  /** Explicit host policy for this session and, for the first session, creation. */
  cfc?: MultiRuntimeCfcOptions;
  /** Label used in error messages and as the identity passphrase seed. */
  label: string;

  /**
   * Identity for this session. Pass the same Identity in two specs to model
   * one user with two concurrent sessions (e.g. two browser tabs).
   */
  identity?: Identity;

  /**
   * Test-only network shaping: delay every storage WebSocket frame (both
   * directions) in this session's realm by this many milliseconds. Reproduces
   * multiplayer contention (optimistic pipelining, conflict storms) that
   * near-zero in-process latency hides.
   */
  wsDelayMs?: number;

  /**
   * Test-only network shaping: make this session's inbound storage frames
   * holdable, with `send()`'s `thenHoldInbound` and `releaseInbound()`.
   */
  inboundHold?: boolean;

  /** Routes this session through a test relay backed by the same storage server. */
  apiUrl?: URL;
  /**
   * Write-side `requiredIntegrity` floor for this session's runtime,
   * overriding the harness-wide setting. Set it per session to model a fleet
   * partway through the staged rollout, where one client already enforces the
   * floor and another does not.
   */
  cfcWriteFloor?: CfcWriteFloorMode;
}

export interface MultiRuntimeHarnessOptions {
  /** Result paths to keep active, instead of eagerly observing private siblings. */
  watchPaths?: readonly (readonly (string | number)[])[];
  /** Path to the pattern entry file (e.g. `<dir>/main.tsx`). */
  programPath: string;

  /** Module-resolution root, usually the `packages/patterns` directory. */
  rootPath: string;

  /**
   * Data files to store with the pattern, as paths on disk. A file the pattern
   * reads with `dataFile()` is attached from that call alone and needs no
   * entry here; this is for a file the source cannot name. The bootstrap
   * worker compiles the pattern in its own process, so these travel with the
   * request rather than being attached here.
   */
  dataFilePaths?: readonly string[];

  /** Optional initial pattern input for the bootstrap-created piece. */
  input?: Record<string, FabricValue>;

  /** Enable scheduler graph/stats/action diagnostics for this harness run. */
  diagnostics?: boolean;

  /**
   * Record every commit the sessions have refused, for
   * {@link MultiRuntimeSession.rejections}. Separate from `diagnostics`
   * because it costs a listener and an array, while that costs the
   * scheduler's per-action tracing; a test measuring contention wants the
   * first and not the second.
   */
  recordRejections?: boolean;
  sessions: (string | MultiRuntimeSessionSpec)[];
  spaceName?: string;

  /**
   * When set, sessions talk to a running toolshed at this URL instead of the
   * self-hosted in-process storage server.
   */
  apiUrl?: URL;
  /**
   * Write-side `requiredIntegrity` floor for every runtime this harness
   * creates, the bootstrap worker that authors the piece included. Defaults to
   * the runtime's own default, which is `off`.
   */
  cfcWriteFloor?: CfcWriteFloorMode;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 120_000;

/** Total event-consequence quiescence budget per `settle()` call on a
 * toolshed-backed harness (see `settle`): generous against the measured
 * ~2–3 s serving drain of a 40-event pipelined storm, small against the
 * suite timeouts a wedged consequence would otherwise eat. */
const SERVED_SETTLE_QUIESCENCE_BUDGET_MS = 10_000;

/**
 * The authored patterns tree this repository deploys, served at the same
 * address as the in-process storage server.
 *
 * A runtime resolves a `system:` provenance ref — the origin the wish
 * builtin's sidecar surfaces record, and the one a space root carries —
 * against the host serving its space. Self-hosting storage and leaving that
 * route unanswered is a topology no deployment has, and under it a piece
 * whose identity is a profile cell never gets its create surface. Answering it
 * here is what lets a headless multi-runtime test drive the real resolution.
 *
 * One route for the process: it computes each pattern's closure identity once
 * and holds it, and every harness in a run wants the same answers.
 */
let patternsRoute: PatternsRoute | undefined;
function systemPatternsRoute(): PatternsRoute {
  return patternsRoute ??= new PatternsRoute(
    fromFileUrl(new URL("..", import.meta.url)),
  );
}

const coverageFile =
  `multi-runtime-${Deno.pid}-${crypto.randomUUID()}.pattern-coverage.lcov`;

class WorkerClient {
  #worker: Worker;
  #ready = false;
  #nextId = 1;
  #pending = new Map<
    number,
    {
      request: WorkerRequest;
      resolve: (value: FabricValue) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly label: string;

  constructor(label: string) {
    this.label = label;
    this.#worker = new Worker(
      new URL("./multi-runtime-worker.ts", import.meta.url),
      { type: "module", name: `multi-runtime:${label}` },
    );
    this.#worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if ("ready" in event.data) {
        this.#ready = true;
        for (const pending of this.#pending.values()) {
          this.#worker.postMessage(pending.request);
        }
        return;
      }
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      if ("error" in event.data) {
        pending.reject(
          new Error(`[${this.label}] ${event.data.error}`),
        );
      } else {
        try {
          pending.resolve(fabricFromRealmValue(event.data.ok));
        } catch (error) {
          pending.reject(
            new Error(`[${this.label}] undecodable answer`, { cause: error }),
          );
        }
      }
    };
    this.#worker.onerror = (event) => {
      const error = new Error(`[${this.label}] worker error: ${event.message}`);
      for (const pending of this.#pending.values()) {
        pending.reject(error);
      }
      this.#pending.clear();
    };
  }

  /**
   * Calls `cmd` in the worker realm, answering with what it returns.
   *
   * `args` and the answer each cross as one `codec-realm` encoding, so both
   * carry the whole `FabricValue` domain.
   */
  call(
    cmd: string,
    args: Record<string, FabricValue> = {},
  ): Promise<FabricValue> {
    const id = this.#nextId++;
    const request: WorkerRequest = {
      id,
      cmd,
      args: realmFromFabricValue(args),
    };
    return new Promise<FabricValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `[${this.label}] ${cmd} timed out after ${RPC_TIMEOUT_MS}ms`,
          ),
        );
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, {
        request,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (this.#ready) this.#worker.postMessage(request);
    });
  }

  /** Collects this realm before releasing its runtime and instrumented graph. */
  async dispose(): Promise<void> {
    const collector = patternCoverageCollector();
    const directory = patternCoverageDir();
    if (collector && directory) {
      const data = await this.call("patternCoverage");
      if (data) collector.ingest(data as unknown as PatternCoverageData);
      await writePatternCoverageLcov(collector, join(directory, coverageFile), {
        root: PATTERNS_ROOT,
        testName: "multi-runtime integration",
      });
    }
    await this.call("dispose");
  }

  terminate(): void {
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(`[${this.label}] worker terminated`));
    }
    this.#pending.clear();
  }
}

export class MultiRuntimeSession {
  readonly label: string;
  readonly identity: Identity;
  #client: WorkerClient;

  constructor(label: string, identity: Identity, client: WorkerClient) {
    this.label = label;
    this.identity = identity;
    this.#client = client;
  }

  /**
   * Send an event to a handler stream exposed on the piece result. Pass
   * `trustedUi` to emulate a genuine user interaction on a trusted CFC
   * surface (required for trusted-action handlers).
   *
   * Pass `thenHoldInbound` to hold every storage frame this session receives
   * from the moment the event has run here until `releaseInbound()`, on a
   * session created with `inboundHold: true`. Its replica then stays as it
   * is, whatever other sessions commit, and nothing the server sends back
   * reaches it: no commit confirmation, and no consequence of an event it
   * fired, so the speculative writes of the event's run here stand. What it
   * sends goes out as usual.
   */
  async send(
    handler: string,
    event: FabricValue = {},
    trustedUi?: TrustedUiDescriptor,
    opts: { idle?: boolean; thenHoldInbound?: boolean } = {},
  ): Promise<void> {
    await this.#client.call("send", {
      handler,
      event,
      trustedUi,
      idle: opts.idle,
      thenHoldInbound: opts.thenHoldInbound,
    });
  }

  /**
   * Set a cell reached from the piece result by `path`, exactly like a UI
   * `$value` binding: one fresh edit tx and a single un-retried commit (the
   * `handleCellSet` path). Returns the commit outcome so tests can observe
   * conflicts. Pass `idle: false` to leave this runtime un-settled (preserves
   * a stale local replica for own-write-race / no-op repros).
   */
  async set(
    path: (string | number)[],
    value: FabricValue,
    opts: { idle?: boolean } = {},
  ): Promise<{ ok: boolean; error?: { name?: string; message?: string } }> {
    return await this.#client.call("set", {
      path,
      value,
      idle: opts.idle,
    }) as { ok: boolean; error?: { name?: string; message?: string } };
  }

  /**
   * Append `value` to the array cell reached by `path`, exactly like a
   * `CellHandle.push`: read-modify-write that keeps its read as a compare-and-set
   * precondition (the `handleCellPush` path), so a concurrent push conflicts
   * rather than being clobbered — unlike the blind `set` above.
   */
  async push(
    path: (string | number)[],
    value: FabricValue,
    opts: { idle?: boolean } = {},
  ): Promise<{ ok: boolean; error?: { name?: string; message?: string } }> {
    return await this.#client.call("push", {
      path,
      value,
      idle: opts.idle,
    }) as { ok: boolean; error?: { name?: string; message?: string } };
  }

  /**
   * Read a value from the piece result, pulling fresh state first. Where the
   * result schema says `asCell` — over a pattern's `[UI]` tree, among other
   * places — the value carries the link that reaches the cell rather than the
   * cell, which belongs to the runtime's own realm. Read a path below such a
   * cell, or use `readRaw`, to reach its contents.
   */
  async read(path: (string | number)[] = []): Promise<FabricValue> {
    return await this.#client.call("read", { path });
  }

  /** Read the RAW stored value at `path` (links resolved to the target cell,
   *  no result-schema shaping) — for state the declared schema does not
   *  carry, e.g. a query result's `requestHash`. */
  async readRaw(path: (string | number)[] = []): Promise<FabricValue> {
    return await this.#client.call("readRaw", { path });
  }

  /**
   * Mint a cell in this runtime's space holding `value`, and answer with the
   * link that reaches it. `cause` names the cell: the same cause is the same
   * cell, a different cause a different one.
   *
   * The link is ordinary data, so it can be passed straight back in a `send`
   * event to reach a handler input declared `asCell`. That is how a headless
   * caller hands a pattern a cell it did not create — a viewer identity, say,
   * where a browser would supply a resolved `#profile`.
   */
  async createCell(
    cause: FabricValue,
    value: FabricValue,
  ): Promise<FabricValue> {
    return await this.#client.call("createCell", { cause, value });
  }

  /** Inspect the normalized link (id, space, scope) at `path` in the result. */
  async link(
    path: (string | number)[] = [],
  ): Promise<{ id: string; space: string; scope: string; path: string[] }> {
    return await this.#client.call("link", { path }) as {
      id: string;
      space: string;
      scope: string;
      path: string[];
    };
  }

  /**
   * Raw replica read at an explicit storage address — bypasses the piece
   * result / schema / link resolution. Distinguishes "replica lacks the doc"
   * from "schema-aware read fails to resolve it".
   */
  async rawRead(
    address: {
      id: string;
      space: string;
      path?: (string | number)[];
      scope?: FabricValue;
    },
  ): Promise<{ ok: boolean; value?: FabricValue; error?: string }> {
    return await this.#client.call("rawRead", address) as {
      ok: boolean;
      value?: FabricValue;
      error?: string;
    };
  }

  async idle(): Promise<void> {
    await this.#client.call("idle");
  }

  /**
   * Wait, bounded by `timeoutMs`, until every event this session fired has
   * its terminal consequence ARRIVED back here (speculation.md §4 step 2 —
   * the overlay's outstanding-intent set is empty). Resolves with the
   * still-outstanding count when the budget elapses first. Instant on the
   * OFF arm (no overlay). See `MultiRuntimeHarness.settle`.
   */
  async eventQuiescence(timeoutMs?: number): Promise<{ pending: number }> {
    return await this.#client.call("eventQuiescence", { timeoutMs }) as {
      pending: number;
    };
  }

  /**
   * Wait — with no budget of its own, backstopped by the RPC timeout —
   * until every event THIS session fired has its terminal consequence
   * (consequenced, errored, dropped, or refused) arrived back here:
   * the overlay's outstanding-intent set is empty (speculation.md §4
   * step 2). Instant on the OFF arm and when nothing is outstanding.
   *
   * This is the gate between two CHAINED events whose second served
   * handler reads state the first one writes (a draft-then-trusted-
   * action pair): events on different streams have no cross-stream
   * serve-order guarantee (events.md §2), so firing the second while
   * the first is in flight can serve it against a pre-first view — a
   * precondition-reading handler then no-ops silently, an interleaving
   * the real UI forbids (the trusted control stays disabled until the
   * served precondition round-trips). Await this before the second
   * fire; once the first consequence has arrived back, its commit is
   * in the space's history and every later-fired event is served
   * against a view that includes it.
   */
  async awaitEventConsequences(): Promise<void> {
    await this.#client.call("awaitEventConsequences");
  }

  /**
   * How many events this session fired whose consequence has yet to arrive
   * back here, or `null` on the OFF arm, which does not track them.
   */
  async outstandingEventCount(): Promise<number | null> {
    return await this.#client.call("outstandingEventCount") as number | null;
  }

  /**
   * Deliver the frames held since a `send()` with `thenHoldInbound`, in the
   * order they arrived, and settle this runtime's reactivity.
   */
  async releaseInbound(): Promise<void> {
    await this.#client.call("releaseInbound");
  }

  /**
   * Force an ordered-after round trip on this runtime's open space connections,
   * so any subscription fan-out the server has already sent has landed here.
   * See `MultiRuntimeHarness.settle`.
   */
  async barrier(): Promise<void> {
    await this.#client.call("barrier");
  }

  /** Capture scheduler graph, settle stats history, and action run trace. */
  async diagnostics(): Promise<RuntimeDiagnosticsSnapshot> {
    return await this.#client.call("diagnostics") as RuntimeDiagnosticsSnapshot;
  }

  /**
   * Every commit this session had refused since {@link clearRejections},
   * oldest first, each carrying the rejection's text and the addresses the
   * commit read and wrote. Throws unless the harness was created with
   * `recordRejections`, so a test that forgets it fails rather than reading
   * an empty list as an absence of refusals.
   *
   * These say what each refusal was over, which separates a document two
   * sessions contend for from a commit dropped behind one that was. The
   * `commit-revert` count in `loggerCounts` covers much the same population
   * but is not the same measure: a revert is logged only for a commit with
   * semantic operations and a subscriber to notify.
   */
  async rejections(): Promise<CommitRejection[]> {
    const { rejections } = await this.#client.call("rejections") as {
      rejections: CommitRejection[];
    };
    return rejections;
  }

  /** Drop what {@link rejections} has recorded, opening a fresh window. */
  async clearRejections(): Promise<void> {
    await this.#client.call("clearRejections");
  }

  /** Per-logger message counts (logger name -> key -> {total,...}). */
  async loggerCounts(): Promise<
    Record<string, Record<string, { total: number }>> & { total: number }
  > {
    return await this.#client.call("loggerCounts") as
      & Record<
        string,
        Record<string, { total: number }>
      >
      & { total: number };
  }

  async disposeSession(): Promise<void> {
    try {
      await this.#client.dispose();
    } finally {
      this.#client.terminate();
    }
  }

  /** @internal */
  client(): WorkerClient {
    return this.#client;
  }
}

export class MultiRuntimeHarness {
  readonly sessions: MultiRuntimeSession[];
  readonly pieceId: string;
  #server?: StandaloneMemoryServer;

  private constructor(
    sessions: MultiRuntimeSession[],
    pieceId: string,
    server?: StandaloneMemoryServer,
  ) {
    this.sessions = sessions;
    this.pieceId = pieceId;
    this.#server = server;
  }

  static async create(
    options: MultiRuntimeHarnessOptions,
  ): Promise<MultiRuntimeHarness> {
    if (options.sessions.length === 0) {
      throw new Error("MultiRuntimeHarness needs at least one session");
    }
    const spaceName = options.spaceName ?? crypto.randomUUID();
    // The ON posture needs a serving host, which the standalone in-process
    // server does not have — see the header's POSTURE block. Resolve the
    // posture exactly like a deployed entry point (canonical env mapping,
    // else the first-party default) and pick the backend accordingly.
    const firstSession = options.sessions[0];
    const explicitServerExecution = typeof firstSession === "string"
      ? undefined
      : firstSession.cfc?.experimental?.serverExecution;
    const serverExecutionOn = explicitServerExecution ??
      experimentalOptionsFromEnv(Deno.env.get).serverExecution ??
      SERVER_EXECUTION_DEFAULT_ENABLED;
    const targetUrl = options.apiUrl ??
      (serverExecutionOn ? new URL(env.API_URL) : undefined);
    const server = targetUrl ? undefined : StandaloneMemoryServer.start({
      serve: (request) => systemPatternsRoute().serve(request),
    });
    const apiUrl = (targetUrl ?? server!.url).href;

    const sessions: MultiRuntimeSession[] = [];
    let bootstrap: WorkerClient | undefined;
    try {
      for (const spec of options.sessions) {
        const normalized: MultiRuntimeSessionSpec = typeof spec === "string"
          ? { label: spec }
          : spec;
        const identity = normalized.identity ??
          await Identity.fromPassphrase(
            `multi-runtime-harness ${normalized.label}`,
            { implementation: "noble" },
          );
        const cfcWriteFloor = normalized.cfcWriteFloor ?? options.cfcWriteFloor;
        const client = new WorkerClient(normalized.label);
        await client.call("init", {
          identity: identity.keyPair,
          spaceName,
          apiUrl: normalized.apiUrl?.href ?? apiUrl,
          diagnostics: options.diagnostics === true,
          recordRejections: options.recordRejections === true,
          cfc: normalized.cfc as FabricValue,
          watchPaths: options.watchPaths as FabricValue,
          ...(normalized.wsDelayMs !== undefined
            ? { wsDelayMs: normalized.wsDelayMs }
            : {}),
          ...(normalized.inboundHold === true ? { inboundHold: true } : {}),
          ...(cfcWriteFloor !== undefined ? { cfcWriteFloor } : {}),
        });
        sessions.push(
          new MultiRuntimeSession(normalized.label, identity, client),
        );
      }

      // A throwaway bootstrap worker creates the piece, then every test
      // session opens it BY ID from storage. This mirrors production: each
      // client loads the pattern through a verified load (required for
      // trusted-action CFC writes), and no session holds special in-memory
      // compile state.
      bootstrap = new WorkerClient("bootstrap");
      await bootstrap.call("init", {
        identity: sessions[0].identity.keyPair,
        spaceName,
        apiUrl,
        diagnostics: options.diagnostics === true,
        watchPaths: options.watchPaths as FabricValue,
        cfc: typeof options.sessions[0] === "string"
          ? undefined
          : options.sessions[0].cfc as FabricValue,
        ...(options.cfcWriteFloor !== undefined
          ? { cfcWriteFloor: options.cfcWriteFloor }
          : {}),
      });
      const { pieceId } = await bootstrap.call("createPiece", {
        programPath: options.programPath,
        rootPath: options.rootPath,
        dataFilePaths: options.dataFilePaths,
        input: options.input,
      }) as { pieceId: string };
      await bootstrap.dispose();
      bootstrap.terminate();
      bootstrap = undefined;

      for (const session of sessions) {
        await session.client().call("openPiece", { pieceId });
      }

      return new MultiRuntimeHarness(sessions, pieceId, server);
    } catch (error) {
      bootstrap?.terminate();
      for (const session of sessions) {
        await session.disposeSession().catch(() => {});
      }
      await server?.close().catch(() => {});
      throw error;
    }
  }

  session(label: string): MultiRuntimeSession {
    const session = this.sessions.find((s) => s.label === label);
    if (!session) {
      throw new Error(`No session labeled "${label}"`);
    }
    return session;
  }

  /**
   * Let all runtimes finish local work and exchange pending sync traffic. Each
   * round is one full cross-runtime hop, driven by real completion signals
   * rather than a timer:
   *
   * 1. Every runtime settles its own reactivity and flushes its pending commits
   *    to the server (`session.idle`).
   * 2. The in-process server drains: it applies every commit it has received
   *    and sends all pending subscription fan-out (`server.idle`).
   * 3. Every runtime forces an ordered-after round trip on its open space
   *    connections (`session.barrier`). Because a WebSocket delivers a
   *    connection's frames in order, the fan-out the server just sent has been
   *    received and applied by the time each round trip's response returns.
   * 4. Every runtime settles again, so a foreign write that just arrived and
   *    re-derives local cells has its recompute run before this round ends.
   *
   * With a running toolshed (when `apiUrl` was passed, or the ON posture
   * resolved one) there is no in-process server handle for step 2, and under
   * the ON posture the toolshed's serving loop processes this harness's event
   * appends ASYNCHRONOUSLY — a fixed round count of idle/barrier hops races
   * the drain (the OW52 shape: a 40-event pipelined storm needs ~2–3 s of
   * server time while 20 rounds complete in well under a second, so the
   * assert read a mid-drain head). Step 2's replacement is the
   * client-observable stand-in for `server.idle()`: wait until every event
   * each session fired has its terminal consequence ARRIVED back at that
   * session (speculation.md §4 step 2 — the overlay's outstanding-intent set
   * empties exactly then). CAVEAT (#6158 review F2): this covers
   * FIRST-ORDER consequences only — a server-side cascade child (an event a
   * served handler itself emits) is no session's intent and commits in a
   * LATER wave, outside the wait; cascades ride the ordinary barrier rounds,
   * so a test asserting on cascade results still needs enough rounds (or a
   * `waitFor`). The wait shares ONE budget across the whole `settle()`
   * call, so a genuinely wedged consequence degrades to the old behavior
   * (the caller's assert speaks) instead of hanging the harness — LOUDLY:
   * exhausting the budget with intents still outstanding warns once, so a
   * red assert after it self-identifies as budget exhaustion (a slow
   * serving drain) rather than re-opening the OW52 loss triage. The
   * barrier then pulls each replica to a head ≥ every first-order
   * consequence commit. Instant on an OFF-posture toolshed run (no
   * overlay, no outstanding intents).
   */
  async settle(rounds = 2): Promise<void> {
    const quiescenceDeadline = this.#server === undefined
      ? Date.now() + SERVED_SETTLE_QUIESCENCE_BUDGET_MS
      : undefined;
    let quiescenceWarned = false;
    for (let i = 0; i < rounds; i++) {
      await Promise.all(this.sessions.map((session) => session.idle()));
      await this.#server?.idle();
      if (quiescenceDeadline !== undefined) {
        const budget = Math.max(0, quiescenceDeadline - Date.now());
        const outcomes = await Promise.all(
          this.sessions.map((session) => session.eventQuiescence(budget)),
        );
        // #6158 review F1: the worker returns pending > 0 ONLY at its
        // deadline, so any nonzero here means the shared budget ran out
        // with consequences still outstanding — the reads that follow may
        // see a MID-DRAIN head. Say so once, so the resulting red names
        // itself instead of presenting as the OW52 "loss" shape.
        if (!quiescenceWarned && outcomes.some((o) => o.pending > 0)) {
          quiescenceWarned = true;
          const detail = outcomes
            .map((outcome, index) =>
              outcome.pending > 0
                ? `${this.sessions[index].label}: ${outcome.pending}`
                : undefined
            )
            .filter((entry) => entry !== undefined)
            .join(", ");
          console.warn(
            `[multi-runtime-harness] settle: event-consequence quiescence ` +
              `budget (${SERVED_SETTLE_QUIESCENCE_BUDGET_MS} ms) exhausted ` +
              `with intents still outstanding (${detail}) — subsequent ` +
              `reads may see a mid-drain head. A red assert after this ` +
              `line is BUDGET EXHAUSTION (a slow serving drain or a wedged ` +
              `consequence), not the OW52 loss shape.`,
          );
        }
      }
      await Promise.all(this.sessions.map((session) => session.barrier()));
      await Promise.all(this.sessions.map((session) => session.idle()));
    }
  }

  /**
   * Poll until `predicate` resolves truthy, settling between attempts.
   * Use for assertions about state that must cross runtimes.
   */
  async waitFor(
    description: string,
    predicate: () => Promise<boolean> | boolean,
    { timeout = DEFAULT_TIMEOUT_MS }: { timeout?: number } = {},
  ): Promise<void> {
    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeout) {
      try {
        if (await predicate()) return;
      } catch (error) {
        lastError = error;
      }
      await this.settle(1);
    }
    throw new Error(
      `Timed out waiting for: ${description}` +
        (lastError ? ` (last error: ${lastError})` : ""),
    );
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions) {
      await session.disposeSession().catch((error) => {
        console.warn(`Failed to dispose session "${session.label}":`, error);
      });
    }
    await this.#server?.close();
  }

  /**
   * Drop every worker without asking it to shut down first, for a caller that
   * has no `await` to spend — a process-exit listener, which Deno runs
   * synchronously. `dispose()` is the ordinary path and says goodbye properly;
   * this one exists so a harness held for the life of a process is still
   * released deterministically rather than left to process teardown. The
   * in-process server is not closed, because closing it is asynchronous and it
   * has nothing outside this process to release.
   */
  terminate(): void {
    for (const session of this.sessions) session.client().terminate();
  }
}
