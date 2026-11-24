/**
 * Runs the Linux default end to end against a real store, a real `runsc` and
 * a real `pasta`: the selection as the process it runs in sees its host, and
 * the direct driver it selects, with nothing faked. It needs a Linux host
 * with gVisor's Linux store installed under `CF_HARNESS_LIVE_LINUX_HOME`, and
 * is ignored everywhere else; gVisor's `cfc-rootfs` workflow runs it, once as
 * a user that is not root and once as root.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { createHarnessCfcInvocationContext } from "../src/contracts/cfc-invocation-context.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import {
  resolveRunscSandboxConfig,
  RunscSandboxRuntime,
} from "../src/sandbox/runsc.ts";
import { resolveSandboxRuntimeSelection } from "../src/sandbox/runtime-selection.ts";

const home = Deno.env.get("CF_HARNESS_LIVE_LINUX_HOME");

/** An invocation context for one shell call, in observe mode. */
const context = (command: string) =>
  createHarnessCfcInvocationContext({
    sequence: 1,
    runId: "live",
    createdAt: new Date().toISOString(),
    toolId: "bash",
    toolOutputId: createToolOutputId("live", "bash", 1),
    operation: "shell",
    cfcEnforcementMode: "observe",
    cwd: "/workspace",
    runManifest: { present: false },
    command,
  });

/**
 * Runs `curl` in `runtime` against `target`, giving up after `connectLimit`
 * where one is given: a bound on the wait for a connection that a check
 * expects to find nothing, not on one that would succeed.
 */
const fetched = (
  runtime: RunscSandboxRuntime,
  target: string,
  connectLimit = "",
) =>
  runtime.runShell({
    command: `curl -s ${connectLimit}--max-time 20 ${target}`,
  });

/**
 * Checks, in a runtime under pasta built from `selection`, that of the
 * host's loopback the container reaches `ports` at `host.docker.internal`
 * and no other port, and that it has egress, by address and by name.
 */
const reachesOnly = async (
  selection: Awaited<ReturnType<typeof resolveSandboxRuntimeSelection>>,
  ports: readonly number[],
  other: number,
  rootless: boolean,
) => {
  const workspace = await Deno.makeTempDir({ prefix: "runsc-live-" });
  const runtime = new RunscSandboxRuntime(resolveRunscSandboxConfig({
    workspaceHostPath: workspace,
    rootfs: selection.sandboxRootfs,
    runscBinary: selection.sandboxRunscBinary,
    cfcPolicyPath: selection.sandboxCfcPolicy,
    rootless,
    networkMode: selection.sandboxRunscNetworkMode,
    networkHelper: selection.sandboxRunscNetworkHelper,
    unshare: selection.sandboxRunscUnshare,
    setpriv: selection.sandboxRunscSetpriv,
    forwardedHostPorts: selection.sandboxRunscForwardedHostPorts,
    platform: "linux",
    homeDir: home,
  }));
  try {
    for (const port of ports) {
      const reached = await fetched(
        runtime,
        `http://host.docker.internal:${port}/`,
      );
      // Nothing of pasta's reaches the call's output.
      expect([reached.exitCode, reached.stdout, reached.stderr]).toEqual([
        0,
        `port-${port}`,
        "",
      ]);
    }

    // The name leads to the container's own loopback, where pasta listens
    // on the forwarded ports alone, so another port is refused there at
    // once (curl's 7, "could not connect").
    const otherByName = await fetched(
      runtime,
      `http://host.docker.internal:${other}/`,
    );
    expect([otherByName.exitCode, otherByName.stdout]).toEqual([7, ""]);

    // The gateway does not lead to the host's loopback: a connection there
    // goes out as any other and finds nothing, where a mapped gateway would
    // have answered at once.
    const atGateway = await fetched(
      runtime,
      `http://10.0.2.2:${other}/`,
      "--connect-timeout 2 ",
    );
    expect([atGateway.exitCode !== 0, atGateway.stdout]).toEqual([true, ""]);

    // Egress, by address and by name: the gateway answers DNS.
    for (const target of ["http://1.1.1.1/", "https://github.com/"]) {
      const egress = await runtime.runShell({
        command:
          `curl -s -o /dev/null -w '%{http_code}' --max-time 20 ${target}`,
      });
      expect([egress.exitCode, egress.stderr]).toEqual([0, ""]);
      expect(egress.stdout).toMatch(/^[23]\d\d$/);
    }
  } finally {
    await runtime.close();
    await Deno.remove(workspace, { recursive: true });
  }
};

