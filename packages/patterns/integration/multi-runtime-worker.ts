/**
 * Worker-side runtime host for the multi-runtime harness.
 *
 * Each worker owns ONE full client stack — Identity, StorageManager, Runtime,
 * PiecesController — in its own JS realm, exactly like one browser tab. The
 * main thread orchestrates via a tiny request/response protocol, whose shapes
 * and conversions live in `./multi-runtime-ipc.ts`.
 *
 * This is a worker entry point: loading it installs a `self.onmessage`
 * handler. Nothing outside a worker may import a value from here, which is
 * what the protocol module is for.
 */

import { cfcAtom } from "@commonfabric/api/cfc";
import {
  agentQueueIndexCell,
  AgentRunRecordSchema,
} from "@commonfabric/runner/agent-run";
import { patternCoverageCollector } from "@commonfabric/integration/pattern-coverage";
import {
  debugVDOMSchema,
  rendererVDOMSchema,
} from "@commonfabric/runner/schemas";
import type { MultiRuntimeCfcOptions } from "./multi-runtime-harness.ts";

import {
  type FabricValue,
  isValidFabricValue,
  toShortQuotedDebugString,
} from "@commonfabric/data-model";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import type { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import type { Cell } from "@commonfabric/runner";
import {
  convertCellsToLinks,
  isCell,
  markUiInputBlindWriteTx,
  parseLink,
  type RuntimeTelemetry,
  type RuntimeTelemetryEvent,
  setBlindStructuralTarget,
  unmarkUiInputBlindWriteTx,
} from "@commonfabric/runner";
import {
  cfcLabelViewForCell,
  type CfcWriteFloorMode,
  markRendererTrustedEvent,
} from "@commonfabric/runner/cfc";
import { Identity } from "@commonfabric/identity";
import {
  commitSnapshotShare,
  prepareSnapshotShare,
} from "@commonfabric/runner/cfc/share-snapshot";
import {
  initializePiecesController,
  type PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  type CommitRejection,
  type RuntimeDiagnosticsSnapshot,
  type TrustedUiDescriptor,
  type WorkerRequest,
  type WorkerResponse,
} from "./multi-runtime-ipc.ts";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { authenticatedOwnerFromLabel } from "../../ui/src/v2/components/cf-owner-view/owner-predicate.ts";

let cc: PiecesController | undefined;
let piece: PieceController | undefined;
let resultSchema: unknown;
let resultSinkCancel: (() => void) | undefined;
let boundedReads = false;
let watchPaths: readonly (readonly (string | number)[])[] = [[]];

/**
 * Every commit this runtime had refused since the last `clearRejections`,
 * oldest first, or absent when this runtime was not asked to record them. A
 * caller brackets the window it wants to read: an entry holds one commit's
 * whole conflict set, so a contention-heavy run left unbracketed accumulates
 * megabytes of addresses.
 */
let rejections: CommitRejection[] | undefined;

/** Record every refused commit `telemetry` reports into {@link rejections}. */
function recordRejectionsInto(telemetry: RuntimeTelemetry): void {
  const recording: CommitRejection[] = [];
  rejections = recording;
  telemetry.addEventListener("telemetry", (event) => {
    const marker = (event as RuntimeTelemetryEvent).marker;
    if (marker.type !== "storage.push.error") return;
    recording.push({
      error: marker.error,
      message: marker.message,
      reads: marker.reads,
      writes: marker.writes,
    });
  });
}

/** The recorded refusals, or a loud failure when nothing is recording them. */
function recorded(): CommitRejection[] {
  if (!rejections) {
    throw new Error(
      "no refused commits are being recorded; create the harness with " +
        "`recordRejections: true`",
    );
  }
  return rejections;
}

function controller(): PiecesController {
  if (!cc) throw new Error("worker not initialized");
  return cc;
}

function currentPiece(): PieceController {
  if (!piece) throw new Error("no piece attached");
  return piece;
}

// Read through the pattern's declared result schema, like the UI does —
// schema defaults and scope annotations only apply on schema-aware reads.
function result(): Cell<any> {
  const raw = controller().getResult(currentPiece().getCell());
  return resultSchema !== undefined ? raw.asSchema(resultSchema as never) : raw;
}

async function idle(): Promise<void> {
  await controller().runtime.idle();
  await controller().synced();
}

async function attachPiece(next: PieceController): Promise<void> {
  piece = next;
  resultSchema = (await next.getPattern() as { resultSchema?: unknown })
    .resultSchema;
  resultSinkCancel?.();
  // Keep only the paths the test observes active. A real UI does not read
  // private sibling outputs merely because they belong to the same piece.
  const cancels = watchPaths.map((path) => {
    let cell = result();
    for (const segment of path) cell = cell.key(segment);
    return cell.sink(() => {});
  });
  resultSinkCancel = () => {
    for (const cancel of cancels) cancel();
  };
}

// Test-only network shaping: wrap this realm's WebSocket so every frame (both
// directions) is delayed by a fixed amount. Installed BEFORE the runtime opens
// its storage session, so the whole client stack sees the added latency —
// the in-process equivalent of the browser-harness WS shim used to reproduce
// multiplayer contention (starvation / wedge) without a network.
function installWsDelay(delayMs: number): void {
  if (delayMs <= 0) return;
  const Native = globalThis.WebSocket;
  const Delayed = function (
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const ws = protocols !== undefined
      ? new Native(url, protocols)
      : new Native(url);
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const nativeAdd = ws.addEventListener.bind(ws);
    const nativeRemove = ws.removeEventListener.bind(ws);
    ws.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "message" && listener) listeners.add(listener);
      else if (listener) nativeAdd(type, listener, options);
    };
    // Mirror removal for the diverted message listeners, preserving
    // WebSocket semantics for callers that unsubscribe/re-subscribe.
    ws.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === "message" && listener) listeners.delete(listener);
      else if (listener) nativeRemove(type, listener, options);
    };
    let onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null =
      null;
    Object.defineProperty(ws, "onmessage", {
      configurable: true,
      get: () => onmessage,
      set: (fn) => {
        onmessage = fn;
      },
    });
    nativeAdd("message", (ev: Event) => {
      const deliver = () => {
        onmessage?.call(ws, ev as MessageEvent);
        for (const listener of listeners) {
          const fn = typeof listener === "function"
            ? listener
            : listener.handleEvent.bind(listener);
          fn.call(ws, ev);
        }
      };
      setTimeout(deliver, delayMs);
    });
    const nativeSend = ws.send.bind(ws);
    ws.send = (data: Parameters<WebSocket["send"]>[0]) => {
      setTimeout(() => {
        try {
          nativeSend(data);
        } catch {
          // Socket closed while the frame was in flight; same as a network drop.
        }
      }, delayMs);
    };
    return ws;
  } as unknown as typeof WebSocket;
  Delayed.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    (Delayed as unknown as Record<string, unknown>)[k] = Native[k];
  }
  globalThis.WebSocket = Delayed;
}

