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

describe("runsc-linux-live", () => {
  it({
    name:
      "runs calls and a session on the Linux default, with pasta's network, as whoever this process is",
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
      const runtime = new RunscSandboxRuntime(resolveRunscSandboxConfig({
        workspaceHostPath: workspace,
        rootfs: selection.sandboxRootfs,
        runscBinary: selection.sandboxRunscBinary,
        cfcPolicyPath: selection.sandboxCfcPolicy,
        rootless: selection.sandboxRunscRootless === true,
        networkHelper: selection.sandboxRunscNetworkHelper,
        unshare: selection.sandboxRunscUnshare,
        platform: "linux",
        homeDir: home,
      }));
      try {
        await Deno.writeTextFile(join(workspace, "seen.txt"), "from-host\n");

        const read = await runtime.runShell({
          command: "cat /workspace/seen.txt && echo written > /workspace/out",
          cfcInvocationContext: await context("cat"),
        });
        expect([read.exitCode, read.stdout, read.stderr]).toEqual([
          0,
          "from-host\n",
          "",
        ]);
        expect(await Deno.readTextFile(join(workspace, "out"))).toBe(
          "written\n",
        );
        expect(read.cfcResult).toBeDefined();

        const failed = await runtime.runShell({ command: "exit 7" });
        expect(failed.exitCode).toBe(7);

        const stdin = await runtime.runShell({
          command: "cat",
          stdinText: "piped\n",
        });
        expect(stdin.stdout).toBe("piped\n");

        const egress = await runtime.runShell({
          command:
            "curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://1.1.1.1/",
        });
        expect([egress.exitCode, egress.stderr]).toEqual([0, ""]);
        expect(egress.stdout).toMatch(/^[23]\d\d$/);

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

        await runtime.run({
          argv: ["/bin/sh", "-c", "echo kept > /tmp/state"],
          session: "live",
        });
        const later = await runtime.run({
          argv: ["/bin/cat", "/tmp/state"],
          session: "live",
        });
        expect([later.exitCode, later.stdout]).toEqual([0, "kept\n"]);
      } finally {
        await runtime.close();
        await host.shutdown();
        await Deno.remove(workspace, { recursive: true });
      }
    },
  });
});
