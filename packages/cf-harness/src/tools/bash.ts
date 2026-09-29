import type { JSONSchema } from "@commonfabric/api";
import { debugStr, toCompactDebugString } from "@commonfabric/data-model";
import type { CfcLabelView, CfcSandboxResult } from "@commonfabric/runner/cfc";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  BASH_COMMAND_DENIED_EXIT_CODE,
  BASH_COMMAND_DENIED_PREFIX,
  validateBashCurlCommand,
} from "./bash-curl-policy.ts";
import {
  commandWithFinalWorkingDirectoryMarker,
  cwdMarkerForOutput,
  extractFinalWorkingDirectory,
} from "./shell-cwd.ts";
import { ProcessTimeoutError } from "../sandbox/process-runner.ts";
import {
  SANDBOX_SESSION_NAME_PATTERN,
  type SandboxRuntimeDescription,
  SandboxSessionUnavailableError,
  type SandboxSessionUnavailableReason,
} from "../sandbox/types.ts";
import { SandboxPathEscapeError } from "../sandbox/errors.ts";
import { escapeForOperatorLog } from "../operator-log.ts";
import type { HarnessToolDefinition } from "./types.ts";

// Two RECOVERABLE tool errors the model itself can fix: it passed a `cwd`
// outside the sandbox, or its command overran the time budget. Like the
// curl-denied branch below, bash surfaces each as an ordinary failed
// BashToolOutput the model reacts to on its next turn — it does NOT throw.
// A throw here would propagate through `CfHarnessEngine.invokeBuiltinTool`,
// which records it as a failure, to the prompt loop, which fails the whole
// run on it — killing an agent for a mistake it could simply correct. This
// was defect D9 in the loom fuse-fabric-access arc and the topics-board topic
// "cf-harness: tool-call failures are run-fatal (path escape, 20s timeout)".
// Only host-safe, self-authored detail is echoed: the model's own `cwd` string
// (already in the transcript) and the numeric timeout — never the raw
// exception text, which can carry host paths or runtime config, and never the
// resolved sandbox path. Genuinely fatal failures (docker spawn/infra, CFC
// transport, persistence, invariants) are left to throw and stay run-fatal.
export const BASH_CWD_OUTSIDE_SANDBOX_PREFIX = "cwd is outside the sandbox";
export const BASH_CWD_OUTSIDE_SANDBOX_EXIT_CODE = 1;
// 124 is the conventional shell exit code for a timed-out command (GNU coreutils
// `timeout`), which agents already recognize.
export const BASH_TIMEOUT_EXIT_CODE = 124;
/**
 * The command did not run: it named a sandbox session the runtime cannot
 * honor (no sessions, or not for this call), or a name that is not a
 * session name. Recoverable, and what the model does next depends on which
 * refusal it was, so the text beside this exit code says: rerun without the
 * session, with a name that is one, or with the same name to start over.
 */
export const BASH_SESSION_UNAVAILABLE_EXIT_CODE = 125;

/**
 * How many characters of a runtime's message about a refused session the
 * operator's log carries. A message is written for an operator and ends in
 * the underlying cause, and the log is the one place it is kept, so the bound
 * is there to keep a message of any length from flooding the log and not to
 * summarize one. A longer message is carried to this length, followed by the
 * length it had.
 */
export const BASH_SESSION_REFUSAL_LOG_MESSAGE_MAX_LENGTH = 8000;

export interface BashToolInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Optional sandbox session. Commands that name the same session share one
   * sandbox for the rest of the run; commands that name none each get a
   * fresh one. Only the runsc runtime honours it today.
   */
  session?: string;
  // Trusted harness/test plumbing for invocation input labels. This is omitted
  // from the public tool schema so model-authored tool calls do not mint labels.
  cfcInputLabels?: CfcLabelView;
}

export interface BashToolOutput {
  outputId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  cfcResult?: CfcSandboxResult;
}

const CWD_MARKER_PREFIX = "__CF_HARNESS_CWD__";

const observedCfcStdout = (
  cfcResult: CfcSandboxResult | undefined,
): string | undefined =>
  cfcResult?.stdout.policy === "observed"
    ? cfcResult.stdout.segments.map((segment) => segment.text).join("")
    : undefined;

const bashInputSchema = {
  type: "object",
  properties: {
    command: { type: "string" },
    cwd: { type: "string" },
    timeoutMs: { type: "number", minimum: 0 },
  },
  required: ["command"],
  additionalProperties: false,
} satisfies JSONSchema;

