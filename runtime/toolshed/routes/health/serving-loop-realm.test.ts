import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { createTestApp } from "@/lib/create-app.ts";
import {
  startServerExecutionHost,
  stopServerExecutionHost,
} from "@/lib/server-execution.ts";
import router from "@/routes/health/health.index.ts";

const app = createTestApp(router);

/** Requests the route, and returns its status, cache policy and body. */
async function realm() {
  const response = await app.request("/api/health/serving-loop-realm");
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

describe("GET /api/health/serving-loop-realm", () => {
  let directory: string | undefined;
  let server: MemoryServer | undefined;

  afterEach(async () => {
    await stopServerExecutionHost();
    await server?.close();
    server = undefined;
    if (directory !== undefined) {
      await Deno.remove(directory, { recursive: true });
      directory = undefined;
    }
  });

  /** Starts a serving loop in a worker or on this thread. */
  async function startLoop(worker: boolean) {
    directory = await Deno.makeTempDir({ prefix: "serving-loop-realm-" });
    server = new MemoryServer({
      store: toFileUrl(`${directory}/`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-serving-loop-realm" },
    });
    const knobs: Record<string, string> = {
      EXPERIMENTAL_SERVER_EXECUTION: "true",
      SERVER_EXECUTION_WORKER: `${worker}`,
      SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "false",
    };
    const loop = startServerExecutionHost({
      server,
      identity: await Identity.fromPassphrase("serving loop realm service"),
      apiUrl: new URL("http://toolshed.test"),
      envGet: (name) => knobs[name],
    });
    if (loop === undefined) throw new Error("No serving loop started");
    return loop;
  }

  it("returns the loop's realm's logger counts and timings where the loop runs on this thread", async () => {
    await startLoop(false);

    const { status, cacheControl, body } = await realm();

    expect(status).toBe(200);
    expect(cacheControl).toBe("no-store");
    expect(typeof body.timestamp).toBe("number");
    expect(typeof body.loggerCounts).toBe("object");
    expect(typeof body.timingStats).toBe("object");
  });

  it("returns 503 naming the cause once the loop's workers are closed", async () => {
    const loop = await startLoop(true);
    await loop.close();

    const { status, cacheControl, body } = await realm();

    expect(status).toBe(503);
    expect(cacheControl).toBe("no-store");
    expect(body.error).toContain(
      "The serving loop's workers are not serving: ",
    );
    expect(body.error).toContain("the serving workers are closed");
  });
});
