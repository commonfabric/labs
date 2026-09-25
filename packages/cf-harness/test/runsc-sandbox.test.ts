import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";

import {
  assertRunscCfcPolicyForMode,
  defaultDarwinRootfs,
  realPathOfNearestExisting,
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
  execIds: string[] = [];
  execContexts: string[] = [];
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
    if (request.command === "/bin/sh" && sub === "exec") {
      // The session call: flags, then the container id, then the command.
      const flagsWithValue = new Set([
        "--cwd",
        "--env",
        "--user",
        "--cfc-invocation-context-fd",
        "--cfc-result-fd",
      ]);
      let i = argv.indexOf("exec") + 1;
      while (i < argv.length && argv[i].startsWith("--")) {
        i += flagsWithValue.has(argv[i]) ? 2 : 1;
      }
      const cid = argv[i];
      this.execIds.push(cid);
      const contextPath = request.args[3];
      if (contextPath !== "/dev/null") {
        this.execContexts.push(await Deno.readTextFile(contextPath));
      }
      const resultPath = request.args[4];
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
      return {
        stdout: "from-session\n",
        stderr: "",
        exitCode: 0,
        ...this.runResult,
      };
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
  // The docker runtime defaults to `bridge`; the runsc runtime's default is
  // the runsc spelling of the same posture, so a run that names no network
  // mode gets the same reach on either runtime. `none` here would leave a
  // chat session on runsc without the network the docker session has.
  assertEquals(c.networkMode, "sandbox");
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
  assert(globals.includes("--network=sandbox"), "the default network mode");
  assert(globals.includes("--overlay2=root:memory"));
  const sub = argv.slice(runAt + 1);
  assertEquals(sub[sub.indexOf("--cfc-invocation-context-fd") + 1], "3");
  assertEquals(sub[sub.indexOf("--cfc-result-fd") + 1], "4");
  const cid = sub[sub.length - 1];
  // run tag (12 chars of the run id + a per-runtime nonce), then the call.
  assertMatch(cid, /^c-run-abc-[0-9a-f]{8}-[0-9a-f]{8}$/);

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
  assertMatch(cid, /^s-run-abc-[0-9a-f]{8}-build$/);
  assertEquals(runtime.sessionContainerIds(), [cid]);

  // Both calls were execs into that container, with cwd honoured, through
  // the same fd wrapper a fresh call uses: the policy is set, so each exec
  // asked for its result on fd 4 and got one keyed to the container.
  const execs = runner.requests.filter((r) =>
    r.command === "/bin/sh" && r.args.includes("exec")
  );
  assertEquals(execs.length, 2);
  assertEquals(runner.execIds, [cid, cid]);
  assertEquals(
    execs[1].args[execs[1].args.indexOf("--cwd") + 1],
    "/workspace/x",
  );
  assertEquals(
    execs[0].args[execs[0].args.indexOf("--cfc-result-fd") + 1],
    "4",
  );
  assert(!execs[0].args.includes("--cfc-invocation-context-fd"));
  assertEquals(first.cfcResult?.stdout.policy, "observed");
  // No fresh containers were run for session calls.
  assertEquals(
    runner.requests.filter((r) =>
      r.command === "/bin/sh" && r.args.slice(5).includes("run")
    ).length,
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
  assertMatch(ids[0], /^s-run-a-[0-9a-f]{8}-x$/);
  assertMatch(ids[1], /^s-run-a-[0-9a-f]{8}-y$/);
  assertMatch(ids[2], /^s-run-b-[0-9a-f]{8}-x$/);
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

Deno.test("a session call carries its own CFC context in and result out, enforcing modes included", async () => {
  const runner = new FakeRunscRunner();
  runner.resultTaint = {
    string: "{conf: User(did:key:alice), integ: ∅}",
    xattrJSON: { confidentiality: [{ subject: "did:key:alice" }] },
  };
  const runtime = new RunscSandboxRuntime(config(), runner);
  const enforcing = await context("enforce-explicit");
  const result = await runtime.runShell({
    command: "cat secret",
    session: "build",
    cfcInvocationContext: enforcing,
  });
  const exec = runner.requests.find((r) =>
    r.command === "/bin/sh" && r.args.includes("exec")
  );
  assert(exec !== undefined);
  assertEquals(
    exec.args[exec.args.indexOf("--cfc-invocation-context-fd") + 1],
    "3",
  );
  assertEquals(exec.args[exec.args.indexOf("--cfc-result-fd") + 1], "4");
  // The context reached the exec as a file on fd 3, verbatim.
  assertEquals(runner.execContexts.length, 1);
  assertEquals(
    JSON.parse(runner.execContexts[0]).cfcEnforcementMode,
    "enforce-explicit",
  );
  // And the exec's own result decided the verdict: confidential, so opaque.
  assertEquals(result.cfcResult?.stdout.policy, "opaque");
  assertEquals(result.cfcResult?.stdout.label, {
    confidentiality: [{ subject: "did:key:alice" }],
  });
  // The session container itself was started with no context: nothing seeds
  // the container's own labels, each call brings its own.
  assert(!runner.spawns[0].args.includes("--cfc-invocation-context-fd"));
  await runtime.close();
  // The per-call files went with the call.
  let calls: string[] = [];
  try {
    for await (
      const e of Deno.readDir(join(runtime.config.scratchDir, "calls"))
    ) calls.push(e.name);
  } catch {
    calls = [];
  }
  assertEquals(calls, []);
});

Deno.test("resolveRunscSandboxConfig refuses relative paths, empty bind names and overlapping roots", () => {
  assertThrows(
    () =>
      resolveRunscSandboxConfig({
        workspaceHostPath: "relative/ws",
        rootfs: "/r",
        platform: "linux",
      }),
    Error,
    "workspace host path must be an absolute host path",
  );
  assertThrows(
    () =>
      resolveRunscSandboxConfig({
        workspaceHostPath: "/ws",
        rootfs: "/r",
        workspaceMountPath: "workspace",
        platform: "linux",
      }),
    Error,
    "workspace mount path must be an absolute sandbox path",
  );
  assertThrows(
    () =>
      resolveRunscSandboxConfig({
        workspaceHostPath: "/ws",
        rootfs: "/r",
        platform: "linux",
        additionalMounts: [{
          kind: "host-bind",
          name: " ",
          hostPath: "/h",
          sandboxPath: "/x",
        }],
      }),
    Error,
    "host bind mount name must be non-empty",
  );
  assertThrows(
    () =>
      resolveRunscSandboxConfig({
        workspaceHostPath: "/ws",
        rootfs: "/r",
        platform: "linux",
        additionalMounts: [{
          kind: "host-bind",
          name: "inner",
          hostPath: "/h",
          sandboxPath: "/workspace/inner",
        }],
      }),
    Error,
    "sandbox roots overlap",
  );
  const c = resolveRunscSandboxConfig({
    workspaceHostPath: "/ws",
    rootfs: "/r",
    platform: "linux",
    containerUser: "1000:1000",
    sessionStartTimeoutMs: 5,
  });
  assertEquals(c.containerUser, "1000:1000");
  assertEquals(c.sessionStartTimeoutMs, 5);
});

Deno.test("RunscSandboxRuntime describes itself with its mounts and session support", () => {
  const runtime = new RunscSandboxRuntime(
    config({
      additionalMounts: [
        {
          kind: "host-bind",
          name: "cabinet",
          hostPath: "/home/u/cabinet",
          sandboxPath: "/file-cabinet",
          readOnly: false,
        },
        { kind: "fabric-fuse", hostPath: "/mnt/fabric" },
      ],
    }),
    new FakeRunscRunner(),
  );
  const d = runtime.describe();
  assertEquals(d.kind, "runsc-cfc");
  assertEquals(d.sessions, true);
  assertEquals(d.defaultWorkingDirectory, "/workspace");
  assertEquals(d.cfc?.runtimeRequested, true);
  assertEquals(d.cfc?.invocationContextTransport, "fd");
  // The audit record names the network mode, as the Docker record does.
  assertEquals(d.cfc?.networkMode, "sandbox");
  const mounts = d.cfc?.mounts ?? [];
  assertEquals(mounts.map((m) => m.sandboxPath), [
    "/workspace",
    "/file-cabinet",
    "/fabric",
  ]);
  assertEquals(mounts[1].mode, "writable");
  assertEquals(mounts[1].name, "cabinet");
  assertEquals(mounts[2].kind, "fabric-fuse");
});

Deno.test("RunscSandboxRuntime resolves paths inside its roots and refuses escapes", () => {
  const runtime = new RunscSandboxRuntime(
    config({
      additionalMounts: [{
        kind: "host-bind",
        name: "cabinet",
        hostPath: "/h",
        sandboxPath: "/file-cabinet",
      }],
    }),
    new FakeRunscRunner(),
  );
  assertEquals(runtime.resolvePath("notes.md"), "/workspace/notes.md");
  assertEquals(runtime.resolvePath("../b", "/workspace/a"), "/workspace/b");
  assertEquals(runtime.resolvePath("/file-cabinet/x"), "/file-cabinet/x");
  assert(runtime.isPathWithinWorkspace("/workspace/x"));
  assert(!runtime.isPathWithinWorkspace("/file-cabinet/x"));
  assert(runtime.isPathWithinAllowedRoots("/file-cabinet/x"));
  assertThrows(
    () => runtime.resolvePath("/etc/passwd"),
    Error,
    "escapes allowed sandbox roots",
  );
  assertThrows(
    () => runtime.resolvePath("../../etc", "/workspace"),
    Error,
    "escapes",
  );
});

Deno.test("RunscSandboxRuntime passes env and user to a session exec and to the spec", async () => {
  const runner = new FakeRunscRunner();
  let spec: { process: { user: { uid: number; gid: number } } } | undefined;
  runner.spawn = function (this: FakeRunscRunner, request) {
    const bundle = request.args[request.args.indexOf("--bundle") + 1];
    spec = JSON.parse(Deno.readTextFileSync(join(bundle, "config.json")));
    return FakeRunscRunner.prototype.spawn.call(this, request);
  };
  const runtime = new RunscSandboxRuntime(
    config({ containerUser: "1000:2000" }),
    runner,
  );
  await runtime.run({
    argv: ["/bin/true"],
    session: "s",
    env: { B: "2", A: "1" },
  });
  const exec = runner.requests.find((r) => r.args.includes("exec"))!;
  const i = exec.args.indexOf("--env");
  assertEquals(exec.args.slice(i, i + 4), ["--env", "A=1", "--env", "B=2"]);
  assertEquals(exec.args[exec.args.indexOf("--user") + 1], "1000:2000");
  assertEquals(spec?.process.user, { uid: 1000, gid: 2000 });
  await runtime.close();
});

Deno.test("RunscSandboxRuntime gives up on a session whose container never reports running", async () => {
  const runner = new FakeRunscRunner();
  const base = FakeRunscRunner.prototype.run;
  runner.run = function (this: FakeRunscRunner, request) {
    if (request.args.includes("state")) {
      this.requests.push(request);
      return Promise.resolve({
        stdout: '{"status": "created"}',
        stderr: "",
        exitCode: 0,
      });
    }
    return base.call(this, request);
  };
  const runtime = new RunscSandboxRuntime(
    config({ sessionStartTimeoutMs: 60 }),
    runner,
  );
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "slow" }),
    Error,
    "did not start within 60ms",
  );
  assertEquals(runner.killed.length, 1);
  assertMatch(runner.killed[0], /^s-run-abc-[0-9a-f]{8}-slow:SIGKILL$/);
  await runtime.close();
});

