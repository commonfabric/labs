/**
 * The wire between a serving loop in a worker and the memory server on the
 * thread that owns the store: the messages each side sends, and the endpoint
 * both sides build on, which frames requests with ids and settles their
 * replies. `serving-port-plane.ts` is the worker side; `serving-port-bridge.ts`
 * the main-thread side. Everything that crosses is data a structured clone
 * keeps, except a wave batch and a delegated append, whose values are the
 * memory boundary's and cross as its encoding.
 */

import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import type {
  SessionViewHandle,
  SessionViewInterest,
} from "@commonfabric/memory/v2";
import { ProtocolError } from "@commonfabric/memory/v2";
import type {
  AdmittedCommitNotice,
  DemandChangeReason,
  ServedAclChange,
  ServedAclChangeVerdict,
  Server,
  SessionDemand,
  SessionLifecycleEvent,
} from "@commonfabric/memory/v2/server";
import {
  getLogger,
  type getLoggerCountsBreakdown,
  type TimingStatsBreakdown,
} from "@commonfabric/utils/logger";
import type { SpaceAccessChange } from "../builder/types.ts";
import type { ExperimentalOptions } from "../runtime.ts";
import type { MemorySpace, Result } from "../storage/interface.ts";
import type { SpaceServerPolicy } from "./space-server.ts";
import type { ServingLoopStats } from "./stats.ts";
import { LifecycleVerbFailure } from "./lifecycle-verb.ts";
import type {
  LifecyclePhaseTiming,
  LifecycleVerbRun,
} from "./lifecycle-verb.ts";
import type { WaveCommitRejection } from "./wave.ts";

export type {
  LifecyclePhaseTiming,
  LifecycleVerbRun,
} from "./lifecycle-verb.ts";

/**
 * What either end posts to and listens on: a `MessagePort`, a `Worker` from
 * its creator's side, or a worker's own global scope.
 */
export type PortLike = {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  start?(): void;
};

/**
 * A served access-list change as it crosses the port: the function that
 * applies it replaced by the list of changes it applies, from which the other
 * side rebuilds the function.
 */
export type ServedAclChangeData = Omit<ServedAclChange, "change"> & {
  readonly changes: readonly SpaceAccessChange[];
};

/** The entry `Server.commitDelegatedAppend()` takes. */
export type DelegatedAppendEntry = Parameters<
  Server["commitDelegatedAppend"]
>[0];

/** The selection `Server.setViewSelection()` takes. */
export type ViewSelection = Parameters<Server["setViewSelection"]>[2];

/**
 * A pattern-lifecycle verb named for the worker to build: the verb's name
 * and the request it serves. The worker's host owns the table of names.
 */
export type LifecycleVerbDescriptor = {
  readonly name: string;
  readonly request: unknown;
};

/**
 * What the serving loop's realm logged: its loggers' counts and timing
 * statistics, which are the process's own where the loop runs on the main
 * thread and the worker's where it runs there.
 */
export type ServingLoopDiagnostics = {
  loggerCounts: ReturnType<typeof getLoggerCountsBreakdown>;
  timingStats: TimingStatsBreakdown;
};

/**
 * A space server policy as it crosses to the worker: the fields that hold
 * data, since a closure does not cross the port.
 */
export type ServingWorkerPolicy = {
  [
    Key
      in keyof SpaceServerPolicy as NonNullable<SpaceServerPolicy[Key]> extends
        (...args: never[]) => unknown ? never : Key
  ]: SpaceServerPolicy[Key];
};

/** What the worker's entry module needs to build its host. */
export type ServingWorkerInit = {
  /** The service identity's key pair, encoded for the realm crossing. */
  readonly serviceKeyPair: RealmEncodedValue;

  /** The lease holder's process component this worker start adopts. */
  readonly processInstanceId: string;

  /** The serving runtimes' patterns and compile base. */
  readonly apiUrl: string;

  /** The loop's policy, its data fields alone. */
  readonly policy: ServingWorkerPolicy | undefined;

  /** The host's space-root ensure switch (`ExecutorHostOptions`). */
  readonly ensureSpaceRoots: boolean | undefined;

  /** The serving runtimes' experimental options. */
  readonly experimental: ExperimentalOptions | undefined;
};

