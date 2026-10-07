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
  canonicalHostPath,
  darwinCfcVmRootfs,
  defaultDarwinCfcVmStore,
  executableOnPath,
  PASTA_ARGS,
  PASTA_HOSTS_FILE,
  PASTA_ROOT_ARGS,
  resolveRunscSandboxConfig,
  RUNSC_MAX_SESSIONS,
  RunscSandboxRuntime,
  UNSHARE_ARGS,
  verifyPrivateScratchParent,
} from "../src/sandbox/runsc.ts";
import { SandboxPathEscapeError } from "../src/sandbox/errors.ts";
import { ProcessTimeoutError } from "../src/sandbox/process-runner.ts";
import { SandboxSessionUnavailableError } from "../src/sandbox/types.ts";
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
  /** Containers runsc no longer knows: `state` fails for them, as runsc's does. */
  deleted = new Set<string>();
  /** Ends a session's `runsc run` child, as the container exiting would. */
  exits = new Map<string, (code: number) => void>();
  /** When set, an exec throws this instead of returning. */
  execError: Error | undefined;
  /** When false, an exec writes no result file. */
  execWritesResult = true;

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
      if (this.execError !== undefined) throw this.execError;
      const resultPath = request.args[4];
      if (resultPath !== "/dev/null" && this.execWritesResult) {
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
    if (sub === "delete") {
      this.deleted.add(argv[argv.length - 1]);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (sub === "state") {
      const id = argv[argv.length - 1];
      if (this.deleted.has(id)) {
        return { stdout: "", stderr: "does not exist", exitCode: 128 };
      }
      return {
        stdout: `{"id": "${id}", "status": "running"}\n`,
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
    this.exits.set(cid, (code) => resolve({ exitCode: code }));
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

/**
 * The runsc binary these configurations name. Nothing is there: a binary
 * that does not exist is resolved under its nearest existing ancestor, and
 * no runner here executes one.
 */
const RUNSC = "/opt/runsc/bin/runsc";

const config = (
  overrides: Partial<Parameters<typeof resolveRunscSandboxConfig>[0]> = {},
) =>
  resolveRunscSandboxConfig({
    workspaceHostPath: "/tmp/workspace",
    runscBinary: RUNSC,
    rootfs: "/images/kitchensink",
    scratchDir: scratch(),
    runId: "run-abc",
    cfcPolicyPath: "/policy.json",
    platform: "linux",
    ...overrides,
  });

const context = (
  cfcEnforcementMode: "observe" | "enforce-explicit" | "enforce-strict" =
    "observe",
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

Deno.test("resolveRunscSandboxConfig defaults to the cfc-vm image on macOS", async () => {
  // The default binary is a name to find on `PATH`, so the case gives `PATH`
  // one directory holding it.
  const bin = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "runsc-default-binary-" }),
  );
  await Deno.writeTextFile(join(bin, "runsc"), "#!/bin/sh\n");
  await Deno.chmod(join(bin, "runsc"), 0o755);
  const path = Deno.env.get("PATH");
  let c: ReturnType<typeof resolveRunscSandboxConfig>;
  try {
    Deno.env.set("PATH", bin);
    c = resolveRunscSandboxConfig({
      workspaceHostPath: "/tmp/ws",
      platform: "darwin",
      homeDir: "/Users/someone",
      scratchDir: "/tmp/scratch",
    });
  } finally {
    if (path === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", path);
    await Deno.remove(bin, { recursive: true });
  }
  assertEquals(
    c.rootfs,
    darwinCfcVmRootfs(defaultDarwinCfcVmStore("/Users/someone")),
  );
  // The docker runtime defaults to `bridge`; the runsc runtime's default is
  // the runsc spelling of the same posture, so a run that names no network
  // mode gets the same reach on either runtime. `none` here would leave a
  // chat session on runsc without the network the docker session has.
  assertEquals(c.networkMode, "sandbox");
  assertEquals(c.runscBinary, join(bin, "runsc"));
  assertEquals(c.cfcPolicyPath, undefined);
});

Deno.test("resolveRunscSandboxConfig keeps the macOS store out of every writable mount", async () => {
  // The macOS `runsc` runs from the store whatever binary, rootfs and policy
  // are named: its config, VM image and daemon socket are there. So the store
  // is refused inside a writable mount, and a writable mount inside the
  // store, even with all three named elsewhere.
  const base = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "runsc-store-reach-" }),
  );
  const outside = {
    runscBinary: RUNSC,
    rootfs: "/images/kitchensink",
    cfcPolicyPath: "/policy.json",
  };
  const darwin = (
    workspaceHostPath: string,
    cfcVmHome: string,
    additionalMounts: Parameters<
      typeof resolveRunscSandboxConfig
    >[0]["additionalMounts"] = [],
  ) =>
    resolveRunscSandboxConfig({
      ...outside,
      workspaceHostPath,
      additionalMounts,
      platform: "darwin",
      homeDir: "/Users/someone",
      cfcVmHome,
      scratchDir: join(base, "scratch"),
    });
  try {
    const workspace = join(base, "ws");
    const store = join(base, "ws", "cfc-vm");
    await Deno.mkdir(store, { recursive: true });
    assertThrows(
      () => darwin(workspace, store),
      Error,
      `cfc-vm store ${store} lies inside the writable mount ${workspace}`,
    );

    const elsewhere = join(base, "cfc-vm");
    await Deno.mkdir(join(elsewhere, "ext4"), { recursive: true });
    assertThrows(
      () =>
        darwin(join(base, "other"), elsewhere, [{
          kind: "host-bind",
          name: "images",
          hostPath: join(elsewhere, "ext4"),
          sandboxPath: "/images",
          readOnly: false,
        }]),
      Error,
      `writable mount ${
        join(elsewhere, "ext4")
      } lies inside the cfc-vm store ${elsewhere}`,
    );

    // Read only, the sandbox cannot rewrite it either way.
    darwin(join(base, "other"), elsewhere, [{
      kind: "host-bind",
      name: "store",
      hostPath: elsewhere,
      sandboxPath: "/store",
      readOnly: true,
    }]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("resolveRunscSandboxConfig refuses a macOS store that is not an absolute path", () => {
  // The macOS `runsc` resolves `CFC_VM_HOME` against its own working
  // directory, so a relative store names one place here and another there.
  for (const cfcVmHome of ["cfc-vm", "~/cfc-vm", "./cfc-vm"]) {
    for (const rootfs of [undefined, "/images/kitchensink"]) {
      assertThrows(
        () =>
          resolveRunscSandboxConfig({
            workspaceHostPath: "/tmp/ws",
            runscBinary: RUNSC,
            platform: "darwin",
            homeDir: "/Users/someone",
            cfcVmHome,
            rootfs,
            scratchDir: "/tmp/scratch",
          }),
        Error,
        `\`${cfcVmHome}\` is not an absolute path`,
      );
    }
  }
});

Deno.test("resolveRunscSandboxConfig refuses an empty runsc binary, which names none", () => {
  assertThrows(
    () => config({ runscBinary: "" }),
    Error,
    "runsc binary must not be empty: give an absolute path",
  );
});

Deno.test("resolveRunscSandboxConfig refuses a Linux config with no rootfs", () => {
  assertThrows(
    () =>
      resolveRunscSandboxConfig({
        workspaceHostPath: "/tmp/ws",
        runscBinary: RUNSC,
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
  assertEquals(run.args[5], RUNSC);
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
  // With a context in hand, as an observing run has: without a policy runsc
  // runs with no `--cfc`, and a runsc that is not tracking refuses the CFC
  // descriptors outright rather than take a context it would drop.
  const result = await runtime.run({
    argv: ["/bin/true"],
    cfcInvocationContext: await context("observe"),
  });
  const argv = runner.requests[0].args;
  assert(!argv.includes("--cfc"));
  assert(!argv.includes("--cfc-result-fd"));
  assert(!argv.includes("--cfc-invocation-context-fd"));
  assertEquals(argv[3], "/dev/null");
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
  assertEquals(spawn.command, RUNSC);
  assert(spawn.args.includes("run"));
  assert(!spawn.args.includes("--detach"));
  const cid = spawn.args[spawn.args.length - 1];
  // Minted, fixed in width, and without the name: see the prefix test.
  assertMatch(cid, /^s-run-abc-[0-9a-f]{8}-0001$/);
  assertEquals(runtime.sessionContainerIds(), [cid]);
  // The init waits on a stdin pipe the harness holds, so the container ends
  // when the harness does.
  assertEquals(spawn.stdin, "held");

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

  // Closing kills the child, deletes the container and confirms it is gone.
  await runtime.close();
  assertEquals(runner.killed, [`${cid}:SIGKILL`]);
  const control = runner.requests.filter((r) => r.command === RUNSC).map((
    r,
  ) => r.args.slice(-3));
  assert(
    control.some((a) => a.join(" ") === `delete --force ${cid}`),
    "the container is deleted",
  );
  assertEquals(control[control.length - 1].slice(-2), ["state", cid]);
  assert(runner.deleted.has(cid));
  assertEquals(runtime.sessionContainerIds(), []);
  // Every control command is bounded.
  for (const r of runner.requests.filter((r) => r.command === RUNSC)) {
    assert(r.timeoutMs !== undefined, `no timeout on: ${r.args.join(" ")}`);
  }
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
  assertMatch(ids[0], /^s-run-a-[0-9a-f]{8}-0001$/);
  assertMatch(ids[1], /^s-run-a-[0-9a-f]{8}-0002$/);
  assertMatch(ids[2], /^s-run-b-[0-9a-f]{8}-0001$/);
  await a.close();
  await b.close();
});

Deno.test("RunscSandboxRuntime rejects a session name that is not an identifier", async () => {
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  // Each fixture breaks the pattern in one way only: first character, body,
  // end anchor, length, emptiness.
  for (
    const name of [
      "../escape",
      "-lead",
      "a/b",
      "a b",
      "a\nb",
      "ok\n",
      "",
      "x".repeat(33),
    ]
  ) {
    await assertRejects(
      () => runtime.run({ argv: ["/bin/true"], session: name }),
      // Recoverable: a model that mistypes a name must not end the run.
      SandboxSessionUnavailableError,
      "invalid sandbox session name",
    );
  }
  assertEquals(runner.spawns.length, 0);
  assertEquals(runner.requests.length, 0);
  await runtime.run({ argv: ["/bin/true"], session: "x".repeat(32) });
  assertEquals(runner.spawns.length, 1);
  await runtime.close();
});

Deno.test("a session is refused in an enforcing mode, before anything runs", async () => {
  // A session's CFC result is a snapshot at the exec's exit, while output
  // keeps draining and the session's other processes keep running, and
  // calls in one container can read each other's data through metadata:
  // labelled data came back `observed` (review, verified live). Enforcement
  // cannot rest on that result, so an enforcing run gets no session.
  for (const mode of ["enforce-explicit", "enforce-strict"] as const) {
    const runner = new FakeRunscRunner();
    const runtime = new RunscSandboxRuntime(config(), runner);
    await assertRejects(
      async () =>
        await runtime.runShell({
          command: "cat secret",
          session: "build",
          cfcInvocationContext: await context(mode),
        }),
      SandboxSessionUnavailableError,
      `not available under cfc enforcement mode '${mode}'`,
    );
    assertEquals(runner.spawns.length, 0);
    assertEquals(runner.requests.length, 0);
    // The same call without a session runs, in a container of its own.
    const fresh = await runtime.runShell({
      command: "cat secret",
      cfcInvocationContext: await context(mode),
    });
    assertEquals(fresh.cfcResult?.stdout.policy, "observed");
    await runtime.close();
  }
});

Deno.test("an observing session call carries its own CFC context in and result out", async () => {
  const runner = new FakeRunscRunner();
  runner.resultTaint = {
    string: "{conf: User(did:key:alice), integ: ∅}",
    xattrJSON: { confidentiality: [{ subject: "did:key:alice" }] },
  };
  const runtime = new RunscSandboxRuntime(config(), runner);
  const result = await runtime.runShell({
    command: "cat secret",
    session: "build",
    cfcInvocationContext: await context("observe"),
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
    "observe",
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
        runscBinary: RUNSC,
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
        runscBinary: RUNSC,
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
        runscBinary: RUNSC,
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
        runscBinary: RUNSC,
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
    runscBinary: RUNSC,
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
    SandboxSessionUnavailableError,
    "did not start within 60ms",
  );
  assertEquals(runner.killed.length, 1);
  assertMatch(runner.killed[0], /^s-run-abc-[0-9a-f]{8}-0001:SIGKILL$/);
  // What the attempt created is gone, and the failure is not cached: the
  // next call tries again, in a container of its own.
  assertEquals(runtime.sessionContainerIds(), []);
  assert(
    runner.requests.some((r) =>
      r.args.slice(-3).join(" ").startsWith("delete --force s-run-abc-")
    ),
  );
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "slow" }),
    SandboxSessionUnavailableError,
    "did not start within 60ms",
  );
  assertEquals(runner.spawns.length, 2);
  assertMatch(
    runner.spawns[1].args[runner.spawns[1].args.length - 1],
    /-0002$/,
  );
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
    runscBinary: RUNSC,
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
    runscBinary: RUNSC,
    rootfs: "/images/kitchensink",
    runId: `${parent}.subagent.1`,
    platform: "linux",
  });
  const two = resolveRunscSandboxConfig({
    workspaceHostPath: "/tmp/workspace",
    runscBinary: RUNSC,
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
          runscBinary: RUNSC,
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
          runscBinary: RUNSC,
          rootfs: "/images/kitchensink",
          runId: "run-link",
          platform: "linux",
          scratchDir: join(base, "workspace", "scratch"),
        }),
      Error,
      "inside",
    );
    assertEquals(
      canonicalHostPath("path", join(base, "alias", "not", "yet")),
      join(await Deno.realPath(join(base, "workspace")), "not", "yet"),
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Adversarial review, 2026-09-28. Each test names the defect it was found by.
// ---------------------------------------------------------------------------

Deno.test("no session container id is a prefix of another, whatever the names", async () => {
  // runsc resolves abbreviated ids. With the name in the id, a first call
  // to `build` ran inside `build2`'s container and read its files, and `a`
  // became ambiguous for the rest of the run once `ab` existed.
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  for (const name of ["build2", "build", "a", "ab", "A"]) {
    await runtime.run({ argv: ["/bin/true"], session: name });
  }
  const ids = runtime.sessionContainerIds();
  assertEquals(new Set(ids).size, 5);
  for (const a of ids) {
    for (const b of ids) {
      assert(a === b || !b.startsWith(a), `${a} is a prefix of ${b}`);
    }
    // No name in the id, so names differing only in case cannot meet in one
    // bundle directory on a case-insensitive volume either.
    assertMatch(a, /^s-run-abc-[0-9a-f]{8}-\d{4}$/);
  }
  // Each call went to its own session's container.
  assertEquals(runner.execIds, ids);
  await runtime.close();
});

Deno.test("a run holds a bounded number of sessions", async () => {
  // Every session is a long-lived container in memory the whole machine
  // shares. The refusal is one the model can act on.
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  for (let i = 0; i < RUNSC_MAX_SESSIONS; i += 1) {
    await runtime.run({ argv: ["/bin/true"], session: `s${i}` });
  }
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "one-too-many" }),
    SandboxSessionUnavailableError,
    `already holds ${RUNSC_MAX_SESSIONS} sandbox sessions`,
  );
  assertEquals(runner.spawns.length, RUNSC_MAX_SESSIONS);
  // An existing session is still usable at the bound.
  await runtime.run({ argv: ["/bin/true"], session: "s0" });
  await runtime.close();
});

Deno.test("a session whose container died is reported lost once, then starts empty", async () => {
  // `kill -9 1` inside a session used to leave the name unusable for the
  // rest of the run, each call failing as if the command had.
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  await runtime.run({ argv: ["/bin/true"], session: "build" });
  const [first] = runtime.sessionContainerIds();
  runner.exits.get(first)!(137);
  await new Promise((r) => setTimeout(r, 0));
  const execsBefore = runner.execIds.length;
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "build" }),
    SandboxSessionUnavailableError,
    'session "build" ended',
  );
  // Nothing was executed in the dead container, and it was cleaned up.
  assertEquals(runner.execIds.length, execsBefore);
  assert(runner.deleted.has(first));
  assertEquals(runtime.sessionContainerIds(), []);
  // Named again, it is a new, empty session under a new id.
  await runtime.run({ argv: ["/bin/true"], session: "build" });
  const [second] = runtime.sessionContainerIds();
  assert(second !== first);
  assertEquals(runner.execIds[runner.execIds.length - 1], second);
  await runtime.close();
});