Deno.test("RunscSandboxRuntime needs a runner that can spawn for sessions, and refuses new sessions once closed", async () => {
  const noSpawn: ProcessRunner = { run: (r) => new FakeRunscRunner().run(r) };
  const runtime = new RunscSandboxRuntime(config(), noSpawn);
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "s" }),
    Error,
    "cannot keep a session alive",
  );
  await runtime.close();
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "t" }),
    Error,
    "sandbox runtime is closed",
  );
  const runner = new FakeRunscRunner();
  const open = new RunscSandboxRuntime(
    config({ cfcPolicyPath: undefined }),
    runner,
  );
  await open.close();
  // Closed means closed for fresh calls too: an engine that ended its run
  // must not be able to start more work through a runtime it released.
  await assertRejects(
    () => open.run({ argv: ["/bin/true"] }),
    Error,
    "sandbox runtime is closed",
  );
});

class ThrowingRunscRunner extends FakeRunscRunner {
  override run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const sub = request.command === "/bin/sh"
      ? request.args.slice(5).find((a) =>
        ["run", "exec", "state", "delete", "kill"].includes(a)
      )
      : undefined;
    if (request.command === "/bin/sh") {
      this.requests.push(request);
      return Promise.reject(new Error(`runsc ${sub ?? "run"} exploded`));
    }
    return super.run(request);
  }
}