/** What the worker asks of the thread that holds the memory server. */
export type PlaneRequests = {
  /**
   * Opens the space's store on the server's side and names its file, so the
   * worker opens a connection of its own to the same file.
   */
  "space.open": { params: { space: string }; result: { url: string } };

  "server.idle": { params: null; result: void };
  "server.flushSessions": {
    params: { spaces: string[] | undefined };
    result: void;
  };
  "server.demandForSessions": {
    params: {
      space: string;
      sessionIds: string[];
      excludePrincipal: string | undefined;
    };
    result: SessionDemand[];
  };
  "server.viewInterestsForSpace": {
    params: { space: string; excludePrincipal: string | undefined };
    result: SessionViewInterest[];
  };
  "server.setViewSelection": {
    params: {
      space: string;
      handle: SessionViewHandle;
      selection: ViewSelection;
    };
    result: boolean;
  };
  "server.foreignWriteAuthorityFor": {
    params: { space: string; principal: string | undefined };
    result: Awaited<ReturnType<Server["foreignWriteAuthorityFor"]>>;
  };
  "server.checkServedAclChange": {
    params: { change: ServedAclChangeData };
    result: ServedAclChangeVerdict;
  };
  "server.commitServedAclChange": {
    params: {
      change: ServedAclChangeData;
      sessionId: string;
      localSeq: number;
    };
    result: ServedAclChangeVerdict;
  };
  /**
   * `entry` is a {@link DelegatedAppendEntry} in the memory boundary's
   * encoding.
   */
  "server.commitDelegatedAppend": {
    params: { entry: string };
    result: Awaited<ReturnType<Server["commitDelegatedAppend"]>>;
  };
  /**
   * Commits one wave batch (a `WaveSpaceCommit` in the memory boundary's
   * encoding) under the worker's counter value, through the sink the server's
   * thread keeps for `sessionId`. `homeRefused` reports that applying a home
   * batch threw, which the worker's sink turns into its own refusal hook.
   */
  "sink.commitWave": {
    params: { sessionId: string; localSeq: number; batch: string };
    result: {
      result: Result<{ seq: number }, WaveCommitRejection>;
      homeRefused: boolean;
    };
  };
  "sink.commitSpaceAccessChange": {
    params: {
      sessionId: string;
      localSeq: number;
      change: ServedAclChangeData;
    };
    result: Result<{ seq?: number }, WaveCommitRejection>;
  };
  "loopback.open": { params: { transport: number }; result: void };
  "loopback.send": {
    params: { transport: number; payload: string };
    result: void;
  };
};

/** What the worker tells the server's thread without waiting on an answer. */
export type PlaneNotices = {
  /**
   * The worker entry's listener is installed. A message posted to a worker
   * before that is dropped, so the server's thread sends nothing earlier.
   */
  "worker.ready": null;

  "server.noteExecutorCommit": { notice: AdmittedCommitNotice };
  "server.noteLeaseReacquired": {
    notice: { space: string; principal: string };
  };
  "loopback.close": { transport: number };
  "host.stats": { stats: ServingLoopStats };
  "host.activationSettled": {
    space: MemorySpace;
    outcome: "active" | "refused" | "failed";
  };
  "host.spaceParked": { space: MemorySpace; reason: string };
};

/** What the server's thread asks of the worker. */
export type BridgeRequests = {
  /** The worker entry's first request, answered once its host serves. */
  "worker.init": {
    params: ServingWorkerInit;
    result: { lifetimeLock: string | undefined };
  };

  "host.stats": { params: null; result: ServingLoopStats };
  "host.diagnostics": { params: null; result: ServingLoopDiagnostics };
  "host.runLifecycleVerb": {
    params: { space: MemorySpace; verb: LifecycleVerbDescriptor };
    result: LifecycleVerbRun;
  };
  "host.close": { params: null; result: void };
};

/** What the server's thread tells the worker without waiting on an answer. */
export type BridgeNotices = {
  "observer.commitAdmitted": { notice: AdmittedCommitNotice };
  "observer.sessionOpened": { space: string };
  "observer.demandChanged": {
    space: string;
    reason: DemandChangeReason | undefined;
    principal: string | undefined;
    sessionId: string | undefined;
  };
  "observer.viewsChanged": { space: string; sessionId: string };
  "observer.sessionChanged": { event: SessionLifecycleEvent };
  "loopback.frame": { transport: number; frame: string };
};

