/**
 * The pattern-lifecycle verbs as a `pattern.lifecycle` request on a memory
 * session runs them: validate the verb's arguments, authorize the caller as a
 * writer of the space, hand the verb to the space's serving runtime, and turn
 * what comes back into a receipt or a refusal with its code. Creation and
 * source changes run inside `@commonfabric/piece`'s served operations on the
 * serving loop's cycle; registration uses trusted event ingress after creation
 * commits (docs/features/server-pattern-lifecycle.md).
 */

import type { AttributeValue } from "@opentelemetry/api";
import { z } from "zod";

import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import type {
  PatternLifecycleCall,
  PatternLifecycleOutcome,
  Server,
} from "@commonfabric/memory/v2/server";
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
import type { RoutedPlane } from "@commonfabric/runner/executor/routed-plane";
import {
  authorizeSpaceWriter,
  type SpaceAuthorityDeps,
} from "@/lib/space-authority.ts";

const programSchema = z.object({
  main: z.string(),
  mainExport: z.string().optional(),
  files: z.array(z.object({ name: z.string(), contents: z.string() })),
  sourceRoots: z.array(z.string()).optional(),
  dataFiles: z.array(z.string()).optional(),
});

const patternRefSchema = z.object({
  identity: z.string(),
  symbol: z.string(),
});

const sourceFields = {
  program: programSchema.optional(),
  pattern: patternRefSchema.optional(),
};

/** Whether a body names exactly one of `program` and `pattern`. */
const oneSource = (body: { program?: unknown; pattern?: unknown }): boolean =>
  (body.program === undefined) !== (body.pattern === undefined);

const oneSourceMessage = {
  message: "Supply exactly one of `program` and `pattern`.",
};

/**
 * Each verb's arguments as a `pattern.lifecycle` request carries them, without
 * the space, which the request's session supplies.
 */
const lifecycleBodies = {
  upload: z.object({ program: programSchema }),
  instantiate: z.object({
    ...sourceFields,
    requestKey: z.string().min(1).max(256).optional(),
    argument: z.record(z.string(), z.unknown()).optional(),
    repository: z.string().optional(),
    slug: z.string().optional(),
    force: z.boolean().optional(),
    register: z.boolean().optional(),
    start: z.boolean().optional(),
  }).refine(oneSource, oneSourceMessage),
  setsrc: z.object({
    piece: z.string(),
    ...sourceFields,
    repository: z.string().optional(),
    dangerouslyAllowIncompatibleSchema: z.boolean().optional(),
    expectedPattern: patternRefSchema.optional(),
    start: z.boolean().optional(),
  }).refine(oneSource, oneSourceMessage),
};

export interface LifecycleDeps {
  /** What the writer check reads the space's ACL through. */
  authority: SpaceAuthorityDeps;

  /**
   * The serving loop, running on this thread or in a worker of this process;
   * `undefined` on a deployment running without it, which refuses every verb
   * with `server-execution-off`. It builds each verb from the descriptor it is
   * sent and runs it as the serving side's own identity, since the verb runs
   * as the loop's bookkeeping under the lease.
   */
  host: () => ServedLifecycleVerbRunner | undefined;

  /**
   * The routed plane to other spaces' owners while the process routes its
   * crossings (docs/plans/serving-loop-owner-routing.md); `undefined` while
   * it does not, and then every delivery goes to this process's own server.
   */
  route?: () => Pick<RoutedPlane, "scope"> | undefined;

