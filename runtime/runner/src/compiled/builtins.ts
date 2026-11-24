/**
 * The built-ins of `commonfabric` that the runtime answers, for the value
 * code of a compiled piece, behind the experimental option
 * `compiledPatterns`.
 *
 * Each function here is the runtime's own (`../builder/factory.ts` gives
 * the same ones to a pattern of today's path), called with each cell handle
 * of the executor written as the runtime's cell of the same position. The
 * runtime's functions read the frame of the run: the piece runs a handler
 * under a frame of the kind `handler` and a derivation under one of the
 * kind `lift`, each with the runtime, the transaction of the run and, for
 * a handler, the key of the event. So what a function reads, it reads
 * through the transaction of the run, and what it decides (whose profile a
 * profile is, which level an access list grants, which principal a label
 * attests) is decided by the runtime's code and not here.
 *
 * A function called in a derivation is also recorded with
 * `RuntimeAnswers`, for the principal the derivation is for: an action of
 * the scheduler for each question asks it again when something its answer
 * read changes, and marks the cone instances that used an answer that is
 * now another.
 */
import {
  FabricBytes,
  FabricDurationNsec,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { isWellFormedDID, parseDID } from "@commonfabric/identity/did";

import {
  Handle,
  type Instance,
  targetOf,
} from "../../../../base/pattern-compiler/exec/executor.ts";
import {
  Ref,
  StreamRef,
} from "../../../../base/pattern-compiler/exec/store.ts";
import { nameBlob } from "../builder/blob-name.ts";
import { currentPrincipal } from "../builder/current-principal.ts";
import { getPatternEnvironment } from "../builder/env.ts";
import { eventKey } from "../builder/event-key.ts";
import { topFrame } from "../builder/frame-context.ts";
import { linksOf } from "../builder/links-of.ts";
import { makeFrame, runInFrame } from "../builder/pattern.ts";
import {
  principalOf,
  principalsOf,
  writtenPrincipalOf,
} from "../builder/principal-of.ts";
import { profileOwnerOf } from "../builder/profile-owner-of.ts";
import { resultOwnerOf } from "../builder/result-owner-of.ts";
import {
  spaceAccess,
  spaceAccessOf,
  spaceDeleted,
  spaceMembers,
  spaceOfLink,
} from "../builder/space-access.ts";
import {
  grantSpaceAccess,
  revokeSpaceAccess,
} from "../builder/space-access-change.ts";
import type { Cancel } from "../cancel.ts";
import { type Cell, isCell, type MemorySpace } from "../cell.ts";
import { getEntityId } from "../create-ref.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler/types.ts";
import { joinSpaceMembers } from "../space-members.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { scopeKeyOf } from "./scopes.ts";

/** What the built-ins of a piece are given of the piece. */
export type RuntimeBuiltinsContext = {
  runtime: Runtime;
  space: MemorySpace;
  /** The runtime's address of a position of a document of the executor. */
  linkOf: (doc: string, path: readonly string[]) => NormalizedFullLink;
  /** The document of the executor that an entity holds. */
  documentOf: (link: NormalizedFullLink) => string;
  /** Has the derivation of the piece run. */
  invalidate: () => void;
  /** Stamps a transaction a scheduler action of the piece is given. */
  stamp: (tx: IExtendedStorageTransaction, what: string) => void;
  /** The scope key of the principal the evaluation in progress is for. */
  scopeKey: (scope: "user" | "session") => string;
  /** The piece, as an action of the scheduler names it. */
  piece: { space: MemorySpace; pieceId: string; pieceRootId: string };
  /**
   * Called when a question was asked again for a principal, with the
   * transaction it was asked through: what the piece keeps of what the
   * answer read (`OutsideReads`).
   */
  read?: (position: string, tx: IExtendedStorageTransaction) => void;
};

/** A text that is the same for two answers that are the same. */
const textOf = (value: unknown): string => {
  try {
    return JSON.stringify(
      value,
      (_name, member) =>
        isCell(member)
          ? { cell: member.getAsNormalizedFullLink() }
          : typeof member === "bigint"
          ? `${member}n`
          : member,
    ) ?? "undefined";
  } catch {
    return `${value}`;
  }
};

/** What one principal was given as the answer to a question. */
type Answered = {
  /** The text of the answer the users were given. */
  last: string;
  /** The memo entries that used the answer, by instance and name. */
  users: Map<string, { instance: Instance; key: string }>;
};

/** A question a derivation asked, and what each principal was answered. */
type Asked = {
  ask: () => unknown;
  /** By the scope key of the principal the derivation ran for. */
  by: Map<string, Answered>;
  /** The action that asks again, and what stops it. */
  action: Action;
  cancel: Cancel;
};

/**
 * The answers the runtime gave to derivations of a piece, each with the
 * principal it was given for and the memo entries that used it.
 *
 * Each question has an action of the scheduler of its own, which asks the
 * question again through the transaction the scheduler gives it. So the
 * scheduler runs the action of a question when something the answer to
 * that question read changes, and no other. The action names the piece
 * and reads the principal its run is for, which makes it a computation of
 * the scope `user`: a serving loop runs it once for each principal that
 * demands the piece, and each run compares with what that principal was
 * answered.
 */
export class RuntimeAnswers {
  readonly #context: RuntimeBuiltinsContext;
  readonly #asked = new Map<string, Asked>();

  /** Constructs an instance that holds no answer. */
  constructor(context: RuntimeBuiltinsContext) {
    this.#context = context;
  }

  /**
   * Records that the evaluation in progress of the executor of `instance`,
   * where there is one, used the answer `answer` to the question
   * `question`, which `ask` asks again. The answer is that of the
   * principal the evaluation is for.
   */
  used(
    instance: Instance,
    question: string,
    ask: () => unknown,
    answer: unknown,
  ): void {
    const by = instance.evaluationInProgress();
    if (by === undefined) return;
    const { runtime, scopeKey } = this.#context;
    let asked = this.#asked.get(question);
    if (asked === undefined) {
      asked = this.#watch(question, ask);
      this.#asked.set(question, asked);
    }
    const principal = scopeKey("user");
    let held = asked.by.get(principal);
    if (held === undefined) {
      held = { last: textOf(answer), users: new Map() };
      asked.by.set(principal, held);
      // The scheduler learns what the answer reads when the action runs.
      runtime.scheduler.invalidateAction(asked.action);
    }
    held.users.set(`${by.instance.id}\n${by.key}`, by);
  }

  /** Stops asking. */
  stop(): void {
    for (const { cancel } of this.#asked.values()) cancel();
    this.#asked.clear();
  }

  /** How many questions have an action. */
  get questions(): number {
    return this.#asked.size;
  }

  /** Registers the action that asks `question` again. */
  #watch(question: string, ask: () => unknown): Asked {
    const { runtime, piece } = this.#context;
    const action: Action = (tx) => this.#askAgain(tx, question);
    const asked: Asked = {
      ask,
      by: new Map(),
      action,
      cancel: runtime.scheduler.subscribe(action, {
        isEffect: true,
        observationIdentity: piece,
      }),
    };
    return asked;
  }

  /**
   * Asks `question` again through `tx`, under a frame of the kind `lift`,
   * for the principal the run on `tx` is for. An answer that is another
   * than the one that principal's users were given marks them, and the
   * derivation of the piece then evaluates them.
   */
  #askAgain(tx: IExtendedStorageTransaction, question: string): void {
    const { runtime, space, invalidate, stamp } = this.#context;
    const asked = this.#asked.get(question);
    if (asked === undefined) return;
    stamp(tx, "answers");
    // The principal of the run, read as the runtime gives it, which makes
    // the run one of the scope `user` for the scheduler.
    runtime.homeSpacePrincipalFor(tx);
    const principal = scopeKeyOf(
      "user",
      tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity,
    );
    const held = asked.by.get(principal);
    if (held === undefined) return;
    // An answer no memo entry uses is not asked for again.
    if (held.users.size === 0) {
      asked.by.delete(principal);
      return;
    }
    let now: string;
    try {
      now = runInFrame(
        makeFrame({ runtime, tx, space, frameKind: "lift" }),
        () => textOf(asked.ask()),
      );
    } catch (error) {
      now = `threw: ${error}`;
    }
    this.#context.read?.(`answer ${principal} ${question}`, tx);
    if (now === held.last) return;
    held.last = now;
    // The entry that used the answer is one for every principal, or one of
    // this principal or of a session of it.
    const sessions = `session:${principal.slice("user:".length)}:`;
    const ofPrincipal = (key: string) =>
      key === principal || key.startsWith(sessions);
    for (const { instance, key } of held.users.values()) {
      instance.markStale(key, ofPrincipal);
    }
    held.users.clear();
    invalidate();
  }
}

