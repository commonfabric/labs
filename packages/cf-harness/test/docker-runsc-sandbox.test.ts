import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  assertDockerRunscCfcTransportForMode,
  cfcTransportReadinessFromDockerRuntimes,
  DEFAULT_DOCKER_RUNSC_IMAGE,
  DockerRunscSandboxRuntime,
  registeredCfcSidecarHostDirs,
  resolveDefaultContainerUser,
  resolveDockerRunscSandboxConfig,
} from "../src/sandbox/docker-runsc.ts";
import { createHarnessCfcInvocationContext } from "../src/contracts/cfc-invocation-context.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";
import type { DockerRunscAdditionalMountConfig } from "../src/sandbox/types.ts";

class FakeProcessRunner implements ProcessRunner {
  requests: ProcessRunRequest[] = [];

  readonly #results: ProcessRunResult[];

  constructor(results: ProcessRunResult[]) {
    this.#results = results;
  }

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.requests.push(request);
    const result = this.#results.shift();
    if (result === undefined) {
      throw new Error(`unexpected process request: ${request.command}`);
    }
    return Promise.resolve(result);
  }
}

const dockerLifecycleResults = (
  options: {
    containerId?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  } = {},
): ProcessRunResult[] => [
  {
    stdout: `${options.containerId ?? "container-123"}\n`,
    stderr: "",
    exitCode: 0,
  },
  {
    stdout: options.stdout ?? "hello\n",
    stderr: options.stderr ?? "",
    exitCode: options.exitCode ?? 0,
  },
  {
    stdout: `${options.exitCode ?? 0}\n`,
    stderr: "",
    exitCode: 0,
  },
  {
    stdout: "",
    stderr: "",
    exitCode: 0,
  },
];

Deno.test("resolveDockerRunscSandboxConfig fills the expected defaults", () => {
  const config = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/project",
  });
  assertEquals(config.dockerBinary, "docker");
  assertEquals(config.runtimeName, "runsc-cfc");
  assertEquals(
    config.image,
    "us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest",
  );
  assertEquals(config.workspaceMountPath, "/workspace");
  assertEquals(config.shellPath, "/bin/sh");
  assertEquals(config.dockerNetworkMode, "bridge");
  assertEquals(config.additionalMounts, []);
  assertEquals(config.extraDockerArgs, []);
  assertEquals(config.cfcResultDir, undefined);
  assertEquals(config.cfcInvocationContextDir, undefined);
});

Deno.test("resolveDefaultContainerUser omits default --user on macOS", () => {
  assertEquals(resolveDefaultContainerUser("darwin"), undefined);
});

Deno.test("resolveDefaultContainerUser keeps host UID/GID default on Linux", () => {
  if (Deno.build.os === "windows") {
    return;
  }

  assertMatch(resolveDefaultContainerUser("linux") ?? "", /^\d+:\d+$/);
});

Deno.test("resolveDockerRunscSandboxConfig accepts explicit docker network mode", () => {
  const config = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/project",
    dockerNetworkMode: "bridge",
  });

  assertEquals(config.dockerNetworkMode, "bridge");
});

Deno.test("DockerRunscSandboxRuntime builds a docker create/start/wait/rm invocation", async () => {
  const runner = new FakeProcessRunner(dockerLifecycleResults());
  const config = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/project",
    image: "sandbox:latest",
  });
  const runtime = new DockerRunscSandboxRuntime(
    config,
    runner,
  );

  const result = await runtime.run({
    argv: ["/bin/echo", "hello"],
    cwd: "subdir",
    stdinText: "ignored",
    timeoutMs: 500,
  });

  assertEquals(result.stdout, "hello\n");
  assertEquals(result.exitCode, 0);
  assertEquals(runner.requests.length, 4);
  assertEquals(runner.requests[0], {
    command: "docker",
    args: [
      "create",
      "-i",
      "--runtime",
      "runsc-cfc",
      "--network",
      "bridge",
      ...(config.containerUser !== undefined
        ? ["--user", config.containerUser]
        : []),
      "--mount",
      "type=bind,src=/host/project,dst=/workspace",
      "-w",
      "/workspace/subdir",
      "sandbox:latest",
      "/bin/echo",
      "hello",
    ],
  });
  assertEquals(runner.requests[1], {
    command: "docker",
    args: [
      "start",
      "--attach",
      "--interactive",
      "container-123",
    ],
    stdinText: "ignored",
    timeoutMs: 500,
  });
  assertEquals(runner.requests[2], {
    command: "docker",
    args: ["wait", "container-123"],
  });
  assertEquals(runner.requests[3], {
    command: "docker",
    args: ["rm", "-f", "container-123"],
  });
});

Deno.test("DockerRunscSandboxRuntime describe preserves custom CFC runtime aliases", () => {
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      runtimeName: "corp-runsc-prod",
      image: "sandbox:deno2",
    }),
  );
  const description = runtime.describe();
  if (description.cfc === undefined) {
    throw new Error("expected CFC sandbox description");
  }

  assertEquals(description.cfc.runtimeRequested, true);
  assertEquals(description.cfc.runtimeName, "corp-runsc-prod");
  assertEquals(description.cfc.image, "sandbox:deno2");
});

//
// The description is persisted into the CFC policy snapshot that the ops
// dashboard reads, so the wording of these two tags is part of that output.
//

Deno.test("DockerRunscSandboxRuntime describe reports an unprobed sidecar transport as unverified", () => {
  const description = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      cfcInvocationContextDir: "/tmp/cfc-invocations",
    }),
  ).describe();

  assertEquals(description.kind, "docker-runsc-cfc");
  // The transport tag records where the harness writes. On its own it says
  // nothing about whether the runtime reads there, and a snapshot carrying it
  // alone reads as a working transport, so the readiness of that directory is
  // reported beside it and starts out unread rather than assumed.
  assertEquals(description.cfc?.invocationContextTransport, "sidecar");
  assertEquals(
    description.cfc?.invocationContextTransportReadiness,
    "unverified",
  );
});

Deno.test("DockerRunscSandboxRuntime describe omits the transport when no invocation context dir is configured", () => {
  const description = new DockerRunscSandboxRuntime({
    // Written out rather than resolved, so that a host with the invocation
    // context environment variable set still exercises the absent case.
    ...resolveDockerRunscSandboxConfig({ workspaceHostPath: "/host/project" }),
    cfcInvocationContextDir: undefined,
  }).describe();

  assertEquals(description.cfc?.invocationContextTransport, undefined);
});