/** The shape of one request's parameters and answer. */
type RequestShape = { params: unknown; result: unknown };

/** Requests by method, each with its parameters and answer. */
type RequestMap = Record<string, RequestShape>;

/** Notices by method, each with its parameters. */
type NoticeMap = Record<string, unknown>;

/**
 * An error as it crosses the port: its name, message and stack, and the
 * `code` a refusal names its condition by, where it has one.
 */
type PortFault = {
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
  readonly code: string | undefined;
  readonly timings?: LifecyclePhaseTiming[];
};

type Envelope =
  | {
    readonly t: "req";
    readonly id: number;
    readonly method: string;
    readonly params: unknown;
  }
  | { readonly t: "ok"; readonly id: number; readonly result: unknown }
  | { readonly t: "err"; readonly id: number; readonly fault: PortFault }
  | { readonly t: "note"; readonly method: string; readonly params: unknown };

const faultOf = (error: unknown): PortFault => {
  if (!(error instanceof Error)) {
    return {
      name: "Error",
      message: String(error),
      stack: undefined,
      code: undefined,
    };
  }
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: typeof code === "string" ? code : undefined,
    ...(error instanceof LifecycleVerbFailure
      ? { timings: [...error.timings] }
      : {}),
  };
};

/**
 * The error a fault stands for on this side. An untimed `ProtocolError`
 * keeps its class: the outbox classifies delegated-append refusals by it.
 * Lifecycle failures instead retain their timing envelope and reconstruct
 * the underlying error as its cause. Lifecycle routes classify those
 * failures by name and code, which the envelope also keeps.
 */
const errorOf = (fault: PortFault): Error => {
  const error = fault.name === "ProtocolError"
    ? new ProtocolError(fault.message)
    : Object.assign(new Error(fault.message), { name: fault.name });
  if (fault.stack !== undefined) error.stack = fault.stack;
  if (fault.code !== undefined) Object.assign(error, { code: fault.code });
  return fault.timings === undefined
    ? error
    : new LifecycleVerbFailure(error, fault.timings);
};

/**
 * The port's timing rows, under the serving loop's `executor` statistics:
 * `executor/port/request/<method>` on the side that asked, the whole round
 * trip, and `executor/port/handle/<method>` on the side that answered, the
 * handler's own time. The difference is what the request spent waiting for
 * the other thread's turn and in transit.
 */
const timing = getLogger("executor", { enabled: false });

/**
 * One end of the port: sends requests and notices of the `Out` maps and
 * answers those of the `In` maps. A request handler is called as its message
 * arrives, before the next message is read, so two requests posted in order
 * start in that order; its answer is posted when it settles. A notice handler
 * that throws, or an answer that cannot be posted, is reported to `onFault`.
 */
export class PortEndpoint<
  OutRequests extends RequestMap,
  OutNotices extends NoticeMap,
  InRequests extends RequestMap,
  InNotices extends NoticeMap,
