import {
  type CallableExecutionDeps,
  type CallableResolution,
  type CallableResultRef,
  executeResolvedCallable,
  type InvocationOutcome,
} from "./callable.ts";
import {
  type ExecCommandSpec,
  type ExecInputResolverDeps,
  normalizeCallableInputForExecution,
  type ParsedExecArgs,
  resolveExecInvocation,
} from "./exec-schema.ts";

export interface CallableCommandExecutionResult<TResolved> {
  helpText?: string;
  outputText?: string;

  /** Handler invocation outcome, passed through from ExecutedCallable. */
  invocation?: InvocationOutcome;

  /** Tool result cell address, passed through from ExecutedCallable. */
  resultRef?: CallableResultRef;

  parsed: ParsedExecArgs;
  resolved: TResolved;
}

export interface CallableCommandExecutionOptions<
  TResolved,
  TDeps extends CallableExecutionDeps & ExecInputResolverDeps,
> {
  resolved: TResolved;
  execution: CallableResolution;
  commandSpec: ExecCommandSpec;
  rawArgs: string[];
  deps?: TDeps;

  /** Render the help page, once the parse has established one was asked for.
   *
   * Allowed to be async so a renderer can resolve something it needs ONLY
   * here: `cf piece call` reads a handler's declared result off the compiled
   * pattern, and every other invocation of the command has no use for it. A
   * synchronous renderer satisfies this signature unchanged. */
  renderHelp: (
    commandSpec: ExecCommandSpec,
    parsed: ParsedExecArgs,
  ) => string | Promise<string>;

  validateRawArgs?: (
    rawArgs: string[],
    commandSpec: ExecCommandSpec,
    resolved: TResolved,
  ) => void;

  /**
   * The command through the word that opened the callable's section — `cf
   * call ... addItem`, `cf exec /tmp/search.tool` — as a refusal about that
   * section reprints it.
   *
   * The parser sees the section and nothing before it, so this is the half of
   * the line it cannot reconstruct. It elides the target the way the verb's
   * own help page elides it, for the same reason.
   */
  sectionPrefix?: string;
}

export async function readJsonInputFromStdin(): Promise<unknown> {
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let sawChunk = false;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sawChunk = true;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  if (!sawChunk && text.trim().length === 0) {
    throw new Error("Expected JSON on stdin for --json");
  }

  if (text.trim().length === 0) {
    throw new Error("Expected JSON on stdin for --json");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON on stdin for --json");
  }
}

export async function executeCallableCommand<
  TResolved,
  TDeps extends CallableExecutionDeps & ExecInputResolverDeps,
>(
  options: CallableCommandExecutionOptions<TResolved, TDeps>,
): Promise<CallableCommandExecutionResult<TResolved>> {
  const {
    resolved,
    execution,
    commandSpec,
    rawArgs,
    deps,
    renderHelp,
    validateRawArgs,
    sectionPrefix,
  } = options;

  validateRawArgs?.(rawArgs, commandSpec, resolved);

  const invocation = await resolveExecInvocation(
    commandSpec,
    rawArgs,
    deps,
    sectionPrefix,
  );
  const parsed = invocation.parsed;

  if (parsed.showHelp) {
    return {
      helpText: await renderHelp(commandSpec, parsed),
      parsed,
      resolved,
    };
  }

  const input = invocation.input;

  const executed = await executeResolvedCallable(
    execution,
    parsed.usedJsonInput
      ? input
      : normalizeCallableInputForExecution(commandSpec, input),
    deps,
  );

  return {
    outputText: executed.outputText,
    invocation: executed.invocation,
    resultRef: executed.resultRef,
    parsed,
    resolved,
  };
}