Deno.test("resolveDockerRunscSandboxConfig normalizes a Fabric FUSE mount", () => {
  const config = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/project",
    additionalMounts: [{
      kind: "fabric-fuse",
      hostPath: "/tmp/cf-fuse",
    }],
  });

  assertEquals(config.additionalMounts, [{
    kind: "fabric-fuse",
    hostPath: "/tmp/cf-fuse",
    sandboxPath: "/fabric",
    readOnly: true,
  }]);
});

Deno.test("resolveDockerRunscSandboxConfig rejects writable Fabric FUSE mounts", () => {
  const writableFabricMount = {
    kind: "fabric-fuse",
    hostPath: "/tmp/cf-fuse",
    readOnly: false,
  } as unknown as DockerRunscAdditionalMountConfig;

  assertThrows(
    () =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        additionalMounts: [writableFabricMount],
      }),
    Error,
    "fabric-fuse mounts must be read-only",
  );
});

Deno.test("resolveDockerRunscSandboxConfig normalizes host bind mounts", () => {
  const config = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/project",
    additionalMounts: [{
      kind: "host-bind",
      name: "file-cabinet",
      hostPath: "/host/File Cabinet",
      sandboxPath: "/file-cabinet/",
    }],
  });

  assertEquals(config.additionalMounts, [{
    kind: "host-bind",
    name: "file-cabinet",
    hostPath: "/host/File Cabinet",
    sandboxPath: "/file-cabinet",
    readOnly: true,
  }]);
});

Deno.test("resolveDockerRunscSandboxConfig rejects empty host bind names", () => {
  assertThrows(
    () =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        additionalMounts: [{
          kind: "host-bind",
          name: "",
          hostPath: "/host/data",
          sandboxPath: "/data",
        }],
      }),
    Error,
    "host-bind name must not be empty",
  );
});

Deno.test("resolveDockerRunscSandboxConfig rejects overlapping sandbox roots", () => {
  assertThrows(
    () =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        additionalMounts: [{
          kind: "fabric-fuse",
          hostPath: "/tmp/cf-fuse",
          sandboxPath: "/workspace/fabric",
        }],
      }),
    Error,
    "sandbox mount paths overlap",
  );
});

Deno.test("resolveDockerRunscSandboxConfig resolves invocation context sidecar transport", () => {
  const config = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/project",
    cfcInvocationContextDir: "/tmp/cfc-invocations",
  });

  assertEquals(config.cfcInvocationContextDir, "/tmp/cfc-invocations");
});

Deno.test("resolveDockerRunscSandboxConfig rejects relative invocation context sidecar dirs", () => {
  assertThrows(
    () =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir: "relative/cfc-invocations",
      }),
    Error,
    "cfcInvocationContextDir must be an absolute host path",
  );
});

Deno.test("DockerRunscSandboxRuntime runShell honors an explicit container user override", async () => {
  const runner = new FakeProcessRunner(dockerLifecycleResults({ stdout: "" }));
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      containerUser: "1234:2345",
    }),
    runner,
  );

  await runtime.runShell({
    command: "pwd",
    cwd: "/workspace/demo",
    args: ["arg-1", "arg-2"],
  });

  assertEquals(runner.requests[0], {
    command: "docker",
    args: [
      "create",
      "--runtime",
      "runsc-cfc",
      "--network",
      "bridge",
      "--user",
      "1234:2345",
      "--mount",
      "type=bind,src=/host/project,dst=/workspace",
      "-w",
      "/workspace/demo",
      DEFAULT_DOCKER_RUNSC_IMAGE,
      "/bin/sh",
      "-lc",
      "pwd",
      "/bin/sh",
      "arg-1",
      "arg-2",
    ],
  });
});