Deno.test("a session start that fails at once does not wait out the start timeout", async () => {
  // With a bad rootfs a fresh call failed in 73 ms while a session waited
  // its whole 30 s budget.
  const runner = new FakeRunscRunner();
  const base = FakeRunscRunner.prototype.spawn;
  runner.spawn = function (this: FakeRunscRunner, request) {
    const handle = base.call(this, request);
    this.exits.get(request.args[request.args.length - 1])!(128);
    return handle;
  };
  const baseRun = FakeRunscRunner.prototype.run;
  runner.run = function (this: FakeRunscRunner, request) {
    if (request.args.includes("state")) {
      this.requests.push(request);
      return Promise.resolve({ stdout: "", stderr: "gone", exitCode: 128 });
    }
    return baseRun.call(this, request);
  };
  const runtime = new RunscSandboxRuntime(
    config({ sessionStartTimeoutMs: 20_000 }),
    runner,
  );
  const started = Date.now();
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "bad" }),
    SandboxSessionUnavailableError,
    "exited with code 128 before it was running",
  );
  assert(Date.now() - started < 5_000, "waited for the timeout");
  await runtime.close();
});

Deno.test("a session call that times out takes the session down with it", async () => {
  // The timeout stopped the host side of the exec only: `ps` in the next
  // call showed the command still running, with the workspace and network.
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  await runtime.run({ argv: ["/bin/true"], session: "build" });
  const [cid] = runtime.sessionContainerIds();
  runner.execError = new ProcessTimeoutError("runsc exec", 1500);
  await assertRejects(
    () =>
      runtime.run({ argv: ["sleep", "99"], session: "build", timeoutMs: 1500 }),
    ProcessTimeoutError,
  );
  assert(runner.killed.includes(`${cid}:SIGKILL`));
  assert(runner.deleted.has(cid));
  assertEquals(runtime.sessionContainerIds(), []);
  // The model is told, once, that what it left in the session is gone.
  runner.execError = undefined;
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "build" }),
    SandboxSessionUnavailableError,
    "a command in it timed out",
  );
  await runtime.run({ argv: ["/bin/true"], session: "build" });
  assert(runtime.sessionContainerIds()[0] !== cid);
  await runtime.close();
});

