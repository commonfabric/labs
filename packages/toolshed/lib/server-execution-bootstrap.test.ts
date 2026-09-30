/** The serving bootstrap advances an authored commit over the loopback plane. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { serverSeq } from "@commonfabric/memory/v2/engine";
import { Runtime } from "@commonfabric/runner";
import { waitForSettled } from "@commonfabric/runner/executor/watermark";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  startServerExecutionHost,
  stopServerExecutionHost,
} from "./server-execution.ts";

describe("server-execution bootstrap", () => {
  it("serves a client-authored commit and releases its active space on shutdown", async () => {
    const client = await Identity.fromPassphrase("bootstrap-client");
    const service = await Identity.fromPassphrase("bootstrap-service");
    const space = client.did();
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const storage = EmulatedStorageManager.connectTo(server, { as: client });
    const runtime = new Runtime({
      storageManager: storage,
      apiUrl: new URL("http://toolshed.test"),
      cfcFlowLabels: "persist",
      experimental: { serverExecution: true },
    });
    try {
      const host = startServerExecutionHost({
        server,
        identity: service,
        apiUrl: new URL("http://toolshed.test"),
        envGet: (name) =>
          ({
            EXPERIMENTAL_SERVER_EXECUTION: "true",
            SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "false",
          })[name],
      });
      expect(host).toBeDefined();
      const cell = runtime.getCell(space, "bootstrap-input");
      await cell.sync();
      const write = runtime.edit();
      cell.withTx(write).set("authored");
      expect((await write.commit()).error).toBeUndefined();
      const engine = await server.engineForSpace(space);
      const authoredSeq = serverSeq(engine);
      expect(authoredSeq).toBeGreaterThan(0);
      expect(await waitForSettled(runtime, space, authoredSeq))
        .toBeGreaterThanOrEqual(authoredSeq);
      expect(host!.spaceServer(space)?.active).toBe(true);
      expect(cell.get()).toBe("authored");
      await stopServerExecutionHost();
      expect(host!.spaceServer(space)).toBeUndefined();
    } finally {
      await stopServerExecutionHost();
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });
});
