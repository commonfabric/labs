import { Command } from "@cliffy/command";
import { executeMountedCallableFile } from "../lib/exec.ts";
import { cliText } from "../lib/cli-name.ts";
import { canonicalAddress, type InvocationPhase } from "../lib/callable.ts";
import {
  exitPieceCallFailure,
  exitWithDataError,
  invocationJson,
  invocationPhaseReporter,
} from "./piece.ts";
import { newSessionId } from "../lib/session.ts";
import {
  type CellSelection,
  CellSelectionError,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";
import type { ExecutedMountedCallableFile } from "../lib/exec.ts";
import {
  parseReadSection,
  readSectionAsksVerbHelp,
  refuseProjectionBeforeSection,
  sectionWithVerbHelp,
} from "../lib/verb-section.ts";

/**
 * `cf exec` runs no verbose in-flight span, so the failure exit it shares with
 * `cf piece call` is handed a span that closes to nothing. The exit's own
 * contract is what is being reused here — the message, the id and the phase —
 * and that part is span-independent.
 */
const NO_SPAN = { finish: () => {} };

/** The read options `cf exec` shapes a result with. They are declared on the
 * command so its page names them, and read from the words past the `--` that
 * closes the callable's section — the mounted file opens that section, and
 * everything between the two belongs to the callable's own schema-derived
 * interface. */
export interface ExecCommandOptions {
  filter?: string;
  select?: string;
  schema?: string;
}

/**
 * What `cf exec` writes, and where.
 *
 * **stdout carries the machine surface, and only it.** A tool's is its result
 * — the same bytes `cf piece call` prints for the same tool, now shaped by
 * whatever the caller selected. A handler's is the Invocation JSON its
 * handling settled to, which is the envelope `cf piece call` already declares:
 * `cf exec` reaches a verb through a filesystem mount rather than through a
 * piece address, and that is the whole of the difference between them.
 *
 * **The result cell's address goes to stderr, written the way the next command
 * takes it.** An address has three parts, and `canonicalAddress` renders all
 * three as one reference, the space embedded as its `//did:.../` prefix. A
 * reference is written positionally, so the address is printed into the
 * position the next command reads it from rather than behind a flag. Naming
 * the space is not decoration — `cf exec` takes
 * its space from the mount, while `cf cell get` falls back to whatever space
 * the caller has configured, so a token that omitted it would suggest a
 * command that reads a different cell.
 *
 * Standing apart from the action is what lets a test state a result of each
 * shape and read what came out of the two sinks, rather than mounting a file
 * and dispatching to it three times. The action body does run under the unit
 * suite, so what the separation buys is reaching the three outcomes, not
 * reaching the lines.
 */
export function renderExecOutcome(
  result: ExecutedMountedCallableFile,
  deps: {
    write?: (text: string) => void;
    writeError?: (text: string) => void;
  } = {},
): void {
  const write = deps.write ?? console.log;
  const writeError = deps.writeError ?? console.error;
  if (result.helpText) {
    write(result.helpText);
    return;
  }
  if (result.outputText) {
    write(result.outputText);
    if (result.resultRef) {
      const address = canonicalAddress(result.resultRef);
      writeError(
        `Tool result cell: ${address} (read it back with ` +
          `\`cf cell get ${address}\`)`,
      );
    }
    return;
  }
  if (result.invocation) {
    write(JSON.stringify(invocationJson(result.invocation), null, 2));
  }
}

/**
 * The caller's read options, read before anything is resolved or dispatched.
 *
 * A malformed selection is a fact about the flags: it costs no mount lookup and
 * runs no verb, so it is reported as the data error `cf cell get` reports for
 * the same mistake. Routing it through {@link exitExecFailure} instead would
 * name an invocation and a phase to retry from for a call that was never made.
 * A selection that fails against a RESULT is the other case, and that one does
 * name them.
 *
 * A named export with a `deps` seam rather than a `try` inside the action:
 * the exit ends the process, so a malformed selection reached through argv
 * is read off a stubbed `Deno.exit`, while a direct call reads the report
 * off the seam the exit contract is written against.
 */
export async function parseExecSelection(
  options: ExecCommandOptions,
  deps?: Parameters<typeof exitWithDataError>[1],
): Promise<CellSelection | undefined> {
  try {
    return await parseCellSelectionOptions(options);
  } catch (error) {
    if (error instanceof CellSelectionError) {
      exitWithDataError({ message: error.message }, deps);
    }
    throw error;
  }
}

/**
 * The failure exit for `cf exec`.
 *
 * Before `dispatched` there is no invocation worth naming: the pair minted for
 * this call was never spent and never announced, and a tool never passes
 * through the handler phases at all — so the report is the message alone, the
 * same one a missing mount or an unreadable callable has always printed.
 *
 * From `dispatched` onward the handling may have committed, and the report
 * becomes the one `cf piece call` makes: the message, then the id beside the
 * furthest phase reached. That phase is the difference between a retry that
 * deduplicates and one that commits a second time — and `cf exec` accepts no
 * `--invocation`, so a retry can only be a fresh pair. Saying so is what lets
 * a caller decide rather than guess. The session completing the pair is
 * already on stderr, announced at dispatch.
 *
 * A named export rather than catch-block prose because the phase is what
 * chooses between those two reports, and as a parameter a test names it —
 * reaching the second one through the action would take a mounted callable
 * that fails after it has dispatched. The seams let a test observe the exact
 * exit contract, and the action's catch calls THIS function.
 */
export function exitExecFailure(
  error: unknown,
  invocationId: string,
  phase: InvocationPhase,
  deps?: {
    printError?: (message: string) => void;
    render?: (text: string) => void;
    exit?: (code: number) => never;
  },
): never {
  if (phase !== "initial_sync") {
    return exitPieceCallFailure(NO_SPAN, error, invocationId, phase, deps);
  }
  const printError = deps?.printError ?? console.error;
  const exit = deps?.exit ?? Deno.exit;
  printError(error instanceof Error ? error.message : String(error));
  return exit(1);
}

export const exec = new Command()
  .name("exec")
  .description(
    "Execute a mounted callable file from a Common Fabric FUSE mount.",
  )
  .example(
    cliText(
      "cf exec /tmp/cf/home/pieces/notes/result/add.handler invoke --query milk",
    ),
    "Invoke a mounted handler with schema-derived flags.",
  )
  .example(
    cliText(
      "cf exec /tmp/cf/home/pieces/notes/result/search.tool --query milk",
    ),
    "Run a mounted tool using its default verb.",
  )
  .example(
    cliText(
      "cf exec /tmp/cf/home/pieces/notes/result/search.tool --query milk -- --select id,title",
    ),
    'Project the result to selected fields (read options follow the "--" ' +
      "that closes the callable's section).",
  )
  // The three read options are declared so this page names them and a caller
  // who writes one before the mounted file meets a refusal that can say where
  // it belongs. They are READ from the words past `--`, which is the one
  // position the grammar accepts them in; see lib/verb-section.ts.
  .option(
    "--filter <predicate:string>",
    'Filter an array with a jq-inspired predicate (past the "--" that ' +
      "closes the callable's section)",
  )
  .option(
    "--select <fields:string>",
    'Project output to comma-separated field paths (past the "--" that ' +
      "closes the callable's section); a trailing @ asks for a position's " +
      "address",
  )
  .option(
    "--schema <schema:string>",
    "Project output with an inline JSON Schema, @file, or the --select " +
      'field list (past the "--" that closes the callable\'s section)',
    // Both flags carry the one projection, so a command naming both has not
    // said which shape it wants. Refuse before the call rather than pick.
    { conflicts: ["select"] },
  )
  .stopEarly()
  .arguments("<mountedFile:string> [tail...:string]")
  .action(async function (
    options: ExecCommandOptions,
    mountedFile: string,
    ...tail: string[]
  ) {
    // The grammar is a fact about the argv alone, settled before a mount is
    // looked up or an invocation minted: a projection written before the
    // mounted file names positions in a result nothing has produced.
    refuseProjectionBeforeSection(
      "exec",
      "the mounted file",
      this.getRawArgs(),
      options,
    );
    const literalArgs = this.getLiteralArgs();
    // `-- --help` reaches the callable's own page rather than this command's,
    // so those words rejoin the section rather than being read here.
    const asksVerbHelp = readSectionAsksVerbHelp(literalArgs);
    const readSection = asksVerbHelp ? {} : await parseReadSection(
      "exec",
      this.getRawArgs(),
      literalArgs,
    );
    // Into the section, at the position the callable's parser reads `--help`.
    const sectionArgs = asksVerbHelp
      ? sectionWithVerbHelp(tail, literalArgs)
      : tail;
    // Outside the failure wrapper below, and refusing before a mount is even
    // looked up: see {@link parseExecSelection}.
    const selection = await parseExecSelection(readSection);

    // Minted here rather than inside the dispatch so this frame can both
    // announce it and name it again if the call fails. `cf exec` accepts no
    // `--invocation`, so every call is a fresh pair; that makes announcing it
    // the ONLY way a caller ever learns what to retry under.
    const invocation = { id: crypto.randomUUID(), session: newSessionId() };
    let phase: InvocationPhase = "initial_sync";
    const onPhase = invocationPhaseReporter(
      invocation,
      (next) => phase = next,
      undefined,
      Boolean(Deno.env.get("CF_TEST_ANNOUNCE_INVOCATION_PHASES")),
    );

    try {
      const result = await executeMountedCallableFile(
        mountedFile,
        sectionArgs,
        { onPhase },
        {
          invocation,
          ...(selection === undefined ? {} : { selection }),
        },
      );
      renderExecOutcome(result);
    } catch (error) {
      exitExecFailure(error, invocation.id, phase);
    }
  });