Deno.test("DockerRunscSandboxRuntime writes invocation context sidecars before start", async () => {
  const cfcInvocationContextDir = await Deno.makeTempDir();
  try {
    const cfcInvocationContext = await createHarnessCfcInvocationContext({
      sequence: 1,
      runId: "run-1",
      createdAt: "2026-04-30T00:00:00.000Z",
      toolId: "bash",
      toolOutputId: createToolOutputId("run-1", "bash", 1),
      operation: "shell",
      cfcEnforcementMode: "observe",
      cwd: "/workspace",
      promptSlot: {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "cf-harness.test-input", surface: "cli" },
        role: "direct-command",
        kernelName: "cli",
        surface: "cli",
      },
      runManifest: { present: false },
      command: "echo hello",
      cfcInputLabels: {
        version: 1,
        entries: [
          {
            path: ["argv"],
            label: {
              confidentiality: [
                { type: "test.cfc/User", subject: "did:key:argv-reader" },
              ],
            },
          },
        ],
      },
    });
    const runner = new FakeProcessRunner(dockerLifecycleResults());
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir,
      }),
      runner,
    );

    await runtime.run({
      argv: ["/bin/echo", "hello"],
      cfcInvocationContext,
    });

    assertEquals(
      JSON.parse(
        await Deno.readTextFile(
          `${cfcInvocationContextDir}/container-123.json`,
        ),
      ),
      cfcInvocationContext,
    );
    assertEquals(runner.requests[1]?.args, [
      "start",
      "--attach",
      "container-123",
    ]);
  } finally {
    await Deno.remove(cfcInvocationContextDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime reports sidecar write failures before start", async () => {
  const cfcInvocationContextDir = await Deno.makeTempDir();
  try {
    const cfcInvocationContext = await createHarnessCfcInvocationContext({
      sequence: 1,
      runId: "run-1",
      createdAt: "2026-04-30T00:00:00.000Z",
      toolId: "bash",
      operation: "shell",
      cfcEnforcementMode: "observe",
      cwd: "/workspace",
      runManifest: { present: false },
      command: "echo hello",
    });
    const runner = new FakeProcessRunner([
      {
        stdout: "../container\n",
        stderr: "",
        exitCode: 0,
      },
      {
        stdout: "",
        stderr: "",
        exitCode: 0,
      },
    ]);
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir,
      }),
      runner,
    );

    const result = await runtime.run({
      argv: ["/bin/echo", "hello"],
      cfcInvocationContext,
    });

    assertEquals(result.exitCode, 125);
    assertMatch(
      result.stderr,
      /failed to write CFC invocation context sidecar/,
    );
    assertEquals(runner.requests.map((request) => request.args[0]), [
      "create",
      "rm",
    ]);
  } finally {
    await Deno.remove(cfcInvocationContextDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime attaches observed CFC sidecar output", async () => {
  const cfcResultDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${cfcResultDir}/container-123.json`,
      JSON.stringify({
        version: 1,
        containerId: "container-123",
        sandboxId: "sandbox-123",
        waitStatus: 0,
        cfcTaint: {
          string: "{conf: public, integ: empty}",
          xattrJSON: {},
        },
      }),
    );
    const runner = new FakeProcessRunner(
      dockerLifecycleResults({ stdout: "public\n", stderr: "note\n" }),
    );
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcResultDir,
      }),
      runner,
    );

    const result = await runtime.run({ argv: ["/bin/echo", "public"] });

    assertEquals(result.stdout, "public\n");
    if (result.cfcResult === undefined) {
      throw new Error("missing cfcResult");
    }
    if (result.cfcResult.stdout.policy !== "observed") {
      throw new Error("expected observed stdout");
    }
    assertEquals(result.cfcResult.stdout.segments[0].text, "public\n");
    if (result.cfcResult.stderr.policy !== "observed") {
      throw new Error("expected observed stderr");
    }
    assertEquals(result.cfcResult.stderr.segments[0].text, "note\n");
    assertEquals(result.cfcResult.exitCode, {
      policy: "observed",
      label: {},
      value: 0,
    });
  } finally {
    await Deno.remove(cfcResultDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime leaves output unmediated when CFC sidecar is missing", async () => {
  const cfcResultDir = await Deno.makeTempDir();
  try {
    const runner = new FakeProcessRunner(
      dockerLifecycleResults({ stdout: "raw without sidecar\n" }),
    );
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcResultDir,
      }),
      runner,
    );

    const result = await runtime.run({ argv: ["/bin/echo", "public"] });

    assertEquals(result, {
      stdout: "raw without sidecar\n",
      stderr: "",
      exitCode: 0,
    });
  } finally {
    await Deno.remove(cfcResultDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime makes tainted sidecar output opaque", async () => {
  const cfcResultDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${cfcResultDir}/container-123.json`,
      JSON.stringify({
        version: 1,
        containerId: "container-123",
        waitStatus: 0,
        cfcTaint: {
          string: "{conf: alice, integ: empty}",
          xattrJSON: { confidentiality: ["did:key:alice"] },
        },
      }),
    );
    const runner = new FakeProcessRunner(
      dockerLifecycleResults({ stdout: "secret\n", exitCode: 3 }),
    );
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcResultDir,
      }),
      runner,
    );

    const result = await runtime.run({ argv: ["/bin/cat", "secret.txt"] });

    assertEquals(result.stdout, "secret\n");
    assertEquals(result.exitCode, 3);
    if (result.cfcResult === undefined) {
      throw new Error("missing cfcResult");
    }
    assertEquals(result.cfcResult.stdout, {
      channel: "stdout",
      policy: "opaque",
      label: { confidentiality: ["did:key:alice"] },
      byteLength: 7,
    });
    assertEquals(result.cfcResult.exitCode, {
      policy: "opaque",
      label: { confidentiality: ["did:key:alice"] },
    });
  } finally {
    await Deno.remove(cfcResultDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime resolvePath rejects paths outside the workspace", () => {
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
    }),
  );

  assertThrows(
    () => runtime.resolvePath("../../escape", "/workspace/demo"),
    Error,
    "path escapes workspace root",
  );
});

Deno.test("DockerRunscSandboxRuntime accepts workspace paths when the mount path has a trailing slash", () => {
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      workspaceMountPath: "/workspace/",
    }),
  );

  assertEquals(runtime.defaultWorkingDirectory(), "/workspace");
  assertEquals(
    runtime.resolvePath("notes/todo.txt"),
    "/workspace/notes/todo.txt",
  );
  assertEquals(
    runtime.isPathWithinWorkspace("/workspace/notes/todo.txt"),
    true,
  );
});

Deno.test("DockerRunscSandboxRuntime mounts Fabric separately and accepts Fabric paths", async () => {
  const runner = new FakeProcessRunner(dockerLifecycleResults({ stdout: "" }));
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      image: "sandbox:latest",
      additionalMounts: [{
        kind: "fabric-fuse",
        hostPath: "/tmp/cf-fuse",
      }],
    }),
    runner,
  );

  assertEquals(
    runtime.resolvePath("/fabric/home/pieces"),
    "/fabric/home/pieces",
  );
  assertEquals(runtime.isPathWithinWorkspace("/fabric/home"), false);
  assertEquals(runtime.isPathWithinAllowedRoots("/fabric/home"), true);

  const description = runtime.describe();
  assertEquals(description.cfc?.mounts, [
    {
      kind: "workspace",
      hostPath: "/host/project",
      sandboxPath: "/workspace",
      readOnly: false,
    },
    {
      kind: "fabric-fuse",
      hostPath: "/tmp/cf-fuse",
      sandboxPath: "/fabric",
      readOnly: true,
    },
  ]);

  await runtime.run({
    argv: ["/bin/pwd"],
    cwd: "/fabric/home",
  });

  assertEquals(runner.requests[0]?.args, [
    "create",
    "--runtime",
    "runsc-cfc",
    "--network",
    "bridge",
    ...(runtime.config.containerUser !== undefined
      ? ["--user", runtime.config.containerUser]
      : []),
    "--mount",
    "type=bind,src=/host/project,dst=/workspace",
    "--mount",
    "type=bind,src=/tmp/cf-fuse,dst=/fabric,readonly",
    "-w",
    "/fabric/home",
    "sandbox:latest",
    "/bin/pwd",
  ]);
});

