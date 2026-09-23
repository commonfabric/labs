// The pattern-lifecycle verbs as the serving side runs them
// (docs/features/server-pattern-lifecycle.md): compile a program into a
// space, create a piece from a pattern, and replace a piece's source. Each
// runs on a space's serving runtime inside a wave cycle. A write the first
// two make seals into that cycle's wave and reaches the store as one of the
// serving loop's own commits, which rules out the client-side shape of the
// same operations in two places: a transaction the runtime seals is
// accepted at the seal and durable only at the wave commit, so a receipt
// minted from the transaction is refused (`runSyncedWithCommit`), and the
// storage manager's full `synced()` waits on that same commit and would
// deadlock. Those verbs mint their receipts from what they wrote and leave
// durability to the `confirm` read, which the serving loop runs once the
// wave has committed. A source update carries module-update authority the
// runner publishes only from a transaction that commits to storage itself,
// so its setup transaction commits directly, outside the wave, and its
// receipt is the store's verdict.

import {
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import {
  type Cell,
  compileAndSavePattern,
  entityIdFrom,
  getPatternIdentityRef,
  getPieceSourceRevisions,
  isLink,
  isStream,
  type MemorySpace,
  type NormalizedFullLink,
  type Pattern,
  PIECE_SOURCE_MOVED,
  resolveSpaceRootPattern,
  type Runtime,
  type RuntimeProgram,
  scopeCallerEventId,
} from "@commonfabric/runner";
import { pieceListSchema } from "@commonfabric/runner/schemas";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { pieceId as pieceIdOf } from "../piece-id.ts";
import { claimSlugInTx, prepareSlugClaim } from "../slugs.ts";
import { prepareSourceClosureVerification } from "../../../runner/src/compilation-cache/cell-cache.ts";
import {
  isPieceSourceCompatibilityRefusal,
  type PatternUpdateReceipt,
  type PieceController,
  PieceSourceChangedError,
} from "./piece-controller.ts";
import type { PiecesController } from "./pieces-controller.ts";

/** A content-addressed pattern pointer: the closure and the export run. */
export type ServedPatternRef = { identity: string; symbol: string };

/**
 * Where a served verb takes its pattern from: a program the serving side
 * compiles, or a pattern the space already holds by identity — the result
 * of an earlier upload.
 */
export type ServedPatternSource =
  | { program: RuntimeProgram; pattern?: undefined }
  | { pattern: ServedPatternRef; program?: undefined };

/**
 * Why a served verb refused. Each code names one condition a caller can
 * act on; anything else the verbs throw is a failure of the serving side.
 */
export type ServedLifecycleRefusalCode =
  /** The program did not compile. */
  | "compile-failed"
  /** The named pattern is not held by the space, or cannot load. */
  | "pattern-not-found"
  /** Setup refused the pattern or the argument. */
  | "setup-failed"
  /** The requested slug already names something, and `force` was not set. */
  | "slug-taken"
  /** The named piece is not held by the space. */
  | "piece-not-found"
  /** The candidate source cannot run over the piece's retained state. */
  | "incompatible"
  /** The piece is not on the pattern the update was proved against. */
  | "source-moved";

/** A served verb's refusal, carrying the code the wire reports. */
export class ServedLifecycleRefusal extends Error {
  readonly #code: ServedLifecycleRefusalCode;

  constructor(
    code: ServedLifecycleRefusalCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ServedLifecycleRefusal";
    this.#code = code;
  }

  get code(): ServedLifecycleRefusalCode {
    return this.#code;
  }
}

/** What `instantiate` asks for. */
export interface ServedInstantiateRequest {
  source: ServedPatternSource;

  /** The new piece's argument; absent means the pattern's defaults. */
  argument?: object;

  /** Repository locator stored with the piece's source. */
  repository?: string;

  /** A name for the new piece, claimed in the creation transaction. */
  slug?: string;

  /** Take `slug` even when it already names something. */
  force?: boolean;

  /** Register through the root action after the creation commits. */
  register?: boolean;

  /** Caller-owned creation key, scoped to the acting principal and space. */
  requestKey?: string;

  /**
   * The principal the verb acts for. The creation transaction carries this
   * principal's trust snapshot, so a label the setup mints attributes to
   * the requester rather than to the serving identity.
   */
  actingUser: string;
}

/** What `instantiate` hands back. */
export interface ServedInstantiateReceipt {
  /** Retain this key when retrying creation or pending registration. */
  requestKey: string;

  /** Registration is a separate durable action after creation. */
  registration: {
    status: "skipped" | "pending" | "handled" | "failed";
    error?: string;
    /** Delivery attempts advance only after a proven unsuccessful durable outcome. */
    attempt?: number;
    /** The durable event failed or committed without registering the piece. */
    terminal?: true;
  };

  pieceId: string;
  pattern: ServedPatternRef;

  /** The name the piece was created under, when one was asked for. */
  slug?: string;
}

/** What `setsrc` asks for. */
export interface ServedSetSourceRequest {
  /** The piece whose source is replaced. */
  pieceId: string;

  /**
   * The pattern the piece moves to: a closure the space already holds. A
   * program is uploaded first, as a verb of its own, so the closure is
   * durable before the update's setup transaction reads and extends it.
   */
  pattern: ServedPatternRef;

  /** Repository locator stored with the piece's source. */
  repository?: string;

  /**
   * Replace the source even when compatibility cannot be proven, or when
   * the current pattern cannot be loaded at all.
   */
  dangerouslyAllowIncompatibleSchema?: boolean;

  /** The pattern the update was proved against; a piece on another refuses. */
  expectedPattern?: ServedPatternRef;

  /**
   * The principal the verb acts for. The setup transaction carries this
   * principal's trust snapshot, as a creation's does
   * ({@link ServedInstantiateRequest}).
   */
  actingUser: string;
}

/** What `setsrc` hands back: the accepted setup transaction's receipt. */
export interface ServedSetSourceReceipt {
  pieceId: string;

  /** The pointer the piece now holds. */
  pattern: ServedPatternRef;

  /** The source revision the transaction appended. */
  revisionId: string;

  /**
   * Position in the space's commit log at which the transaction was
   * accepted: the seq `cf inspect value-at --seq` and `diff --from/--to`
   * read.
   */
  seq: number;

  /** The origin the update detached, `null` when the piece had none. */
  detachedOrigin: string | null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    isObjectOrArray(error) && "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

/**
 * Compile `program` into the space and persist its closure, so a later
 * verb — here or on another runtime — can take the pattern by identity.
 */
export async function servedUploadPattern(
  pieces: PiecesController,
  program: RuntimeProgram,
  options: { previousEntryIdentity?: string } = {},
): Promise<{ pattern: Pattern; ref: ServedPatternRef }> {
  const runtime = pieces.runtime;
  let pattern: Pattern;
  try {
    pattern = await compileAndSavePattern(runtime, program, {
      space: pieces.getSpace(),
      ...(options.previousEntryIdentity === undefined
        ? {}
        : { previousEntryIdentity: options.previousEntryIdentity }),
    });
  } catch (error) {
    throw new ServedLifecycleRefusal("compile-failed", messageOf(error), {
      cause: error,
    });
  }
  const ref = runtime.patternManager.getArtifactEntryRef(pattern);
  if (ref === undefined) {
    throw new Error("the compiled source has no pattern identity");
  }
  return { pattern, ref };
}

async function resolveServedPattern(
  pieces: PiecesController,
  source: ServedPatternSource,
  options: { previousEntryIdentity?: string; repairCache?: boolean } = {},
): Promise<{ pattern: Pattern; ref: ServedPatternRef }> {
  if (source.program !== undefined) {
    return await servedUploadPattern(pieces, source.program, options);
  }
  const ref = source.pattern;
  let pattern: Pattern | undefined;
  try {
    pattern = await pieces.runtime.patternManager.loadPatternByIdentity(
      ref.identity,
      ref.symbol,
      pieces.getSpace(),
      options.repairCache === undefined
        ? undefined
        : { repairCache: options.repairCache },
    );
  } catch (error) {
    // A closure the space holds but cannot load is, to the caller, one it
    // does not hold: the same refusal, with the loader's reason attached.
    throw new ServedLifecycleRefusal("pattern-not-found", messageOf(error), {
      cause: error,
    });
  }
  if (!pattern) {
    throw new ServedLifecycleRefusal(
      "pattern-not-found",
      `pattern ${ref.identity}#${ref.symbol} is not held by the space`,
    );
  }
  return { pattern, ref };
}

/**
 * Create a piece from the requested pattern in one transaction: the result
 * document with its pattern metadata and argument, the first source
 * revision, an idempotent creation receipt, and the slug when asked for
 * — a name already taken refuses the whole creation unless `force` is set.
 * The piece is set up here and never started here: a graph instantiated on
 * the serving runtime before anything demands it is not live, so its first
 * run would not happen and a later demand would find it registered and
 * skip the load that runs it. The caller names the new piece's root as the
 * verb's demand instead, and the serving loop loads and derives it once
 * the creation has committed.
 */
export async function servedInstantiatePiece(
  pieces: PiecesController,
  request: ServedInstantiateRequest,
): Promise<ServedInstantiateReceipt> {
  const runtime = pieces.runtime;
  const space = pieces.getSpace();
  const requestKey = request.requestKey ?? crypto.randomUUID();
  const requestRecord = runtime.getCell<ServedInstantiateReceipt | undefined>(
    space,
    {
      purpose: "piece-instantiation-receipt",
      principal: request.actingUser,
      requestKey,
    },
  );
  await requestRecord.sync();
  const completed = requestRecord.get();
  if (completed !== undefined) return completed;
  const { pattern, ref } = await resolveServedPattern(pieces, request.source);
  await runtime.idle();
  const piece = runtime.getCell(
    space,
    {
      purpose: "piece-instantiation",
      principal: request.actingUser,
      requestKey,
    },
    pattern.resultSchema,
  );
  // Setup verifies the source closure behind a content-addressed entry
  // ref synchronously, so the parser it needs is loaded ahead of it.
  await prepareSourceClosureVerification();
  const slugClaim = request.slug === undefined
    ? undefined
    : await prepareSlugClaim(pieces, request.slug, piece, {
      writeTargetMetadata: true,
    });
  const address = piece.getAsNormalizedFullLink().id;
  const pieceId = pieceIdOf(piece);
  if (pieceId === undefined) throw new Error("the new piece has no entity id");
  const receipt: ServedInstantiateReceipt = {
    requestKey,
    pieceId,
    pattern: ref,
    registration: { status: request.register === true ? "pending" : "skipped" },
    ...(slugClaim === undefined ? {} : { slug: slugClaim.validSlug }),
  };
  const outcome = await runtime.editWithRetry((tx) => {
    // Per attempt: the trust snapshot governs the reads that follow it,
    // and a retry runs on a fresh transaction.
    runtime.stampServerRun(tx, {
      actionId: `pattern-lifecycle/instantiate/${address}`,
      kind: "bookkeeping",
    });
    tx.setCfcTrustSnapshot(
      runtime.trustSnapshotForPrincipal(request.actingUser),
    );
    const retained = requestRecord.withTx(tx).get();
    if (retained !== undefined) return retained;
    // With a transaction supplied, setup runs to completion before it
    // returns and leaves the commit to this transaction.
    void runtime.setup(tx, pattern, request.argument ?? {}, piece, {
      ...(request.repository === undefined
        ? {}
        : { patternRepository: request.repository }),
      initializePieceSourceHistory: true,
    });
    if (slugClaim !== undefined) {
      const refusal = claimSlugInTx(pieces, slugClaim, tx, {
        ...(request.force === undefined ? {} : { force: request.force }),
      });
      if (refusal !== undefined) {
        throw new ServedLifecycleRefusal(
          "slug-taken",
          `Slug "${slugClaim.validSlug}" already points at ` +
            `${refusal.held ?? "nothing"}, so assigning it would take that ` +
            "address from whoever holds it. Pass `force` to take it anyway; " +
            "nothing was created.",
        );
      }
    }
    requestRecord.withTx(tx).set(receipt);
    return receipt;
  });
  if (outcome.error !== undefined) {
    // A setup that threw is reported through the aborted transaction's
    // `reason`; a storage rejection is the error itself.
    const cause =
      "reason" in outcome.error && outcome.error.reason !== undefined
        ? outcome.error.reason
        : outcome.error;
    if (cause instanceof ServedLifecycleRefusal) throw cause;
    throw new ServedLifecycleRefusal("setup-failed", messageOf(cause), {
      cause,
    });
  }
  return outcome.ok!;
}

/** The address-only delivery plan retained after a registration preparation wave. */
export interface ServedRegistrationPreparation {
  receipt: ServedInstantiateReceipt;
  delivery?: {
    root: NormalizedFullLink;
    stream: NormalizedFullLink;
    piece: ReturnType<Cell<unknown>["getAsLink"]>;
    eventId: string;
    deliveryKey: string;
  };
  error?: string;
}

/** Durable event evidence, or an uncertain error that retains its delivery identity. */
export interface ServedRegistrationOutcome {
  error?: string;
  terminal?: true;
}

function registrationRecord(
  runtime: Runtime,
  space: MemorySpace,
  receipt: ServedInstantiateReceipt,
  actingUser: string,
): Cell<ServedInstantiateReceipt | undefined> {
  return runtime.getCell<ServedInstantiateReceipt | undefined>(space, {
    purpose: "piece-instantiation-receipt",
    principal: actingUser,
    requestKey: receipt.requestKey,
  });
}

/** Select one durable attempt and resolve its native event target inside a serving wave. */
export async function prepareServedRegistration(
  pieces: PiecesController,
  receipt: ServedInstantiateReceipt,
  actingUser: string,
): Promise<ServedRegistrationPreparation> {
  if (
    receipt.registration.status === "skipped" ||
    receipt.registration.status === "handled"
  ) return { receipt };
  const runtime = pieces.runtime;
  const requestRecord = registrationRecord(
    runtime,
    pieces.getSpace(),
    receipt,
    actingUser,
  );
  await requestRecord.sync();
  const selected = await runtime.editWithRetry((tx) => {
    if (runtime.servingPosture) {
      runtime.stampServerRun(tx, {
        actionId: "pattern-lifecycle/registration-prepare",
        kind: "bookkeeping",
      });
      tx.setCfcTrustSnapshot(runtime.trustSnapshotForPrincipal(actingUser));
    }
    const retained = requestRecord.withTx(tx).get();
    if (retained === undefined || retained.pieceId !== receipt.pieceId) {
      throw new Error("Registration receipt was not retained for this piece");
    }
    if (retained.registration.status === "handled") return retained;
    const attempt = (retained.registration.attempt ?? 0) +
      (retained.registration.status === "failed" &&
          retained.registration.terminal
        ? 1
        : 0);
    const pending: ServedInstantiateReceipt = {
      ...retained,
      registration: { status: "pending", attempt },
    };
    requestRecord.withTx(tx).set(pending);
    return pending;
  });
  if (selected.error) {
    throw new Error("Could not retain the registration attempt", {
      cause: selected.error,
    });
  }
  receipt = selected.ok!;
  if (receipt.registration.status === "handled") return { receipt };
  const attempt = receipt.registration.attempt ?? 0;
  const deliveryKey = JSON.stringify([
    "piece-registration",
    receipt.requestKey,
    attempt,
  ]);
  try {
    const root = await resolveSpaceRootPattern(runtime, pieces.getSpace());
    if (root === undefined) {
      throw new Error(
        "The space has no default pattern; install its root and retry this request key",
      );
    }
    const handlerCell = root.key("addPiece");
    await handlerCell.sync();
    // Inspect the declaration without reading a possibly foreign event target.
    // The transport authorizes that target before it observes or appends events.
    if (!isLink(handlerCell.getRaw())) {
      throw new Error("The default pattern has no addPiece handler");
    }
    const handler = await root.asSchema({
      type: "object",
      properties: { addPiece: { asCell: ["stream"] } },
    }).key("addPiece").pull();
    if (!isStream(handler)) {
      throw new Error("The default pattern has no addPiece handler");
    }
    const piece = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(receipt.pieceId),
    );
    const stream = handler.getAsNormalizedFullLink();
    const eventId = scopeCallerEventId(
      deliveryKey,
      actingUser,
      stream,
    );
    return {
      receipt,
      delivery: {
        root: root.getAsNormalizedFullLink(),
        stream,
        piece: piece.getAsLink(),
        eventId,
        deliveryKey,
      },
    };
  } catch (error) {
    return { receipt, error: messageOf(error) };
  }
}

/** Verify registration and retain its outcome in a separate wave after event completion. */
export async function finishServedRegistration(
  pieces: PiecesController,
  prepared: ServedRegistrationPreparation,
  actingUser: string,
  result: ServedRegistrationOutcome,
): Promise<ServedInstantiateReceipt> {
  const { receipt } = prepared;
  if (
    receipt.registration.status === "skipped" ||
    receipt.registration.status === "handled"
  ) return receipt;
  const runtime = pieces.runtime;
  const requestRecord = registrationRecord(
    runtime,
    pieces.getSpace(),
    receipt,
    actingUser,
  );
  const attempt = receipt.registration.attempt ?? 0;
  let terminal = result.terminal === true;
  let completed: ServedInstantiateReceipt;
  try {
    if (prepared.error !== undefined || result.error !== undefined) {
      throw new Error(prepared.error ?? result.error);
    }
    if (prepared.delivery === undefined) {
      throw new Error("Registration has no delivery plan");
    }
    const root = runtime.getCellFromLink(prepared.delivery.root);
    const piece = runtime.getCellFromLink(prepared.delivery.piece);
    const registry = root.asSchema({
      type: "object",
      properties: { pieceRegistry: pieceListSchema },
    }).key("pieceRegistry") as Cell<Cell<unknown>[]>;
    const members = await registry.pull();
    if (!members.some((member) => member.equalLinks(piece))) {
      terminal = true;
      throw new Error(
        "The addPiece handler committed without registering the piece",
      );
    }
    completed = { ...receipt, registration: { status: "handled", attempt } };
  } catch (error) {
    completed = {
      ...receipt,
      registration: {
        status: "failed",
        error: messageOf(error),
        attempt,
        ...(terminal ? { terminal: true as const } : {}),
      },
    };
  }
  await requestRecord.sync();
  const outcome = await runtime.editWithRetry((tx) => {
    if (runtime.servingPosture) {
      runtime.stampServerRun(tx, {
        actionId: "pattern-lifecycle/registration-finish",
        kind: "bookkeeping",
      });
      tx.setCfcTrustSnapshot(runtime.trustSnapshotForPrincipal(actingUser));
    }
    const current = requestRecord.withTx(tx).get();
    if (current === undefined || current.pieceId !== receipt.pieceId) {
      throw new Error("Registration receipt was not retained for this piece");
    }
    if (
      current.registration.status === "handled" ||
      (current.registration.attempt ?? 0) !== attempt ||
      (current.registration.terminal === true &&
        completed.registration.status === "failed" &&
        completed.registration.terminal !== true)
    ) return current;
    requestRecord.withTx(tx).set(completed);
    return completed;
  });
  if (outcome.error) {
    throw new Error("Could not retain the registration outcome", {
      cause: outcome.error,
    });
  }
  return outcome.ok!;
}

/** Confirm that a registration wave's receipt is retained, or superseded by stronger evidence. */
export async function confirmServedRegistration(
  runtime: Runtime,
  space: MemorySpace,
  receipt: ServedInstantiateReceipt,
  actingUser: string,
): Promise<void> {
  const retained = await registrationRecord(runtime, space, receipt, actingUser)
    .pull();
  if (retained === undefined || retained.pieceId !== receipt.pieceId) {
    throw new Error("Registration receipt was not retained");
  }
  const actual = retained.registration;
  const expected = receipt.registration;
  if (
    (actual.attempt ?? 0) > (expected.attempt ?? 0) ||
    actual.status === "handled"
  ) return;
  if (
    (actual.attempt ?? 0) < (expected.attempt ?? 0) ||
    expected.status === "handled" ||
    (expected.status === "failed" && actual.status !== "failed") ||
    (expected.terminal === true && actual.terminal !== true)
  ) {
    throw new Error("Registration outcome was not retained");
  }
}

/** Finish registration from an authorized client; hosted callers run the phases in serving waves. */
export async function completeServedRegistration(
  pieces: PiecesController,
  receipt: ServedInstantiateReceipt,
  actingUser: string,
  options: {
    append?: (
      input: {
        stream: NormalizedFullLink;
        eventId: string;
        piece: Cell<unknown>;
      },
    ) => Promise<void>;
  } = {},
): Promise<ServedInstantiateReceipt> {
  if (
    receipt.registration.status === "skipped" ||
    receipt.registration.status === "handled"
  ) return receipt;
  const runtime = pieces.runtime;
  if (runtime.servingPosture) {
    throw new Error(
      "Registration completion requires a client runtime outside the serving wave",
    );
  }
  const prepared = await prepareServedRegistration(pieces, receipt, actingUser);
  if (prepared.delivery === undefined) {
    return finishServedRegistration(pieces, prepared, actingUser, {});
  }
  const { stream, eventId, deliveryKey } = prepared.delivery;
  const piece = runtime.getCellFromLink(prepared.delivery.piece);
  let terminal = false;
  let observedEntries: Cell<StreamEventsDocValue> | undefined;
  let observedEventId: string | undefined;
  let result: ServedRegistrationOutcome = {};
  try {
    const entries = runtime.getCellFromEntityId<StreamEventsDocValue>(
      pieces.getSpace(),
      entityIdFrom(streamEntriesDocId(stream)),
      [],
      {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                eventId: { type: "string" },
                consequenced: { type: "boolean" },
                error: { type: "string" },
                status: { type: "string" },
                reason: { type: "string" },
              },
            },
          },
        },
      },
    );
    observedEntries = entries;
    observedEventId = eventId;
    await entries.sync();
    if (options.append !== undefined) {
      let cancel = () => {};
      try {
        const consequence = new Promise<void>((resolve, reject) => {
          cancel = entries.sink((value) => {
            const entry = value?.entries?.find((entry) =>
              entry.eventId === eventId
            );
            if (!entry) return;
            if (
              entry.status === "dropped" ||
              entry.status === "needs-attention" || entry.error
            ) {
              terminal = true;
              reject(new Error(entry.error ?? entry.reason ?? entry.status));
            } else if (entry.consequenced) resolve();
          });
        });
        await Promise.all([
          options.append({ stream, eventId, piece }),
          consequence,
        ]);
      } finally {
        cancel();
      }
    } else {
      const handler = await runtime.getCellFromLink(stream, {
        asCell: ["stream"],
      }).pull();
      if (!isStream(handler)) {
        throw new Error("The default pattern has no addPiece handler");
      }
      await new Promise<void>((resolve, reject) => {
        handler.send({ piece }, (tx) => {
          const status = tx.status();
          if (status.status === "error") {
            reject(new Error(status.error.message));
          } else resolve();
        }, { eventId: deliveryKey, session: actingUser });
      });
    }
  } catch (error) {
    // A lost transport acknowledgment is not proof that the handler failed.
    // A durable failure or a completed event with verified absent membership
    // permits another delivery identity; an unreadable registry does not.
    if (!terminal && observedEntries !== undefined) {
      try {
        const value = await observedEntries.pull();
        const entry = value?.entries?.find((entry) =>
          entry.eventId === observedEventId
        );
        terminal = !!entry &&
          (entry.status === "dropped" || entry.status === "needs-attention" ||
            !!entry.error);
      } catch {
        /* Keep the original attempt when the outcome cannot be read. */
      }
    }
    result = {
      error: messageOf(error),
      ...(terminal ? { terminal: true as const } : {}),
    };
  }
  return finishServedRegistration(pieces, prepared, actingUser, result);
}

