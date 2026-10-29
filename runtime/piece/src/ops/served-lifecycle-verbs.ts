/**
 * The served lifecycle verbs named as data. A descriptor carries a verb's
 * name and request to whichever thread hosts the serving loop, and
 * {@link buildServedLifecycleVerb} turns it back into the `LifecycleVerb` an
 * `ExecutorHost` runs, over a piece controller the service identity opens on
 * the serving runtime. The pattern-lifecycle route sends descriptors, so the
 * verbs it offers are the same whether the loop runs in its process or in a
 * worker of it.
 */

import {
  createSession,
  type Identity,
  type Session,
} from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import type { Runtime, RuntimeProgram } from "@commonfabric/runner";
import {
  type LifecyclePhaseTiming,
  LifecycleVerbFailure,
  type LifecycleVerbRun,
} from "@commonfabric/runner/executor/lifecycle-verb";
import type { LifecycleVerb } from "@commonfabric/runner/executor/host";
import { PiecesController } from "./pieces-controller.ts";
import {
  confirmServedInstantiate,
  confirmServedRegistration,
  confirmServedSetSource,
  finishServedRegistration,
  prepareServedRegistration,
  servedInstantiatePiece,
  type ServedInstantiateReceipt,
  type ServedInstantiateRequest,
  type ServedPatternRef,
  type ServedRegistrationOutcome,
  type ServedRegistrationPreparation,
  servedSetPieceSource,
  type ServedSetSourceReceipt,
  type ServedSetSourceRequest,
  servedUploadPattern,
} from "./served-lifecycle.ts";

/** One served lifecycle verb, named with the request it serves. */
export type ServedLifecycleVerbDescriptor =
  | { readonly name: "upload"; readonly request: { program: RuntimeProgram } }
  | {
    readonly name: "instantiate";
    /** `start` names the new piece's root as the loop's demand. */
    readonly request: ServedInstantiateRequest & { start: boolean };
  }
  | {
    readonly name: "registration-prepare";
    readonly request: { receipt: ServedInstantiateReceipt; actingUser: string };
  }
  | {
    readonly name: "registration-finish";
    readonly request: {
      prepared: ServedRegistrationPreparation;
      actingUser: string;
      outcome: ServedRegistrationOutcome;
    };
  }
  | {
    readonly name: "setsrc";
    /** `start` names the piece's root as the loop's demand. */
    readonly request: ServedSetSourceRequest & { start: boolean };
  };

/** The receipt each verb returns, by the verb's name. */
export type ServedLifecycleReceipts = {
  upload: ServedPatternRef;
  instantiate: ServedInstantiateReceipt;
  "registration-prepare": ServedRegistrationPreparation;
  "registration-finish": ServedInstantiateReceipt;
  setsrc: ServedSetSourceReceipt;
};

/**
 * Runs served lifecycle verbs from descriptors: an `ExecutorHost` through
 * {@link servedLifecycleRunner}, or the serving worker's launcher. Each run
 * yields the verb's receipt and the steps the serving side timed.
 */
export type ServedLifecycleVerbRunner = {
  runLifecycleVerb(
    space: MemorySpace,
    verb: ServedLifecycleVerbDescriptor,
  ): Promise<LifecycleVerbRun>;
};

/** What runs a built verb: an `ExecutorHost`, or what stands in for one. */
export type ServedLifecycleVerbHost = {
  runLifecycleVerb<T>(
    space: MemorySpace,
    verb: LifecycleVerb<T>,
  ): Promise<T>;
};

/** The document a piece id names, the root the serving loop demands. */
const pieceRootDocId = (pieceId: string): string =>
  pieceId.startsWith("of:") ? pieceId : `of:${pieceId}`;

/**
 * `verb` with its receipt type forgotten. A verb's `confirm` and
 * `demandRoots` take the receipt its `run` returned, so handing them what the
 * loop hands back as `unknown` is handing them their own receipt.
 */
const withReceiptForgotten = <T>(
  verb: LifecycleVerb<T>,
): LifecycleVerb<unknown> => ({
  name: verb.name,
  run: verb.run,
  ...(verb.confirm === undefined ? {} : {
    confirm: (runtime: Runtime, receipt: unknown) =>
      verb.confirm!(runtime, receipt as T),
  }),
  ...(verb.demandRoots === undefined ? {} : {
    demandRoots: (receipt: unknown) => verb.demandRoots!(receipt as T),
  }),
});

/**
 * Builds the verb `descriptor` names, to run on `space`'s serving runtime.
 * Its run opens the space over `session`, the serving side's own, since the
 * verb runs as the loop's bookkeeping under the lease.
 *
 * @throws Error on a descriptor whose name this module does not know.
 */