Deno.test("DockerRunscSandboxRuntime mounts host bind roots with read/write modes", async () => {
  const runner = new FakeProcessRunner(dockerLifecycleResults({ stdout: "" }));
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      image: "sandbox:latest",
      additionalMounts: [{
        kind: "host-bind",
        name: "file-cabinet",
        hostPath: "/host/File Cabinet",
        sandboxPath: "/file-cabinet",
        readOnly: false,
      }],
    }),
    runner,
  );

  assertEquals(runtime.isPathWithinWorkspace("/file-cabinet/Inbox"), false);
  assertEquals(runtime.isPathWithinAllowedRoots("/file-cabinet/Inbox"), true);
  assertEquals(runtime.describe().cfc?.mounts?.[1], {
    kind: "host-bind",
    name: "file-cabinet",
    hostPath: "/host/File Cabinet",
    sandboxPath: "/file-cabinet",
    readOnly: false,
    mode: "writable",
  });

  await runtime.run({
    argv: ["/bin/pwd"],
    cwd: "/file-cabinet",
  });

  assertEquals(runner.requests[0]?.args, [
    "create",
    "--runtime",
    "runsc-cfc",
    "--network",
    "bridge",
    ...(runtime.config.containerUser !== undefined
      ? ["--user", runtime.config.containerUser]
      : []),
    "--mount",
    "type=bind,src=/host/project,dst=/workspace",
    "--mount",
    "type=bind,src=/host/File Cabinet,dst=/file-cabinet",
    "-w",
    "/file-cabinet",
    "sandbox:latest",
    "/bin/pwd",
  ]);
});

Deno.test("assertDockerRunscCfcTransportForMode allows non-enforce modes without transports", () => {
  assertDockerRunscCfcTransportForMode("disabled", {});
  assertDockerRunscCfcTransportForMode("observe", {});
});

Deno.test("assertDockerRunscCfcTransportForMode rejects enforce modes without transports", () => {
  for (const mode of ["enforce-explicit", "enforce-strict"] as const) {
    assertThrows(
      () => assertDockerRunscCfcTransportForMode(mode, {}),
      Error,
      "invocation-context transport",
    );
    assertThrows(
      () =>
        assertDockerRunscCfcTransportForMode(mode, {
          cfcInvocationContextDir: "/host/ctx",
        }),
      Error,
      "result transport",
    );
    assertThrows(
      () =>
        assertDockerRunscCfcTransportForMode(mode, {
          cfcResultDir: "/host/results",
        }),
      Error,
      "invocation-context transport",
    );
  }
});

Deno.test("assertDockerRunscCfcTransportForMode allows enforce modes with both transports", () => {
  for (const mode of ["enforce-explicit", "enforce-strict"] as const) {
    assertDockerRunscCfcTransportForMode(mode, {
      cfcResultDir: "/host/results",
      cfcInvocationContextDir: "/host/ctx",
    });
  }
});

//
// The two CFC sidecar directories are wired between the harness config and the
// installed Docker runtime's registered arguments, and each is wired
// independently of the other. Naming one in the harness config says only where
// the harness will write.
//

const dockerRuntimes = (runtimeArgs?: readonly string[]) => ({
  "runsc-cfc": {
    path: "/host_mnt/Users/example/.local/share/runsc-cfc/runsc",
    ...(runtimeArgs !== undefined ? { runtimeArgs } : {}),
  },
});

const dockerInfoResult = (
  runtimeArgs?: readonly string[],
): ProcessRunResult => ({
  stdout: `${JSON.stringify(dockerRuntimes(runtimeArgs))}\n`,
  stderr: "",
  exitCode: 0,
});

// An invocation context for the tests of the runsc registration probe. The
// sandbox probes that registration only under an enforcing mode, so a bare
// call here carries one. The test asserting that no probe runs passes
// `observe`.
const enforcingInvocationContext = (
  cfcEnforcementMode: "enforce-explicit" | "observe" = "enforce-explicit",
) =>
  createHarnessCfcInvocationContext({
    sequence: 1,
    runId: "run-1",
    createdAt: "2026-04-30T00:00:00.000Z",
    toolId: "bash",
    operation: "shell",
    cfcEnforcementMode,
    cwd: "/workspace",
    runManifest: { present: false },
    command: "echo hello",
    cfcInputLabels: {
      version: 1,
      entries: [
        {
          path: ["command"],
          label: {
            confidentiality: [
              { type: "test.cfc/User", subject: "did:key:argv-reader" },
            ],
          },
        },
      ],
    },
  });

Deno.test("DockerRunscSandboxRuntime refuses an enforcing invocation whose input labels no runtime reads", async () => {
  const cfcInvocationContext = await enforcingInvocationContext();
  const runner = new FakeProcessRunner([
    { stdout: "container-123\n", stderr: "", exitCode: 0 },
    dockerInfoResult(["--cfc", "--cfc-policy=/host/cfc-policy.json"]),
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      cfcInvocationContextDir: "/host/invocations",
    }),
    runner,
  );

  const result = await runtime.run({
    argv: ["/bin/echo", "hello"],
    cfcInvocationContext,
  });

  assertEquals(result.exitCode, 125);
  assertMatch(
    result.stderr,
    /--cfc-invocation-context-dir=\/host\/invocations/,
  );
  assertMatch(result.stderr, /would be written and never read/);
  // The container is never started, so no output is produced under a posture
  // the run cannot honour.
  assertEquals(runner.requests.map((request) => request.args[0]), [
    "create",
    "info",
    "rm",
  ]);
  assertEquals(
    runtime.describe().cfc?.invocationContextTransportReadiness,
    "unregistered",
  );
});

Deno.test("DockerRunscSandboxRuntime refuses shell-unsafe runtime arguments before starting the container", async () => {
  // Moby's runtime wrapper strips the backslash before runsc parses the two
  // occurrences, so runsc receives an empty final value even though the raw
  // runtime argument list appears to register `/expected`.
  const cfcInvocationContextDir = await Deno.makeTempDir();
  try {
    const cfcInvocationContext = await enforcingInvocationContext();
    const [create, , , remove] = dockerLifecycleResults();
    const runner = new FakeProcessRunner([
      create!,
      dockerInfoResult([
        "--cfc-invocation-context-dir=/expected",
        "\\--cfc-invocation-context-dir=",
      ]),
      remove!,
    ]);
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir,
      }),
      runner,
    );

    const result = await runtime.run({
      argv: ["/bin/echo", "hello"],
      cfcInvocationContext,
    });

    assertEquals(result.exitCode, 125);
    assertMatch(result.stderr, /runtime argument at index 1/);
    assertMatch(result.stderr, /unsafe characters: \["\\\\"\]/);
    assertEquals(runner.requests.map((request) => request.args[0]), [
      "create",
      "info",
      "rm",
    ]);
    assertEquals(
      runtime.describe().cfc?.invocationContextTransportReadiness,
      "unsafe-runtime-arguments",
    );
  } finally {
    await Deno.remove(cfcInvocationContextDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime refuses when only the result transport is registered", async () => {
  const cfcInvocationContext = await enforcingInvocationContext();
  const runner = new FakeProcessRunner([
    { stdout: "container-123\n", stderr: "", exitCode: 0 },
    dockerInfoResult(["--cfc-result-dir=/host/results"]),
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      cfcInvocationContextDir: "/host/invocations",
      cfcResultDir: "/host/results",
    }),
    runner,
  );

  const result = await runtime.run({
    argv: ["/bin/echo", "hello"],
    cfcInvocationContext,
  });

  assertEquals(result.exitCode, 125);
  assertEquals(runner.requests.map((request) => request.args[0]), [
    "create",
    "info",
    "rm",
  ]);
});