/**
 * The descriptor for a run whose sandbox has no sessions, which is the
 * Docker runtime and so the default. It takes no `session`: offering one
 * would change the tool manifest of every run that cannot use it, and invite
 * a call that can only be refused.
 */
export const bashToolDescriptor: HarnessToolDescriptor = {
  toolId: "bash",
  title: "Bash",
  description:
    "Run a shell command inside the target VM. Use this for navigation, search, and command-driven workflows.",
  effectClass: "side-effect",
  inputSchema: bashInputSchema,
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { type: "number" },
      cwd: { type: "string" },
      cfcResult: { type: "object" },
    },
    required: ["outputId", "stdout", "stderr", "exitCode", "cwd"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["shell", "vm", "command"],
};

/** The same tool, for a run whose sandbox has sessions. */
const bashToolDescriptorWithSessions: HarnessToolDescriptor = {
  ...bashToolDescriptor,
  inputSchema: {
    ...bashInputSchema,
    properties: {
      ...bashInputSchema.properties,
      session: {
        type: "string",
        // The runtime's own pattern, so the schema the model reads and the
        // check made on the name are one rule.
        pattern: SANDBOX_SESSION_NAME_PATTERN.source,
        description:
          "Name a sandbox session to keep state between commands (files outside the mounts, background processes). A session lasts for this run or chat turn only: it starts empty in a new turn or a resumed run. A session that has ended (a command in it timed out, its process was killed) is reported as an error once and starts empty when named again. Omit `session` to run the command in a fresh sandbox of its own.",
      },
    },
  } satisfies JSONSchema,
};

/** The bash descriptor a run on this sandbox runtime offers the model. */
export const bashToolDescriptorForRuntime = (
  runtime: Pick<SandboxRuntimeDescription, "sessions">,
): HarnessToolDescriptor =>
  runtime.sessions === true
    ? bashToolDescriptorWithSessions
    : bashToolDescriptor;

/**
 * A refusal over `session`. The command did not run, so `cwd` is the working
 * directory the run already had and the refusal leaves it there. Whether the
 * run holds an invocation record for the call depends on who refuses: the
 * tool refuses before it makes one, and the runtime can only refuse a call
 * that was handed to it, which is after.
 */
const sessionRefusal = (
  outputId: BashToolOutput["outputId"],
  cwd: string,
  stderr: string,
): BashToolOutput => ({
  outputId,
  stdout: "",
  stderr,
  exitCode: BASH_SESSION_UNAVAILABLE_EXIT_CODE,
  cwd,
});

const INVALID_SESSION_NAME_REFUSAL =
  "invalid `session` name: use 1 to 32 characters from letters, digits, `_`, `.` and `-`, starting with a letter or a digit; rerun the command with such a name, or without `session`";

/**
 * What the model is shown for each reason a runtime refuses a session. Every
 * text is written here and none is taken from the error, whose message is
 * the runtime's account for an operator: it can carry host paths, container
 * ids and the text of the error a session failed to start with.
 *
 * Each text ends in what to do next, which is where the reasons differ. A
 * session that was lost starts empty under the same name. A run at its bound
 * of sessions has sessions to reuse. A session that did not start is not
 * worth starting again.
 */
const SESSION_REFUSAL_BY_REASON: Readonly<
  Record<SandboxSessionUnavailableReason, string>
> = {
  "invalid-name": INVALID_SESSION_NAME_REFUSAL,
  "enforcing-mode":
    "sandbox sessions are not available under this run's CFC enforcement mode; the command did not run; rerun it without `session`",
  "session-lost":
    "the sandbox session ended and its state is lost: files outside the mounts and background processes are gone; the command did not run; rerun it with the same `session` to start an empty session, or without `session`",
  "session-limit":
    "this run already holds as many sandbox sessions as it may; the command did not run; rerun it with the `session` of a session this run already started, or without `session`",
  "start-failed":
    "the sandbox session could not be started; the command did not run; rerun it without `session`; a start that failed is likely to fail again, so do not retry the session in a loop",
};

/**
 * The text for a reason outside the set. A runtime is handed to a run
 * through an interface, so what arrives as `reason` is checked and not
 * assumed.
 */
const SESSION_REFUSAL_FOR_UNKNOWN_REASON =
  "the sandbox runtime refused the `session` of this call; the command did not run; rerun it without `session`";

const sessionRefusalForReason = (reason: unknown): string =>
  typeof reason === "string" && Object.hasOwn(SESSION_REFUSAL_BY_REASON, reason)
    ? SESSION_REFUSAL_BY_REASON[reason as SandboxSessionUnavailableReason]
    : SESSION_REFUSAL_FOR_UNKNOWN_REASON;

