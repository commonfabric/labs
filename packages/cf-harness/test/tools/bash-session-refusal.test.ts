/**
 * What a run holds, and what its model is shown, after the sandbox runtime
 * refuses the session a bash call named.
 *
 * Every case goes the way a run goes: the engine invokes the bash tool, the
 * tool asks the runsc runtime, and the runtime drives `runsc` through a
 * process runner. Only the runner is a fake, so the refusals are the ones the
 * runtime makes and the records are the ones the engine keeps.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";

import { CfHarnessEngine } from "../../src/engine.ts";
import type {
  ProcessHandle,
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
  ProcessSpawnRequest,
} from "../../src/sandbox/process-runner.ts";
import { ProcessTimeoutError } from "../../src/sandbox/process-runner.ts";
import {
  resolveRunscSandboxConfig,
  RUNSC_MAX_SESSIONS,
  RunscSandboxRuntime,
} from "../../src/sandbox/runsc.ts";
import { SandboxSessionUnavailableError } from "../../src/sandbox/types.ts";
import {
  BASH_SESSION_UNAVAILABLE_EXIT_CODE,
  BASH_TIMEOUT_EXIT_CODE,
} from "../../src/tools/bash.ts";

const RUNSC_SUBCOMMANDS = ["run", "exec", "state", "delete", "kill"];

/**
 * A process runner that returns what `runsc` returns, with no sandbox behind
 * it: `state` reports a container running until it is deleted, a session's
 * `runsc run` child lives until a test ends it, and an exec returns
 * `execResult`.
 */
class FakeRunscRunner implements ProcessRunner {
  /** The containers started as sessions, in the order they were started. */
  readonly sessionContainerIds: string[] = [];

  /** The containers `runsc` reports as absent. */
  readonly absent = new Set<string>();

  /** The number of commands executed in a session. */
  execCount = 0;

  /** What an exec in a session returns. */
  execResult: ProcessRunResult = { stdout: "", stderr: "", exitCode: 0 };

  /** When set, an exec in a session throws this. */
  execError: Error | undefined;

  /** When set, starting a session's container throws this. */
  spawnError: Error | undefined;

