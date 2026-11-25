/**
 * Answers the `wish` operations of a compiled piece with the runtime's own
 * `wish` (`../builtins/wish.ts`), behind the experimental option
 * `compiledPatterns`.
 *
 * The request of a `wish` is what the executor stores at `request` of the
 * operation's state document: the operands of the call, a reference in
 * them as a link. For each state document the piece registers one action
 * of the scheduler, which is the action the runtime's `wish` returns for a
 * node whose inputs are that position. The action resolves the target as
 * it does for any pattern: it reads the root of the space, the home of the
 * principal the run acts for and the profile spaces through the cells of
 * the runtime, in the transaction the scheduler gives it, and the
 * scheduler runs it again when one of those reads changes.
 *
 * The answer is what the action sends: the cell of the state of the wish,
 * or the cell of a sidecar or of a shared search. It is written at
 * `outcome` of the operation's state document in the transaction of the
 * action. The piece holds that document, so the write reaches the executor
 * as a change by another writer, which marks what read the outcome, and a
 * resume finds the outcome stored where it finds the request.
 *
 * The outcome is a link to the cell sent, with the scope of the cell,
 * which the executor follows to the instance of the principal a run is
 * for. The state document of an operation the plan gives the scope `user`
 * is of that scope, so the request and the outcome of each principal are
 * in the instance of that principal, and the scheduler runs the action
 * once for each principal that demands the piece.
 */
import { isWalkableObjectNotArray } from "@commonfabric/data-model";
import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { FabricValue } from "@commonfabric/data-model";
import type { DID } from "@commonfabric/identity";

import { cellFromUrl } from "../builtins/cell-from-url.ts";
import {
  fetchBinary,
  fetchJson,
  fetchJsonUnchecked,
  fetchText,
} from "../builtins/fetch.ts";
import { wish } from "../builtins/wish.ts";
import type { Cancel } from "../cancel.ts";
import { type Cell, isCell } from "../cell.ts";
import { stampWaveRunContext, waveRunContextOf } from "../executor/wave.ts";
import { isPrimitiveCellLink, type NormalizedFullLink } from "../link-types.ts";
import { createSigilLinkFromParsedLink, parseLink } from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler/types.ts";
import type { URI } from "../sigil-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

const isRecordOfCells = (
  value: unknown,
): value is Record<string, Cell<unknown>> =>
  isWalkableObjectNotArray(value) && Object.values(value).every(isCell);

/** What `RuntimeWishes` takes. */
export type RuntimeWishesOptions = {
  /** The cell of the result document of the piece, bound to no transaction. */
  resultCell: Cell<unknown>;
  /** The entity that holds a document of the executor. */
  entityOf: (doc: string) => URI;
  /**
   * The runtime's address of a document of the executor, in the scope the
   * executor names it for. Without it every state document is the
   * space's.
   */
  linkOf?: (doc: string) => NormalizedFullLink;
  /**
   * Called when a run of the action of the state document `state` ended,
   * with its transaction: what the piece keeps of what the run read
   * (`OutsideReads`).
   */
  read?: (state: string, tx: IExtendedStorageTransaction) => void;
  /**
   * The principal a run of a `wish` acts for where the runtime is in the
   * serving posture and nothing stamped the run
   * (`CompiledPieceOptions.actsFor`).
   */
  actsFor?: DID;
};

/**
 * The built-ins of the runtime that answer the request of an effect of the
 * reactive tier of a compiled piece, by name. Each sends a record of the
 * cells of its outcome, which are the members of the outcome: `pending`,
 * `result` and `error` of a fetch, and `pending` and `cell` of
 * `cellFromUrl`. The other effects of the language have no entry:
 * `fetchProgram`, `generateText`, `generateObject`, `sqliteQuery`,
 * `compileAndRun`, `llmDialog`, `agent` and `navigateTo`, and an effect a
 * handler requests.
 */
const EFFECTS = {
  cellFromUrl,
  fetchBinary,
  fetchJson,
  fetchJsonUnchecked,
  fetchText,
} as const;

/** Whether the runtime answers the effect `builtin` of a compiled piece. */
export const answersEffect = (builtin: string): boolean =>
  Object.hasOwn(EFFECTS, builtin);

/**
 * Why a compiled program cannot run as a compiled piece, where it cannot: a
 * plan of the program requests an effect that no built-in of the runtime
 * answers for a compiled piece (`answersEffect`). A `wish`, and the effects
 * `fetchJson`, `fetchJsonUnchecked`, `fetchText`, `fetchBinary` and
 * `cellFromUrl` of the reactive tier, are answered by the runtime's own. An effect a handler
 * requests is not in the operations of a plan, and is not looked for here:
 * it stays unanswered. Every pattern of the program is looked at where the
 * compiler gives them, since a function body of the pattern may instantiate
 * any of them.
 */
export const unansweredRequestOf = (
  compiled: { main: Artifact; modules?: { patterns: Artifact[] }[] },
): string | undefined => {
  const patterns = [
    compiled.main,
    ...(compiled.modules ?? []).flatMap(({ patterns }) => patterns),
  ];
  for (const { plan, name } of patterns) {
    const operations = (plan as {
      operations?: { kind?: string; implementation?: { builtin?: string } }[];
    }).operations ?? [];
    const unanswered = operations.find(({ kind, implementation }) =>
      kind === "effect" && !answersEffect(implementation?.builtin ?? "")
    );
    if (unanswered !== undefined) {
      return `The plan of the pattern \`${
        name ?? "default"
      }\` requests the effect \`${
        unanswered.implementation?.builtin ?? "unnamed"
      }\`, which a compiled piece does not answer in this runtime.`;
    }
  }
  return undefined;
};