Deno.test("RunscSandboxRuntime removes the bundle when the run itself throws", async () => {
  const cfg = config();
  const runtime = new RunscSandboxRuntime(cfg, new ThrowingRunscRunner());
  await assertRejects(
    async () =>
      await runtime.run({
        argv: ["true"],
        cfcInvocationContext: await context(),
      }),
    Error,
    "exploded",
  );
  const bundles = join(cfg.scratchDir, "bundles");
  const left: string[] = [];
  try {
    for await (const entry of Deno.readDir(bundles)) left.push(entry.name);
  } catch {
    // no bundles directory at all is the cleanest outcome
  }
  assertEquals(left, []);
});

Deno.test("an enforcing mode requires the runsc runtime to run with a CFC policy", () => {
  assertThrows(
    () =>
      assertRunscCfcPolicyForMode("enforce-explicit", {
        cfcPolicyPath: undefined,
      }),
    Error,
    "requires the runsc sandbox to run with a CFC policy",
  );
  assertRunscCfcPolicyForMode("observe", { cfcPolicyPath: undefined });
  assertRunscCfcPolicyForMode("enforce-explicit", {
    cfcPolicyPath: "/policy.json",
  });
});

Deno.test("a resolved runsc configuration is frozen, mounts included", () => {
  const cfg = config();
  assertThrows(() => {
    (cfg.additionalMounts as unknown as unknown[]).push({});
  }, TypeError);
  assertThrows(() => {
    (cfg as unknown as { rootfs: string }).rootfs = "/elsewhere";
  }, TypeError);
});