> {
  readonly #port: PortLike;
  readonly #onFault: (error: Error) => void;
  readonly #requestHandlers = new Map<string, (params: unknown) => unknown>();
  readonly #noticeHandlers = new Map<string, (params: unknown) => void>();
  readonly #pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  readonly #listener: (event: MessageEvent) => void;
  #nextId = 1;
  #closed: Error | undefined;

  constructor(port: PortLike, onFault: (error: Error) => void) {
    this.#port = port;
    this.#onFault = onFault;
    this.#listener = (event) => this.#receive(event.data as Envelope);
    port.addEventListener("message", this.#listener);
    port.start?.();
  }

  /** Whether `close()` has run. */
  get closed(): boolean {
    return this.#closed !== undefined;
  }

  /**
   * Sends one request and settles with its answer, or rejects with the error
   * the other side's handler threw, with the reason this end was closed, or
   * with the failure to post it when the port refuses the message.
   */
  request<Method extends keyof OutRequests & string>(
    method: Method,
    params: OutRequests[Method]["params"],
  ): Promise<OutRequests[Method]["result"]> {
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#pending.set(id, { resolve, reject });
    const sentAt = performance.now();
    const failure = this.#post({ t: "req", id, method, params });
    if (failure !== undefined) {
      this.#pending.delete(id);
      reject(failure);
    }
    // The round trip as this side sees it: the wait for the other thread's
    // turn, the handler's own time (its `executor/port/handle/<method>` row,
    // recorded over there) and the answer's way back.
    promise.finally(() =>
      timing.time(sentAt, "executor", "port", "request", method)
    ).catch(() => {});
    return promise as Promise<OutRequests[Method]["result"]>;
  }

  /** Sends one notice; one sent after `close()` goes nowhere. */
  notify<Method extends keyof OutNotices & string>(
    method: Method,
    params: OutNotices[Method],
  ): void {
    if (this.#closed !== undefined) return;
    this.#post({ t: "note", method, params });
  }

  /** Installs the handler for `method`, replacing one installed before. */
  onRequest<Method extends keyof InRequests & string>(
    method: Method,
    handler: (
      params: InRequests[Method]["params"],
    ) => InRequests[Method]["result"] | Promise<InRequests[Method]["result"]>,
  ): void {
    this.#requestHandlers.set(
      method,
      handler as (params: unknown) => unknown,
    );
  }

  /** Installs the handler for `method`, replacing one installed before. */
  onNotice<Method extends keyof InNotices & string>(
    method: Method,
    handler: (params: InNotices[Method]) => void,
  ): void {
    this.#noticeHandlers.set(method, handler as (params: unknown) => void);
  }

  /**
   * Stops listening and rejects every request still waiting with `reason`.
   * Messages the other side posts afterwards are dropped.
   */
  close(reason: Error = new Error("the port endpoint is closed")): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    this.#port.removeEventListener("message", this.#listener);
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const { reject } of pending) reject(reason);
  }

  /**
   * Posts `envelope`, reporting a failure to post to the fault handler and
   * returning it, so a request can settle on it.
   */
  #post(envelope: Envelope): Error | undefined {
    try {
      this.#port.postMessage(envelope);
      return undefined;
    } catch (error) {
      const failure = new Error(
        `posting a ${envelope.t} message on the serving port failed`,
        { cause: error },
      );
      this.#onFault(failure);
      return failure;
    }
  }

  #receive(envelope: Envelope): void {
    switch (envelope.t) {
      case "req":
        this.#answer(envelope);
        return;
      case "note": {
        const handler = this.#noticeHandlers.get(envelope.method);
        if (handler === undefined) {
          this.#onFault(
            new Error(`no handler for the notice "${envelope.method}"`),
          );
          return;
        }
        try {
          handler(envelope.params);
        } catch (error) {
          this.#onFault(
            new Error(`the handler for the notice "${envelope.method}" threw`, {
              cause: error,
            }),
          );
        }
        return;
      }
      case "ok":
      case "err": {
        const pending = this.#pending.get(envelope.id);
        if (pending === undefined) return;
        this.#pending.delete(envelope.id);
        if (envelope.t === "ok") pending.resolve(envelope.result);
        else pending.reject(errorOf(envelope.fault));
        return;
      }
    }
  }

  /**
   * Helper for `#receive()`, which runs a request's handler and posts its
   * answer.
   */
  #answer(request: Extract<Envelope, { t: "req" }>): void {
    const handler = this.#requestHandlers.get(request.method);
    const { id } = request;
    if (handler === undefined) {
      this.#post({
        t: "err",
        id,
        fault: faultOf(
          new Error(`no handler for the request "${request.method}"`),
        ),
      });
      return;
    }
    const startedAt = performance.now();
    const done = () =>
      timing.time(startedAt, "executor", "port", "handle", request.method);
    let outcome: unknown;
    try {
      outcome = handler(request.params);
    } catch (error) {
      done();
      this.#post({ t: "err", id, fault: faultOf(error) });
      return;
    }
    Promise.resolve(outcome).then(
      (result) => {
        done();
        const failure = this.#post({ t: "ok", id, result });
        if (failure !== undefined) {
          this.#post({ t: "err", id, fault: faultOf(failure) });
        }
      },
      (error) => {
        done();
        this.#post({ t: "err", id, fault: faultOf(error) });
      },
    );
  }
}