/**
 * The runtime's `wish`, and its built-ins of `EFFECTS`, registered for the
 * operations of a piece.
 */
export class RuntimeWishes {
  readonly #runtime: Runtime;
  readonly #options: RuntimeWishesOptions;
  /** What stops the action of each state document registered. */
  readonly #registered = new Map<string, Cancel[]>();

  constructor(runtime: Runtime, options: RuntimeWishesOptions) {
    this.#runtime = runtime;
    this.#options = options;
  }

  /**
   * Has the runtime's `wish`, or its built-in of the effect `builtin`,
   * answer the request that the state document `state` holds, now and
   * whenever the request or what the resolution read changes. The first
   * call for a state document registers the action, and a later one does
   * nothing.
   */
  answer(state: string, builtin: "wish" | keyof typeof EFFECTS = "wish"): void {
    if (this.#registered.has(state)) return;
    const runtime = this.#runtime;
    const { resultCell, entityOf, linkOf } = this.#options;
    const { space, id: result } = resultCell.getAsNormalizedFullLink();
    // The state document of an operation the plan gives a scope is of that
    // scope: each principal the action runs for reads the request and
    // writes the outcome of its own instance.
    const document: NormalizedFullLink = linkOf?.(state) ?? {
      space,
      id: entityOf(state),
      path: [],
      scope: "space",
    };
    const request = { ...document, path: ["request"] };
    const cancels: Cancel[] = [];
    this.#registered.set(state, cancels);
    const implementation = builtin === "wish" ? wish : EFFECTS[builtin];
    const built = implementation(
      runtime.getCellFromLink(request) as never,
      (tx, sent) => this.#store(tx, document, sent),
      (cancel) => cancels.push(cancel),
      // What the stores of the wish are named from: the state document,
      // which is named from the instance, the operation and the keys of
      // the elements it is in.
      { compiledOperation: state, builtin } as never,
      resultCell,
      runtime,
    );
    const resolve = typeof built === "function" ? built : built.action;
    const action: Action = (tx) => {
      this.#stamp(tx, state);
      // The derivation that first evaluates the operation writes the
      // request, and its transaction may commit after this action first
      // runs. The read is one the action depends on, so it runs again when
      // the request is there.
      if (tx.readValueOrThrow(request) === undefined) return;
      const done = resolve(tx);
      const { read } = this.#options;
      if (read === undefined) return done;
      if (done instanceof Promise) {
        return done.then((result) => {
          read(state, tx);
          return result;
        });
      }
      read(state, tx);
      return done;
    };
    cancels.push(
      runtime.scheduler.subscribe(action, {
        isEffect: true,
        // The piece the run is of, so that a serving loop runs the action
        // for each principal that demands the piece.
        observationIdentity: {
          space,
          pieceId: `space:${result}`,
          pieceRootId: result,
        },
      }),
    );
    if (typeof built !== "function") built.onActionRegistered?.(action);
  }

  /** Stops every action registered. */
  stop(): void {
    for (const cancels of this.#registered.values()) {
      for (const cancel of cancels.splice(0)) cancel();
    }
    this.#registered.clear();
  }

  /**
   * Names the principal the run acts for where the runtime is in the
   * serving posture and no serving loop stamped the transaction: the
   * runtime's `wish` resolves the home of the principal of the run, and
   * refuses a run with none.
   */
  #stamp(tx: IExtendedStorageTransaction, state: string): void {
    const { actsFor } = this.#options;
    if (
      actsFor === undefined || !this.#runtime.servingPosture ||
      waveRunContextOf(tx) !== undefined
    ) return;
    stampWaveRunContext(tx, {
      actionId: `compiled-piece:wish:${state}`,
      kind: "derivation",
      scopeKeyIdentity: {
        principal: actsFor,
        sessionId: this.#runtime.scopeKeyIdentity.sessionId,
      },
    });
  }

  /** Writes what the runtime's `wish` sent as the outcome of the operation. */
  #store(
    tx: IExtendedStorageTransaction,
    document: NormalizedFullLink,
    sent: unknown,
  ): void {
    const { resultCell } = this.#options;
    // An effect sends a record of the cells of its outcome: each member
    // of the outcome is a link to its cell.
    if (!isCell(sent) && !isPrimitiveCellLink(sent) && isRecordOfCells(sent)) {
      tx.writeValueOrThrow(
        { ...document, path: ["outcome"] },
        Object.fromEntries(
          Object.entries(sent).map(([name, cell]) => {
            const { schema: _schema, ...link } = cell
              .getAsNormalizedFullLink();
            return [name, createSigilLinkFromParsedLink(link)];
          }),
        ) as FabricValue,
      );
      return;
    }
    const link = isCell(sent)
      ? sent.getAsNormalizedFullLink()
      : parseLink(sent, resultCell) as NormalizedFullLink;
    const at = {
      space: link.space ?? document.space,
      id: link.id,
      path: [...link.path],
      scope: link.scope ?? "space",
    } as NormalizedFullLink;
    // The link says the scope of the cell, and no principal: the executor
    // follows it to the instance of the identity each run carries.
    tx.writeValueOrThrow(
      { ...document, path: ["outcome"] },
      createSigilLinkFromParsedLink(at) as FabricValue,
    );
  }
}