  /** Trusted event ingress once the caller is authorized as a writer. */
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

/** What a verb returns: its receipt, or a refusal with its code. */
export type LifecycleResult<T> =
  | { ok: T }
  | { refusal: { code: LifecycleErrorCode; message: string } };

/** A request's pattern source as the wire carries it: one of the two. */
export interface WireSource {
  program?: RuntimeProgram;
  pattern?: ServedPatternRef;
}

const refuse = (
  code: LifecycleErrorCode,
  message: string,
): LifecycleResult<never> => ({ refusal: { code, message } });

/** Every code a served verb's own refusal carries. */
const SERVED_REFUSAL_CODES: Record<ServedLifecycleRefusalCode, true> = {
  "compile-failed": true,
  "pattern-not-found": true,
  "setup-failed": true,
  "slug-taken": true,
  "piece-not-found": true,
  "incompatible": true,
  "source-moved": true,
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
  return typeof code === "string" && Object.hasOwn(SERVED_REFUSAL_CODES, code)
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
    return refuse("forbidden", authority.message);
  }
  try {
    const run = await host.runLifecycleVerb(space as MemorySpace, verb);
    for (const timing of run.timings) timings?.push(timing);
    return { ok: run.receipt as ServedLifecycleReceipts[Verb["name"]] };
  } catch (error) {
    if (error instanceof LifecycleVerbFailure) {
      for (const timing of error.timings) timings?.push(timing);
    }
    const refusal = servedRefusalOf(error);
    if (refusal !== undefined) return refuse(refusal.code, refusal.message);
    const message = error instanceof Error ? error.message : String(error);
    // The loop's own `SpaceNotServedError`, by the name a worker's port keeps.
    if (error instanceof Error && error.name === "SpaceNotServedError") {
      return refuse("space-not-served", message);
    }
    deps.logger?.warn(
      { space, verb: verb.name, error: message },
      "pattern-lifecycle verb failed",
    );
    return refuse("internal", `${verb.name} failed: ${message}`);
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
  return "ok" in uploaded ? { ok: { pattern: uploaded.ok } } : uploaded;
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
    "ok" in result ? result.ok.requestKey : input.requestKey,
    timings,
  );
  return "ok" in result ? { ok: { ...result.ok, timings } } : result;
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
    return refuse(
      "invalid-source",
      "Supply exactly one of `program` and `pattern`.",
    );
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
  if (!("ok" in result)) return result;
  if (
    result.ok.registration.status === "skipped" ||
    result.ok.registration.status === "handled"
  ) return result;
  const incomplete = (
    receipt: ServedInstantiateReceipt,
    phase: string,
    code: LifecycleErrorCode,
  ): LifecycleResult<ServedInstantiateReceipt> => ({
    ok: {
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
    request: { receipt: result.ok, actingUser: callerDid },
  }, timings);
  if (!("ok" in prepared)) {
    return incomplete(result.ok, "preparation", prepared.refusal.code);
  }
  const delivering = performance.now();
  const outcome = prepared.ok.delivery === undefined
    ? {}
    : await observeRegistrationDelivery(
      deps,
      callerDid,
      input.space,
      prepared.ok.delivery,
    );
  if (prepared.ok.delivery !== undefined) {
    timings.push({
      phase: "registration.delivery",
      ms: Math.round(performance.now() - delivering),
    });
  }
  const finished = await runServedVerb(deps, callerDid, input.space, {
    name: "registration-finish",
    request: { prepared: prepared.ok, actingUser: callerDid, outcome },
  }, timings);
  return "ok" in finished
    ? finished
    : incomplete(prepared.ok.receipt, "completion", finished.refusal.code);
}

/**
 * A registration event as the delivery's transport sends it: the entry
 * without the session and position each transport numbers its own way.
 */
type DeliveryEntry = Omit<
  Parameters<Server["commitDelegatedAppend"]>[0],
  "sessionId" | "localSeq"
>;

/**
 * How a registration's delivery reaches the stream's space: where it appends
 * the event, and where it watches the stream's document for the event's
 * outcome.
 */
export interface DeliveryTransport {
  /** Sends the registration event into the stream's space, at least once. */
  append: (entry: DeliveryEntry) => Promise<unknown>;

  /**
   * Calls `onChange` each time the document `id` in `space` changes, until
   * the returned function is called.
   */
  watch: (
    space: MemorySpace,
    id: string,
    onChange: () => void,
  ) => Promise<() => void>;

