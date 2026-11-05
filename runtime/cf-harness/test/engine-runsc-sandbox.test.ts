import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";

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

Deno.test("CfHarnessEngine builds the runsc sandbox when asked", () => {
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    sandboxRuntimeKind: "runsc",
    sandboxRunscBinary: "/opt/runsc",
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
});

Deno.test("CfHarnessEngine refuses the runsc sandbox without a workspace", () => {
  assertThrows(
    () =>
      new CfHarnessEngine({
        runId: "run-1",
        sandboxRuntimeKind: "runsc",
        sandboxRunscBinary: "/opt/runsc",
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
  // The three transitions that each close the sandbox themselves. An
  // interrupted run ends through `failRun` and is covered on its own below:
  // in this list it would pass on `failRun`'s close and prove nothing of its
  // own.
  for (
    const end of [
      (e: CfHarnessEngine) => e.completeRun("assistant_completed"),
      (e: CfHarnessEngine) => e.failRun("prompt_loop_error", new Error("x")),
      (e: CfHarnessEngine) => e.cancelRun("stop"),
    ]
  ) {
    const runtime = closingRuntime(() => Promise.resolve());
    const engine = new CfHarnessEngine({
      runId: "run-1",
      workspaceHostPath: "/host/project",
      sandboxRuntime: runtime,
      ownsSandboxRuntime: true,
    });
    await end(engine);
    assertEquals(runtime.closes, 1);
  }
});

Deno.test("CfHarnessEngine closes an interrupted run's sandbox once, and before it records the interruption", async () => {
  // `terminalizeInterruptedRun` closes the sandbox and then ends the run
  // through `failRun`, which closes it too. Two things are its own:
  //
  //   - the two closes are one: the runtime is asked once;
  //   - its close comes FIRST, before the run state is touched. The process
  //     is going down, and the sandbox is what outlives it if left.
  //
  // The second is what tells its close from `failRun`'s, which runs after
  // the interruption has been recorded.
  const failuresSeenAtClose: number[] = [];
  const statusSeenAtClose: string[] = [];
  let engine: CfHarnessEngine | undefined = undefined;
  const runtime = closingRuntime(() => {
    const state = engine!.getRunState();
    failuresSeenAtClose.push(state.failureRecords?.length ?? 0);
    statusSeenAtClose.push(state.status);
    return Promise.resolve();
  });
  engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    sandboxRuntime: runtime,
    ownsSandboxRuntime: true,
  });

  const state = await engine.terminalizeInterruptedRun("SIGTERM");

  assertEquals(state.status, "failed");
  assertEquals(state.terminalReason, "process_interrupted");
  // The interruption was recorded, so "none at close" below is a statement
  // about order and not about a record that is never written.
  assertEquals(state.failureRecords?.length, 1);
  assertEquals(runtime.closes, 1);
  assertEquals(failuresSeenAtClose, [0]);
  assertEquals(statusSeenAtClose.includes("failed"), false);

  // A run that already has its outcome is left as it is, sandbox included.
  await engine.terminalizeInterruptedRun("SIGTERM");
  assertEquals(runtime.closes, 1);
});

Deno.test("CfHarnessEngine leaves a shared, injected sandbox open when it ends", async () => {
  // A child handed its parent's runtime must not close it under the parent
  // (review, verified live: the parent's next session call threw).
  const runtime = closingRuntime(() => Promise.resolve());
  const engine = new CfHarnessEngine({
    runId: "run-1.subagent.1",
    workspaceHostPath: "/host/project",
    sandboxRuntime: runtime,
  });
  await engine.completeRun("assistant_completed");
  assertEquals(runtime.closes, 0);
});

Deno.test("CfHarnessEngine closes the runsc runtime it built itself", async () => {
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    sandboxRuntimeKind: "runsc",
    sandboxRunscBinary: "/opt/runsc",
    sandboxRootfs: "/images/kitchensink",
    processRunner: new RecordingRunner(),
  });
  await engine.completeRun("assistant_completed");
  await assertRejects(
    () => engine.sandbox.run({ argv: ["true"] }),
    Error,
    "sandbox runtime is closed",
  );
});

Deno.test("CfHarnessEngine still ends the run when the sandbox refuses to close", async () => {
  const runtime = closingRuntime(() => Promise.reject(new Error("vm gone")));
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    sandboxRuntime: runtime,
    ownsSandboxRuntime: true,
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
    sandboxRunscBinary: "/opt/runsc",
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
    sandboxRunscBinary: "/opt/runsc",
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
  assertEquals(engine.ownedRunscSandboxConfig?.rootfs, "/images/kitchensink");
  assertEquals(
    engine.ownedRunscSandboxConfig?.additionalMounts.map((m) => m.sandboxPath),
    ["/file-cabinet"],
  );
});