  readonly #exits = new Map<string, (exitCode: number) => void>();

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const argv = request.command === "/bin/sh"
      ? request.args.slice(5)
      : request.args;
    const subcommand = argv.find((arg) => RUNSC_SUBCOMMANDS.includes(arg));
    const containerId = argv[argv.length - 1];
    if (subcommand === "state") {
      return Promise.resolve(
        this.absent.has(containerId)
          ? { stdout: "", stderr: "does not exist", exitCode: 128 }
          : {
            stdout: `{"id": "${containerId}", "status": "running"}\n`,
            stderr: "",
            exitCode: 0,
          },
      );
    }
    if (subcommand === "delete") {
      this.absent.add(containerId);
    }
    if (subcommand === "exec") {
      this.execCount += 1;
      return this.execError !== undefined
        ? Promise.reject(this.execError)
        : Promise.resolve(this.execResult);
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  spawn(request: ProcessSpawnRequest): ProcessHandle {
    if (this.spawnError !== undefined) {
      throw this.spawnError;
    }
    const containerId = request.args[request.args.length - 1];
    this.sessionContainerIds.push(containerId);
    const { promise: exited, resolve } = Promise.withResolvers<
      { exitCode: number }
    >();
    this.#exits.set(containerId, (exitCode) => resolve({ exitCode }));
    return {
      pid: 4242,
      exited,
      kill: () => resolve({ exitCode: 137 }),
    };
  }

  /**
   * Ends the most recently started session's container, as its init process
   * dying does, and returns once the runtime has been told.
   */
  async endLatestSession(): Promise<void> {
    const containerId = this.sessionContainerIds.at(-1)!;
    this.#exits.get(containerId)!(137);
    this.absent.add(containerId);
    // The runtime reads the exit in a continuation of `exited`.
    await Promise.resolve();
  }
}

const SESSION_LOST_TEXT =
  "the sandbox session ended and its state is lost: files outside the mounts and background processes are gone; the command did not run; rerun it with the same `session` to start an empty session, or without `session`";

describe("bash session refusals", () => {
  let scratchDir: string;
  let runner: FakeRunscRunner;
  let runtime: RunscSandboxRuntime;
  let engine: CfHarnessEngine;
  let logged: Stub<Console>;

  /** Everything written to the operator's log, one line per call. */
  const loggedLines = (): string[] =>
    logged.calls.map((call) => call.args.join(" "));

  beforeEach(async () => {
    logged = stub(console, "error");
    scratchDir = await Deno.makeTempDir({ prefix: "bash-session-refusal-" });
    runner = new FakeRunscRunner();
    runtime = new RunscSandboxRuntime(
      resolveRunscSandboxConfig({
        workspaceHostPath: "/tmp/workspace",
        runscBinary: "/opt/runsc",
        rootfs: "/images/kitchensink",
        scratchDir,
        runId: "run-refusal",
        platform: "linux",
      }),
      runner,
    );
    engine = new CfHarnessEngine({
      runId: "run-refusal",
      sandboxRuntime: runtime,
      // A session is a thing of the modes that do not enforce.
      cfcEnforcementMode: "observe",
    });
  });

  afterEach(async () => {
    await runtime.close();
    await Deno.remove(scratchDir, { recursive: true }).catch(() => undefined);
    logged.restore();
  });

  /** The invocation records the run holds for one tool output. */
  const invocationRecordsFor = (outputId: string) =>
    (engine.getRunState().cfcInvocationContexts ?? []).filter((record) =>
      record.toolOutputId === outputId
    );

  describe("a refusal the runtime makes", () => {
    it("keeps the invocation record the call was handed to the runtime with", async () => {
      await engine.invokeBuiltinTool("bash", {
        command: "make",
        session: "build",
      });
      await runner.endLatestSession();

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        cwd: "repo",
        session: "build",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toContain("session");
      // Nothing was executed in the session that ended.
      expect(runner.execCount).toBe(1);
      const records = invocationRecordsFor(output.outputId);
      expect(records.length).toBe(1);
      expect(records[0].toolId).toBe("bash");
      expect(records[0].operation).toBe("shell");
      expect(records[0].cwd).toBe("/workspace/repo");
    });

    it("leaves the working directory where the call before it left it", async () => {
      // Three directories, so that the one expected is neither the run's
      // first nor the one the refused call asked for.

      await engine.invokeBuiltinTool("bash", {
        command: "make",
        cwd: "first",
        session: "build",
      });
      expect(engine.getRunState().currentDir).toBe("/workspace/first");
      await runner.endLatestSession();

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        cwd: "second",
        session: "build",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toContain("session");
      expect(output.cwd).toBe("/workspace/first");
      expect(engine.getRunState().currentDir).toBe("/workspace/first");

      // A relative `cwd` on the call after it resolves from there.
      const next = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        cwd: "third",
        session: "build",
      });
      expect(next.output.exitCode).toBe(0);
      expect(next.output.cwd).toBe("/workspace/first/third");
    });
  });

  describe("a refusal the tool makes before it asks the runtime", () => {
    it("keeps no invocation record and leaves the working directory", async () => {
      await engine.invokeBuiltinTool("bash", { command: "true", cwd: "first" });

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make",
        cwd: "second",
        session: "not a name",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toContain("invalid `session` name");
      expect(invocationRecordsFor(output.outputId)).toEqual([]);
      expect(runner.sessionContainerIds).toEqual([]);
      expect(output.cwd).toBe("/workspace/first");
      expect(engine.getRunState().currentDir).toBe("/workspace/first");
    });
  });

  describe("the reason the runtime gives", () => {
    it("is `invalid-name` for a name the tool would have refused first", async () => {
      // The one refusal of the runtime's that no bash call reaches, since
      // the tool checks the name by the same pattern before it asks.

      const refusal = await runtime.run({
        argv: ["/bin/true"],
        session: "not a name",
      }).then(() => undefined, (error: unknown) => error);

      expect(refusal).toBeInstanceOf(SandboxSessionUnavailableError);
      expect((refusal as SandboxSessionUnavailableError).reason).toBe(
        "invalid-name",
      );
    });
  });