  /** Releases what the transport holds. */
  dispose: () => void;
}

/**
 * The transport for a registration into `streamSpace` from a verb that ran
 * in `verbSpace`: the process's own server when the stream's space is the
 * verb's, which this process serves, and otherwise the stream's owner
 * through the route while the process has one. Without a route every
 * delivery stays on this process's server.
 */
export function registrationDeliveryTransport(
  deps: Pick<LifecycleDeps, "append" | "watchAdmittedCommits" | "route">,
  verbSpace: string,
  streamSpace: string,
): DeliveryTransport {
  const route = verbSpace === streamSpace ? undefined : deps.route?.();
  if (route === undefined) {
    return {
      append: (entry) =>
        deps.append({ ...entry, sessionId: crypto.randomUUID(), localSeq: 1 }),
      watch: (space, id, onChange) =>
        Promise.resolve(deps.watchAdmittedCommits((notice) => {
          if (
            notice.space === space &&
            notice.writes.some((write) => write.id === id)
          ) onChange();
        })),
      dispose: () => {},
    };
  }
  // The owner's session names the target, and the plane numbers the entry.
  const scope = route.scope();
  return {
    append: ({ targetSpace, ...entry }) =>
      scope.append(targetSpace as MemorySpace, entry),
    watch: (space, id, onChange) => scope.watchDocument(space, id, onChange),
    dispose: () => scope.dispose(),
  };
}

/** Observe only a server-prepared stream; no process-identity session reads private space data. */
async function observeRegistrationDelivery(
  deps: LifecycleDeps,
  callerDid: string,
  verbSpace: string,
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
  const transport = registrationDeliveryTransport(
    deps,
    verbSpace,
    stream.space,
  );
  let cancel: (() => void) | undefined;
  try {
    cancel = await transport.watch(stream.space, targetStream, observe);
    observe();
    const [, outcome] = await Promise.all([
      transport.append({
        targetSpace: stream.space,
        targetStream,
        targetStreamLink: stream,
        eventId,
        payload: { piece },
        actingPrincipal: callerDid,
        actingSession: callerDid,
        capabilityRef: `stream-append:${targetStream}`,
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
    cancel?.();
    transport.dispose();
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
    if (!("ok" in uploaded)) return uploaded;
    candidate = uploaded.ok;
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

/**
 * Runs one `pattern.lifecycle` request the memory server handed over: the
 * verb's arguments are validated against the verb's schema, the verb runs as
 * `call.principal`, and its result is the outcome the memory server answers
 * with. A body that fails validation is refused as `invalid-request`.
 */
export async function processLifecycleCall(
  deps: LifecycleDeps,
  call: PatternLifecycleCall,
): Promise<PatternLifecycleOutcome> {
  return await lifecycleResult(deps, call) ?? {
    refusal: {
      code: "invalid-request",
      message: `The \`${call.verb}\` arguments do not match the verb's schema`,
    },
  };
}

/**
 * Helper for `processLifecycleCall()`, which validates the arguments and
 * runs the verb, returning `undefined` for arguments that fail validation.
 */
async function lifecycleResult(
  deps: LifecycleDeps,
  { space, principal, verb, body }: PatternLifecycleCall,
): Promise<
  | LifecycleResult<
    | { pattern: ServedPatternRef }
    | InstantiateReceipt
    | ServedSetSourceReceipt
  >
  | undefined
> {
  switch (verb) {
    case "upload": {
      const parsed = lifecycleBodies.upload.safeParse(body);
      return parsed.success
        ? await processUpload(deps, principal, { space, ...parsed.data })
        : undefined;
    }
    case "instantiate": {
      const parsed = lifecycleBodies.instantiate.safeParse(body);
      return parsed.success
        ? await processInstantiate(deps, principal, { space, ...parsed.data })
        : undefined;
    }
    case "setsrc": {
      const parsed = lifecycleBodies.setsrc.safeParse(body);
      return parsed.success
        ? await processSetSource(deps, principal, { space, ...parsed.data })
        : undefined;
    }
  }
}