/**
 * Replace a piece's source with a pattern the space holds, through the same
 * checks a client's update runs — the pin against the pattern it was proved
 * on, the compatibility assertions, the retained-argument validators — and
 * one setup transaction that commits directly to the store: the transaction
 * carries the requester's trust snapshot and the update's module authority,
 * which registers on this runtime from the store's verdict. The piece is
 * not started here. A piece the loop
 * runs is swapped by its pointer watcher, and one it does not run waits for
 * demand; the caller names the piece's root as the verb's demand for the
 * latter. Neither the candidate nor the current pattern loads with cache
 * repair, so the verb seals nothing into the cycle's wave that the update
 * would rest on or answer for.
 */
export async function servedSetPieceSource(
  pieces: PiecesController,
  request: ServedSetSourceRequest,
): Promise<ServedSetSourceReceipt> {
  const { pattern } = await resolveServedPattern(
    pieces,
    { pattern: request.pattern },
    { repairCache: false },
  );
  let piece: PieceController;
  try {
    piece = await pieces.get(request.pieceId, false);
  } catch (error) {
    throw new ServedLifecycleRefusal("piece-not-found", messageOf(error), {
      cause: error,
    });
  }
  if (getPatternIdentityRef(piece.getCell()) === undefined) {
    throw new ServedLifecycleRefusal(
      "piece-not-found",
      `piece ${request.pieceId} is not held by the space`,
    );
  }
  await prepareSourceClosureVerification();
  let receipt: PatternUpdateReceipt;
  try {
    receipt = await piece.setCompiledPattern(pattern, {
      ...(request.repository === undefined
        ? {}
        : { repository: request.repository }),
      ...(request.dangerouslyAllowIncompatibleSchema === true
        ? { dangerouslyAllowIncompatibleSchema: true }
        : {}),
      ...(request.expectedPattern === undefined
        ? {}
        : { expectedPattern: request.expectedPattern }),
      served: { actingUser: request.actingUser },
    });
  } catch (error) {
    throw setSourceRefusal(error);
  }
  return {
    pieceId: request.pieceId,
    pattern: receipt.ref,
    revisionId: receipt.revisionId,
    seq: receipt.seq,
    detachedOrigin: receipt.detachedOrigin,
  };
}