export function buildServedLifecycleVerb(
  space: MemorySpace,
  descriptor: ServedLifecycleVerbDescriptor,
  session: Session,
): LifecycleVerb<unknown> {
  const pieces = (runtime: Runtime): PiecesController =>
    new PiecesController(session, runtime, { deferSpaceCellSync: true });
  const demandRoots = (start: boolean) =>
    start
      ? {
        demandRoots: (receipt: { pieceId: string }) => [
          pieceRootDocId(receipt.pieceId),
        ],
      }
      : {};
  switch (descriptor.name) {
    case "upload": {
      const { program } = descriptor.request;
      const verb: LifecycleVerb<ServedPatternRef> = {
        name: descriptor.name,
        run: async (runtime) =>
          (await servedUploadPattern(pieces(runtime), program)).ref,
      };
      return withReceiptForgotten(verb);
    }
    case "instantiate": {
      const { start, ...request } = descriptor.request;
      const verb: LifecycleVerb<ServedInstantiateReceipt> = {
        name: descriptor.name,
        run: (runtime) => servedInstantiatePiece(pieces(runtime), request),
        confirm: (runtime, receipt) =>
          confirmServedInstantiate(runtime, space, receipt, request.actingUser),
        ...demandRoots(start),
      };
      return withReceiptForgotten(verb);
    }
    case "registration-prepare": {
      const { receipt, actingUser } = descriptor.request;
      const verb: LifecycleVerb<ServedRegistrationPreparation> = {
        name: descriptor.name,
        run: (runtime) =>
          prepareServedRegistration(pieces(runtime), receipt, actingUser),
        confirm: (runtime, prepared) =>
          confirmServedRegistration(
            runtime,
            space,
            prepared.receipt,
            actingUser,
          ),
      };
      return withReceiptForgotten(verb);
    }
    case "registration-finish": {
      const { prepared, actingUser, outcome } = descriptor.request;
      const verb: LifecycleVerb<ServedInstantiateReceipt> = {
        name: descriptor.name,
        run: (runtime) =>
          finishServedRegistration(
            pieces(runtime),
            prepared,
            actingUser,
            outcome,
          ),
        confirm: (runtime, receipt) =>
          confirmServedRegistration(runtime, space, receipt, actingUser),
      };
      return withReceiptForgotten(verb);
    }
    case "setsrc": {
      const { start, ...request } = descriptor.request;
      const verb: LifecycleVerb<ServedSetSourceReceipt> = {
        name: descriptor.name,
        run: (runtime) => servedSetPieceSource(pieces(runtime), request),
        confirm: (runtime, receipt) =>
          confirmServedSetSource(runtime, space, receipt),
        ...demandRoots(start),
      };
      return withReceiptForgotten(verb);
    }
    default: {
      const unknown: never = descriptor;
      throw new Error(
        `no served lifecycle verb is named "${
          (unknown as { name: string }).name
        }"`,
      );
    }
  }
}

/**
 * A lap timer over one served verb: each call records, under the verb's
 * name, the time since the previous call or since the timer started.
 */
function verbTimer(
  verbName: string,
  timings: LifecyclePhaseTiming[],
): (phase: string) => void {
  let since = performance.now();
  return (phase) => {
    const now = performance.now();
    timings.push({
      phase: `${verbName}.${phase}`,
      ms: Math.round(now - since),
    });
    since = now;
  };
}

/**
 * Runs the verb `descriptor` names on `space`'s serving runtime through
 * `host`, as `serviceIdentity`, and times its steps as {@link LifecycleVerbRun}
 * states them: the session opened here ahead of the queue, then the queue
 * wait, the run, the commit and the confirm around the verb the host runs.
 */
export async function runServedLifecycleVerb(
  host: ServedLifecycleVerbHost,
  space: MemorySpace,
  descriptor: ServedLifecycleVerbDescriptor,
  serviceIdentity: Identity,
): Promise<LifecycleVerbRun> {
  const timings: LifecyclePhaseTiming[] = [];
  const lap = verbTimer(descriptor.name, timings);
  try {
    const session = createSession({
      identity: serviceIdentity,
      spaceDid: space as DID,
    });
    lap("session");
    const verb = buildServedLifecycleVerb(space, descriptor, session);
    const confirm = verb.confirm;
    const receipt = await host.runLifecycleVerb<unknown>(space, {
      ...verb,
      run: async (runtime) => {
        lap("queue");
        try {
          return await verb.run(runtime);
        } finally {
          lap("run");
        }
      },
      ...(confirm === undefined ? {} : {
        confirm: async (runtime: Runtime, receipt: unknown) => {
          lap("commit");
          try {
            await confirm(runtime, receipt);
          } finally {
            lap("confirm");
          }
        },
      }),
    });
    if (confirm === undefined) lap("commit");
    return { receipt, timings };
  } catch (error) {
    throw new LifecycleVerbFailure(error, timings);
  }
}

/**
 * A runner of descriptors over `host`, which runs each verb this module
 * builds from one, as `serviceIdentity`, through
 * {@link runServedLifecycleVerb}.
 */
export function servedLifecycleRunner(
  host: ServedLifecycleVerbHost,
  serviceIdentity: Identity,
): ServedLifecycleVerbRunner {
  return {
    runLifecycleVerb: (space, descriptor) =>
      runServedLifecycleVerb(host, space, descriptor, serviceIdentity),
  };
}