/** A server on the host's loopback that answers `port-<its port>`. */
const serve = () => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => new Response(`port-${new URL(request.url).port}`),
  );
  return { server, port: (server.addr as Deno.NetAddr).port };
};

describe("runsc-linux-live", () => {
  it({
    name:
      "runs calls on the Linux default with pasta's network, and a session with none, as whoever this process is",
    ignore: home === undefined || Deno.build.os !== "linux",
    // The host server below outlives nothing, and the runtime is closed.
    fn: async () => {
      const selection = await resolveSandboxRuntimeSelection(
        { HOME: home },
        {},
        { platform: "linux", flags: false, homeDir: home },
      );
      expect(selection.sandboxRuntimeChoice).toMatchObject({
        runtime: "runsc",
        source: "default",
        platform: "linux",
      });
      expect(selection.sandboxRunscRootless === true).toBe(Deno.uid() !== 0);
      expect(selection.sandboxRunscNetworkHelper).toBeDefined();
      // Root's pasta runs in a mount namespace of its own.
      expect(selection.sandboxRunscUnshare === undefined).toBe(
        Deno.uid() !== 0,
      );

      const workspace = await Deno.makeTempDir({ prefix: "runsc-live-" });
      const host = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        () => new Response("hello-from-host"),
      );
      const pastaConfig = resolveRunscSandboxConfig({
        workspaceHostPath: workspace,
        rootfs: selection.sandboxRootfs,
        runscBinary: selection.sandboxRunscBinary,
        cfcPolicyPath: selection.sandboxCfcPolicy,
        rootless: selection.sandboxRunscRootless === true,
        networkHelper: selection.sandboxRunscNetworkHelper,
        unshare: selection.sandboxRunscUnshare,
        setpriv: selection.sandboxRunscSetpriv,
        platform: "linux",
        homeDir: home,
      });
      const runtime = new RunscSandboxRuntime(pastaConfig);
      const sessionsConfig = resolveRunscSandboxConfig({
        workspaceHostPath: workspace,
        rootfs: selection.sandboxRootfs,
        runscBinary: selection.sandboxRunscBinary,
        cfcPolicyPath: selection.sandboxCfcPolicy,
        rootless: selection.sandboxRunscRootless === true,
        networkMode: "none",
        platform: "linux",
        homeDir: home,
      });
      const sessions = new RunscSandboxRuntime(sessionsConfig);
      let closed = false;
      try {
        await Deno.writeTextFile(join(workspace, "seen.txt"), "from-host\n");

        const read = await runtime.runShell({
          command: "cat /workspace/seen.txt && echo written > /workspace/out",
          cfcInvocationContext: await context("cat"),
        });
        // Nothing of pasta's reaches the call's output, root's warnings
        // included.
        expect([read.exitCode, read.stdout, read.stderr])
          .toEqual([0, "from-host\n", ""]);
        expect(await Deno.readTextFile(join(workspace, "out"))).toBe(
          "written\n",
        );
        // The sandbox's root is whoever runs it: as root, root; rootless, the
        // user its user namespace maps root to, so what it writes is theirs.
        expect((await Deno.stat(join(workspace, "out"))).uid).toBe(Deno.uid());
        expect(read.cfcResult).toBeDefined();

        const failed = await runtime.runShell({ command: "exit 7" });
        expect(failed.exitCode).toBe(7);

        const stdin = await runtime.runShell({
          command: "cat",
          stdinText: "piped\n",
        });
        expect(stdin.stdout).toBe("piped\n");

        // Egress, by address and by name: the gateway answers DNS.
        for (const target of ["http://1.1.1.1/", "https://github.com/"]) {
          const egress = await runtime.runShell({
            command:
              `curl -s -o /dev/null -w '%{http_code}' --max-time 20 ${target}`,
          });
          expect([egress.exitCode, egress.stderr]).toEqual([0, ""]);
          expect(egress.stdout).toMatch(/^[23]\d\d$/);
        }

        const reached = await runtime.runShell({
          command: `curl -s --max-time 20 http://host.docker.internal:${
            (host.addr as Deno.NetAddr).port
          }/`,
        });
        expect([reached.exitCode, reached.stdout]).toEqual([
          0,
          "hello-from-host",
        ]);

        // The host's own interfaces stay the host's: the container sees
        // pasta's one interface and its loopback.
        const interfaces = await runtime.runShell({
          command: "cat /proc/net/dev",
        });
        expect(interfaces.stdout).not.toContain("docker0");

        // A call that times out under pasta ends with all it ran: pasta's
        // command is tied to pasta, so the container dies with it, and the
        // call ends only once nothing holding its output is left, its
        // sandbox included. Had the container outlived pasta, the call
        // would have waited for it, and found what it wrote.
        await expect(runtime.runShell({
          command: "sleep 30; echo late > /workspace/late",
          timeoutMs: 3000,
        })).rejects.toThrow("process timed out after 3000ms");
        await expect(Deno.stat(join(workspace, "late"))).rejects
          .toBeInstanceOf(Deno.errors.NotFound);

        // Under pasta no session is offered; with no network, one keeps
        // its state between calls.
        expect(runtime.describe().sessions).toBe(false);
        await sessions.run({
          argv: ["/bin/sh", "-c", "echo kept > /tmp/state"],
          session: "live",
        });
        const later = await sessions.run({
          argv: ["/bin/cat", "/tmp/state"],
          session: "live",
        });
        expect([later.exitCode, later.stdout]).toEqual([0, "kept\n"]);

        // A finished `runsc run` destroys its own container, so nothing of a
        // call under pasta, nor of the session, is left once both close:
        // each scratch tree is taken down only where it is empty.
        await runtime.close();
        await sessions.close();
        closed = true;
        for (const config of [pastaConfig, sessionsConfig]) {
          await expect(Deno.stat(config.scratchDir)).rejects.toBeInstanceOf(
            Deno.errors.NotFound,
          );
        }
      } finally {
        if (!closed) {
          await runtime.close();
          await sessions.close();
        }
        await host.shutdown();
        await Deno.remove(workspace, { recursive: true });
      }
    },
  });

  it({
    name:
      "reaches the host ports a run forwards at `host.docker.internal`, and no other port of the host's loopback, with egress kept",
    ignore: home === undefined || Deno.build.os !== "linux",
    fn: async () => {
      const forwarded = serve();
      const other = serve();
      try {
        const selection = await resolveSandboxRuntimeSelection(
          { HOME: home, CFC_VM_FORWARD_PORTS: String(forwarded.port) },
          {},
          { platform: "linux", flags: false, homeDir: home },
        );
        expect(selection.sandboxRunscForwardedHostPorts).toEqual([
          forwarded.port,
        ]);
        await reachesOnly(
          selection,
          [forwarded.port],
          other.port,
          selection.sandboxRunscRootless === true,
        );
      } finally {
        await forwarded.server.shutdown();
        await other.server.shutdown();
      }
    },
  });

  it({
    name:
      "gives a named `runsc` under `bridge` egress and no port of the host's loopback, where the run forwards none",
    ignore: home === undefined || Deno.build.os !== "linux",
    fn: async () => {
      const other = serve();
      try {
        // The store's pieces, as the default finds them, named as Loom names
        // them, with `bridge`.
        const store = await resolveSandboxRuntimeSelection(
          { HOME: home },
          {},
          { platform: "linux", flags: false, homeDir: home },
        );
        const selection = await resolveSandboxRuntimeSelection(
          {
            HOME: home,
            CF_HARNESS_SANDBOX_RUNTIME: "runsc",
            CF_HARNESS_SANDBOX_ROOTFS: store.sandboxRootfs,
            CF_HARNESS_RUNSC_BINARY: store.sandboxRunscBinary,
            ...(store.sandboxCfcPolicy !== undefined
              ? { CF_HARNESS_RUNSC_CFC_POLICY: store.sandboxCfcPolicy }
              : {}),
            CF_HARNESS_DOCKER_NETWORK_MODE: "bridge",
          },
          {},
          {
            namedBy: "Loom",
            processPlatform: "linux",
            flags: false,
            homeDir: home,
          },
        );
        expect(selection.sandboxRunscForwardedHostPorts).toEqual([]);
        // A named runsc runs as it is named; Loom names a wrapper that adds
        // `--rootless` for a user that is not root, as this does.
        await reachesOnly(selection, [], other.port, Deno.uid() !== 0);
      } finally {
        await other.server.shutdown();
      }
    },
  });
});