// When the harness process runs under Deno's native OpenTelemetry
// (`OTEL_DENO=true deno run --unstable-otel …` — the harness has no SDK setup
// of its own), `@opentelemetry/api`'s globals resolve to Deno's providers, so
// bridging the runtime's existing telemetry bus exports scheduler spans and
// ct.* metrics with zero configuration. Inert otherwise: without a registered
// provider the API hands the bridge no-op instruments. Also flips the
// preflight-telemetry gate, which is what runtime-client's
// setTelemetryEnabled(true) does for browser sessions — without it the
// scheduler.event.preflight markers never fire.
async function maybeAttachOtelBridge(identity: Identity): Promise<void> {
  const env = (name: string): string | undefined =>
    typeof Deno !== "undefined" ? Deno.env.get(name) : undefined;
  const otelActive = env("OTEL_DENO") === "true" || env("OTEL_DENO") === "1" ||
    env("OTEL_ENABLED") === "true";
  if (!otelActive) return;
  const [{ attachRuntimeTelemetryOtelBridge }, { metrics, trace }] =
    await Promise.all([
      // The OpenTelemetry bridge loads only for a run that reports.
      // deno-lint-ignore cf-imports/no-inline-module-import
      import("@commonfabric/runner/telemetry-otel-bridge"),
      // deno-lint-ignore cf-imports/no-inline-module-import
      import("@opentelemetry/api"),
    ]);
  const pieces = controller();
  const runtime = pieces.runtime;
  attachRuntimeTelemetryOtelBridge(runtime.telemetry, {
    tracer: trace.getTracer("ct-runner-bridge"),
    meter: metrics.getMeter("ct-runner-bridge"),
    attributes: {
      "ct.runtime": "harness",
      "space.did": pieces.getSpace(),
      "user.did": identity.did(),
    },
  });
  runtime.scheduler.setEventPreflightTelemetryEnabled(true);
}

