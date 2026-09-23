import type { JSONSchema } from "@commonfabric/api";
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
import { SandboxSessionUnavailableError } from "../sandbox/types.ts";
import { SandboxPathEscapeError } from "../sandbox/errors.ts";
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
 * honour (no sessions, or an enforcing mode). Recoverable — the model reruns
 * without the session.
 */
export const BASH_SESSION_UNAVAILABLE_EXIT_CODE = 125;

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

export const bashToolDescriptor: HarnessToolDescriptor = {
  toolId: "bash",
  title: "Bash",
  description:
    "Run a shell command inside the target VM. Use this for navigation, search, and command-driven workflows.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number", minimum: 0 },
      session: {
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$",
        description:
          "Name a sandbox session to keep state between commands (files outside the mounts, background processes). Only some sandbox runtimes offer sessions, and none do under an enforcing CFC mode: where one is unavailable the call does not run and returns a recoverable error saying so, and you rerun it without a session. Omit for a fresh sandbox per command.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  } satisfies JSONSchema,
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

export const bashTool: HarnessToolDefinition<BashToolInput, BashToolOutput> = {
  descriptor: bashToolDescriptor,
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
    if (
      input.session !== undefined &&
      context.sandbox.describe().sessions !== true
    ) {
      // Said rather than silently dropped: a runtime without sessions would
      // run the command in a fresh sandbox and the model would go on relying
      // on state that is not there.
      // Nothing ran, so the working directory is unchanged — the same
      // shape as the cwd-outside-sandbox refusal above.
      return {
        outputId,
        stdout: "",
        stderr:
          "this sandbox runtime has no sessions; rerun the command without `session`",
        exitCode: BASH_SESSION_UNAVAILABLE_EXIT_CODE,
        cwd: context.currentDir,
      };
    }
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
        // The runtime has sessions but not for this run (an enforcing mode):
        // the model can act on that by dropping the session.
        return {
          outputId,
          stdout: "",
          stderr: `${error.message}; rerun the command without \`session\``,
          exitCode: BASH_SESSION_UNAVAILABLE_EXIT_CODE,
          cwd: context.currentDir,
        };
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