/**
 * How long the rendering of a runtime's message may be: six characters for
 * each character carried, which is what the longest escape takes, and room
 * for the quotes and the note of a cut. No message that is a string renders
 * longer, so the cut at this length is for a `message` that is something
 * else.
 */
const SESSION_REFUSAL_LOG_RENDERING_MAX_LENGTH =
  6 * BASH_SESSION_REFUSAL_LOG_MESSAGE_MAX_LENGTH + 100;

/**
 * The line the operator's log gets for a session the runtime refused: the run
 * and the tool output the refusal belongs to, which are what join the line
 * to a transcript, then the runtime's reason and its message. The tool adds
 * nothing of the call's input: a command or a session name is in the line
 * only where the runtime's message holds one. It is one line whatever the
 * message holds, and it is bounded: see
 * {@link BASH_SESSION_REFUSAL_LOG_MESSAGE_MAX_LENGTH}.
 */
const sessionRefusalLogLine = (
  runId: string,
  outputId: BashToolOutput["outputId"],
  error: SandboxSessionUnavailableError,
): string => {
  const message = toCompactDebugString(error.message, {
    maxStringLength: BASH_SESSION_REFUSAL_LOG_MESSAGE_MAX_LENGTH,
    // As many lines as a rendering carries: the length is the bound.
    maxStringLines: Infinity,
    maxLength: SESSION_REFUSAL_LOG_RENDERING_MAX_LENGTH,
    backtickQuote: true,
  });
  // The rendering escapes what JSON escapes, which leaves the C1 control
  // characters, the Unicode line breaks and the directional characters as
  // they are. The line is escaped whole, so that what the run id holds is
  // covered with the rest.
  return escapeForOperatorLog(
    debugStr`cf-harness: bash: the sandbox runtime refused a session, run $quote,long${runId}, output $quote,long${outputId}, reason $quote${error.reason}: ${message}`,
  );
};

