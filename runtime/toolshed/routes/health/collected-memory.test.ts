import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { exposeGarbageCollector } from "@commonfabric/runner/collected-memory";

import { createTestApp } from "@/lib/create-app.ts";
import {
  startServerExecutionHost,
  stopServerExecutionHost,
} from "@/lib/server-execution.ts";
import router from "@/routes/health/health.index.ts";

const app = createTestApp(router);

// As a server started with EXPOSE_GC=true does at startup.
exposeGarbageCollector();

/** Requests the route, and returns its status and body. */
async function collected() {
  const response = await app.request("/api/health/collected-memory");
  return { status: response.status, body: await response.json() };
}

describe("GET /api/health/collected-memory", () => {
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

  /**
   * Starts a serving loop in workers or on this thread, over a file store
   * the memory server owns. In workers it keeps one spare, the toolshed's
   * default, so there is a worker to collect before any space is served.
   */
  async function startLoop(worker: boolean) {
    directory = await Deno.makeTempDir({ prefix: "collected-memory-" });
    server = new MemoryServer({
      store: toFileUrl(`${directory}/`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-collected-memory" },
    });
    const knobs: Record<string, string> = {
      EXPERIMENTAL_SERVER_EXECUTION: "true",
      SERVER_EXECUTION_WORKER: `${worker}`,
      SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "false",
    };
    const loop = startServerExecutionHost({
      server,
      identity: await Identity.fromPassphrase("collected memory service"),
      apiUrl: new URL("http://toolshed.test"),
      envGet: (name) => knobs[name],
    });
    if (loop === undefined) throw new Error("No serving loop started");
    return loop;
  }

  it("reports a buffer this thread holds, and no worker while no serving loop runs", async () => {
    const size = 64 * 1024 * 1024;
    const before = await collected();
    expect(before.status).toBe(200);
    expect(before.body.servingLoopWorker).toBeUndefined();
    const held = new Uint8Array(size);
    const during = await collected();
    expect(during.body.mainThread.external - before.body.mainThread.external)
      .toBeGreaterThanOrEqual(size);
    expect(held.length).toBe(size);
  });

  it("reports the serving loop's workers beside this thread where the loop runs in them, one by one and added up, leaving out what this thread holds", async () => {
    await startLoop(true);
    const size = 64 * 1024 * 1024;
    const before = await collected();
    expect(before.status).toBe(200);
    expect(before.body.servingLoopWorker.heapUsed).toBeGreaterThan(0);
    expect(before.body.servingLoopWorkers).toEqual([{
      ...before.body.servingLoopWorker,
      spaces: [],
    }]);
    const held = new Uint8Array(size);
    const during = await collected();
    expect(during.body.mainThread.external - before.body.mainThread.external)
      .toBeGreaterThanOrEqual(size);
    expect(
      during.body.servingLoopWorker.external -
        before.body.servingLoopWorker.external,
    ).toBeLessThan(size);
    expect(held.length).toBe(size);
  });

  it("reports no worker where the serving loop runs on this thread", async () => {
    await startLoop(false);
    const { status, body } = await collected();
    expect(status).toBe(200);
    expect(body.servingLoopWorker).toBeUndefined();
    expect(body.servingLoopWorkers).toBeUndefined();
  });

  it("answers 503 once the serving loop's workers are closed", async () => {
    const loop = await startLoop(true);
    await loop.close();
    const { status, body } = await collected();
    expect(status).toBe(503);
    expect(body.error).toContain("the serving workers are closed");
  });
});