/** Finds a rendered native component without inspecting unrelated props. */
async function elementProps(
  value: unknown,
  tag: string,
): Promise<Cell<unknown> | Record<string, unknown> | undefined> {
  if (isCell(value)) {
    await value.pull();
    return elementProps(value.get(), tag);
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = await elementProps(child, tag);
      if (found) return found;
    }
  }
  if (value === null || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown>;
  if ("$UI" in node) return elementProps(node.$UI, tag);
  const name = isCell(node.name) ? node.name.get() : node.name;
  if (name === tag) {
    return isCell(node.props)
      ? node.props
      : node.props as Record<string, unknown>;
  }
  return elementProps(node.children, tag);
}

/** Resolves the cell a native component receives through a renderer binding. */
function componentBinding(
  props: Cell<unknown> | Record<string, unknown> | undefined,
  name: string,
): unknown {
  if (!isCell(props)) return props?.[name];
  const prop = props.key(name).asSchema(true);
  if (name.startsWith("on")) return prop.resolveAsCell();
  const raw = props.getRawUntyped({ frozen: false }) as Record<string, unknown>;
  const link = parseLink(raw[name], props.getAsNormalizedFullLink());
  return link?.id && link.space
    ? props.runtime.getCellFromLink(link)
    : prop.resolveAsCell();
}