Deno.test("a session call's missing CFC result is denied, as a fresh call's is", async () => {
  const runner = new FakeRunscRunner();
  runner.execWritesResult = false;
  const runtime = new RunscSandboxRuntime(config(), runner);
  const result = await runtime.run({ argv: ["/bin/true"], session: "s" });
  assertEquals(result.cfcResult?.stdout.policy, "denied");
  assertEquals(
    result.cfcResult?.diagnostics?.[0]?.code,
    "runsc_cfc_result_fd_unreadable",
  );
  await runtime.close();
});

Deno.test("a session call without a policy asks for no result and reports none", async () => {
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(
    config({ cfcPolicyPath: undefined }),
    runner,
  );
  const result = await runtime.run({
    argv: ["/bin/true"],
    session: "s",
    cfcInvocationContext: await context("observe"),
  });
  const exec = runner.requests.find((r) =>
    r.command === "/bin/sh" && r.args.includes("exec")
  )!;
  assert(!exec.args.includes("--cfc-result-fd"));
  assert(!exec.args.includes("--cfc-invocation-context-fd"));
  assertEquals(exec.args[3], "/dev/null");
  assertEquals(exec.args[4], "/dev/null");
  assertEquals(result.cfcResult, undefined);
  await runtime.close();
});

Deno.test("a fresh call hands runsc its context as a file and no context flag without one", async () => {
  const runner = new FakeRunscRunner();
  const seen: string[] = [];
  const base = FakeRunscRunner.prototype.run;
  runner.run = async function (this: FakeRunscRunner, request) {
    if (request.command === "/bin/sh" && request.args[3] !== "/dev/null") {
      seen.push(await Deno.readTextFile(request.args[3]));
    }
    return await base.call(this, request);
  };
  const runtime = new RunscSandboxRuntime(config(), runner);
  await runtime.run({
    argv: ["/bin/true"],
    cfcInvocationContext: await context("enforce-strict"),
  });
  assertEquals(seen.length, 1);
  assertEquals(JSON.parse(seen[0]).cfcEnforcementMode, "enforce-strict");
  await runtime.run({ argv: ["/bin/true"] });
  const bare = runner.requests.filter((r) => r.command === "/bin/sh")[1];
  assert(!bare.args.includes("--cfc-invocation-context-fd"));
  assertEquals(bare.args[3], "/dev/null");
});

