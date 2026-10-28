/**
 * Calling a verb: sending an event to a stream a piece declares, and reading
 * back what the handling returned.
 *
 * {@link callVerb} is the whole call for a caller that names a piece and a
 * verb — a runtime, a piece's address, a verb's name and a JSON event — and
 * is what an agent's tool and a service's warm runtime call. It finds the verb
 * in the piece's compiled pattern, judges the event through the gate in
 * `./verb-input.ts`, and dispatches it with {@link sendVerbEvent}.
 * `cf piece call` resolves its target its own way, with fallbacks a named verb
 * on a piece's result never needs, and dispatches through
 * {@link sendVerbEvent} directly. Either way one implementation sends the
 * event and settles it.
 */

import type { JSONSchema, Pattern } from "@commonfabric/api";
import {
  type Cell,
  type EventAppendDeliveryOutcome,
  type IExtendedStorageTransaction,
  isStream,
  type NormalizedFullLink,
  type Runtime,
  sendEvent,
  transactionFailureMessage,
} from "@commonfabric/runner";
import { isInstance, isObjectNotArray } from "@commonfabric/utils/types";
import { loadPiecePattern } from "./ops/piece-controller.ts";
import { nearestName } from "./refusal.ts";
import { verbEventForDispatch } from "./verb-input.ts";
import {
  handlerVerbEvents,
  type PieceCallableListing,
  verbsFromCompiledPattern,
} from "./verb-listing.ts";

/**
 * What names one handler invocation: the caller's idempotency key for a
 * dispatch, and the session that key was chosen within.
 *
 * The two travel as a pair because an id is the caller's own word, and
 * another caller can pick the same one. The pair reaches the durable event
 * id, so a retry naming both collides on the handling's create-only receipt
 * and reads the original outcome back, while the same id under another
 * session is a different invocation entirely.
 *
 * The guarantee is at-most-once *commit*, not at-most-once *execution* — a
 * redelivered event re-runs the handler body and loses the race for the
 * receipt, so a verb whose body has effects outside its transaction (an LLM
 * call, a fetch) repeats those effects on retry even though nothing commits
 * twice.
 */
export interface VerbInvocation {
  id: string;
  session: string;
}

/** The failure a handling's transaction carries. */
export type VerbHandlingError = Extract<
  ReturnType<IExtendedStorageTransaction["status"]>,
  { status: "error" }
>["error"];

/** The two spans a dispatch passes through, named to a timing hook. */
export type VerbDispatchSpan = "dispatch" | "handled";

/** How {@link sendVerbEvent} dispatches, and what it reports on the way. */
export interface SendVerbEventOptions {
  /** The id and session naming this call's invocation. Absent for a call
   * that names none, which is dispatched under a runtime-minted event id. */
  invocation?: VerbInvocation;

  /** Reports each phase as it is reached. */
  onPhase?: (phase: "dispatched" | "committed") => void;

  /** Wraps each span, for a caller that times them. */
  time?: <T>(span: VerbDispatchSpan, run: () => Promise<T>) => Promise<T>;

  /** @internal Seam for tests, which dispatch to a stand-in handler. */
  sendEvent?: typeof sendEvent;
}

/** A handling's failure. */
export interface VerbHandlingFailed {
  status: "failed";
  error: VerbHandlingError;
}

/** What {@link sendVerbEvent} returns once the caller's act committed. */
export interface VerbEventCommitted {
  status: "committed";

  /** The transaction the commit callback handed back. */
  tx: IExtendedStorageTransaction;

  /** True when this call collided on the create-only receipt: the handling
   * did not commit again, and its receipt is the ORIGINAL handling's. */
  deduplicated: boolean;

  /** The handling's receipt, where its outcome is written. Absent when the
   * runtime wrote none. Known at commit, before anything is read. */
  receipt?: NormalizedFullLink;

  /**
   * Waits for the handling itself to land — under server execution the
   * served handling's consequence, otherwise the commit already in hand — and
   * returns its failure, if it failed there.
   */
  handled(): Promise<{ status: "handled" } | VerbHandlingFailed>;
}

const defaultTime = <T>(
  _span: VerbDispatchSpan,
  run: () => Promise<T>,
): Promise<T> => run();

/** Whether a handling's failure is the receipt-exists collision a
 * deduplicated retry meets. */
const isReceiptCollision = (error: VerbHandlingError): boolean =>
  "precondition" in error && error.precondition === "receipt-exists";

/**
 * Sends `event` to the verb stream `stream` and returns once the caller's act
 * is durable, or the handling's failure where its commit was refused.
 * `event` is dispatched as given, so a caller judges it first —
 * `verbEventForDispatch` is that gate.
 *
 * @throws Error when the event append is refused on an otherwise clean
 * transaction, or the send itself throws.
 */