Deno.test("DockerRunscSandboxRuntime writes the sidecar when the runtime is registered to read it", async () => {
  const cfcInvocationContextDir = await Deno.makeTempDir();
  try {
    const cfcInvocationContext = await enforcingInvocationContext();
    const [create, start, wait, remove] = dockerLifecycleResults();
    const runner = new FakeProcessRunner([
      create!,
      dockerInfoResult([
        `--cfc-invocation-context-dir=${cfcInvocationContextDir}`,
      ]),
      start!,
      wait!,
      remove!,
    ]);
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir,
      }),
      runner,
    );

    const result = await runtime.run({
      argv: ["/bin/echo", "hello"],
      cfcInvocationContext,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(
          `${cfcInvocationContextDir}/container-123.json`,
        ),
      ),
      cfcInvocationContext,
    );
    assertEquals(
      runtime.describe().cfc?.invocationContextTransportReadiness,
      "registered",
    );
  } finally {
    await Deno.remove(cfcInvocationContextDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime runs an indeterminate registration rather than refusing it", async () => {
  const cfcInvocationContextDir = await Deno.makeTempDir();
  try {
    const cfcInvocationContext = await enforcingInvocationContext();
    const [create, start, wait, remove] = dockerLifecycleResults();
    const runner = new FakeProcessRunner([
      create!,
      { stdout: "", stderr: "cannot connect to docker", exitCode: 1 },
      start!,
      wait!,
      remove!,
    ]);
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir,
      }),
      runner,
    );

    const result = await runtime.run({
      argv: ["/bin/echo", "hello"],
      cfcInvocationContext,
    });

    assertEquals(result.exitCode, 0);
    // Not read is reported as not read: the snapshot says indeterminate rather
    // than borrowing either verdict.
    assertEquals(
      runtime.describe().cfc?.invocationContextTransportReadiness,
      "indeterminate",
    );
  } finally {
    await Deno.remove(cfcInvocationContextDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime does not probe the registration outside enforcing modes", async () => {
  const cfcInvocationContextDir = await Deno.makeTempDir();
  try {
    const cfcInvocationContext = await enforcingInvocationContext("observe");
    const runner = new FakeProcessRunner(dockerLifecycleResults());
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir,
      }),
      runner,
    );

    const result = await runtime.run({
      argv: ["/bin/echo", "hello"],
      cfcInvocationContext,
    });

    assertEquals(result.exitCode, 0);
    // `observe` neither mediates nor denies, so a missing transport cannot
    // silently weaken it and there is nothing for the probe to protect.
    assertEquals(runner.requests.map((request) => request.args[0]), [
      "create",
      "start",
      "wait",
      "rm",
    ]);
  } finally {
    await Deno.remove(cfcInvocationContextDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime refuses on a registration reloaded away between probe and launch", async () => {
  // Docker reloads `runtimes` on SIGHUP, so a registration read at probe time
  // can be replaced before the container starts. A cached reading would not
  // merely be a weaker affirmative: it would suppress the refusal a current
  // read makes, which is the one thing this check is for.
  const cfcInvocationContext = await enforcingInvocationContext();
  const runner = new FakeProcessRunner([
    dockerInfoResult(["--cfc-invocation-context-dir=/host/invocations"]),
    { stdout: "container-123\n", stderr: "", exitCode: 0 },
    // Same runtime name, same directories, same endpoint — only the daemon's
    // registration changed underneath.
    dockerInfoResult(["--cfc"]),
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      cfcInvocationContextDir: "/host/invocations",
    }),
    runner,
  );

  assertEquals(
    (await runtime.probeCfcTransportReadiness())["invocation-context"]?.status,
    "registered",
  );

  const result = await runtime.run({
    argv: ["/bin/echo", "hello"],
    cfcInvocationContext,
  });

  assertEquals(result.exitCode, 125);
  assertMatch(result.stderr, /would be written and never read/);
  assertEquals(runner.requests.map((request) => request.args[0]), [
    "info",
    "create",
    "info",
    "rm",
  ]);
  assertEquals(
    runtime.describe().cfc?.invocationContextTransportReadiness,
    "unregistered",
  );
});