  describe("what the model is shown", () => {
    it("says a session whose container exited starts empty when named again", async () => {
      await engine.invokeBuiltinTool("bash", {
        command: "make",
        session: "build",
      });
      await runner.endLatestSession();

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        session: "build",
      });

      expect(output).toEqual({
        outputId: output.outputId,
        stdout: "",
        stderr: SESSION_LOST_TEXT,
        exitCode: BASH_SESSION_UNAVAILABLE_EXIT_CODE,
        cwd: "/workspace",
      });
      // Named again, as the text says, it is a second container.
      const again = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        session: "build",
      });
      expect(again.output.exitCode).toBe(0);
      expect(runner.sessionContainerIds.length).toBe(2);
    });

    it("says the same of a session that went with a command that timed out", async () => {
      await engine.invokeBuiltinTool("bash", {
        command: "make",
        session: "build",
      });
      runner.execError = new ProcessTimeoutError(
        "/bin/sh -c exec /opt/operator/bin/runsc exec",
        1500,
      );
      const timedOut = await engine.invokeBuiltinTool("bash", {
        command: "sleep 99",
        session: "build",
        timeoutMs: 1500,
      });
      expect(timedOut.output.exitCode).toBe(BASH_TIMEOUT_EXIT_CODE);
      runner.execError = undefined;

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        session: "build",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toBe(SESSION_LOST_TEXT);
    });

    it("says the same of a session `runsc` no longer knows at the call", async () => {
      await engine.invokeBuiltinTool("bash", {
        command: "make",
        session: "build",
      });
      // The container is gone and its child has not been reaped: the exec
      // is what finds out.
      runner.absent.add(runner.sessionContainerIds[0]);
      runner.execResult = {
        stdout: "",
        stderr:
          "loading container: file does not exist: /run/operator/runsc/state",
        exitCode: 128,
      };

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        session: "build",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toBe(SESSION_LOST_TEXT);
    });

    it("says a run at its bound of sessions may reuse one, and names none", async () => {
      for (let index = 0; index < RUNSC_MAX_SESSIONS; index += 1) {
        const started = await engine.invokeBuiltinTool("bash", {
          command: "true",
          session: `held-${index}`,
        });
        expect(started.output.exitCode).toBe(0);
      }

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make",
        session: "one-too-many",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toBe(
        "this run already holds as many sandbox sessions as it may; the command did not run; rerun it with the `session` of a session this run already started, or without `session`",
      );
      expect(runner.sessionContainerIds.length).toBe(RUNSC_MAX_SESSIONS);
      // The runtime's own account, names included, is the operator's.
      expect(loggedLines().join("\n")).toContain("held-0, held-1");
    });

    it("says a session that could not start is not to be retried, and nothing of why", async () => {
      runner.spawnError = new Error(
        "Failed to spawn '/opt/operator/bin/runsc': No such file or directory (os error 2)",
      );

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make",
        session: "build",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toBe(
        "the sandbox session could not be started; the command did not run; rerun it without `session`; a start that failed is likely to fail again, so do not retry the session in a loop",
      );
      expect(output.stdout).toBe("");
      // Why it failed is the operator's to read.
      const lines = loggedLines();
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("start-failed");
      expect(lines[0]).toContain("/opt/operator/bin/runsc");
    });

    it("says an enforcing run has no sessions", async () => {
      // A runtime with a policy, since one without refuses an enforcing
      // call before it looks at the session.

      const enforcingScratchDir = await Deno.makeTempDir({
        prefix: "bash-session-refusal-",
      });
      const enforcingRuntime = new RunscSandboxRuntime(
        resolveRunscSandboxConfig({
          workspaceHostPath: "/tmp/workspace",
          runscBinary: "/opt/runsc",
          rootfs: "/images/kitchensink",
          scratchDir: enforcingScratchDir,
          runId: "run-enforcing",
          platform: "linux",
          cfcPolicyPath: "/policy.json",
        }),
        runner,
      );
      const enforcingEngine = new CfHarnessEngine({
        runId: "run-enforcing",
        sandboxRuntime: enforcingRuntime,
        cfcEnforcementMode: "enforce-explicit",
      });
      try {
        const { output } = await enforcingEngine.invokeBuiltinTool("bash", {
          command: "make",
          session: "build",
        });

        expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
        expect(output.stderr).toBe(
          "sandbox sessions are not available under this run's CFC enforcement mode; the command did not run; rerun it without `session`",
        );
        expect(runner.sessionContainerIds).toEqual([]);
        expect(
          (enforcingEngine.getRunState().cfcInvocationContexts ?? []).filter((
            record,
          ) => record.toolOutputId === output.outputId).length,
        ).toBe(1);
      } finally {
        await enforcingRuntime.close();
        await Deno.remove(enforcingScratchDir, { recursive: true }).catch(() =>
          undefined
        );
      }
    });
  });
});
