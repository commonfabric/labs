/**
 * Starts a piece from the source of a pattern through `Runtime.run`, behind
 * the experimental option `compiledPatterns` (milestone 5 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * `runCompiledPatterns()` gives a runtime a compiler. From then on
 * `PatternManager.compilePattern` also hands the program to the compiler,
 * and `Runtime.run` of the pattern it returned starts a compiled piece
 * where the compiler accepted the program. Where the compiler refused it,
 * the pattern runs as it does without the option, and the refusal is
 * logged with the compiler's diagnostics, which name the construct, and
 * kept (`CompiledPatternRunner.refusalOf`).
 *
 * How a piece is marked in storage: as a client under server execution
 * marks one (`setUpCompiledPiece`). The result document names no pattern
 * identity, a document named from it holds the entity of the program, and
 * that entity holds the program as text and is named by the text. A piece
 * that is started again from storage therefore takes the path of
 * `serveCompiledPieces()`, which this function installs: the program is
 * compiled again and the piece resumed from its basis. Where the program
 * is no longer accepted then, the piece is refused and the reason stored
 * (`compiledFailureOf`). It is not run on today's path, which reads none
 * of the documents the executor wrote for it.
 *
 * Nothing imports this module but a caller that gives a runtime a
 * compiler, so a runtime without one loads no executor.
 */
import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { getLogger } from "@commonfabric/logger";
import type { RuntimeProgram } from "../harness/types.ts";
import type { Runtime } from "../runtime.ts";
import { type CompiledPiece, startCompiledPiece } from "./piece.ts";
import {
  adoptCompiledPiece,
  type CompilePatternProgram,
  forgetCompiledPiece,
  serveCompiledPieces,
  type ServeCompiledPiecesOptions,
} from "./serving.ts";
import { type PatternProgram, setUpCompiledPiece } from "./setup.ts";
import { answersEffect } from "./wish.ts";

const logger = getLogger("compiled-run");

/** What `runCompiledPatterns()` takes. */
export type RunCompiledPatternsOptions = ServeCompiledPiecesOptions & {
  /**
   * Called for each program the compiler refused, with what it rejected
   * with: the pattern of that program runs as it does without the option.
   */
  fellBack?: (program: RuntimeProgram, reason: string) => void;
};

/** What the compiler gave for the program of a pattern. */
type Prepared =
  | {
    program: PatternProgram;
    compiled: Awaited<ReturnType<CompilePatternProgram>>;
  }
  | { refused: string };

/**
 * Whether an error says that the host has no compiler to run, which is a
 * fault of its configuration and no refusal of a program. The class is
 * named and not imported: it is in a module that runs on Deno alone.
 */
const isMissingCompiler = (error: unknown): boolean =>
  error instanceof Error && error.name === "PatternCompilerMissingError";

/**
 * Why a compiled program cannot run as a compiled piece in a runtime that
 * `Runtime.run` starts it in, where it cannot: a plan of the program
 * requests an effect that no built-in of the runtime answers for a
 * compiled piece (`answersEffect`). A `wish`, and the effects
 * `fetchJson`, `fetchJsonUnchecked`, `fetchText` and `fetchBinary` of the
 * reactive tier, are answered by the runtime's own (`compiled/wish.ts`).
 * An effect a handler requests is not in the operations of a plan, and is
 * not looked for here: it stays unanswered. Every pattern of the program
 * is looked at where the compiler gives them, since a function body of the
 * pattern may instantiate any of them.
 */
const unansweredRequestOf = (
  compiled: Awaited<ReturnType<CompilePatternProgram>> & {
    modules?: { patterns: Artifact[] }[];
  },
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
 * Has `runtime` compile each program `PatternManager.compilePattern` is
 * given and start a compiled piece in `Runtime.run` where the compiler
 * accepted the program. The runtime needs the experimental option
 * `compiledPatterns`.
 */
export const runCompiledPatterns = (
  runtime: Runtime,
  options: RunCompiledPatternsOptions,
): void => {
  serveCompiledPieces(runtime, options);
  const prepared = new WeakMap<object, Prepared>();
  // The pieces this runtime started through `Runtime.run`, by the entity
  // of the result document.
  const started = new Map<string, CompiledPiece>();
  runtime.compiledPatternRunner = {
    prepare: async (pattern, program) => {
      const { main, mainExport, files } = program;
      const stored: PatternProgram = {
        main,
        ...(mainExport === undefined ? {} : { mainExport }),
        files: files.map((file) => ({
          name: file.name,
          contents: file.contents,
        })),
      };
      try {
        const compiled = await options.compile(stored);
        const unanswered = unansweredRequestOf(compiled);
        if (unanswered !== undefined) throw new Error(unanswered);
        prepared.set(pattern, { program: stored, compiled });
      } catch (error) {
        if (isMissingCompiler(error)) throw error;
        const refused = error instanceof Error ? error.message : `${error}`;
        prepared.set(pattern, { refused });
        logger.warn("pattern-not-compiled", () => [
          `The pattern of ${main} runs on the path without a plan:`,
          refused,
        ]);
        options.fellBack?.(program, refused);
      }
    },
    refusalOf: (pattern) => {
      const known = prepared.get(pattern);
      return known !== undefined && "refused" in known
        ? known.refused
        : undefined;
    },
    run: (tx, pattern, argument, resultCell) => {
      const known = prepared.get(pattern);
      if (known === undefined || "refused" in known) return false;
      const { id } = resultCell.getAsNormalizedFullLink();
      // A second run for a result document whose piece runs here leaves
      // the piece as it is: see the plan in `SPEC-NOTES.md`, note 676.
      if (started.has(id)) return true;
      const own = tx === undefined ? runtime.edit() : undefined;
      const within = tx ?? own!;
      let piece: CompiledPiece;
      try {
        setUpCompiledPiece(
          runtime,
          within,
          known.program,
          argument,
          resultCell.withTx(within),
        );
        piece = startCompiledPiece(
          runtime,
          within,
          known.compiled.main,
          argument,
          resultCell.withTx(within),
          {
            ...options.piece,
            // The artifacts are what the compiler of the runtime gave
            // for the program.
            attested: true,
            artifacts: (identity) =>
              known.compiled.artifacts(identity) ??
                options.piece?.artifacts?.(identity),
          },
        );
      } catch (error) {
        own?.abort(error);
        throw error;
      }
      started.set(id, piece);
      adoptCompiledPiece(runtime, id, piece);
      options.started?.(piece);
      // A piece whose start did not commit does not exist: the storage
      // holds no document of it, and its handlers and its derivation would
      // write documents under none of the policies the start records.
      const begun = piece;
      within.addCommitCallback((_tx, { error }) => {
        if (error === undefined || started.get(id) !== begun) return;
        started.delete(id);
        forgetCompiledPiece(runtime, id, begun);
        begun.stop();
      });
      if (own !== undefined) {
        runtime.prepareTxForCommit(own);
        own.commit();
      }
      return true;
    },
    stop: (resultCell) => {
      const { id } = resultCell.getAsNormalizedFullLink();
      const piece = started.get(id);
      if (piece === undefined) return false;
      started.delete(id);
      piece.stop();
      return true;
    },
    stopAll: () => {
      for (const piece of started.values()) piece.stop();
      started.clear();
    },
  };
};