/**
 * Helper for `servedSetPieceSource()`, which names the refusal a failed
 * update is: the piece moved off the pattern it was proved against, the
 * candidate cannot run over the piece's state, or setup refused for a
 * reason of its own.
 */
function setSourceRefusal(error: unknown): ServedLifecycleRefusal {
  const message = messageOf(error);
  if (
    error instanceof PieceSourceChangedError ||
    message.includes(PIECE_SOURCE_MOVED)
  ) {
    return new ServedLifecycleRefusal("source-moved", message, {
      cause: error,
    });
  }
  if (isPieceSourceCompatibilityRefusal(error)) {
    return new ServedLifecycleRefusal("incompatible", message, {
      cause: error,
    });
  }
  return new ServedLifecycleRefusal("setup-failed", message, { cause: error });
}

/**
 * The durability read behind {@link servedSetPieceSource}: the piece
 * document holds the pattern pointer the transaction wrote and the
 * revision it appended.
 */
export async function confirmServedSetSource(
  runtime: Runtime,
  space: MemorySpace,
  receipt: ServedSetSourceReceipt,
): Promise<void> {
  const piece = runtime.getCellFromEntityId(
    space,
    entityIdFrom(receipt.pieceId),
  );
  await piece.sync();
  const stored = getPatternIdentityRef(piece);
  if (
    stored === undefined ||
    stored.identity !== receipt.pattern.identity ||
    stored.symbol !== receipt.pattern.symbol ||
    !getPieceSourceRevisions(piece).some((revision) =>
      revision.revisionId === receipt.revisionId
    )
  ) {
    throw new Error(
      `piece ${receipt.pieceId} does not hold pattern ` +
        `${receipt.pattern.identity}#${receipt.pattern.symbol} at revision ` +
        `${receipt.revisionId}: the source update did not commit`,
    );
  }
}