export async function sendVerbEvent(
  stream: Cell<unknown>,
  event: unknown,
  options: SendVerbEventOptions = {},
): Promise<VerbEventCommitted | VerbHandlingFailed> {
  const { invocation } = options;
  const time = options.time ?? defaultTime;
  options.onPhase?.("dispatched");
  // Two settlements come back from one send. `appended` is the caller's
  // own authored act durable: under server execution the event append,
  // which the server then handles; otherwise the handling's commit, the
  // same moment as `handled`. `handled` is the handling's final commit
  // callback — under server execution, the served handling's consequence.
  // The dispatch span runs to the first, and a readback waits for the second
  // before it reads the receipt.
  const handled = Promise.withResolvers<IExtendedStorageTransaction>();
  const tx = await time(
    "dispatch",
    () =>
      new Promise<IExtendedStorageTransaction>((resolve, reject) => {
        const onAppended = (
          delivery: EventAppendDeliveryOutcome,
          appendedTx: IExtendedStorageTransaction,
        ) => {
          // A refusal the transaction itself carries — a handling that
          // threw or whose commit was rejected — is reported below off
          // the transaction's status; only an append refused on an
          // otherwise clean transaction is reported here.
          if (delivery.delivered || appendedTx.status().status === "error") {
            resolve(appendedTx);
          } else {
            reject(new Error(`event append refused: ${delivery.refused}`));
          }
        };
        // The commit callback settles both: a sender that never reports
        // the append — one whose act IS the commit — is acknowledged
        // here, and the appended report, when it comes, comes first.
        const onCommit = (committedTx: IExtendedStorageTransaction) => {
          resolve(committedTx);
          handled.resolve(committedTx);
        };
        try {
          (options.sendEvent ?? sendEvent)(
            stream,
            event,
            onCommit,
            {
              ...(invocation === undefined ? {} : {
                // The id and the session that chose it travel together:
                // an id is the caller's own word, and only the pair
                // decides which receipt this handling files under.
                eventId: invocation.id,
                session: invocation.session,
              }),
              onAppended,
            },
          );
        } catch (error) {
          reject(error);
        }
      }),
  );
  // Acknowledgment is transaction-local (verb contract, Settlement): the
  // callback above fires on THIS caller's durable act. Awaiting
  // runtime.idle() here instead would hold an already-committed write
  // hostage to every derived recomputation it triggered elsewhere in the
  // graph.
  options.onPhase?.("committed");

  const txStatus = tx.status();
  const deduplicated = txStatus.status === "error" &&
    isReceiptCollision(txStatus.error);
  if (txStatus.status === "error" && !deduplicated) {
    return { status: "failed", error: txStatus.error };
  }

  return {
    status: "committed",
    tx,
    deduplicated,
    // The handling's receipt address, taken off the transaction the commit
    // callback handed back (verb contract WS-D). It is known HERE — at
    // commit, before anything is read — which is what lets a caller that
    // does not wait publish an address for an outcome nobody read.
    ...(tx.handlingReceiptLink !== undefined
      ? { receipt: tx.handlingReceiptLink }
      : {}),
    handled: async () => {
      // The readback needs the handling itself to have landed, which under
      // server execution is the served handling's consequence — refused,
      // errored, or dropped there, a readback would find no receipt. Off
      // it, `handled` settled with `tx` above.
      const handledTx = await time("handled", () => handled.promise);
      const handledStatus = handledTx.status();
      if (
        handledStatus.status === "error" && handledTx !== tx &&
        !isReceiptCollision(handledStatus.error)
      ) {
        return { status: "failed", error: handledStatus.error };
      }
      return { status: "handled" };
    },
  };
}

/**
 * The verbs an event can be sent to on a piece's result, read from the
 * compiled pattern it is pinned to: the rows `cf piece verbs` lists, narrowed
 * to the handlers the result declares or wires.
 */
export const resultVerbs = (pattern: Pattern): PieceCallableListing[] =>
  verbsFromCompiledPattern(pattern).filter((verb) =>
    verb.kind === "handler" && verb.on === "result"
  );

/**
 * The verbs {@link callVerb} can call on the piece whose result cell is
 * `piece`.
 *
 * @throws Error when the piece's pattern cannot be loaded.
 */
export async function pieceVerbs(
  runtime: Runtime,
  piece: Cell<unknown>,
): Promise<PieceCallableListing[]> {
  const { pattern } = await loadPiecePattern(
    runtime,
    piece,
    piece.getAsNormalizedFullLink().space,
    { projectResult: false },
  );
  return resultVerbs(pattern);
}

/** What {@link callVerb} returns. */
export type VerbCall =
  /** Refused before anything was sent: nothing ran and nothing was written. */
  | { status: "refused"; message: string }
  /** Sent, and the handling failed: nothing it wrote was kept. */
  | { status: "failed"; message: string }
  | VerbCallSettled;

/** A call whose handling landed. */
export interface VerbCallSettled {
  status: "settled";

  /** The handling's receipt, where its outcome is written. Absent when the
   * runtime wrote none. */
  receipt?: NormalizedFullLink;

  /** What the verb returned, read off the receipt. Absent for a verb that
   * returns nothing. */
  result?: unknown;

  /** The result the verb declares, as its listing states it. Absent where it
   * declares none. */
  outputSchema?: JSONSchema;

