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
    const starting = {
      ok: true,
      lanes: { local: false, fabric: false },
      readiness: {
        local: {
          state: "starting",
          since: "2026-10-07T00:10:14Z",
          reason: "Initializing the local lane",
        },
      },
    };
    const seen: string[] = [];
    const server = Deno.serve(
      { transport: "unix", path, onListen: () => {} },
      (request) => {
        seen.push(new URL(request.url).pathname);
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        return mode === "ok"
          ? Response.json({ lanes: { local: true, fabric: false } })
          : mode === "starting"
          ? Response.json(starting, { status: 503 })
          : mode === "http"
          ? new Response("refused", { status: 401 })
          : mode === "invalid-starting"
          ? new Response("not JSON", { status: 503 })
          : new Response("not JSON");
      },
    );
    try {
      expect(await readRunnerHealth(path)).toEqual({
        lanes: { local: true, fabric: false },
      });
      mode = "starting";
      const printed: string[] = [];
      await createAgentStatusCommand({
        read: readRunnerHealth,
        print: (text) => printed.push(text),
      }).throwErrors().noExit().parse(["--local-jobs-socket", path]);
      expect(JSON.parse(printed[0])).toEqual(starting);
      mode = "http";
      await expect(readRunnerHealth(path)).rejects.toThrow("HTTP 401: refused");
      mode = "json";
      await expect(readRunnerHealth(path)).rejects.toThrow();
      mode = "invalid-starting";
      await expect(readRunnerHealth(path)).rejects.toThrow();
      expect(seen).toEqual(Array(5).fill("/health"));
      await expect(readRunnerHealth(join(dir, "absent.sock"))).rejects
        .toThrow();
    } finally {
      await server.shutdown();
      await expect(readRunnerHealth(path)).rejects.toThrow();
      await Deno.remove(dir, { recursive: true });
    }
  });
});