Deno.test("DockerRunscSandboxRuntime refuses an enforcing invocation with no invocation-context directory configured", async () => {
  const cfcInvocationContext = await enforcingInvocationContext();
  const runner = new FakeProcessRunner([
    { stdout: "container-123\n", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const runtime = new DockerRunscSandboxRuntime({
    // Written out rather than resolved, so that a host with the invocation
    // context environment variable set still exercises the absent case.
    ...resolveDockerRunscSandboxConfig({ workspaceHostPath: "/host/project" }),
    cfcInvocationContextDir: undefined,
  }, runner);

  const result = await runtime.run({
    argv: ["/bin/echo", "hello"],
    cfcInvocationContext,
  });

  // The engine refuses this configuration at run start, but that guard sits on
  // the engine's entry; a runtime constructed directly arrives here carrying
  // the same labels with nothing behind it.
  assertEquals(result.exitCode, 125);
  assertMatch(result.stderr, /have nowhere to be read from/);
  assertEquals(runner.requests.map((request) => request.args[0]), [
    "create",
    "rm",
  ]);
});

Deno.test("DockerRunscSandboxRuntime reports an unparseable runtime table as indeterminate", async () => {
  const cfcInvocationContextDir = await Deno.makeTempDir();
  try {
    const cfcInvocationContext = await enforcingInvocationContext();
    const [create, start, wait, remove] = dockerLifecycleResults();
    const runner = new FakeProcessRunner([
      create!,
      {
        stdout: "Cannot connect to the Docker daemon\n",
        stderr: "",
        exitCode: 0,
      },
      start!,
      wait!,
      remove!,
    ]);
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir,
      }),
      runner,
    );

    const result = await runtime.run({
      argv: ["/bin/echo", "hello"],
      cfcInvocationContext,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(
      runtime.describe().cfc?.invocationContextTransportReadiness,
      "indeterminate",
    );
  } finally {
    await Deno.remove(cfcInvocationContextDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime reports an unrunnable docker info as indeterminate", async () => {
  const cfcInvocationContextDir = await Deno.makeTempDir();
  try {
    const cfcInvocationContext = await enforcingInvocationContext();
    const [create, start, wait, remove] = dockerLifecycleResults();
    const lifecycle = new FakeProcessRunner([create!, start!, wait!, remove!]);
    const runner: ProcessRunner = {
      run(request) {
        if (request.args[0] === "info") {
          throw new Error("docker: command not found");
        }
        return lifecycle.run(request);
      },
    };
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir,
      }),
      runner,
    );

    const result = await runtime.run({
      argv: ["/bin/echo", "hello"],
      cfcInvocationContext,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(
      runtime.describe().cfc?.invocationContextTransportReadiness,
      "indeterminate",
    );
  } finally {
    await Deno.remove(cfcInvocationContextDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime holds the directories its readiness verdict was read against", async () => {
  // `readonly` is erased at runtime, so it cannot stop a JavaScript caller, a
  // cast, or `any`. The runtime copies both directories at construction, so a
  // memoized verdict can never be served for a directory it was not read
  // against: the drift is not refused, it simply cannot reach anything.
  const original = await Deno.makeTempDir();
  try {
    const cfcInvocationContext = await enforcingInvocationContext();
    const [create, start, wait, remove] = dockerLifecycleResults();
    const runner = new FakeProcessRunner([
      dockerInfoResult([`--cfc-invocation-context-dir=${original}`]),
      create!,
      dockerInfoResult([`--cfc-invocation-context-dir=${original}`]),
      start!,
      wait!,
      remove!,
    ]);
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcInvocationContextDir: original,
      }),
      runner,
    );

    assertEquals(
      (await runtime.probeCfcTransportReadiness())["invocation-context"]
        ?.status,
      "registered",
    );
    (runtime.config as { cfcInvocationContextDir?: string })
      .cfcInvocationContextDir = "/host/drifted";

    const result = await runtime.run({
      argv: ["/bin/echo", "hello"],
      cfcInvocationContext,
    });

    // The sidecar lands in the directory the verdict was read against, and
    // the drifted value is never consulted — no second `docker info` either.
    assertEquals(result.exitCode, 0);
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${original}/container-123.json`)),
      cfcInvocationContext,
    );
    // Both readings are taken against the copied directory, never the
    // drifted one.
    assertEquals(
      runner.requests.filter((request) => request.args[0] === "info").length,
      2,
    );
  } finally {
    await Deno.remove(original, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime holds the runtime identity its verdict was read against", async () => {
  // The reading is about a named runtime reached through a named binary, so a
  // caller-held mutable alias must not be able to redirect the launch away
  // from the registration that was read. TypeScript accepts a mutable object
  // where a readonly property is declared, so the type cannot hold this.
  const mutable = {
    ...resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      cfcInvocationContextDir: "/host/invocations",
    }),
  };
  const [create, start, wait, remove] = dockerLifecycleResults();
  const runner = new FakeProcessRunner([
    dockerInfoResult(["--cfc-invocation-context-dir=/host/invocations"]),
    create!,
    start!,
    wait!,
    remove!,
  ]);
  const runtime = new DockerRunscSandboxRuntime(mutable, runner);

  await runtime.probeCfcTransportReadiness();
  mutable.runtimeName = "some-other-runtime";
  mutable.dockerBinary = "not-docker";

  await runtime.run({ argv: ["/bin/echo", "hello"] });

  assertEquals(runtime.describe().cfc?.runtimeName, "runsc-cfc");
  for (const request of runner.requests) {
    assertEquals(request.command, "docker");
  }
  const createRequest = runner.requests.find((request) =>
    request.args[0] === "create"
  );
  const runtimeArg = createRequest?.args ?? [];
  assertEquals(runtimeArg[runtimeArg.indexOf("--runtime") + 1], "runsc-cfc");
});

Deno.test("DockerRunscSandboxRuntime probes the runtime an extraDockerArgs override actually launches", async () => {
  // `extraDockerArgs` is appended after `--runtime` on the create command line
  // and Docker takes the last occurrence, so an override there is what the
  // container runs under. Reading the registration of the configured name
  // while launching another would be a verdict about a runtime that never ran
  // — a false `registered` with no refusal, which is the failure this check
  // to stop.
  const cfcInvocationContext = await enforcingInvocationContext();
  const runner = new FakeProcessRunner([
    { stdout: "container-123\n", stderr: "", exitCode: 0 },
    // The override's registration is what gets read, and it names no sidecar
    // directory, so the invocation must be refused.
    {
      stdout: JSON.stringify({
        "runsc-cfc": {
          runtimeArgs: ["--cfc-invocation-context-dir=/host/invocations"],
        },
        "corp-runsc": { runtimeArgs: ["--cfc"] },
      }),
      stderr: "",
      exitCode: 0,
    },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      runtimeName: "runsc-cfc",
      cfcInvocationContextDir: "/host/invocations",
      extraDockerArgs: ["--runtime", "corp-runsc"],
    }),
    runner,
  );

  const result = await runtime.run({
    argv: ["/bin/echo", "hello"],
    cfcInvocationContext,
  });

  assertEquals(result.exitCode, 125);
  assertMatch(result.stderr, /the 'corp-runsc' docker runtime/);
  assertEquals(runner.requests.map((request) => request.args[0]), [
    "create",
    "info",
    "rm",
  ]);
  // The description names the runtime that would actually run, not the one
  // the config asked for.
  assertEquals(runtime.describe().cfc?.runtimeName, "corp-runsc");
});

Deno.test("DockerRunscSandboxRuntime holds its extra docker arguments against later mutation", () => {
  const extraDockerArgs = ["--runtime", "corp-runsc"];
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      runtimeName: "runsc-cfc",
      extraDockerArgs,
    }),
  );

  extraDockerArgs[1] = "some-other-runtime";
  extraDockerArgs.push("--runtime", "yet-another");

  // The array the caller still holds cannot redirect a launch away from the
  // runtime whose registration the verdict describes.
  assertEquals(runtime.describe().cfc?.runtimeName, "corp-runsc");
  assertEquals(runtime.describe().cfc?.extraDockerArgsCount, 2);
});

//
// The reading asks one question: is a valid absolute directory registered for
// this flag. It never compares that directory with the harness's, so none of
// these exercise a path comparison — there is none to exercise.
//

Deno.test("cfcTransportReadinessFromDockerRuntimes reports a registered absolute directory and carries it", () => {
  assertEquals(
    cfcTransportReadinessFromDockerRuntimes({
      runtimeName: "runsc-cfc",
      runtimes: dockerRuntimes([
        "--cfc",
        "--cfc-invocation-context-dir=/host/invocations",
        "--cfc-result-dir=/host/results",
      ]),
      cfcInvocationContextDir: "/host/invocations",
      cfcResultDir: "/host/results",
    }),
    {
      "invocation-context": {
        status: "registered",
        registeredPath: "/host/invocations",
      },
      result: { status: "registered", registeredPath: "/host/results" },
    },
  );
});

Deno.test("cfcTransportReadinessFromDockerRuntimes accepts every allowlisted runtime argument character", () => {
  assertEquals(
    cfcTransportReadinessFromDockerRuntimes({
      runtimeName: "runsc-cfc",
      runtimes: dockerRuntimes([
        "--cfc-invocation-context-dir=/AZaz09._/=:,-",
      ]),
      cfcInvocationContextDir: "/host/invocations",
    })["invocation-context"],
    {
      status: "registered",
      registeredPath: "/AZaz09._/=:,-",
    },
  );
});

Deno.test("cfcTransportReadinessFromDockerRuntimes reports shell-active characters as unsafe runtime arguments", () => {
  const shellActiveCharacters = [
    "\\",
    '"',
    "'",
    " ",
    "\t",
    "\n",
    "$",
    "`",
    ";",
    "&",
    "|",
    "<",
    ">",
    "(",
    ")",
    "*",
    "?",
    "[",
    "]",
  ];
  for (const character of shellActiveCharacters) {
    assertEquals(
      cfcTransportReadinessFromDockerRuntimes({
        runtimeName: "runsc-cfc",
        runtimes: dockerRuntimes([
          "--cfc-invocation-context-dir=/host/invocations",
          `--another-argument=${character}`,
        ]),
        cfcInvocationContextDir: "/host/invocations",
      })["invocation-context"],
      {
        status: "unsafe-runtime-arguments",
        argumentIndex: 1,
        unsafeCharacters: [character],
      },
      `expected ${JSON.stringify(character)} to be unsafe`,
    );
  }
});

Deno.test("cfcTransportReadinessFromDockerRuntimes registers a directory that is not the configured one", () => {
  // The registered path differs from what the harness writes to, and this is
  // deliberately NOT a refusal. Two spellings cannot establish two
  // directories: a symlink, a bind alias or a case-insensitive projection
  // makes them one. The path travels with the status so an operator can see
  // the difference the check will not claim to understand.
  assertEquals(
    cfcTransportReadinessFromDockerRuntimes({
      runtimeName: "runsc-cfc",
      runtimes: dockerRuntimes([
        "--cfc-invocation-context-dir=/host/somewhere-else",
      ]),
      cfcInvocationContextDir: "/host/invocations",
    })["invocation-context"],
    { status: "registered", registeredPath: "/host/somewhere-else" },
  );
});

Deno.test("cfcTransportReadinessFromDockerRuntimes reports every shape that registers nothing as unregistered", () => {
  // The one sound status, and the only one that refuses. runsc refuses a
  // non-absolute `--cfc-*-dir`, so absent, empty and relative all mean the
  // same thing: nothing reads anywhere, whatever filesystem either side is on.
  // Docker omits `runtimeArgs` entirely when a runtime carries none, so an
  // absent key and an empty array are different shapes of the same reading and
  // both have to be exercised.
  const cases: Array<[string, readonly string[] | undefined]> = [
    ["flag absent", ["--cfc", "--cfc-policy=/host/cfc-policy.json"]],
    ["runtimeArgs key absent", undefined],
    ["runtimeArgs present but empty", []],
    ["empty value", ["--cfc-invocation-context-dir="]],
    ["relative value", ["--cfc-invocation-context-dir=relative/dir"]],
    ["dot-relative value", ["--cfc-invocation-context-dir=./dir"]],
  ];
  for (const [label, runtimeArgs] of cases) {
    assertEquals(
      cfcTransportReadinessFromDockerRuntimes({
        runtimeName: "runsc-cfc",
        runtimes: dockerRuntimes(runtimeArgs),
        cfcInvocationContextDir: "/host/invocations",
      })["invocation-context"],
      { status: "unregistered" },
      label,
    );
  }
});

Deno.test("cfcTransportReadinessFromDockerRuntimes reads the last occurrence of a repeated flag", () => {
  // Go's parser applies every occurrence, so the last is what runsc runs with
  // and the last is what the reading must report. This decides which path is
  // carried, and — when the last one is not absolute — whether anything is
  // registered at all.
  assertEquals(
    cfcTransportReadinessFromDockerRuntimes({
      runtimeName: "runsc-cfc",
      runtimes: dockerRuntimes([
        "--cfc-invocation-context-dir=/host/first",
        "--cfc-invocation-context-dir=/host/last",
      ]),
      cfcInvocationContextDir: "/host/first",
    })["invocation-context"],
    { status: "registered", registeredPath: "/host/last" },
  );
  assertEquals(
    cfcTransportReadinessFromDockerRuntimes({
      runtimeName: "runsc-cfc",
      runtimes: dockerRuntimes([
        "--cfc-invocation-context-dir=/host/invocations",
        "--cfc-invocation-context-dir=relative/dir",
      ]),
      cfcInvocationContextDir: "/host/invocations",
    })["invocation-context"],
    { status: "unregistered" },
    "a valid value overridden by an invalid one registers nothing",
  );
});

Deno.test("cfcTransportReadinessFromDockerRuntimes reads both Go flag spellings", () => {
  for (
    const runtimeArgs of [
      ["-cfc-invocation-context-dir=/host/invocations"],
      ["--cfc-invocation-context-dir", "/host/invocations"],
      ["-cfc-invocation-context-dir", "/host/invocations"],
    ]
  ) {
    assertEquals(
      cfcTransportReadinessFromDockerRuntimes({
        runtimeName: "runsc-cfc",
        runtimes: dockerRuntimes(runtimeArgs),
        cfcInvocationContextDir: "/host/invocations",
      })["invocation-context"],
      { status: "registered", registeredPath: "/host/invocations" },
      `expected ${JSON.stringify(runtimeArgs)} to register the directory`,
    );
  }
});

Deno.test("cfcTransportReadinessFromDockerRuntimes keeps one reading per transport", () => {
  // The two transports are registered independently and can disagree. A
  // summary would have to pick one answer, and the invocation guard would then
  // read a verdict the result transport contributed to.
  const readiness = cfcTransportReadinessFromDockerRuntimes({
    runtimeName: "runsc-cfc",
    runtimes: dockerRuntimes(["--cfc-result-dir=/host/results"]),
    cfcInvocationContextDir: "/host/invocations",
    cfcResultDir: "/host/results",
  });
  assertEquals(readiness["invocation-context"], { status: "unregistered" });
  assertEquals(readiness.result, {
    status: "registered",
    registeredPath: "/host/results",
  });
});

Deno.test("cfcTransportReadinessFromDockerRuntimes ignores a transport the harness is not configured with", () => {
  assertEquals(
    cfcTransportReadinessFromDockerRuntimes({
      runtimeName: "runsc-cfc",
      runtimes: dockerRuntimes(["--cfc"]),
    }),
    {},
  );
});

Deno.test("cfcTransportReadinessFromDockerRuntimes reports indeterminate when it cannot read a registration at all", () => {
  // An unreadable table is a fact about the reading, not about the directory,
  // and must not be expressed as an absent flag — that would be positive
  // evidence the check never gathered.
  const unreadable: Array<[string, unknown]> = [
    ["no runtime table", "not-json-shaped"],
    ["runtime not registered", dockerRuntimes(["--cfc"])],
    ["non-object entry", { "other-runsc": "path-only" }],
  ];
  for (const [label, runtimes] of unreadable) {
    assertEquals(
      cfcTransportReadinessFromDockerRuntimes({
        runtimeName: "other-runsc",
        runtimes,
        cfcInvocationContextDir: "/host/invocations",
      })["invocation-context"]?.status,
      "indeterminate",
      label,
    );
  }
  assertEquals(
    cfcTransportReadinessFromDockerRuntimes({
      runtimeName: "runsc-cfc",
      runtimes: { "runsc-cfc": { runtimeArgs: [{ cfc: true }] } },
      cfcInvocationContextDir: "/host/invocations",
    })["invocation-context"]?.status,
    "indeterminate",
  );
});

Deno.test("DockerRunscSandboxRuntime reports the registered and configured paths as a pair", async () => {
  // The two are expected to differ on the documented Docker Desktop setup,
  // where the runtime is registered with the `/host_mnt` projection of the
  // very directory the harness writes to. That is why the difference is
  // reported for an operator to judge rather than refused: a check that
  // refused it would refuse the supported macOS configuration, and one that
  // excused it would need the projection logic that cannot be made sound.
  const runner = new FakeProcessRunner([
    dockerInfoResult([
      "--cfc-invocation-context-dir=/host_mnt/host/invocations",
    ]),
  ]);
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      cfcInvocationContextDir: "/host/invocations",
    }),
    runner,
  );

  await runtime.probeCfcTransportReadiness();
  const cfc = runtime.describe().cfc;

  assertEquals(cfc?.invocationContextTransportReadiness, "registered");
  assertEquals(
    cfc?.invocationContextRegisteredPath,
    "/host_mnt/host/invocations",
  );
  assertEquals(cfc?.invocationContextConfiguredPath, "/host/invocations");
});