Deno.test("the scratch directory defaults outside every sandbox mount and refuses to sit inside one", () => {
  // The result and context files live in scratch; a sandbox that can reach
  // them can forge its own CFC result (review, verified live).
  const cfg = resolveRunscSandboxConfig({
    workspaceHostPath: "/tmp/workspace",
    rootfs: "/images/kitchensink",
    runId: "run-abc",
    platform: "linux",
    additionalMounts: [{
      kind: "host-bind",
      name: "cabinet",
      hostPath: "/tmp/cabinet",
      sandboxPath: "/file-cabinet",
      readOnly: false,
    }],
  });
  for (const root of ["/tmp/workspace", "/tmp/cabinet"]) {
    assert(
      cfg.scratchDir !== root && !cfg.scratchDir.startsWith(root + "/"),
      `scratch ${cfg.scratchDir} inside ${root}`,
    );
  }
  assertThrows(
    () => config({ scratchDir: "/tmp/workspace/.cf-harness-runsc" }),
    Error,
    "inside",
  );
  assertThrows(
    () =>
      config({
        scratchDir: "/tmp/cabinet/scratch",
        additionalMounts: [{
          kind: "host-bind",
          name: "cabinet",
          hostPath: "/tmp/cabinet",
          sandboxPath: "/file-cabinet",
          readOnly: true,
        }],
      }),
    Error,
    "inside",
  );
});

Deno.test("two runs with a shared id prefix never share a session container", async () => {
  const a = new FakeRunscRunner();
  const b = new FakeRunscRunner();
  const first = new RunscSandboxRuntime(
    config({ runId: "same-prefix-AAAA-first", scratchDir: scratch() }),
    a,
  );
  const second = new RunscSandboxRuntime(
    config({ runId: "same-prefix-BBBB-second", scratchDir: scratch() }),
    b,
  );
  await first.run({ argv: ["true"], session: "same" });
  await second.run({ argv: ["true"], session: "same" });
  const idOf = (r: FakeRunscRunner) => {
    const spawn = r.spawns[0];
    return spawn.args[spawn.args.length - 1];
  };
  assert(
    idOf(a) !== idOf(b),
    `both runs resolved session "same" to ${idOf(a)}`,
  );
  await first.close();
  await second.close();
});

Deno.test("a closed runtime refuses fresh calls as well as sessions", async () => {
  const runtime = new RunscSandboxRuntime(config(), new FakeRunscRunner());
  await runtime.close();
  await assertRejects(
    () => runtime.run({ argv: ["true"] }),
    Error,
    "sandbox runtime is closed",
  );
});

Deno.test("sibling subagent runs never share a scratch directory", () => {
  // `<uuid>.subagent.1` and `<uuid>.subagent.2` agree on their first 40
  // characters, which is all the sanitizer keeps.
  const parent = "0f9b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
  const one = resolveRunscSandboxConfig({
    workspaceHostPath: "/tmp/workspace",
    rootfs: "/images/kitchensink",
    runId: `${parent}.subagent.1`,
    platform: "linux",
  });
  const two = resolveRunscSandboxConfig({
    workspaceHostPath: "/tmp/workspace",
    rootfs: "/images/kitchensink",
    runId: `${parent}.subagent.2`,
    platform: "linux",
  });
  assert(one.scratchDir !== two.scratchDir, one.scratchDir);
});

Deno.test("the scratch containment check sees through symlinks", async () => {
  const base = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(base, "workspace"));
    await Deno.symlink(join(base, "workspace"), join(base, "alias"));
    // Spelled outside the workspace, really inside it.
    assertThrows(
      () =>
        resolveRunscSandboxConfig({
          workspaceHostPath: join(base, "workspace"),
          rootfs: "/images/kitchensink",
          runId: "run-link",
          platform: "linux",
          scratchDir: join(base, "alias", "scratch"),
        }),
      Error,
      "inside",
    );
    // And the reverse: the mount spelled through the alias.
    assertThrows(
      () =>
        resolveRunscSandboxConfig({
          workspaceHostPath: join(base, "alias"),
          rootfs: "/images/kitchensink",
          runId: "run-link",
          platform: "linux",
          scratchDir: join(base, "workspace", "scratch"),
        }),
      Error,
      "inside",
    );
    assertEquals(
      realPathOfNearestExisting(join(base, "alias", "not", "yet")),
      join(await Deno.realPath(join(base, "workspace")), "not", "yet"),
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
