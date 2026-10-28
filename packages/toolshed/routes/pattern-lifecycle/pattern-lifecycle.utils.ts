// The pattern-lifecycle verbs behind the route: authorize the caller as a
// writer of the space, hand the verb to the space's serving runtime, and
// turn what comes back into a status and a body. Creation and source changes
// run inside `@commonfabric/piece`'s served operations on the serving loop's
// cycle; registration uses trusted event ingress after creation commits
// (docs/features/server-pattern-lifecycle.md);
// this module holds the transport's half and is tested against a real
// memory server and serving host.

import type { AttributeValue } from "@opentelemetry/api";

import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import type { Server } from "@commonfabric/memory/v2/server";
import type {
  ServedInstantiateReceipt,
  ServedLifecycleReceipts,
  ServedLifecycleRefusalCode,
  ServedLifecycleVerbDescriptor,
  ServedLifecycleVerbRunner,
  ServedPatternRef,
  ServedPatternSource,
  ServedRegistrationOutcome,
  ServedRegistrationPreparation,
  ServedSetSourceReceipt,
} from "@commonfabric/piece/ops";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  type LifecyclePhaseTiming,
  LifecycleVerbFailure,
} from "@commonfabric/runner/executor/lifecycle-verb";
import {
  authorizeSpaceWriter,
  type SpaceAuthorityDeps,
} from "@/lib/space-authority.ts";

export interface LifecycleDeps {
  /** What the writer check reads the space's ACL through. */
  authority: SpaceAuthorityDeps;

  /**
   * The serving loop, running on this thread or in a worker of this process;
   * `undefined` on a deployment running without it, which answers every verb
   * 503. It builds each verb from the descriptor it is sent and runs it as
   * the serving side's own identity, since the verb runs as the loop's
   * bookkeeping under the lease.
   */
  host: () => ServedLifecycleVerbRunner | undefined;

  /** Trusted event ingress after this route authenticates and authorizes the caller. */
  append: Server["commitDelegatedAppend"];

  /** Trusted, narrowly addressed observation of the prepared event's durable sidecar. */
  readDocument: Server["readDocument"];
  watchAdmittedCommits: Server["watchAdmittedCommits"];

  logger?: {
    warn: (obj: unknown, msg: string) => void;
    info: (obj: unknown, msg: string) => void;
  };

  /**
   * The request's trace span, marked with the creation key and the duration
   * of each timed step; absent where nothing traces the request.
   */
  requestSpan?: RequestSpan;
}

/** The part of a trace span a lifecycle request marks. */
export interface RequestSpan {
  setAttribute(key: string, value: AttributeValue): unknown;
}

/** An `instantiate` receipt with the steps the serving side timed. */
export type InstantiateReceipt = ServedInstantiateReceipt & {
  timings: LifecyclePhaseTiming[];
};

/** A refusal's stable name on the wire. */
export type LifecycleErrorCode =
  | ServedLifecycleRefusalCode
  | "invalid-source"
  | "forbidden"
  | "server-execution-off"
  | "space-not-served"
  | "internal";

/** What a verb returns: its receipt on 200, or a refusal with its code. */
export type LifecycleResult<T> =
  | { status: 200; body: T }
  | {
    status: 400 | 403 | 404 | 409 | 422 | 500 | 503;
    body: { error: string; code: LifecycleErrorCode };
  };

/** A request's pattern source as the wire carries it: one of the two. */
export interface WireSource {
  program?: RuntimeProgram;
  pattern?: ServedPatternRef;
}

const refuse = (
  status: Exclude<LifecycleResult<never>["status"], 200>,
  code: LifecycleErrorCode,
  error: string,
): LifecycleResult<never> => ({ status, body: { error, code } });

const REFUSAL_STATUS: Record<
  ServedLifecycleRefusalCode,
  403 | 404 | 409 | 422
> = {
  "compile-failed": 422,
  "pattern-not-found": 404,
  "setup-failed": 422,
  "slug-taken": 409,
  "piece-not-found": 404,
  "incompatible": 422,
  "source-moved": 409,
};

function wireSource(source: WireSource): ServedPatternSource | undefined {
  if (source.program !== undefined && source.pattern === undefined) {
    return { program: source.program };
  }
  if (source.pattern !== undefined && source.program === undefined) {
    return { pattern: source.pattern };
  }
  return undefined;
}