Deno.test("registeredCfcSidecarHostDirs returns both directories as host paths", () => {
  // Docker Desktop's VM reports `/host_mnt/…` for a path the host writes at
  // without one, and the harness writes these directories from the host.
  assertEquals(
    registeredCfcSidecarHostDirs({
      runtimeName: "runsc-cfc",
      runtimes: dockerRuntimes([
        "--cfc-result-dir=/host_mnt/store/results",
        "--cfc-invocation-context-dir=/host_mnt/store/invocations",
      ]),
    }),
    {
      resultDir: "/store/results",
      invocationContextDir: "/store/invocations",
    },
  );
});

Deno.test("registeredCfcSidecarHostDirs leaves a host-registered path alone", () => {
  assertEquals(
    registeredCfcSidecarHostDirs({
      runtimeName: "runsc-cfc",
      runtimes: dockerRuntimes(["--cfc-result-dir=/var/lib/results"]),
    }),
    { resultDir: "/var/lib/results" },
  );
});

Deno.test("registeredCfcSidecarHostDirs returns nothing for a table it cannot read", () => {
  // Each of these is a reading that failed, and a failed reading must not
  // present as a registration — it is what the caller turns into a named
  // error rather than a directory nothing writes.
  assertEquals(
    registeredCfcSidecarHostDirs({ runtimeName: "runsc-cfc", runtimes: null }),
    {},
    "no runtime table at all",
  );
  assertEquals(
    registeredCfcSidecarHostDirs({
      runtimeName: "runsc-cfc",
      runtimes: [{ "runsc-cfc": {} }],
    }),
    {},
    "a table that is an array",
  );
  assertEquals(
    registeredCfcSidecarHostDirs({
      runtimeName: "runsc-cfc",
      runtimes: { runc: { path: "runc" } },
    }),
    {},
    "no entry for this runtime",
  );
  assertEquals(
    registeredCfcSidecarHostDirs({
      runtimeName: "runsc-cfc",
      runtimes: { "runsc-cfc": "not an object" },
    }),
    {},
    "an entry that is not an object",
  );
  assertEquals(
    registeredCfcSidecarHostDirs({
      runtimeName: "runsc-cfc",
      runtimes: { "runsc-cfc": { runtimeArgs: [7] } },
    }),
    {},
    "arguments that are not strings",
  );
});

Deno.test("registeredCfcSidecarHostDirs refuses a relative registered path", () => {
  // runsc refuses a non-absolute `--cfc-*-dir`, so a relative one names
  // nothing the runtime will write.
  assertEquals(
    registeredCfcSidecarHostDirs({
      runtimeName: "runsc-cfc",
      runtimes: dockerRuntimes(["--cfc-result-dir=relative/results"]),
    }),
    {},
  );
});