export const bashTool: HarnessToolDefinition<BashToolInput, BashToolOutput> = {
  descriptor: bashToolDescriptor,
  descriptorForRuntime: bashToolDescriptorForRuntime,
  async invoke(context, input) {
    const outputId = context.nextOutputId("bash");
    let commandCwd: string;
    try {
      commandCwd = input.cwd !== undefined
        ? context.resolvePath(input.cwd)
        : context.currentDir;
    } catch (error) {
      // Only a genuine path-escape is recoverable. `context.resolvePath`
      // delegates to an injected SandboxRuntime whose contract does not
      // otherwise restrict its failures, so narrow by TYPE: a corrupt-runtime
      // or invariant failure must stay run-fatal, not masquerade as a bad cwd.
      if (!(error instanceof SandboxPathEscapeError)) {
        throw error;
      }
      // Recoverable: keep the run alive, leave the working directory unchanged,
      // and hand the model a known-safe message built from its own `cwd` —
      // never the raw exception (may carry the sandbox root label) or the
      // resolved path.
      return {
        outputId,
        stdout: "",
        stderr: `${BASH_CWD_OUTSIDE_SANDBOX_PREFIX}: ${input.cwd ?? ""}`,
        exitCode: BASH_CWD_OUTSIDE_SANDBOX_EXIT_CODE,
        cwd: context.currentDir,
      };
    }
    const curlPolicy = validateBashCurlCommand(input.command);
    if (!curlPolicy.allowed) {
      context.setCurrentDir(commandCwd);
      return {
        outputId,
        stdout: "",
        stderr: `${BASH_COMMAND_DENIED_PREFIX}: ${
          curlPolicy.reason ?? "curl is not allowed"
        }`,
        exitCode: BASH_COMMAND_DENIED_EXIT_CODE,
        cwd: commandCwd,
      };
    }
    // The tool's own refusals over `session`, made from the input and the
    // runtime's description alone. They come BEFORE the invocation context
    // below, which appends to run state and persists it: a call that was
    // never handed to the runtime leaves no record that it was prepared.
    if (input.session !== undefined) {
      if (context.sandbox.describe().sessions !== true) {
        // Said rather than silently dropped: a runtime without sessions would
        // run the command in a fresh sandbox and the model would go on
        // relying on state that is not there. Nothing ran, so the working
        // directory is unchanged — the same shape as the cwd-outside-sandbox
        // refusal above.
        return sessionRefusal(
          outputId,
          context.currentDir,
          "this sandbox runtime has no sessions; rerun the command without `session`",
        );
      }
      if (
        typeof input.session !== "string" ||
        !SANDBOX_SESSION_NAME_PATTERN.test(input.session)
      ) {
        // Checked here and not left to the runtime, whose refusal of a name
        // is not one this tool is promised to recognise: an error it does
        // not recognise ends the run, over a name the model can simply
        // correct. The name itself is not echoed.
        return sessionRefusal(
          outputId,
          context.currentDir,
          INVALID_SESSION_NAME_REFUSAL,
        );
      }
    }
    const cwdMarker = cwdMarkerForOutput(CWD_MARKER_PREFIX, outputId);
    const command = commandWithFinalWorkingDirectoryMarker(
      input.command,
      cwdMarker,
    );
    // Build the CFC invocation context BEFORE the timeout-catching try. It
    // updates and persists run state; if it fails (including with a
    // ProcessTimeoutError of its own), that is a setup/persistence failure that
    // must stay run-fatal, not be misreported as a command timeout below —
    // `runShell` has not even been called yet.
    const cfcInvocationContext = await context.createCfcInvocationContext({
      toolId: "bash",
      toolOutputId: outputId,
      operation: "shell",
      cwd: commandCwd,
      command,
      ...(input.cfcInputLabels !== undefined
        ? { cfcInputLabels: input.cfcInputLabels }
        : {}),
      cfcInputLabelPaths: input.cwd !== undefined
        ? [["command"], ["cwd"]]
        : [["command"]],
    });
    let result: Awaited<ReturnType<typeof context.sandbox.runShell>>;
    try {
      result = await context.sandbox.runShell({
        command,
        cwd: commandCwd,
        timeoutMs: input.timeoutMs,
        cfcInvocationContext,
        ...(input.session !== undefined ? { session: input.session } : {}),
      });
    } catch (error) {
      if (error instanceof ProcessTimeoutError) {
        // Recoverable: the model's command overran its time budget. The command
        // still ran in `commandCwd`, so adopt it as the working directory, and
        // report only the numeric timeout — no host detail from the exception.
        context.setCurrentDir(commandCwd);
        return {
          outputId,
          stdout: "",
          stderr: `command timed out after ${error.timeoutMs}ms`,
          exitCode: BASH_TIMEOUT_EXIT_CODE,
          cwd: commandCwd,
        };
      }
      if (error instanceof SandboxSessionUnavailableError) {
        // The runtime has sessions but not for this call (an enforcing
        // mode, a session that ended, too many sessions): recoverable, and
        // the model is told which in this file's words, selected by the
        // error's reason. The runtime's message goes to the operator's log
        // and nowhere the model reads.
        console.error(sessionRefusalLogLine(context.runId, outputId, error));
        // This refusal is the runtime's, so it arrives after the invocation
        // record above was made, and the record stays. It says the call was
        // prepared and handed to the runtime, which is what happened, and
        // it is the record that accounts for this output. Whether a session
        // is there is known by starting it, and a session that ended is
        // reported once, so there is nothing to ask the runtime beforehand.
        // Nothing ran, so the working directory is the one the run had.
        return sessionRefusal(
          outputId,
          context.currentDir,
          sessionRefusalForReason(error.reason),
        );
      }
      // Anything else from runShell — docker spawn/infra, CFC transport — is not
      // something the model can fix. Let it propagate and stay run-fatal.
      throw error;
    }
    const mayTrustCwdMarker = context.cfcEnforcementMode === "disabled" ||
      context.cfcEnforcementMode === "observe";
    const cwdSourceStdout = mayTrustCwdMarker
      ? result.stdout
      : observedCfcStdout(result.cfcResult);
    const parsedCwd = cwdSourceStdout !== undefined
      ? extractFinalWorkingDirectory(cwdSourceStdout, cwdMarker)
      : undefined;
    const outputStdout = mayTrustCwdMarker && parsedCwd !== undefined
      ? parsedCwd.stdout
      : result.stdout;
    const isAllowedCurrentDir = parsedCwd?.cwd !== undefined &&
      context.sandbox.isPathWithinAllowedRoots(parsedCwd.cwd);
    const nextCurrentDir = parsedCwd?.cwd !== undefined &&
        isAllowedCurrentDir
      ? parsedCwd.cwd
      : commandCwd;
    context.setCurrentDir(nextCurrentDir);
    return {
      outputId,
      stdout: outputStdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      cwd: nextCurrentDir,
      ...(result.cfcResult !== undefined
        ? { cfcResult: result.cfcResult }
        : {}),
    };
  },
};