/** The `runsc run` command line of each call the runner was asked to make. */
const runscRunCommandLines = (runner: RecordingRunner): string[][] =>
  runner.calls
    .filter((call) => call.command === "/bin/sh")
    .map((call) => call.args ?? [])
    .filter((args) => args.includes("run"));

Deno.test("CfHarnessEngine builds the runsc runtime from every runsc option it is given", async () => {
  // Each value differs from the default the runtime would fall back to, so
  // an option the engine dropped shows as the default and not as itself.
  const runner = new RecordingRunner();
  const engine = new CfHarnessEngine({
    runId: "run-threaded-options",
    workspaceHostPath: "/host/project",
    sandboxRuntimeKind: "runsc",
    sandboxRootfs: "/images/kitchensink",
    sandboxRunscNetworkMode: "none",
    sandboxCfcPolicy: "/policy.json",
    sandboxRunscBinary: "/opt/runsc",
    processRunner: runner,
  });
  try {
    const description = engine.sandbox.describe();
    assertEquals(description.cfc?.networkMode, "none");
    // The policy is in effect: the runtime asks runsc for CFC.
    assertEquals(description.cfc?.runtimeRequested, true);

    const config = engine.ownedRunscSandboxConfig;
    assertEquals(config?.networkMode, "none");
    assertEquals(config?.cfcPolicyPath, "/policy.json");
    assertEquals(config?.runscBinary, "/opt/runsc");
    assertEquals(config?.runId, "run-threaded-options");
    assertEquals(config?.runId, engine.getRunState().runId);

    // And what runsc is actually started with.
    await engine.invokeBuiltinTool("bash", { command: "true" });
    const commandLines = runscRunCommandLines(runner);
    assertEquals(commandLines.length > 0, true);
    for (const args of commandLines) {
      assertEquals(args.includes("/opt/runsc"), true, args.join(" "));
      assertEquals(args.includes("--network=none"), true, args.join(" "));
      assertEquals(
        args.slice(
          args.indexOf("--cfc-policy"),
          args.indexOf("--cfc-policy") + 2,
        ),
        ["--cfc-policy", "/policy.json"],
      );
      assertEquals(args.includes("--cfc"), true, args.join(" "));
    }
  } finally {
    await engine.completeRun("assistant_completed");
  }
});

Deno.test("CfHarnessEngine gives two runsc runs two run identities", () => {
  // The run id is what keeps one run's sessions from another's. A runtime
  // built without it draws a random one, which is unique too, so uniqueness
  // alone would not show the engine dropping it: the id has to be the run's.
  const build = (runId: string) =>
    new CfHarnessEngine({
      runId,
      workspaceHostPath: "/host/project",
      sandboxRuntimeKind: "runsc",
      sandboxRunscBinary: "/opt/runsc",
      sandboxRootfs: "/images/kitchensink",
      processRunner: new RecordingRunner(),
    });
  assertEquals(build("run-a").ownedRunscSandboxConfig?.runId, "run-a");
  assertEquals(build("run-b").ownedRunscSandboxConfig?.runId, "run-b");
});

const ONE_PIXEL_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=",
);

Deno.test("CfHarnessEngine resolves a host-backed path through the runsc runtime's mounts", async () => {
  // A host tool reads the file behind a sandbox path, so the engine has to
  // know the mounts of the sandbox that runs. The path is under an
  // ADDITIONAL mount: the workspace alone resolves even when the runsc
  // configuration's mounts are not consulted.
  const workspace = await Deno.makeTempDir({ prefix: "cf-runsc-workspace-" });
  const cabinet = await Deno.makeTempDir({ prefix: "cf-runsc-cabinet-" });
  try {
    await Deno.writeFile(join(cabinet, "pixel.png"), ONE_PIXEL_PNG);
    const engine = new CfHarnessEngine({
      runId: "run-host-mounts",
      workspaceHostPath: workspace,
      sandboxRuntimeKind: "runsc",
      sandboxRunscBinary: "/opt/runsc",
      sandboxRootfs: "/images/kitchensink",
      cfcEnforcementMode: "observe",
      additionalMounts: [{
        kind: "host-bind",
        name: "cabinet",
        hostPath: cabinet,
        sandboxPath: "/file-cabinet",
        readOnly: true,
      }],
      processRunner: new RecordingRunner(),
    });
    try {
      const viewed = await engine.invokeBuiltinTool("view_image", {
        path: "/file-cabinet/pixel.png",
      });
      const output = viewed.output as {
        path?: string;
        bytes?: number;
        mediaType?: string;
        error?: unknown;
      };
      assertEquals(output.error, undefined);
      assertEquals(output.path, "/file-cabinet/pixel.png");
      assertEquals(output.mediaType, "image/png");
      assertEquals(output.bytes, ONE_PIXEL_PNG.length);
    } finally {
      await engine.completeRun("assistant_completed");
    }
  } finally {
    await Deno.remove(workspace, { recursive: true });
    await Deno.remove(cabinet, { recursive: true });
  }
});
