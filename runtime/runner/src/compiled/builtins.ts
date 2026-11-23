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
 * `RuntimeAnswers`: one action of the scheduler asks each recorded
 * question again when something the answers read changes, and marks the
 * cone instances that used an answer that is now another.
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

/**
 * The answers the runtime gave to derivations of a piece, each with the
 * cone instances that used it, and the action that asks again.
 */
export class RuntimeAnswers {
  readonly #context: RuntimeBuiltinsContext;
  readonly #asked = new Map<string, {
    ask: () => unknown;
    last: string;
    users: Map<string, { instance: Instance; key: string }>;
  }>();
  #watch: Action | undefined;
  #cancel: Cancel | undefined;

  constructor(context: RuntimeBuiltinsContext) {
    this.#context = context;
  }

  /**
   * Records that the evaluation in progress of the executor of `instance`,
   * where there is one, used the answer `answer` to the question
   * `question`, which `ask` asks again.
   */
  used(
    instance: Instance,
    question: string,
    ask: () => unknown,
    answer: unknown,
  ): void {
    const by = instance.evaluationInProgress();
    if (by === undefined) return;
    let held = this.#asked.get(question);
    if (held === undefined) {
      held = { ask, last: textOf(answer), users: new Map() };
      this.#asked.set(question, held);
      this.#rerun();
    }
    held.users.set(`${by.instance.id}\n${by.key}`, by);
  }

  /** Stops asking. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#asked.clear();
  }

  /**
   * Has the action run, so that the scheduler knows what the answer to a
   * question first asked reads. The first call registers the action.
   */
  #rerun(): void {
    const { runtime } = this.#context;
    if (this.#watch !== undefined) {
      runtime.scheduler.invalidateAction(this.#watch);
      return;
    }
    const watch: Action = (tx) => this.#askAgain(tx);
    this.#watch = watch;
    this.#cancel = runtime.scheduler.subscribe(watch, { isEffect: true });
  }

  /**
   * Asks each question again through `tx`, under a frame of the kind
   * `lift`. An answer that is another than the one its users were given
   * marks them, and the derivation of the piece then evaluates them.
   */
  #askAgain(tx: IExtendedStorageTransaction): void {
    const { runtime, space, invalidate, stamp } = this.#context;
    stamp(tx, "answers");
    let marked = false;
    runInFrame(
      makeFrame({ runtime, tx, space, frameKind: "lift" }),
      () => {
        for (const [question, held] of this.#asked) {
          // An answer no cone instance uses is not asked for again.
          if (held.users.size === 0) {
            this.#asked.delete(question);
            continue;
          }
          let now: string;
          try {
            now = textOf(held.ask());
          } catch (error) {
            now = `threw: ${error}`;
          }
          if (now === held.last) continue;
          held.last = now;
          for (const { instance, key } of held.users.values()) {
            instance.markStale(key);
          }
          held.users.clear();
          marked = true;
        }
      },
    );
    if (marked) invalidate();
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
  ) =>
  (...args: unknown[]): unknown => {
    const converted = args.map(given);
    const answer = run(...converted);
    if (topFrame()?.frameKind === "lift") {
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
    spaceAccess: reading("spaceAccess", spaceAccess),
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
