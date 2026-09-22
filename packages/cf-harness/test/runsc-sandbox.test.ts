import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";

import {
  assertRunscSessionAllowedForMode,
  defaultDarwinRootfs,
  resolveRunscSandboxConfig,
  RunscSandboxRuntime,
} from "../src/sandbox/runsc.ts";
import { createHarnessCfcInvocationContext } from "../src/contracts/cfc-invocation-context.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import type {
  ProcessHandle,
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
  ProcessSpawnRequest,
} from "../src/sandbox/process-runner.ts";

/**
 * A runner that answers `runsc` the way runsc answers, without a sandbox:
 * `run` under the sh wrapper writes the result file named in its argv when
 * a result fd was requested, `state` reports running, everything else
 * succeeds. Every request is recorded for the assertions.
 */
class FakeRunscRunner implements ProcessRunner {
  requests: ProcessRunRequest[] = [];
  spawns: ProcessSpawnRequest[] = [];
  killed: string[] = [];
  runResult: Partial<ProcessRunResult> = {};
  resultTaint: unknown = { string: "{conf: ⊤, integ: ∅}", xattrJSON: {} };

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.requests.push(request);
    const argv = request.command === "/bin/sh"
      ? request.args.slice(5)
      : request.args;
    const sub = argv.find((a) =>
      ["run", "exec", "state", "delete", "kill"].includes(a)
    );
    if (request.command === "/bin/sh" && sub === "run") {
      const resultPath = request.args[4];
      const cid = argv[argv.length - 1];
      if (resultPath !== "/dev/null") {
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({
            version: 1,
            containerId: cid,
            sandboxId: cid,
            waitStatus: 0,
            cfcTaint: this.resultTaint,
          }),
        );
      }
      return { stdout: "hello\n", stderr: "", exitCode: 0, ...this.runResult };
    }
    if (sub === "state") {
      return {
        stdout: `{"id": "${argv[argv.length - 1]}", "status": "running"}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    if (sub === "exec") {
      return {
        stdout: "from-session\n",
        stderr: "",
        exitCode: 0,
        ...this.runResult,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  spawn(request: ProcessSpawnRequest): ProcessHandle {
    this.spawns.push(request);
    const cid = request.args[request.args.length - 1];
    let resolve!: (v: { exitCode: number }) => void;
    const exited = new Promise<{ exitCode: number }>((r) => (resolve = r));
    return {
      pid: 4242,
      exited,
      kill: (signal) => {
        this.killed.push(`${cid}:${signal ?? "SIGTERM"}`);
        resolve({ exitCode: 137 });
      },
    };
  }
}

const scratch = () => Deno.makeTempDirSync({ prefix: "runsc-sandbox-test-" });

const config = (
  overrides: Partial<Parameters<typeof resolveRunscSandboxConfig>[0]> = {},
) =>
  resolveRunscSandboxConfig({
    workspaceHostPath: "/tmp/workspace",
    rootfs: "/images/kitchensink",
    scratchDir: scratch(),
    runId: "run-abc",
    cfcPolicyPath: "/policy.json",
    platform: "linux",
    ...overrides,
  });

const context = (
  cfcEnforcementMode: "observe" | "enforce-explicit" = "observe",
) =>
  createHarnessCfcInvocationContext({
    sequence: 1,
    runId: "run-abc",
    createdAt: "2026-09-22T00:00:00.000Z",
    toolId: "bash",
    toolOutputId: createToolOutputId("run-abc", "bash", 1),
    operation: "shell",
    cfcEnforcementMode,
    cwd: "/workspace",
    runManifest: { present: false },
    command: "echo hi",
  });

Deno.test("resolveRunscSandboxConfig defaults to the cfc-vm image on macOS", () => {
  const c = resolveRunscSandboxConfig({
    workspaceHostPath: "/tmp/ws",
    platform: "darwin",
    homeDir: "/Users/someone",
    scratchDir: "/tmp/scratch",
  });
  assertEquals(c.rootfs, defaultDarwinRootfs("/Users/someone"));
  assertEquals(c.networkMode, "none");
  assertEquals(c.runscBinary, "runsc");
  assertEquals(c.cfcPolicyPath, undefined);
});

Deno.test("resolveRunscSandboxConfig refuses a Linux config with no rootfs", () => {
  assertThrows(
    () =>
      resolveRunscSandboxConfig({
        workspaceHostPath: "/tmp/ws",
        platform: "linux",
      }),
    Error,
    "needs a rootfs",
  );
});

Deno.test("RunscSandboxRuntime runs a call as one container with the CFC transport on fds 3 and 4", async () => {
  const runner = new FakeRunscRunner();
  const c = config();
  const runtime = new RunscSandboxRuntime(c, runner);
  const result = await runtime.runShell({
    command: "echo hi",
    cfcInvocationContext: await context(),
  });
  assertEquals(result.stdout, "hello\n");
  assertEquals(result.exitCode, 0);

  const run = runner.requests[0];
  assertEquals(run.command, "/bin/sh");
  assertEquals(run.args[1], 'exec 3<"$1" 4>"$2"; shift 2; exec "$@"');
  assertMatch(run.args[3], /cfc-invocation-context\.json$/);
  assertMatch(run.args[4], /cfc-result\.json$/);
  assertEquals(run.args[5], "runsc");
  const argv = run.args.slice(6);
  const runAt = argv.indexOf("run");
  assert(runAt > 0);
  const globals = argv.slice(0, runAt);
  assert(globals.includes("--cfc"), "policy configured, so --cfc is passed");
  assertEquals(globals[globals.indexOf("--cfc-policy") + 1], "/policy.json");
  assert(globals.includes("--network=none"));
  assert(globals.includes("--overlay2=root:memory"));
  const sub = argv.slice(runAt + 1);
  assertEquals(sub[sub.indexOf("--cfc-invocation-context-fd") + 1], "3");
  assertEquals(sub[sub.indexOf("--cfc-result-fd") + 1], "4");
  const cid = sub[sub.length - 1];
  assertMatch(cid, /^c-run-abc-[0-9a-f]{8}$/);

  // The result on fd 4 became the call's CFC result, keyed by the container id.
  assert(result.cfcResult !== undefined);
  assertEquals(result.cfcResult.stdout.policy, "observed");
  assertEquals(result.cfcResult.diagnostics?.[0]?.details?.containerId, cid);

  // The container is deleted afterwards even on success, and the bundle removed.
  const del = runner.requests[1];
  assertEquals(del.args.slice(-3), ["delete", "--force", cid]);
  await assertRejects(() => Deno.stat(join(c.scratchDir, "bundles", cid)));
});

Deno.test("RunscSandboxRuntime writes a bundle whose spec names the rootfs and every mount", async () => {
  const runner = new FakeRunscRunner();
  let captured: Record<string, unknown> | undefined;
  runner.run = async function (this: FakeRunscRunner, request) {
    if (request.command === "/bin/sh" && captured === undefined) {
      const bundle = request.args[request.args.indexOf("--bundle") + 1];
      captured = JSON.parse(
        await Deno.readTextFile(join(bundle, "config.json")),
      );
    }
    return FakeRunscRunner.prototype.run.call(this, request);
  };
  const c = config({
    additionalMounts: [
      {
        kind: "host-bind",
        name: "cabinet",
        hostPath: "/home/u/cabinet",
        sandboxPath: "/file-cabinet",
        readOnly: true,
      },
      { kind: "fabric-fuse", hostPath: "/mnt/fabric" },
    ],
  });
  const runtime = new RunscSandboxRuntime(c, runner);
  await runtime.run({
    argv: ["/bin/true"],
    cwd: "/workspace/sub",
    env: { FOO: "bar" },
  });
  assert(captured !== undefined);
  const spec = captured as {
    root: { path: string };
    process: { args: string[]; cwd: string; env: string[] };
    mounts: Array<{ destination: string; source: string; options: string[] }>;
  };
  assertEquals(spec.root.path, "/images/kitchensink");
  assertEquals(spec.process.args, ["/bin/true"]);
  assertEquals(spec.process.cwd, "/workspace/sub");
  assert(spec.process.env.includes("FOO=bar"));
  const binds = Object.fromEntries(
    spec.mounts.filter((m) => m.source.startsWith("/")).map((
      m,
    ) => [m.destination, m]),
  );
  assertEquals(binds["/workspace"].source, "/tmp/workspace");
  assert(binds["/workspace"].options.includes("rw"));
  assertEquals(binds["/file-cabinet"].source, "/home/u/cabinet");
  assert(binds["/file-cabinet"].options.includes("ro"));
  assertEquals(binds["/fabric"].source, "/mnt/fabric");
});

Deno.test("RunscSandboxRuntime omits the CFC flags and reports no result without a policy", async () => {
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(
    config({ cfcPolicyPath: undefined }),
    runner,
  );
  const result = await runtime.run({ argv: ["/bin/true"] });
  const argv = runner.requests[0].args;
  assert(!argv.includes("--cfc"));
  assert(!argv.includes("--cfc-result-fd"));
  assertEquals(argv[4], "/dev/null");
  assertEquals(result.cfcResult, undefined);
});

Deno.test("RunscSandboxRuntime denies the call's CFC result when runsc delivered none on fd 4", async () => {
  const runner = new FakeRunscRunner();
  runner.run = function (this: FakeRunscRunner, request) {
    this.requests.push(request);
    // Never writes the result file.
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
  const runtime = new RunscSandboxRuntime(config(), runner);
  const result = await runtime.run({ argv: ["/bin/true"] });
  assertEquals(result.cfcResult?.stdout.policy, "denied");
  assertEquals(
    result.cfcResult?.diagnostics?.[0]?.code,
    "runsc_cfc_result_fd_unreadable",
  );
});

Deno.test("RunscSandboxRuntime keeps one container per session and execs into it", async () => {
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  const first = await runtime.runShell({
    command: "echo one",
    session: "build",
  });
  const second = await runtime.runShell({
    command: "echo two",
    session: "build",
    cwd: "/workspace/x",
  });
  assertEquals(first.stdout, "from-session\n");
  assertEquals(second.stdout, "from-session\n");

  // One long-lived container for the session, started as an attached run.
  assertEquals(runner.spawns.length, 1);
  const spawn = runner.spawns[0];
  assertEquals(spawn.command, "runsc");
  assert(spawn.args.includes("run"));
  assert(!spawn.args.includes("--detach"));
  const cid = spawn.args[spawn.args.length - 1];
  assertEquals(cid, "s-run-abc-build");
  assertEquals(runtime.sessionContainerIds(), [cid]);

  // Both calls were execs into that container, with cwd honoured.
  const execs = runner.requests.filter((r) => r.args.includes("exec"));
  assertEquals(execs.length, 2);
  assert(execs[0].args.includes(cid));
  assertEquals(
    execs[1].args[execs[1].args.indexOf("--cwd") + 1],
    "/workspace/x",
  );
  // No fresh containers were run for session calls.
  assertEquals(
    runner.requests.filter((r) => r.command === "/bin/sh").length,
    0,
  );

  // Closing kills, waits for the child and deletes.
  await runtime.close();
  assertEquals(runner.killed, [`${cid}:SIGTERM`]);
  const tail = runner.requests.slice(-2).map((r) => r.args.slice(-3));
  assertEquals(tail[0], ["kill", cid, "KILL"]);
  assertEquals(tail[1], ["delete", "--force", cid]);
  assertEquals(runtime.sessionContainerIds(), []);
});

Deno.test("RunscSandboxRuntime gives different sessions and different runs different containers", async () => {
  const runner = new FakeRunscRunner();
  const a = new RunscSandboxRuntime(config({ runId: "run-a" }), runner);
  const b = new RunscSandboxRuntime(config({ runId: "run-b" }), runner);
  await a.run({ argv: ["/bin/true"], session: "x" });
  await a.run({ argv: ["/bin/true"], session: "y" });
  await b.run({ argv: ["/bin/true"], session: "x" });
  const ids = runner.spawns.map((s) => s.args[s.args.length - 1]);
  assertEquals(new Set(ids).size, 3);
  assertEquals(ids, ["s-run-a-x", "s-run-a-y", "s-run-b-x"]);
  await a.close();
  await b.close();
});

Deno.test("RunscSandboxRuntime rejects a session name that is not an identifier", async () => {
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "../escape" }),
    Error,
    "invalid sandbox session name",
  );
  assertEquals(runner.spawns.length, 0);
});

Deno.test("assertRunscSessionAllowedForMode refuses sessions under enforcement only", () => {
  assertRunscSessionAllowedForMode("observe", "build");
  assertRunscSessionAllowedForMode("disabled", "build");
  assertRunscSessionAllowedForMode("enforce-explicit", undefined);
  assertThrows(
    () => assertRunscSessionAllowedForMode("enforce-explicit", "build"),
    Error,
    "cannot run in CFC mode enforce-explicit",
  );
});

Deno.test("RunscSandboxRuntime refuses a session call whose invocation context enforces", async () => {
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  const enforcing = await context("enforce-explicit");
  await assertRejects(
    () =>
      runtime.runShell({
        command: "true",
        session: "build",
        cfcInvocationContext: enforcing,
      }),
    Error,
    "cannot run in CFC mode enforce-explicit",
  );
  assertEquals(runner.spawns.length, 0);
});