/**
 * A served verb's refusal as `error` carries it: the serving loop's own
 * `ServedLifecycleRefusal`, or the error of the same name and code it
 * arrives as from a loop in a worker, whose port carries no classes.
 */
const servedRefusalOf = (
  error: unknown,
): { code: ServedLifecycleRefusalCode; message: string } | undefined => {
  if (!(error instanceof Error) || error.name !== "ServedLifecycleRefusal") {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" && Object.hasOwn(REFUSAL_STATUS, code)
    ? { code: code as ServedLifecycleRefusalCode, message: error.message }
    : undefined;
};

/**
 * Authorize the caller and run one verb on the space's serving runtime,
 * resolving with the receipt the verb's name promises.
 *
 * `timings` collects the verb's steps in the order they happened: the writer
 * check (`<verb>.authorize`) here, then the steps the serving side times and
 * returns with the receipt, its session, the wait for a cycle of the loop to
 * take the verb, the run, the wave commit and the durability read.
 */
async function runServedVerb<Verb extends ServedLifecycleVerbDescriptor>(
  deps: LifecycleDeps,
  callerDid: string,
  space: string,
  verb: Verb,
  timings?: LifecyclePhaseTiming[],
): Promise<LifecycleResult<ServedLifecycleReceipts[Verb["name"]]>> {
  const host = deps.host();
  if (host === undefined) {
    return refuse(
      503,
      "server-execution-off",
      "This deployment does not run the serving loop, so pattern-lifecycle " +
        "verbs cannot run on it (EXPERIMENTAL_SERVER_EXECUTION).",
    );
  }
  const authorizing = performance.now();
  const authority = await authorizeSpaceWriter(
    deps.authority,
    space,
    callerDid,
  );
  timings?.push({
    phase: `${verb.name}.authorize`,
    ms: Math.round(performance.now() - authorizing),
  });
  if (!authority.ok) {
    deps.logger?.warn(
      { space, caller: callerDid, detail: authority.logDetail },
      "pattern-lifecycle verb refused",
    );
    return refuse(403, "forbidden", authority.message);
  }
  try {
    const run = await host.runLifecycleVerb(space as MemorySpace, verb);
    for (const timing of run.timings) timings?.push(timing);
    return {
      status: 200,
      body: run.receipt as ServedLifecycleReceipts[Verb["name"]],
    };
  } catch (error) {
    if (error instanceof LifecycleVerbFailure) {
      for (const timing of error.timings) timings?.push(timing);
    }
    const refusal = servedRefusalOf(error);
    if (refusal !== undefined) {
      return refuse(
        REFUSAL_STATUS[refusal.code],
        refusal.code,
        refusal.message,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    // The loop's own `SpaceNotServedError`, by the name a worker's port keeps.
    if (error instanceof Error && error.name === "SpaceNotServedError") {
      return refuse(503, "space-not-served", message);
    }
    deps.logger?.warn(
      { space, verb: verb.name, error: message },
      "pattern-lifecycle verb failed",
    );
    return refuse(500, "internal", `${verb.name} failed: ${message}`);
  }
}

/** The `upload` verb: compile `program` into the space it names. */
export async function processUpload(
  deps: LifecycleDeps,
  callerDid: string,
  input: { space: string; program: RuntimeProgram },
): Promise<LifecycleResult<{ pattern: ServedPatternRef }>> {
  const uploaded = await runServedVerb(deps, callerDid, input.space, {
    name: "upload",
    request: { program: input.program },
  });
  return uploaded.status === 200
    ? { status: 200, body: { pattern: uploaded.body } }
    : uploaded;
}

/** What the `instantiate` verb takes from its request. */
type InstantiateInput = WireSource & {
  space: string;
  argument?: Record<string, unknown>;
  repository?: string;
  slug?: string;
  force?: boolean;
  register?: boolean;
  start?: boolean;
  requestKey?: string;
};

/**
 * The `instantiate` verb: create a piece from the request's pattern, named
 * and registered as asked, and — unless `start` is `false` — name its root
 * as the loop's demand so the cycle after the creation's commit derives
 * it. A piece created without that demand runs when something first
 * demands it, the served meaning of a setup-only creation.
 *
 * The receipt carries `timings`, the steps of each served verb the
 * creation ran (`instantiate`, then `registration-prepare` and
 * `registration-finish` when it registers) together with
 * `registration.delivery`, the wait for the registration event to take
 * effect. The request span, when there is one, is marked with the same
 * durations and with the request key.
 */
export async function processInstantiate(
  deps: LifecycleDeps,
  callerDid: string,
  input: InstantiateInput,
): Promise<LifecycleResult<InstantiateReceipt>> {
  const timings: LifecyclePhaseTiming[] = [];
  const result = await instantiate(deps, callerDid, input, timings);
  // A caller that sends no key gets the one the server generated, in the
  // receipt; a refusal has only the caller's.
  annotateRequestSpan(
    deps.requestSpan,
    result.status === 200 ? result.body.requestKey : input.requestKey,
    timings,
  );
  return result.status === 200
    ? { status: 200, body: { ...result.body, timings } }
    : result;
}

/**
 * Marks a request's span with its creation key and each timed step, so a
 * slow creation a caller reports by its key can be found among the traces.
 */
function annotateRequestSpan(
  span: LifecycleDeps["requestSpan"],
  requestKey: string | undefined,
  timings: readonly LifecyclePhaseTiming[],
): void {
  if (span === undefined) return;
  if (requestKey !== undefined) span.setAttribute("cf.request_key", requestKey);
  for (const { phase, ms } of timings) {
    span.setAttribute(`cf.lifecycle.${phase}_ms`, ms);
  }
}

/**
 * The `instantiate` verb's creation and registration, timing each served
 * step into `timings`.
 */
async function instantiate(
  deps: LifecycleDeps,
  callerDid: string,
  input: InstantiateInput,
  timings: LifecyclePhaseTiming[],
): Promise<LifecycleResult<ServedInstantiateReceipt>> {
  const source = wireSource(input);
  if (source === undefined) {
    return Promise.resolve(refuse(
      400,
      "invalid-source",
      "Supply exactly one of `program` and `pattern`.",
    ));
  }
  const result = await runServedVerb(deps, callerDid, input.space, {
    name: "instantiate",
    request: {
      source,
      ...(input.argument === undefined ? {} : { argument: input.argument }),
      ...(input.repository === undefined
        ? {}
        : { repository: input.repository }),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(input.register === undefined ? {} : { register: input.register }),
      ...(input.requestKey === undefined
        ? {}
        : { requestKey: input.requestKey }),
      actingUser: callerDid,
      start: input.start !== false,
    },
  }, timings);
  if (result.status !== 200) return result;
  if (
    result.body.registration.status === "skipped" ||
    result.body.registration.status === "handled"
  ) return result;
  const incomplete = (
    receipt: ServedInstantiateReceipt,
    phase: string,
    code: LifecycleErrorCode,
  ): LifecycleResult<ServedInstantiateReceipt> => ({
    status: 200,
    body: {
      ...receipt,
      registration: {
        status: "failed",
        ...(receipt.registration.attempt === undefined
          ? {}
          : { attempt: receipt.registration.attempt }),
        error:
          `Registration ${phase} could not complete (${code}); retry the same request key`,
      },
    },
  });
  const prepared = await runServedVerb(deps, callerDid, input.space, {
    name: "registration-prepare",
    request: { receipt: result.body, actingUser: callerDid },
  }, timings);
  if (prepared.status !== 200) {
    return incomplete(result.body, "preparation", prepared.body.code);
  }
  const delivering = performance.now();
  const outcome = prepared.body.delivery === undefined
    ? {}
    : await observeRegistrationDelivery(
      deps,
      callerDid,
      prepared.body.delivery,
    );
  if (prepared.body.delivery !== undefined) {
    timings.push({
      phase: "registration.delivery",
      ms: Math.round(performance.now() - delivering),
    });
  }
  const finished = await runServedVerb(deps, callerDid, input.space, {
    name: "registration-finish",
    request: { prepared: prepared.body, actingUser: callerDid, outcome },
  }, timings);
  return finished.status === 200
    ? finished
    : incomplete(prepared.body.receipt, "completion", finished.body.code);
}

/** Observe only a server-prepared stream; no process-identity session reads private space data. */
async function observeRegistrationDelivery(
  deps: LifecycleDeps,
  callerDid: string,
  delivery: NonNullable<ServedRegistrationPreparation["delivery"]>,
): Promise<ServedRegistrationOutcome> {
  const { stream, eventId, piece } = delivery;
  const authority = await authorizeSpaceWriter(
    deps.authority,
    stream.space,
    callerDid,
  );
  if (!authority.ok) return { error: authority.message };
  const targetStream = streamEntriesDocId(stream);
  const readOutcome = async (): Promise<
    ServedRegistrationOutcome | undefined
  > => {
    const document = await deps.readDocument(stream.space, targetStream);
    const value = document?.value as StreamEventsDocValue | undefined;
    const entry = value?.entries?.find((entry) => entry.eventId === eventId);
    if (entry === undefined) return undefined;
    if (
      entry.status === "dropped" || entry.status === "needs-attention" ||
      entry.error
    ) {
      return {
        error: entry.error ?? entry.reason ?? entry.status,
        terminal: true,
      };
    }
    return entry.consequenced ? {} : undefined;
  };
  const consequence = Promise.withResolvers<ServedRegistrationOutcome>();
  let finished = false;
  let observations = Promise.resolve();
  const observe = () => {
    observations = observations.then(async () => {
      if (finished) return;
      const outcome = await readOutcome();
      if (outcome !== undefined) consequence.resolve(outcome);
    }).catch((error) => consequence.reject(error));
  };
  const cancel = deps.watchAdmittedCommits((notice) => {
    if (
      notice.space === stream.space &&
      notice.writes.some((write) => write.id === targetStream)
    ) observe();
  });
  observe();
  try {
    const [, outcome] = await Promise.all([
      deps.append({
        targetSpace: stream.space,
        targetStream,
        targetStreamLink: stream,
        eventId,
        payload: { piece },
        actingPrincipal: callerDid,
        actingSession: callerDid,
        capabilityRef: `stream-append:${targetStream}`,
        sessionId: crypto.randomUUID(),
        localSeq: 1,
      }),
      consequence.promise,
    ]);
    return outcome;
  } catch (error) {
    // Only durable terminal evidence advances an attempt after an uncertain append.
    try {
      const retained = await readOutcome();
      if (retained?.terminal) return retained;
    } catch {
      /* Retain the original delivery identity when readback also fails. */
    }
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    finished = true;
    cancel();
  }
}

/**
 * The `setsrc` verb: replace a piece's source with the request's pattern.
 * A program is compiled as a verb of its own first, so its closure is
 * durable at that verb's wave commit before the update's setup transaction
 * reads and extends it; the update then commits directly to the store,
 * outside the wave. Unless `start` is `false`, the piece's root is named as
 * the loop's demand, so a piece nothing runs derives under its new source
 * in the cycle after; a piece the loop runs is swapped by its pointer
 * watcher either way.
 */
export async function processSetSource(
  deps: LifecycleDeps,
  callerDid: string,
  input: WireSource & {
    space: string;
    piece: string;
    repository?: string;
    dangerouslyAllowIncompatibleSchema?: boolean;
    expectedPattern?: ServedPatternRef;
    start?: boolean;
  },
): Promise<LifecycleResult<ServedSetSourceReceipt>> {
  const source = wireSource(input);
  if (source === undefined) {
    return refuse(
      400,
      "invalid-source",
      "Supply exactly one of `program` and `pattern`.",
    );
  }
  let candidate: ServedPatternRef;
  if (source.program !== undefined) {
    const uploaded = await runServedVerb(deps, callerDid, input.space, {
      name: "upload",
      request: { program: source.program },
    });
    if (uploaded.status !== 200) return uploaded;
    candidate = uploaded.body;
  } else {
    candidate = source.pattern;
  }
  return await runServedVerb(deps, callerDid, input.space, {
    name: "setsrc",
    request: {
      pieceId: input.piece,
      pattern: candidate,
      ...(input.repository === undefined
        ? {}
        : { repository: input.repository }),
      ...(input.dangerouslyAllowIncompatibleSchema === undefined ? {} : {
        dangerouslyAllowIncompatibleSchema:
          input.dangerouslyAllowIncompatibleSchema,
      }),
      ...(input.expectedPattern === undefined
        ? {}
        : { expectedPattern: input.expectedPattern }),
      actingUser: callerDid,
      start: input.start !== false,
    },
  });
}