/**
 * Confirm the creation record that commits atomically with setup, and the
 * retained piece identity. A subsequent source update can change the current
 * pattern before a creation or registration retry is confirmed.
 */
export async function confirmServedInstantiate(
  runtime: Runtime,
  space: MemorySpace,
  receipt: ServedInstantiateReceipt,
  actingUser: string,
): Promise<void> {
  const retained = await registrationRecord(runtime, space, receipt, actingUser)
    .pull();
  const expectedPiece = runtime.getCell(space, {
    purpose: "piece-instantiation",
    principal: actingUser,
    requestKey: receipt.requestKey,
  });
  if (
    retained === undefined || retained.requestKey !== receipt.requestKey ||
    retained.pieceId !== receipt.pieceId ||
    pieceIdOf(expectedPiece) !== receipt.pieceId ||
    retained.pattern.identity !== receipt.pattern.identity ||
    retained.pattern.symbol !== receipt.pattern.symbol ||
    retained.slug !== receipt.slug
  ) {
    throw new Error(
      "Creation receipt was not retained for this piece and caller",
    );
  }
  const piece = runtime.getCellFromEntityId(
    space,
    entityIdFrom(receipt.pieceId),
  );
  await piece.sync();
  if (getPatternIdentityRef(piece) === undefined) {
    throw new Error(
      `piece ${receipt.pieceId} has no pattern: the creation did not commit`,
    );
  }
}