Deno.test("an enforcing call is refused by a runtime that has no policy, engine or no engine", async () => {
  // The engine refuses such a run at its start, but a runtime constructed
  // or injected directly ran an enforce-strict call with its labels dropped
  // and no result; the docker runtime refuses per call.
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(
    config({ cfcPolicyPath: undefined }),
    runner,
  );
  for (const session of [undefined, "build"]) {
    const result = await runtime.run({
      argv: ["/bin/true"],
      cfcInvocationContext: await context("enforce-strict"),
      ...(session !== undefined ? { session } : {}),
    });
    assertEquals(result.exitCode, 125);
    assertMatch(result.stderr, /has no CFC policy/);
    assertEquals(result.cfcResult, undefined);
  }
  assertEquals(runner.requests.length, 0);
  assertEquals(runner.spawns.length, 0);
  // Observing calls are untouched.
  const observed = await runtime.run({
    argv: ["/bin/true"],
    cfcInvocationContext: await context("observe"),
  });
  assertEquals(observed.exitCode, 0);
});

Deno.test("the floor holds for every enforcing mode", () => {
  for (const mode of ["enforce-explicit", "enforce-strict"] as const) {
    assertThrows(
      () => assertRunscCfcPolicyForMode(mode, { cfcPolicyPath: undefined }),
      Error,
      "requires the runsc sandbox to run with a CFC policy",
    );
  }
});

