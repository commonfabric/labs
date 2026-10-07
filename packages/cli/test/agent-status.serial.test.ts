import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  createAgentStatusCommand,
  readRunnerHealth,
} from "../commands/agent-status.ts";

describe("agent-status", () => {
  it("prints the full health response without hiding routes, reasons or provenance", async () => {
    const health = {
      ok: true,
      lanes: { local: true, fabric: false },
      readiness: {
        fabric: {
          state: "refused",
          since: "2026-10-07T00:10:14Z",
          reason: "No queue",
        },
      },
      routes: [{ method: "GET", path: "/jobs/:id/browser/stream" }],
      profileFile: "/run/profiles.json",
      storePath: "/run/jobs.sqlite",
      labsCommit: "abc",
    };
    const paths: string[] = [];
    const printed: string[] = [];
    await createAgentStatusCommand({
      read: (path) => {
        paths.push(path);
        return Promise.resolve(health);
      },
      print: (text) => printed.push(text),
    }).throwErrors().noExit().parse(["--local-jobs-socket", "/run/jobs.sock"]);
    expect(paths).toEqual(["/run/jobs.sock"]);
    expect(JSON.parse(printed[0])).toEqual(health);
  });

  it("reads only authenticated health and reports HTTP, JSON and transport failures", async () => {
    const dir = await Deno.makeTempDir({
      dir: "/tmp",
      prefix: "runner-status-",
    });
    const path = join(dir, "jobs.sock");
    await Deno.writeTextFile(`${path}.token`, "secret\n");
    let mode = "ok";
    const seen: string[] = [];
    const server = Deno.serve(
      { transport: "unix", path, onListen: () => {} },
      (request) => {
        seen.push(new URL(request.url).pathname);
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        return mode === "ok"
          ? Response.json({ lanes: { local: true, fabric: false } })
          : mode === "http"
          ? new Response("refused", { status: 503 })
          : new Response("not JSON");
      },
    );
    try {
      expect(await readRunnerHealth(path)).toEqual({
        lanes: { local: true, fabric: false },
      });
      mode = "http";
      await expect(readRunnerHealth(path)).rejects.toThrow("HTTP 503: refused");
      mode = "json";
      await expect(readRunnerHealth(path)).rejects.toThrow();
      expect(seen).toEqual(["/health", "/health", "/health"]);
      await expect(readRunnerHealth(join(dir, "absent.sock"))).rejects
        .toThrow();
    } finally {
      await server.shutdown();
      await expect(readRunnerHealth(path)).rejects.toThrow();
      await Deno.remove(dir, { recursive: true });
    }
  });
});