/**
 * What the value code of the modules of `instance` imports from
 * `commonfabric` under each name the executor does not have and the
 * runtime answers (`Instance.options.builtins`).
 */
export const runtimeBuiltins = (
  context: RuntimeBuiltinsContext,
  answers: RuntimeAnswers,
  instance: Instance,
): Record<string, unknown> => {
  const { runtime, linkOf, documentOf } = context;
  /** A value of the executor as the runtime's functions take it. */
  const given = (value: unknown): unknown => {
    const ref = value instanceof Handle ? targetOf(value) : value;
    if (ref instanceof StreamRef) return value;
    if (ref instanceof Ref) {
      return runtime.getCellFromLink(linkOf(ref.doc, ref.path));
    }
    return value;
  };
  /** What a function of the runtime returned, as value code holds it. */
  const returned = (value: unknown): unknown => {
    if (isCell(value)) {
      const link = (value as Cell<unknown>).getAsNormalizedFullLink();
      // A handle with no host: a read through it is recorded for no cone.
      return new Handle(
        instance,
        new Ref(documentOf(link), [...link.path]),
        undefined,
        undefined,
        [],
      );
    }
    return Array.isArray(value) ? value.map(returned) : value;
  };
  /**
   * A function of the runtime that reads through the transaction of the
   * run: in a derivation, what it answered is asked again when something
   * the runtime read for it changes.
   */
  const reading = (
    name: string,
    // deno-lint-ignore no-explicit-any
    run: (...given: any[]) => unknown,
    /** Whether the answer is one for the acting principal. */
    forPrincipal = false,
  ) =>
  (...args: unknown[]): unknown => {
    const converted = args.map(given);
    const answer = run(...converted);
    if (topFrame()?.frameKind === "lift") {
      // What used an answer that is of the acting principal is of the
      // scope `user`: another principal is not given its value.
      if (forPrincipal) instance.store.scopes?.touch("user");
      answers.used(
        instance,
        `${name}\n${textOf(converted)}`,
        () => run(...converted),
        answer,
      );
    }
    return returned(answer);
  };
  /** A function of the runtime that a handler alone calls. */
  const inHandler =
    // deno-lint-ignore no-explicit-any
    (run: (...given: any[]) => unknown) => (...args: unknown[]): unknown =>
      returned(run(...args.map(given)));
  return {
    // What the runtime computes from its arguments alone.
    FabricBytes,
    FabricDurationNsec,
    FabricEpochNsec,
    isWellFormedDID,
    parseDID,
    joinSpaceMembers,
    entityRefToString,
    getPatternEnvironment,
    // What the frame of a handler holds.
    currentPrincipal,
    eventKey,
    // What a label attests.
    profileOwnerOf: reading("profileOwnerOf", profileOwnerOf),
    principalOf: reading("principalOf", principalOf),
    principalsOf: reading("principalsOf", principalsOf),
    writtenPrincipalOf: reading("writtenPrincipalOf", writtenPrincipalOf),
    resultOwnerOf: reading("resultOwnerOf", resultOwnerOf),
    // What the access list of a space holds.
    spaceAccess: reading("spaceAccess", spaceAccess, true),
    spaceAccessOf: reading("spaceAccessOf", spaceAccessOf),
    spaceMembers: reading("spaceMembers", spaceMembers),
    spaceDeleted: reading("spaceDeleted", spaceDeleted),
    // What a position holds as links, and where a link leads.
    spaceOfLink: reading("spaceOfLink", spaceOfLink),
    linksOf: reading("linksOf", linksOf),
    getEntityId: inHandler(getEntityId),
    // What a handler stages with its transaction.
    grantSpaceAccess: inHandler(grantSpaceAccess),
    revokeSpaceAccess: inHandler(revokeSpaceAccess),
    nameBlob: inHandler(nameBlob),
  };
};