  /** True when this call collided on the create-only receipt: the handling
   * did not commit again, and {@link result} is the ORIGINAL outcome. */
  deduplicated?: true;

  /** Why the result could not be read off the receipt, when it could not:
   * the handling landed, and only its outcome is unknown here. */
  unread?: string;
}

/** The refusal for a name `verbs` does not hold, naming the ones it does. */
const notAVerbMessage = (
  name: string,
  verbs: readonly PieceCallableListing[],
): string => {
  const names = verbs.map((verb) => verb.name);
  const nearest = nearestName(name, names);
  return `"${name}" is not a verb of this piece. ` +
    (nearest === undefined ? "" : `Did you mean "${nearest}"? `) +
    (names.length === 0
      ? "It declares no verbs"
      : `Its verbs are ${names.map((verb) => `"${verb}"`).join(", ")}`);
};

/**
 * Whether a receipt's stored value is the value-less witness: the plain empty
 * record a handling writes when its verb returned nothing. Decided on the
 * stored value, never the materialized one: an instance read through a cell
 * arrives as a proxy over an empty stub, so only the stored form tells the
 * two apart.
 */
const isValueLessReceipt = (raw: unknown): boolean =>
  isObjectNotArray(raw) && !isInstance(raw) && Object.keys(raw).length === 0;

/**
 * Calls the verb `verb` of the piece at `piece` with `event`, and returns
 * what the handling returned.
 *
 * The verb is one the piece's compiled pattern declares or wires on its
 * result. The event is judged against that verb's declared event schema —
 * the one {@link pieceVerbs} lists — with the handler's own event contract
 * deciding which positions take a reference, where an emitted address
 * converts to the link the verb stores. A name that is not a verb, and an
 * event the gate refuses, are refused before anything is sent.
 *
 * The piece is started in `runtime` if it is not running, and the handling
 * runs there. With an `invocation`, a retry naming the same pair settles on
 * the original outcome rather than committing twice.
 */
export async function callVerb(
  runtime: Runtime,
  piece: NormalizedFullLink,
  verb: string,
  event: unknown,
  options: { invocation?: VerbInvocation } = {},
): Promise<VerbCall> {
  const cell = runtime.getCellFromLink({ ...piece, schema: undefined });
  let pattern: Pattern;
  try {
    ({ pattern } = await loadPiecePattern(runtime, cell, piece.space, {
      projectResult: false,
    }));
  } catch (error) {
    return {
      status: "refused",
      message: `could not read the piece's pattern: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const verbs = resultVerbs(pattern);
  const listed = verbs.find((candidate) => candidate.name === verb);
  if (listed === undefined) {
    return { status: "refused", message: notAVerbMessage(verb, verbs) };
  }

  const schema = listed.inputSchema === true
    ? undefined
    : listed.inputSchema as JSONSchema;
  const judged = await verbEventForDispatch(
    event,
    schema,
    () => Promise.resolve(handlerVerbEvents(pattern).get(verb)),
  );
  if ("refusal" in judged) {
    return {
      status: "refused",
      message:
        `the event for "${verb}" was refused before it was sent: ${judged.refusal}`,
    };
  }

  if (!await runtime.start(cell)) {
    return {
      status: "refused",
      message:
        "the piece could not be started here: its start was superseded or it was stopped",
    };
  }
  const stream = cell.key(verb).asSchemaFromLinks() as Cell<unknown>;
  if (!isStream(stream)) {
    return {
      status: "refused",
      message: `"${verb}" did not resolve to a stream on this piece`,
    };
  }
  let sent: VerbEventCommitted | VerbHandlingFailed;
  try {
    sent = await sendVerbEvent(stream, judged.value, options);
  } catch (error) {
    return {
      status: "failed",
      message: `the event for "${verb}" could not be sent: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const handling = sent.status === "committed" ? await sent.handled() : sent;
  if (handling.status === "failed") {
    return {
      status: "failed",
      message: `the handler for "${verb}" failed, and nothing it wrote was ` +
        `kept: ${transactionFailureMessage(handling.error)}`,
    };
  }
  const committed = sent as VerbEventCommitted;
  const settled: VerbCallSettled = {
    status: "settled",
    ...(committed.deduplicated ? { deduplicated: true as const } : {}),
    ...(listed.outputSchema !== undefined
      ? { outputSchema: listed.outputSchema }
      : {}),
  };
  if (committed.receipt === undefined) return settled;
  const receipt = runtime.getCellFromLink(committed.receipt);
  // The handling landed, so a read of its outcome that fails — a receipt the
  // reader may not see, say — is said beside the receipt rather than turned
  // into a failure of a call that succeeded.
  let value: unknown;
  try {
    value = await receipt.pull();
  } catch (error) {
    return {
      ...settled,
      receipt: committed.receipt,
      unread: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ...settled,
    receipt: committed.receipt,
    ...(value !== undefined && !isValueLessReceipt(receipt.getRaw())
      ? { result: value }
      : {}),
  };
}