/** The trusted host gesture used after the test confirms the exact preview. */
function shareClick() {
  const event = {
    type: "click",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: { pattern: "ShareSnapshot" },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<FabricValue>
> = {
  async init(
    {
      identity: keyPair,
      spaceName,
      apiUrl,
      diagnostics,
      recordRejections,
      wsDelayMs,
      cfcWriteFloor,
      cfc,
      watchPaths: requestedWatchPaths,
    },
  ) {
    const identity = await Identity.fromKeyPair(
      keyPair as FabricKeyPair,
    );
    if (typeof wsDelayMs === "number") installWsDelay(wsDelayMs);
    boundedReads =
      (cfc as MultiRuntimeCfcOptions | undefined)?.cfcReadMaxConfidentiality !==
        undefined;
    if (Array.isArray(requestedWatchPaths)) watchPaths = requestedWatchPaths;
    cc = await initializePiecesController({
      apiUrl: new URL(apiUrl as string),
      identity,
      space: spaceName as string,
      ...(cfc as MultiRuntimeCfcOptions | undefined),
      ...(cfcWriteFloor !== undefined
        ? { cfcWriteFloor: cfcWriteFloor as CfcWriteFloorMode }
        : {}),
    });
    if (recordRejections === true) {
      recordRejectionsInto(controller().runtime.telemetry);
    }
    if (diagnostics === true) {
      const scheduler = controller().runtime.scheduler;
      scheduler.enableSettleStats();
      scheduler.setActionRunTraceEnabled(true);
    }
    await maybeAttachOtelBridge(identity);
    return { did: identity.did() };
  },

  async createPiece({ programPath, rootPath, dataFilePaths, input }) {
    // Each runtime compiles the pattern in its own worker, so data files have
    // to cross this boundary with the paths rather than be attached where the
    // worker was spawned.
    const program = await resolveLocalProgram(
      (resolver) => controller().runtime.harness.resolve(resolver),
      {
        main: programPath as string,
        root: rootPath as string,
        ...(Array.isArray(dataFilePaths)
          ? { dataFilePaths: dataFilePaths as string[] }
          : {}),
      },
    );
    const created = await controller().create(program, {
      input: isObjectNotArray(input) ? input : undefined,
      start: true,
    });
    await attachPiece(created);
    await idle();
    return { pieceId: created.id };
  },

  async openPiece({ pieceId }) {
    await attachPiece(await controller().get(pieceId as string, true));
    await idle();
    return {};
  },

  async send({ handler, event, trustedUi, idle: doIdle }) {
    const trusted = trustedUi as TrustedUiDescriptor | undefined;
    let eventValue: unknown = event ?? {};
    if (trusted) {
      // Equivalent of a genuine user interaction on a trusted surface: DOM
      // provenance plus the renderer-trusted mark the html worker reconciler
      // applies when delivering real DOM events.
      eventValue = {
        type: "click",
        ...(isObjectNotArray(event) ? event : {}),
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: trusted.surface,
            eventIntegrity: [trusted.surface],
            uiContractDataset: { uiAction: trusted.action },
          },
        },
      };
      markRendererTrustedEvent(eventValue);
    }
    const target = result();
    const { error } = await controller().runtime.editWithRetry(
      (tx) => {
        target.key(handler as never).withTx(tx).send(eventValue as never);
      },
    );
    if (error) {
      throw new Error(`send "${handler}" failed: ${error.message}`);
    }
    // `idle: false` returns as soon as the event is queued, leaving the action
    // run + commit in flight — lets a test stack several sends into a deep
    // optimistic pipeline (the multiplayer-contention shape) instead of
    // serializing one settled commit per event.
    if (doIdle !== false) await idle();
    return {};
  },

  // Faithful mirror of RuntimeProcessor.handleCellSet — the path a UI binding
  // takes for a plain `set`: ONE fresh edit tx, a single un-retried commit,
  // marked as a blind leaf write. The blind-vs-CAS choice is by METHOD, not value
  // shape: a `set` is ALWAYS blind (last-write-wins); read-modify-write goes
  // through `push` (below), which keeps compare-and-set. We await the commit so
  // the test can observe the outcome (a conflict surfaces as a Result error).
  // Pass `idle: false` to leave this runtime un-settled, so its local replica
  // stays stale (own-write-race repro).
  async set({ path, value, idle: doIdle }) {
    const runtime = controller().runtime;
    const tx = runtime.edit();
    let cell = result();
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never) as Cell<any>;
    }
    markUiInputBlindWriteTx(tx);
    // Mirror handleCellSet: thread the cell's PARENT address as the structural
    // existence/shape precondition for the blind write.
    const link = cell.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
    setBlindStructuralTarget(tx, {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path.slice(0, -1),
    });
    cell.withTx(tx).set(value as never);
    unmarkUiInputBlindWriteTx(tx);
    runtime.prepareTxForCommit(tx);
    const res = await tx.commit() as {
      error?: { name?: string; message?: string };
    };
    if (doIdle !== false) await idle();
    return {
      ok: !res?.error,
      error: res?.error
        ? { name: res.error.name, message: res.error.message }
        : undefined,
    };
  },

  // Faithful mirror of RuntimeProcessor.handleCellPush / CellHandle.push: a
  // read-modify-write append, NOT blind — the set's diff read of the current
  // array is kept as a commit precondition (compare-and-set), so a concurrent
  // push aborts rather than being clobbered by a blind overwrite. Reads the
  // current value from the local replica (no pull), mirroring CellHandle.push
  // reading its cache.
  async push({ path, value, idle: doIdle }) {
    const runtime = controller().runtime;
    let cell = result();
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never) as Cell<any>;
    }
    const currentRaw = cell.get();
    const current = Array.isArray(currentRaw) ? currentRaw : [];
    const tx = runtime.edit();
    cell.withTx(tx).set([...current, value] as never);
    runtime.prepareTxForCommit(tx);
    const res = await tx.commit() as {
      error?: { name?: string; message?: string };
    };
    if (doIdle !== false) await idle();
    return {
      ok: !res?.error,
      error: res?.error
        ? { name: res.error.name, message: res.error.message }
        : undefined,
    };
  },

  /** Supplies the reader's test home queue without changing profile selections. */
  async seedAgentQueue() {
    const runtime = controller().runtime;
    const tx = runtime.edit();
    const home = runtime.getHomeSpaceCell(tx);
    const defaultPattern = runtime.getCell(
      home.space,
      "multi-runtime-profile-home",
      undefined,
      tx,
    );
    defaultPattern.key("agentQueue").set({ entries: [] });
    home.asSchema<{ defaultPattern: Cell<unknown> }>({ type: "object" })
      .key("defaultPattern").set(defaultPattern);
    const { error } = await tx.commit();
    if (error) throw error;
    await idle();
    return true;
  },

  /** Reads queued requests in this authenticated reader's own test home. */
  async agentQueue() {
    const runtime = controller().runtime;
    const home = runtime.getHomeSpaceCell();
    const queue = agentQueueIndexCell(runtime, home.space);
    await queue.pull();
    const entries = await Promise.all(
      (queue.get()?.entries ?? []).map(async (entry) => {
        const run = entry.run.asSchema(AgentRunRecordSchema);
        await run.pull();
        const record = run.get();
        return {
          state: record.state,
          inputs: Object.fromEntries(
            Object.entries(record.inputs).map(([name, cell]) => {
              const link = cell.resolveAsCell().getAsNormalizedFullLink();
              return [name, {
                id: link.id,
                space: link.space,
                path: link.path,
                scope: link.scope,
              }];
            }),
          ),
        };
      }),
    );
    return { principal: home.space, entries };
  },

  /** Publishes the owner's explicitly reviewed test shelf to this invitation. */
  async publishLibrary({ value }) {
    const runtime = controller().runtime;
    const tx = runtime.edit();
    const source = runtime.getCell(currentPiece().getCell().space, {
      testLibrary: crypto.randomUUID(),
    }, {
      ifc: { confidentiality: [cfcAtom.user(runtime.userIdentityDID)] },
    }, tx);
    source.set(value);
    const { error } = await tx.commit();
    if (error) throw error;
    const prepared = prepareSnapshotShare(source.withTx(undefined), {
      space: result().key("originator"),
    });
    const shared = await commitSnapshotShare(prepared.consent, shareClick());
    const published = await runtime.commitUiCellWrite(
      result().key("library", "value"),
      shared.getAsLink(),
      { blind: true },
    );
    if (published.error) throw published.error;
    await idle();
    return { value: prepared.value, audience: prepared.audience };
  },

  /** Sends through the first rendered matching element's event binding. */
  async sendRenderedEvent({ tag, event }) {
    const view = result().key("$UI").asSchema(rendererVDOMSchema);
    const props = await elementProps(view, tag as string);
    const target = isCell(props)
      ? props.key(event as string).resolveAsCell()
      : props?.[event as string];
    if (!isCell(target)) throw new Error("Rendered event binding is absent");
    target.send({});
    await idle();
    return true;
  },

  /** Mirrors a reviewed, renderer-trusted snapshot confirmation in this host. */
  async shareSnapshot() {
    const view = result().key("$UI").asSchema(rendererVDOMSchema);
    await view.pull();
    const props = await elementProps(view, "cf-share-snapshot");
    const source = componentBinding(props, "$source");
    const audience = componentBinding(props, "$recipient");
    const recommended = componentBinding(props, "$recommended");
    const received = componentBinding(props, "$received");
    const eventBinding = componentBinding(props, "oncf-shared");
    const onShared = isCell(eventBinding)
      ? eventBinding.resolveAsCell()
      : eventBinding;
    if (
      !isCell(source) || !isCell(audience) || !isCell(recommended) ||
      !isCell(received) ||
      !isCell(onShared)
    ) {
      throw new Error(
        `The native sharing surface requires held source, recipient, append targets, and completion bindings: ${
          JSON.stringify({
            found: props !== undefined,
            source: isCell(source),
            audience: isCell(audience),
            recommended: isCell(recommended),
            received: isCell(received),
            completion: isCell(onShared),
          })
        }`,
      );
    }
    const prepared = prepareSnapshotShare(source, { user: audience }, {
      recommended,
      received,
    });
    const event = shareClick();
    const shared = await commitSnapshotShare(prepared.consent, event);
    onShared.send({});
    await idle();
    return {
      value: prepared.value,
      audience: prepared.audience,
      link: shared.getAsNormalizedFullLink(),
    };
  },

  /** Tries the removed authored acceptance path with an unreviewed draft. */
  async spoofShareSnapshot() {
    const runtime = controller().runtime;
    const tx = runtime.edit();
    result().key("sharedSelection").withTx(tx).set({
      value: result().key("selected"),
    });
    runtime.prepareTxForCommit(tx);
    const written = await tx.commit();
    if (written.error) throw written.error;
    await idle();
    const sent = await runtime.editWithRetry((eventTx) => {
      result().key("acceptShared").withTx(eventTx).send({});
    });
    if (sent.error) throw sent.error;
    await idle();
    return true;
  },

  /** Tries a raw inbox append using an unreleased private draft book. */
  async spoofRawInbox() {
    const runtime = controller().runtime;
    const tx = runtime.edit();
    result().key("received").withTx(tx).push(
      result().key("selected").key("books", 0),
    );
    runtime.prepareTxForCommit(tx);
    const written = await tx.commit();
    if (written.error) throw written.error;
    await idle();
    return true;
  },

  /** Mirrors the native owner's attested presentation check in this worker. */
  async syncOwnerView() {
    const view = result().key("$UI").asSchema(rendererVDOMSchema);
    await view.pull();
    const props = await elementProps(view, "cf-owner-view");
    const originator = componentBinding(props, "$originator");
    const ownerResult = componentBinding(props, "$result");
    if (!isCell(originator) || !isCell(ownerResult)) {
      throw new Error(
        "The native owner view needs held origin and result bindings",
      );
    }
    const isOwner = authenticatedOwnerFromLabel(
      cfcLabelViewForCell(originator),
      controller().runtime.userIdentityDID,
    );
    const { error } = await controller().runtime.commitUiCellWrite(
      ownerResult,
      isOwner,
      { blind: true },
    );
    if (error) throw error;
    await idle();
    return isOwner;
  },

  /**
   * Read the value of the cell reached from the piece result by `path`,
   * through the result schema.
   *
   * A schema-aware read hands back a live `Cell` wherever the schema says
   * `asCell`, and a pattern's result schema says that all over its `[UI]`
   * tree: every view node's props and children are cells. A live cell belongs
   * to this realm and cannot cross to the harness, so each one becomes the
   * link that reaches it — the sigil form `readRaw` leaves nested links in.
   * Read a path below such a cell, or `readRaw`, to get its contents.
   *
   * `doNotConvertCellResults` limits the conversion to the cells the schema
   * asked for. The same read annotates each container it returns with the cell
   * it came from, and that annotation is machinery rather than content: the
   * container's own entries are what the reader asked for.
   */
  async read({ path }) {
    const target = result();
    if (!boundedReads) await target.pull();
    let cell = target;
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never);
    }
    if (boundedReads) cell.get();
    if (boundedReads) await cell.pull();
    return convertCellsToLinks(cell.get(), { doNotConvertCellResults: true });
  },

  /**
   * Read the RAW stored value of the cell reached from the piece result by
   * `path` (links resolved to the target cell, NO result-schema shaping) —
   * for state the declared schema does not carry, e.g. a query result's
   * `requestHash`. Nested links in the raw value stay sigils.
   */
  async readRaw({ path }) {
    const target = result();
    if (!boundedReads) await target.pull();
    let cell = target;
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never);
    }
    if (boundedReads) cell.get();
    if (boundedReads) await cell.pull();
    return cell.resolveAsCell().getRaw();
  },

  /** Selects the held profile as this test reader's home profile. */
  async selectProfile({ path }) {
    let profile = result();
    for (const segment of path as (string | number)[]) {
      profile = profile.key(segment);
    }
    profile = profile.resolveAsCell();
    const runtime = controller().runtime;
    const tx = runtime.edit();
    const home = runtime.getHomeSpaceCell(tx);
    const defaultPattern = runtime.getCell(
      home.space,
      "multi-runtime-profile-home",
      undefined,
      tx,
    );
    defaultPattern.key("profiles").set([profile]);
    defaultPattern.key("defaultProfile").set(profile);
    home.asSchema<{ defaultPattern: Cell<unknown> }>({ type: "object" })
      .key("defaultPattern").set(defaultPattern);
    const { error } = await tx.commit();
    if (error) throw error;
    await idle();
    return {};
  },

  /** Reads visible VNode children, following the reader's reactive cell views. */
  async viewText({ path }) {
    let cell = result();
    for (const segment of (path ?? ["$UI"]) as (string | number)[]) {
      cell = cell.key(segment);
    }
    cell = cell.asSchema(debugVDOMSchema);
    await cell.pull();
    const text = async (value: unknown): Promise<string> => {
      if (isCell(value)) {
        await value.pull();
        return text(value.get());
      }
      if (Array.isArray(value)) {
        return (await Promise.all(value.map(text))).join(" ");
      }
      if (value !== null && typeof value === "object") {
        if ("$UI" in value) return text(value.$UI);
        if ("children" in value) return text(value.children);
      }
      return typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";
    };
    return text(cell.get());
  },

  /**
   * Mint a cell in this runtime's space holding `value`, and answer with the
   * link that reaches it.
   *
   * `cause` names the cell, so two sessions asking for the same cause in the
   * same space get the same cell and two causes get two cells. The answer is
   * ordinary fabric data, so a later `send` can carry it into a handler input
   * declared `asCell` — which is how a headless caller hands a pattern a cell
   * it did not create, the way a browser viewer's resolved `#profile` reaches
   * one.
   */
  async createCell({ cause, value }) {
    const runtime = controller().runtime;
    const space = currentPiece().getCell().getAsNormalizedFullLink().space;
    const cell = runtime.getCell<FabricValue>(space, cause);
    const { error } = await runtime.editWithRetry((tx) => {
      cell.withTx(tx).set(value as never);
    });
    if (error) {
      throw new Error(`createCell failed: ${error.message}`);
    }
    await idle();
    return cell.getAsLink();
  },

  /**
   * Inspect the normalized link (id, space, scope) of a cell reached from
   * the piece result by `path`, resolving links along the way. Lets tests
   * assert the storage addressing (e.g. scope) of pattern state.
   */
  async link({ path }) {
    const target = result();
    if (!boundedReads) await target.pull();
    let cell = target;
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never);
    }
    if (boundedReads) await cell.sync();
    const resolved = cell.resolveAsCell();
    const link = resolved.getAsNormalizedFullLink();
    return {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path,
    };
  },

  // Raw replica read: a storage-transaction read at an explicit address,
  // bypassing the piece result / schema / link-following path entirely. Lets a
  // test distinguish "this runtime's replica never received the doc" from
  // "the doc is in the replica but the schema-aware read fails to resolve it".
  async rawRead({ id, space, path, scope }) {
    const runtime = controller().runtime;
    const tx = runtime.edit();
    const res = tx.read({
      space: space as never,
      id: id as never,
      type: "application/json",
      path: (path ?? []) as string[],
      ...(scope !== undefined ? { scope: scope as never } : {}),
    } as never) as {
      ok?: { value?: FabricValue };
      error?: { message?: string };
    };
    await tx.commit();
    return {
      ok: res.error === undefined,
      value: res.ok?.value,
      error: res.error?.message,
    };
  },

  /** Reads an explicit held address with the same stored-label gate as any Cell. */
  async readAddress({ link }) {
    const cell = controller().runtime.getCellFromLink(link as never);
    await cell.sync();
    return convertCellsToLinks(
      cell.asSchema({ ifc: { confidentiality: [] } }).get(),
    );
  },

  async idle() {
    await idle();
    return {};
  },

  // Wait until this runtime has NO outstanding event intents: every event it
  // fired has reached a terminal consequence (consequenced, errored, dropped,
  // or refused) AND that consequence has arrived back here — speculation.md
  // §4 step 2's retirement, whose outstanding set the overlay maintains
  // (`Runtime.speculationOverlay.pendingIntentCount`). Under the served (ON)
  // topology this is the client-observable "the server has drained my sends"
  // signal the harness settle uses in place of the in-process server's
  // `idle()` (see MultiRuntimeHarness.settle). Resolves `{ pending: 0 }` on
  // quiescence, or with the still-outstanding count once `timeoutMs`
  // elapses — the caller's settle round proceeds and the test's own assert
  // speaks, so a wedged consequence degrades loudly instead of hanging the
  // harness. The OFF arm has no overlay and resolves immediately.
  async eventQuiescence({ timeoutMs }) {
    const overlay = controller().runtime.speculationOverlay;
    if (overlay === undefined || overlay.pendingIntentCount === 0) {
      return { pending: 0 };
    }
    const budget = typeof timeoutMs === "number" ? timeoutMs : 10_000;
    // Event-driven with a budget: the overlay resolves the quiescence
    // waiter from the same untrack step that retires the last intent
    // (consequence pushes arrive on the WebSocket; nothing here needs
    // nudging), raced against the budget timer. A waiter whose race the
    // timer wins stays parked until the set empties or the overlay
    // closes — a spent resolver, not a leak (growth is bounded by the
    // caller's settle rounds and every parked waiter flushes together).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budgetElapsed = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), budget);
    });
    const raced = await Promise.race([
      overlay.waitForIntentQuiescence().then(() => "quiescent" as const),
      budgetElapsed,
    ]);
    clearTimeout(timer);
    return {
      pending: raced === "quiescent" ? 0 : overlay.pendingIntentCount,
    };
  },

  // Wait — with no budget of its own — until every event this runtime
  // fired has reached a terminal consequence (consequenced, errored,
  // dropped, or refused) that has ARRIVED back here: the overlay's
  // outstanding-intent set is empty (speculation.md §4 step 2). The
  // gate a test needs between two CHAINED events whose second served
  // handler reads state the first one writes: events on DIFFERENT
  // streams have no cross-stream serve-order guarantee (events.md §2 —
  // per stream only), so firing the second while the first is in
  // flight can serve it against a pre-first view; a precondition-
  // reading handler then no-ops SILENTLY (the 2026-08-22 ON-lane
  // group-chat flake). Once the first event's consequence has arrived
  // back, its commit is in the space's history, so any later-fired
  // event is served against a view that includes it. Backstopped by
  // the harness RPC timeout, which names this session and command;
  // instant on the OFF arm (no overlay) and when nothing is
  // outstanding. First-order only, like the count it drains — a
  // server-side cascade child is no session's intent.
  async awaitEventConsequences() {
    const overlay = controller().runtime.speculationOverlay;
    if (overlay !== undefined) await overlay.waitForIntentQuiescence();
    return {};
  },

  // Force an ordered-after round trip on every open space connection, so any
  // subscription fan-out the server has already sent has been received and
  // applied by this runtime before returning. The harness's cross-runtime
  // delivery barrier (see MultiRuntimeHarness.settle).
  async barrier() {
    await controller().runtime.storageManager.pullOpenSpacesToHead();
    return {};
  },

  async diagnostics() {
    await idle();
    const scheduler = controller().runtime.scheduler;
    return {
      graph: scheduler.getGraphSnapshot(),
      settleStatsHistory: scheduler.getSettleStatsHistory(),
      actionRunTrace: scheduler.getActionRunTrace(),
    } satisfies RuntimeDiagnosticsSnapshot;
  },

  async rejections() {
    await idle();
    return { rejections: recorded() };
  },

  async clearRejections() {
    await idle();
    recorded().length = 0;
    return {};
  },

  async loggerCounts() {
    await idle();
    const counts = getLoggerCountsBreakdown();
    // The declaration cannot say this is a `FabricValue`: `LoggerBreakdown` is
    // an index signature intersected with `total`, and `LogCounts` beneath it
    // is an interface. Nor can `utils` be where that is said, `data-model`
    // depending on it. So the question is settled by checking, the same way
    // `assertFabricLoggerFlags()` settles it for the flag breakdown the
    // runtime connection sends.
    if (!isValidFabricValue(counts)) {
      throw new Error(
        "Cannot send logger counts across this boundary, not being a " +
          `\`FabricValue\`: ${toShortQuotedDebugString(counts)}`,
      );
    }
    return counts;
  },

  patternCoverage() {
    return Promise.resolve(
      patternCoverageCollector()?.toData() as unknown as FabricValue,
    );
  },

  async dispose() {
    resultSinkCancel?.();
    resultSinkCancel = undefined;
    piece = undefined;
    if (cc) {
      await cc.dispose();
      cc = undefined;
    }
    return {};
  },
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, cmd, args } = event.data;
  const respond = (response: WorkerResponse) =>
    (self as unknown as Worker).postMessage(response);
  const fail = (error: unknown) =>
    respond({
      id,
      error: error instanceof Error
        ? `${cmd}: ${error.message}\n${
          (globalThis as { getStackString?: (error: Error) => string })
            .getStackString?.(error) ?? error.stack ?? ""
        }`
        : String(error),
    });

  const handler = handlers[cmd];
  if (!handler) {
    respond({ id, error: `unknown command "${cmd}"` });
    return;
  }

  // Every step from here is answered rather than thrown. A decode refuses a
  // payload it cannot read and an encode refuses an answer outside the
  // `FabricValue` domain, and either one thrown out of this listener would
  // leave the caller waiting on a response that is never coming.
  let decoded: Record<string, unknown>;
  try {
    decoded = fabricFromRealmValue(args) as Record<string, unknown>;
  } catch (error) {
    fail(error);
    return;
  }

  handler(decoded).then(
    (ok) => {
      try {
        respond({ id, ok: realmFromFabricValue(ok) });
      } catch (error) {
        fail(error);
      }
    },
    fail,
  );
};

(self as unknown as Worker).postMessage(
  { ready: true } satisfies WorkerResponse,
);