Deno.test("what decides the sandbox's labels and contents is refused inside a writable mount", async () => {
  // A policy in the workspace was rewritten from inside one container, and
  // the next container read a labelled file as public.
  // By its real path, which is how an accepted path is returned.
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "runsc-trusted-" }),
  );
  try {
    const workspace = join(root, "ws");
    const readonlyDir = join(root, "ro");
    const writableDir = join(root, "rw");
    for (const d of [workspace, readonlyDir, writableDir]) await Deno.mkdir(d);
    const base = {
      workspaceHostPath: workspace,
      runscBinary: RUNSC,
      rootfs: "/images/kitchensink",
      scratchDir: scratch(),
      platform: "linux" as const,
      additionalMounts: [
        {
          kind: "host-bind" as const,
          name: "ro",
          hostPath: readonlyDir,
          sandboxPath: "/ro",
          readOnly: true,
        },
        {
          kind: "host-bind" as const,
          name: "rw",
          hostPath: writableDir,
          sandboxPath: "/rw",
          readOnly: false,
        },
      ],
    };
    for (const dir of [workspace, writableDir]) {
      assertThrows(
        () =>
          resolveRunscSandboxConfig({
            ...base,
            cfcPolicyPath: join(dir, "policy.json"),
          }),
        Error,
        "CFC policy",
      );
      assertThrows(
        () => resolveRunscSandboxConfig({ ...base, rootfs: join(dir, "img") }),
        Error,
        "sandbox rootfs",
      );
      assertThrows(
        () =>
          resolveRunscSandboxConfig({
            ...base,
            runscBinary: join(dir, "runsc"),
          }),
        Error,
        "runsc binary",
      );
    }
    // Through a symlink as well: compared by real path.
    await Deno.symlink(workspace, join(root, "link"));
    assertThrows(
      () =>
        resolveRunscSandboxConfig({
          ...base,
          cfcPolicyPath: join(root, "link", "policy.json"),
        }),
      Error,
      "lies inside the writable mount",
    );
    // A read-only mount cannot rewrite it.
    const ok = resolveRunscSandboxConfig({
      ...base,
      cfcPolicyPath: join(readonlyDir, "policy.json"),
    });
    assertEquals(ok.cfcPolicyPath, join(readonlyDir, "policy.json"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the scratch check covers the mount root itself and, on macOS, its other spellings", async () => {
  const root = await Deno.makeTempDir({ prefix: "runsc-scratch-case-" });
  try {
    // Neither directory exists yet, so nothing on disk resolves their case.
    const workspace = join(root, "Work", "Sub");
    const base = {
      workspaceHostPath: workspace,
      runscBinary: RUNSC,
      rootfs: "/images/k",
    };
    assertThrows(
      () =>
        resolveRunscSandboxConfig({
          ...base,
          platform: "linux",
          scratchDir: workspace,
        }),
      Error,
      "lies inside the mount",
    );
    // On a case-insensitive volume this is the workspace's child once both
    // are created.
    const other = join(root, "Work", "SUB", "scratch");
    assertThrows(
      () =>
        resolveRunscSandboxConfig({
          ...base,
          platform: "darwin",
          scratchDir: other,
        }),
      Error,
      "lies inside the mount",
    );
    // On Linux those are different directories.
    resolveRunscSandboxConfig({
      ...base,
      platform: "linux",
      scratchDir: other,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mount, root and user validation matches what the docker runtime refuses", () => {
  const bind = (sandboxPath: string, name = "b") => ({
    kind: "host-bind" as const,
    name,
    hostPath: "/host/" + name,
    sandboxPath,
  });
  // Two mounts at the very same path: the later shadows the earlier.
  assertThrows(
    () => config({ additionalMounts: [bind("/workspace")] }),
    Error,
    "sandbox roots overlap",
  );
  assertThrows(
    () => config({ additionalMounts: [bind("/x", "a"), bind("/x", "b")] }),
    Error,
    "sandbox roots overlap",
  );
  // A root at `/` contains every path.
  assertThrows(
    () => config({ workspaceMountPath: "/" }),
    Error,
    "must not be the sandbox root",
  );
  assertThrows(
    () => config({ additionalMounts: [bind("/")] }),
    Error,
    "must not be the sandbox root",
  );
  // A user name would reach the spec as NaN and run as root.
  for (const user of ["nobody", "nobody:nogroup", "", "1e3:0x10", "1000:"]) {
    assertThrows(
      () => config({ containerUser: user }),
      Error,
      "container user must be numeric",
    );
  }
  assertEquals(config({ containerUser: "1000:100" }).containerUser, "1000:100");
  // Defaults: a host bind is read-only unless it says otherwise; the fabric
  // mount defaults as it does under docker.
  const c = config({
    additionalMounts: [
      bind("/data"),
      { kind: "fabric-fuse", hostPath: "/host/fabric" },
    ],
  });
  assertEquals(c.additionalMounts.map((m) => m.readOnly), [true, false]);
  // Frozen down to each mount.
  assertThrows(() => {
    (c.additionalMounts[0] as { hostPath: string }).hostPath = "/elsewhere";
  }, TypeError);
});

Deno.test("the spec isolates every namespace and bounds the tmpfs it gives the call", async () => {
  const runner = new FakeRunscRunner();
  let specText = "";
  const base = FakeRunscRunner.prototype.run;
  runner.run = async function (this: FakeRunscRunner, request) {
    if (request.command === "/bin/sh" && request.args.includes("run")) {
      const bundle = request.args[request.args.indexOf("--bundle") + 1];
      specText = await Deno.readTextFile(join(bundle, "config.json"));
    }
    return await base.call(this, request);
  };
  const runtime = new RunscSandboxRuntime(config(), runner);
  await runtime.run({ argv: ["/bin/true"] });
  const spec = JSON.parse(specText);
  assertEquals(
    spec.linux.namespaces.map((n: { type: string }) => n.type).sort(),
    ["ipc", "mount", "network", "pid", "uts"],
  );
  const tmp = spec.mounts.find((m: { destination: string }) =>
    m.destination === "/tmp"
  );
  assert(tmp.options.some((o: string) => /^size=\d+[km]$/.test(o)));
});

Deno.test("the spec gives a container on the host's network no network namespace of its own", async () => {
  // With one, runsc makes it empty and the container has its loopback alone,
  // whatever `--network=host` asked for.
  const specs: string[] = [];
  const runner = new FakeRunscRunner();
  const base = FakeRunscRunner.prototype.run;
  runner.run = async function (this: FakeRunscRunner, request) {
    if (request.command === "/bin/sh" && request.args.includes("run")) {
      const bundle = request.args[request.args.indexOf("--bundle") + 1];
      specs.push(await Deno.readTextFile(join(bundle, "config.json")));
    }
    return await base.call(this, request);
  };
  for (const networkMode of ["host", "none", "sandbox"] as const) {
    await new RunscSandboxRuntime(config({ networkMode }), runner).run({
      argv: ["/bin/true"],
    });
  }
  assertEquals(
    specs.map((text) =>
      JSON.parse(text).linux.namespaces.map((n: { type: string }) => n.type)
        .includes("network")
    ),
    [false, true, true],
  );
});

Deno.test("a rootless runtime runs every runsc command, control commands included, with `--rootless`", async () => {
  for (const rootless of [true, false]) {
    const runner = new FakeRunscRunner();
    const runtime = new RunscSandboxRuntime(config({ rootless }), runner);
    await runtime.runShell({ command: "echo hi" });

    // The call itself, run through the shell that opens its descriptors, and
    // the control commands that take its container down after it.
    const runscArgs = runner.requests.map((request) =>
      request.command === "/bin/sh" ? request.args.slice(6) : request.args
    );
    assert(runscArgs.length > 1, "the call and the control commands after it");
    assertEquals(
      runscArgs.map((args) => args.includes("--rootless")),
      runscArgs.map(() => rootless),
    );
  }
});

/** The `pasta` the pasta cases configure. Nothing is there, as for RUNSC. */
const PASTA = "/opt/passt/bin/pasta";

/** The `unshare` root's pasta runs under in those cases; nothing is there. */
const UNSHARE = "/opt/util-linux/bin/unshare";

/**
 * A runner that hands the fake what a command run under pasta runs, and
 * keeps every command it was given as it was given, with the spec of each
 * container started.
 */
class UnderPasta implements ProcessRunner {
  readonly fake = new FakeRunscRunner();
  readonly given: { command: string; args: string[] }[] = [];
  readonly specs: string[] = [];

  async #unwrap<T extends { command: string; args: string[] }>(
    request: T,
  ): Promise<T> {
    this.given.push({ command: request.command, args: [...request.args] });
    if (request.command !== PASTA && request.command !== UNSHARE) {
      return request;
    }
    const [command, ...args] = this.#underPasta(request.command, request.args);
    const bundle = args[args.indexOf("--bundle") + 1];
    this.specs.push(await Deno.readTextFile(join(bundle, "config.json")));
    return { ...request, command, args };
  }

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    return await this.fake.run(await this.#unwrap(request));
  }

  spawn(request: ProcessSpawnRequest): ProcessHandle {
    this.given.push({ command: request.command, args: [...request.args] });
    const [command, ...args] = this.#underPasta(request.command, request.args);
    return this.fake.spawn({ ...request, command, args });
  }

  /**
   * Checks what pasta is given, run as `command`, which is pasta itself or
   * the `unshare` root's pasta runs under, and returns the command pasta
   * runs.
   */
  #underPasta(command: string, given: readonly string[]): string[] {
    const throughUnshare = command === UNSHARE;
    this.unshared.push(throughUnshare);
    if (throughUnshare) {
      assertEquals(given.slice(0, UNSHARE_ARGS.length + 2), [
        ...UNSHARE_ARGS,
        "--",
        PASTA,
      ]);
    } else {
      assertEquals(command, PASTA);
    }
    const args = throughUnshare ? given.slice(UNSHARE_ARGS.length + 2) : given;
    const end = args.indexOf("--");
    const own = args.slice(0, end);
    assertEquals(own.slice(0, PASTA_ARGS.length), [...PASTA_ARGS]);
    const rest = own.slice(PASTA_ARGS.length);
    const log = rest.indexOf("--log-file");
    assertMatch(rest[log + 1], /\/pasta\.log$/);
    this.pastaFlags.push(rest.filter((_, i) => i !== log && i !== log + 1));
    return args.slice(end + 1);
  }

  /** What pasta was given beyond its own arguments and its log file. */
  readonly pastaFlags: string[][] = [];

  /** Whether each command pasta ran ran under `unshare`. */
  readonly unshared: boolean[] = [];
}

Deno.test("under pasta, a call starts its container in pasta's namespace, on that namespace as runsc's host network, with a hosts file naming the host", async () => {
  const runner = new UnderPasta();
  const c = config({ networkHelper: PASTA, unshare: UNSHARE });
  const runtime = new RunscSandboxRuntime(c, runner);

  const result = await runtime.runShell({ command: "echo hi" });

  assertEquals(result.exitCode, 0);
  const [call, ...control] = runner.given;
  assertEquals(call.command, UNSHARE);
  assert(call.args.includes("--network=host"));
  assert(!call.args.includes("--network=sandbox"));
  // Only what starts a container runs under pasta.
  assert(control.length > 0);
  assertEquals(
    control.map((request) => request.command),
    control.map(() => RUNSC),
  );
  const spec = JSON.parse(runner.specs[0]);
  assertEquals(
    spec.linux.namespaces.map((n: { type: string }) => n.type).sort(),
    ["ipc", "mount", "pid", "uts"],
  );
  const hosts = spec.mounts.find((m: { destination: string }) =>
    m.destination === "/etc/hosts"
  );
  assertEquals(hosts, {
    destination: "/etc/hosts",
    type: "bind",
    source: join(c.scratchDir, "hosts"),
    options: ["rbind", "ro"],
  });
  assertEquals(await Deno.readTextFile(hosts.source), PASTA_HOSTS_FILE);
  assertMatch(PASTA_HOSTS_FILE, /^10\.0\.2\.2\thost\.docker\.internal$/m);
});

Deno.test("under pasta, root keeps root in a network namespace alone and a mount namespace of unshare's, and a user that is not root gets pasta's user namespace", async () => {
  for (const rootless of [false, true]) {
    const runner = new UnderPasta();
    await new RunscSandboxRuntime(
      config({ networkHelper: PASTA, unshare: UNSHARE, rootless }),
      runner,
    ).runShell({ command: "echo hi" });

    assertEquals(runner.pastaFlags, [rootless ? [] : [...PASTA_ROOT_ARGS]]);
    assertEquals(runner.unshared, [!rootless]);
  }
});

Deno.test("under pasta as root, a call is refused, starting nothing, where no unshare was given", async () => {
  const runner = new UnderPasta();
  const runtime = new RunscSandboxRuntime(
    config({ networkHelper: PASTA }),
    runner,
  );

  await assertRejects(
    () => runtime.runShell({ command: "echo hi" }),
    Error,
    "which no `unshare` was given to make",
  );
  assertEquals(
    runner.given.filter((request) => request.args.includes("run")),
    [],
  );
});

Deno.test("under pasta, no session is offered, and one asked for is refused, starting nothing", async () => {
  const runner = new UnderPasta();
  const runtime = new RunscSandboxRuntime(
    config({ networkHelper: PASTA, rootless: true }),
    runner,
  );

  assertEquals(runtime.describe().sessions, false);
  const refusal = await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "build" }),
    SandboxSessionUnavailableError,
    "not offered under pasta's network",
  );
  assertEquals(refusal.reason, "start-failed");
  assertEquals(runner.given, []);
  // Every other network mode keeps them.
  assertEquals(
    new RunscSandboxRuntime(
      config({ networkHelper: PASTA, networkMode: "none" }),
      runner,
    ).describe().sessions,
    true,
  );
});

