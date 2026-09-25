/**
 * Exercises the Fabric mount against real Docker and runsc-cfc when explicitly
 * enabled. The ordinary package test lane registers this test but skips its
 * external-runtime work.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DockerRunscSandboxRuntime,
  resolveDockerRunscSandboxConfig,
} from "../src/sandbox/docker-runsc.ts";

describe("DockerRunscSandboxRuntime live Fabric mount", () => {
  it("refuses a write and preserves the host file", {
    ignore: Deno.env.get("CF_HARNESS_RUNSC_CFC_LIVE") !== "1",
    fn: async () => {
      const root = await Deno.makeTempDir({
        prefix: "cf-harness-fabric-live-",
      });
      const workspace = `${root}/workspace`;
      const fabric = `${root}/fabric`;
      const probe = `${fabric}/probe`;
      try {
        await Deno.mkdir(workspace);
        await Deno.mkdir(fabric);
        await Deno.writeTextFile(probe, "sentinel\n");
        const beforeBytes = await Deno.readFile(probe);
        const beforeInfo = await Deno.stat(probe);
        const runtime = new DockerRunscSandboxRuntime(
          resolveDockerRunscSandboxConfig({
            workspaceHostPath: await Deno.realPath(workspace),
            additionalMounts: [{
              kind: "fabric-fuse",
              hostPath: await Deno.realPath(fabric),
            }],
          }),
        );

        const result = await runtime.runShell({
          command: "printf changed > /fabric/probe",
          cwd: "/workspace",
        });

        expect(result.exitCode).not.toBe(0);
        expect(`${result.stderr}\n${result.stdout}`).toMatch(
          /read-only file system|erofs/i,
        );
        expect(await Deno.readFile(probe)).toEqual(beforeBytes);
        const afterInfo = await Deno.stat(probe);
        expect({
          size: afterInfo.size,
          mtime: afterInfo.mtime,
          mode: afterInfo.mode,
        }).toEqual({
          size: beforeInfo.size,
          mtime: beforeInfo.mtime,
          mode: beforeInfo.mode,
        });
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    },
  });
});
