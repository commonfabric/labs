/**
 * The memory URL a deployment publishes on its meta document, as `cf` reads
 * it: Memory opens there, and everything else stays on the API URL. Serial
 * because a connection claims the process's deployment.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import {
  type Options as StorageOptions,
  StorageManager as WorkerStorageManager,
} from "@commonfabric/runner/storage/cache";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { openAgentStorageHost } from "../lib/agent-connections.ts";
import { loadPieces } from "../lib/piece.ts";
import { resetProcessDeployment } from "../lib/process-deployment.ts";

/**
 * Runs `body` against a deployment at `http://api.test:8000` whose meta
 * document publishes `memoryUrl`, with storage emulated and the health check
 * returning `healthy`. Hands `body` the hosts storage was opened on, the
 * runtimes built, and every URL fetched.
 */
async function withDeployment(
  memoryUrl: string | null,
  healthy: boolean,
  body: (
    observed: { memoryHosts: string[]; runtimes: Runtime[]; fetched: string[] },
    keyPath: string,
    identity: Identity,
  ) => Promise<void>,
): Promise<void> {
  const identity = await Identity.fromPassphrase("cli memory url", {
    implementation: "noble",
  });
  const keyPath = await Deno.makeTempFile();
  await Deno.writeFile(keyPath, identity.toPkcs8());
  const storage = StorageManager.emulate({ as: identity });
  const observed = {
    memoryHosts: [] as string[],
    runtimes: [] as Runtime[],
    fetched: [] as string[],
  };
  const opened = (options: StorageOptions) => {
    observed.memoryHosts.push(options.memoryHost.href);
    return storage;
  };
  // `loadPieces` opens storage through the worker-shared module, and a record
  // host through the Deno one.
  const open = stub(WorkerStorageManager, "open", opened);
  const openDeno = stub(StorageManager, "open", opened);
  const fetchMeta = stub(globalThis, "fetch", (input) => {
    observed.fetched.push(String(input instanceof Request ? input.url : input));
    return Promise.resolve(Response.json({ experimental: {}, memoryUrl }));
  });
  const health = stub(Runtime.prototype, "healthCheck", function () {
    observed.runtimes.push(this);
    return Promise.resolve(healthy);
  });
  const session = stub(
    PiecesController.prototype,
    "ensureSpaceSession",
    () => Promise.resolve(),
  );
  resetProcessDeployment();
  try {
    await body(observed, keyPath, identity);
  } finally {
    session.restore();
    health.restore();
    fetchMeta.restore();
    openDeno.restore();
    open.restore();
    for (const runtime of observed.runtimes) await runtime.dispose();
    await storage.close();
    await Deno.remove(keyPath);
    resetProcessDeployment();
  }
}

Deno.test("loadPieces opens Memory on the published memory URL and the rest on the API URL", async () => {
  await withDeployment(
    "https://router.test",
    true,
    async (observed, keyPath, identity) => {
      await loadPieces({
        apiUrl: "http://api.test:8000",
        space: identity.did(),
        identity: keyPath,
      });
      assertEquals(observed.memoryHosts, ["https://router.test/"]);
      // The runtime, which the health check runs on, stays on the API URL,
      // and holds the memory URL so that no host hint moves Memory off it.
      assertEquals(
        observed.runtimes.map((runtime) => [
          runtime.apiUrl.href,
          runtime.memoryUrl?.href,
        ]),
        [["http://api.test:8000/", "https://router.test/"]],
      );
      // One read of the meta document gives the posture and the memory URL.
      assertEquals(
        observed.fetched.filter((url) => url.endsWith("/api/meta")),
        ["http://api.test:8000/api/meta"],
      );
    },
  );
});

Deno.test("loadPieces opens Memory on the API URL when the deployment publishes none", async () => {
  await withDeployment(null, true, async (observed, keyPath, identity) => {
    await loadPieces({
      apiUrl: "http://api.test:8000",
      space: identity.did(),
      identity: keyPath,
    });
    assertEquals(observed.memoryHosts, ["http://api.test:8000/"]);
    assertEquals(observed.runtimes[0].memoryUrl, undefined);
  });
});

Deno.test("loadPieces opens Memory on an API URL with a path when the deployment publishes none", async () => {
  // The API URL, path and all, is the host Memory opens on, and the runtime
  // holds no memory URL rather than refusing the path.
  await withDeployment(null, true, async (observed, keyPath, identity) => {
    await loadPieces({
      apiUrl: "http://api.test:8000/fabric",
      space: identity.did(),
      identity: keyPath,
    });
    assertEquals(observed.memoryHosts, ["http://api.test:8000/fabric"]);
    assertEquals(observed.runtimes[0].memoryUrl, undefined);
  });
});

Deno.test("loadPieces names the memory host when the health check fails", async () => {
  await withDeployment(
    "https://router.test",
    false,
    async (_observed, keyPath, identity) => {
      await assertRejects(
        () =>
          loadPieces({
            apiUrl: "http://api.test:8000",
            space: identity.did(),
            identity: keyPath,
          }),
        Error,
        'Could not connect to "http://api.test:8000". Memory opens on ' +
          '"https://router.test/", which the health check does not ask.',
      );
    },
  );
});

Deno.test("an agent record host opens Memory on the memory URL its own deployment publishes", async () => {
  await withDeployment(
    "https://records-router.test",
    true,
    async (observed, keyPath) => {
      const runtime = await openAgentStorageHost(
        keyPath,
        "http://records.test:9000",
      );
      try {
        assertEquals(observed.memoryHosts, ["https://records-router.test/"]);
        assertEquals(runtime.apiUrl.href, "http://records.test:9000/");
        assertEquals(runtime.memoryUrl?.href, "https://records-router.test/");
        assertEquals(observed.fetched, ["http://records.test:9000/api/meta"]);
      } finally {
        await runtime.dispose();
      }
    },
  );
});