Deno.test("a network other than runsc's own takes no pasta, whatever is configured", async () => {
  for (const networkMode of ["none", "host"] as const) {
    const runner = new UnderPasta();
    await new RunscSandboxRuntime(
      config({ networkHelper: PASTA, networkMode }),
      runner,
    ).runShell({ command: "echo hi" });

    assertEquals(runner.given[0].command, "/bin/sh");
    assert(runner.given[0].args.includes(`--network=${networkMode}`));
  }
});

Deno.test("executableOnPath finds an executable file in the first entry holding one, and nothing elsewhere", async () => {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "runsc-path-" }),
  );
  try {
    for (const entry of ["a", "b", "c"]) await Deno.mkdir(join(dir, entry));
    // Not executable in the first entry, so passed over, as running it would.
    await Deno.writeTextFile(join(dir, "a", "pasta"), "");
    await Deno.writeTextFile(join(dir, "b", "pasta"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    await Deno.writeTextFile(join(dir, "c", "pasta"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    const path = ["a", "b", "c"].map((entry) => join(dir, entry)).join(":");

    assertEquals(executableOnPath("pasta", path), join(dir, "b", "pasta"));
    assertEquals(executableOnPath("slirp4netns", path), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a working directory outside the mounts is refused for fresh and session calls", async () => {
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  for (const session of [undefined, "build"]) {
    await assertRejects(
      () =>
        runtime.run({
          argv: ["/bin/true"],
          cwd: "/etc",
          ...(session !== undefined ? { session } : {}),
        }),
      SandboxPathEscapeError,
    );
  }
  assertEquals(runner.requests.length, 0);
  assertEquals(runner.spawns.length, 0);
  await runtime.close();
});

Deno.test("a run that throws still has its container deleted", async () => {
  const cfg = config();
  const runner = new ThrowingRunscRunner();
  const runtime = new RunscSandboxRuntime(cfg, runner);
  await assertRejects(() => runtime.run({ argv: ["true"] }), Error, "exploded");
  assert(
    runner.requests.some((r) =>
      r.args.slice(-3).join(" ").startsWith("delete --force c-run-abc-")
    ),
    "no delete --force after the throw",
  );
});

Deno.test("close takes down a fresh call that is still in flight", async () => {
  // A call racing the close, or one whose run was interrupted, kept running
  // and writing to the workspace after close() had returned.
  const runner = new FakeRunscRunner();
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const base = FakeRunscRunner.prototype.run;
  runner.run = async function (this: FakeRunscRunner, request) {
    if (request.command === "/bin/sh" && request.args.includes("run")) {
      this.requests.push(request);
      started();
      await blocked;
      return { stdout: "", stderr: "", exitCode: 137 };
    }
    return await base.call(this, request);
  };
  const cfg = config();
  const runtime = new RunscSandboxRuntime(cfg, runner);
  const call = runtime.run({ argv: ["sleep", "99"] });
  await running;
  const cid = runner.requests[0].args[runner.requests[0].args.length - 1];
  await runtime.close();
  assert(runner.deleted.has(cid), "the in-flight container was not deleted");
  await assertRejects(() => Deno.stat(join(cfg.scratchDir, "bundles", cid)));
  release();
  await call;
});

Deno.test("the default scratch parent must be this user's private directory", async () => {
  // With TMPDIR unset the parent is a fixed name under /tmp: whoever owns it
  // can swap a bundle or a result under the run.
  const root = await Deno.makeTempDir({ prefix: "runsc-parent-" });
  try {
    const fresh = join(root, "fresh", "cf-harness-runsc");
    await verifyPrivateScratchParent(fresh);
    assertEquals((await Deno.lstat(fresh)).mode! & 0o777, 0o700);
    // Verified again, it is accepted as it is.
    await verifyPrivateScratchParent(fresh);

    const open = join(root, "open");
    await Deno.mkdir(open, { mode: 0o755 });
    await Deno.chmod(open, 0o755);
    await assertRejects(
      () => verifyPrivateScratchParent(open),
      Error,
      "not a private directory of this user",
    );

    const target = join(root, "target");
    await Deno.mkdir(target, { mode: 0o700 });
    const link = join(root, "link");
    await Deno.symlink(target, link);
    await assertRejects(
      () => verifyPrivateScratchParent(link),
      Error,
      "not a private directory of this user",
    );

    const file = join(root, "file");
    await Deno.writeTextFile(file, "");
    await assertRejects(() => verifyPrivateScratchParent(file));

    // Private in its mode, and someone else's: the mode says who may enter,
    // not whose it is, and its owner can open it to anyone afterwards.
    const mine = (await Deno.lstat(fresh)).uid!;
    await verifyPrivateScratchParent(fresh, () => Promise.resolve(mine));
    await assertRejects(
      () =>
        verifyPrivateScratchParent(
          fresh,
          (path) => Promise.resolve(path === fresh ? mine + 1 : mine),
        ),
      Error,
      "not a private directory of this user",
    );
    // Whose it is cannot be told: that is not a reason to take it.
    await assertRejects(
      () =>
        verifyPrivateScratchParent(
          fresh,
          () => Promise.reject(new Error("cannot tell whose this is")),
        ),
      Error,
      "cannot tell whose this is",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
  // Only the default is verified: an explicit scratch is the caller's.
  assertEquals(config().scratchParentToVerify, undefined);
  const byDefault = resolveRunscSandboxConfig({
    workspaceHostPath: "/tmp/workspace",
    runscBinary: RUNSC,
    rootfs: "/images/kitchensink",
    platform: "linux",
  });
  assertMatch(byDefault.scratchParentToVerify!, /\/cf-harness-runsc$/);
  assert(byDefault.scratchDir.startsWith(byDefault.scratchParentToVerify!));
});

Deno.test("a call that finds its session's container gone says so, rather than failing as a command", async () => {
  // Seen live: after `kill -9 1` in a session, the next call reached runsc
  // before the session's child had been reaped, and came back as exit 128
  // with runsc's own error, as if the model's command had failed.
  const runner = new FakeRunscRunner();
  const runtime = new RunscSandboxRuntime(config(), runner);
  await runtime.run({ argv: ["/bin/true"], session: "k" });
  const [cid] = runtime.sessionContainerIds();
  // The container is gone but its child has not been reaped yet.
  runner.deleted.add(cid);
  runner.runResult = {
    stdout: "",
    stderr: "loading container: file does not exist",
    exitCode: 128,
  };
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "k" }),
    SandboxSessionUnavailableError,
    'session "k" ended',
  );
  assertEquals(runtime.sessionContainerIds(), []);
  // Told once: the next call starts an empty session.
  runner.runResult = {};
  await runtime.run({ argv: ["/bin/true"], session: "k" });
  assert(runtime.sessionContainerIds()[0] !== cid);

  // A command that took the container down itself keeps its own result,
  // and the loss is reported on the next call.
  const [second] = runtime.sessionContainerIds();
  runner.deleted.add(second);
  runner.runResult = { stdout: "", stderr: "", exitCode: 137 };
  const killed = await runtime.run({ argv: ["kill", "-9", "1"], session: "k" });
  assertEquals(killed.exitCode, 137);
  runner.runResult = {};
  await assertRejects(
    () => runtime.run({ argv: ["/bin/true"], session: "k" }),
    SandboxSessionUnavailableError,
    "its container exited",
  );
  // An ordinary failing command leaves a live session alone.
  await runtime.run({ argv: ["/bin/true"], session: "k" });
  const [third] = runtime.sessionContainerIds();
  runner.runResult = { stdout: "", stderr: "nope", exitCode: 1 };
  assertEquals(
    (await runtime.run({ argv: ["false"], session: "k" })).exitCode,
    1,
  );
  assertEquals(runtime.sessionContainerIds(), [third]);
  await runtime.close();
});
