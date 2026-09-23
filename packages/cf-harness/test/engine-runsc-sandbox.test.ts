import { assertEquals, assertRejects, assertThrows } from "@std/assert";

import { CfHarnessEngine } from "../src/engine.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";
import type {
  SandboxRuntime,
  SandboxRuntimeDescription,
} from "../src/sandbox/types.ts";

class RecordingRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = [];
  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request);
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

Deno.test("CfHarnessEngine builds the runsc sandbox when asked, with no docker transport floor", () => {
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    sandboxRuntimeKind: "runsc",
    sandboxRootfs: "/images/kitchensink",
    sandboxCfcPolicy: "/policy.json",
    sandboxRunscNetworkMode: "sandbox",
    processRunner: new RecordingRunner(),
  });
  const description = engine.sandbox.describe();
  assertEquals(description.kind, "runsc-cfc");
  assertEquals(description.sessions, true);
  assertEquals(description.cfc?.image, "/images/kitchensink");
  assertEquals(engine.workspaceHostPath, "/host/project");
  // No docker-runsc config is owned, so the sidecar transport floor never fires.
  assertEquals(engine.ownedSandboxConfig, undefined);
});

Deno.test("CfHarnessEngine refuses the runsc sandbox without a workspace", () => {
  assertThrows(
    () =>
      new CfHarnessEngine({
        runId: "run-1",
        sandboxRuntimeKind: "runsc",
        sandboxRootfs: "/images/kitchensink",
        processRunner: new RecordingRunner(),
      }),
    Error,
    "workspaceHostPath",
  );
});

const closingRuntime = (
  onClose: () => Promise<void>,
): SandboxRuntime & { closes: number } => {
  const description: SandboxRuntimeDescription = {
    kind: "runsc-cfc",
    defaultWorkingDirectory: "/workspace",
  };
  const runtime = {
    closes: 0,
    describe: () => description,
    resolvePath: (path: string) => path,
    isPathWithinWorkspace: () => true,
    isPathWithinAllowedRoots: () => true,
    defaultWorkingDirectory: () => "/workspace",
    run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    runShell: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    close: () => {
      runtime.closes += 1;
      return onClose();
    },
  };
  return runtime;
};

Deno.test("CfHarnessEngine closes the sandbox on every terminal transition", async () => {
  for (
    const end of [
      (e: CfHarnessEngine) => e.completeRun("assistant_completed"),
      (e: CfHarnessEngine) => e.failRun("prompt_loop_error", new Error("x")),
      (e: CfHarnessEngine) => e.cancelRun("stop"),
      (e: CfHarnessEngine) => e.terminalizeInterruptedRun("SIGTERM"),
    ]
  ) {
    const runtime = closingRuntime(() => Promise.resolve());
    const engine = new CfHarnessEngine({
      runId: "run-1",
      workspaceHostPath: "/host/project",
      sandboxRuntime: runtime,
    });
    await end(engine);
    assertEquals(runtime.closes, 1);
  }
});

Deno.test("CfHarnessEngine still ends the run when the sandbox refuses to close", async () => {
  const runtime = closingRuntime(() => Promise.reject(new Error("vm gone")));
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    sandboxRuntime: runtime,
  });
  const state = await engine.completeRun("assistant_completed");
  assertEquals(state.status, "completed");
  assertEquals(runtime.closes, 1);
});

Deno.test("CfHarnessEngine refuses enforcing work on the runsc sandbox without a CFC policy", async () => {
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    sandboxRuntimeKind: "runsc",
    sandboxRootfs: "/images/kitchensink",
    cfcEnforcementMode: "enforce-explicit",
    processRunner: new RecordingRunner(),
  });
  await assertRejects(
    () => engine.invokeBuiltinTool("bash", { command: "echo hi" }),
    Error,
    "requires the runsc sandbox to run with a CFC policy",
  );
});

Deno.test("CfHarnessEngine owns the runsc configuration a child can build on", () => {
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    sandboxRuntimeKind: "runsc",
    sandboxRootfs: "/images/kitchensink",
    sandboxCfcPolicy: "/policy.json",
    additionalMounts: [{
      kind: "host-bind",
      name: "cabinet",
      hostPath: "/host/cabinet",
      sandboxPath: "/file-cabinet",
      readOnly: true,
    }],
    processRunner: new RecordingRunner(),
  });
  assertEquals(engine.ownedSandboxConfig, undefined);
  assertEquals(engine.ownedRunscSandboxConfig?.rootfs, "/images/kitchensink");
  assertEquals(
    engine.ownedRunscSandboxConfig?.additionalMounts.map((m) => m.sandboxPath),
    ["/file-cabinet"],
  );
});
