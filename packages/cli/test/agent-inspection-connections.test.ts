import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { openAgentStorageHost } from "../lib/agent-connections.ts";
import { cancelAgentRun, readAgentRuns } from "../lib/agent-inspection.ts";
import { loadIdentity } from "../lib/identity.ts";
import { claimProcessDeployment } from "../lib/process-deployment.ts";

describe("agent inspection connections", () => {
  it("reads and cancels a run on a second server while retaining the home deployment", async () => {
    const directory = await Deno.makeTempDir({ prefix: "agent-inspection-" });
    const identityPath = join(directory, "identity.key");
    await Deno.writeFile(identityPath, await Identity.generatePkcs8());
    const identity = await loadIdentity(identityPath);
    const homeServer = StandaloneMemoryServer.start();
    const recordServer = StandaloneMemoryServer.start();
    const home = await openAgentStorageHost(
      identityPath,
      homeServer.url.origin,
    );
    const remote = await openAgentStorageHost(
      identityPath,
      recordServer.url.origin,
    );
    try {
      const run = remote.getCell(identity.did(), "remote-run");
      await remote.editWithRetry((tx) => {
        const request = remote.getCell(identity.did(), "request");
        run.withTx(tx).set({
          request,
          piece: request,
          space: request,
          inputs: {},
          resultSchema: true,
          requestHash: "remote-request",
          task: "Read the local catalog",
          state: "running",
          stateSince: "2026-09-20T10:00:00Z",
          submittedAt: "2026-09-20T09:59:00Z",
        });
      });
      await home.editWithRetry((tx) => {
        const pattern = home.getCell(
          identity.did(),
          "home-pattern",
          undefined,
          tx,
        );
        pattern.set({
          agentQueue: {
            entries: [{ run, host: recordServer.url.origin }],
          },
        });
        home.getHomeSpaceCell(tx).key("defaultPattern").set(pattern);
      });
      const config = {
        identity: identityPath,
        apiUrl: homeServer.url.origin,
      };

      const runs = await readAgentRuns(config);
      const cancelled = await cancelAgentRun(config, "remote-request");

      expect(runs.map((value) => [value.host, value.state])).toEqual([
        [recordServer.url.origin, "running"],
      ]);
      expect(cancelled.state).toBe("running");
      expect(cancelled.cancelRequestedAt).toEqual(expect.any(String));
      expect(() => claimProcessDeployment(homeServer.url.origin)).not.toThrow();
      expect(() => claimProcessDeployment(recordServer.url.origin)).toThrow(
        "one deployment per process",
      );
      const stored = await run.pull();
      expect(stored).toMatchObject({
        cancelRequestedAt: cancelled.cancelRequestedAt,
        state: "running",
      });
    } finally {
      await home.dispose();
      await remote.dispose();
      await homeServer.close();
      await recordServer.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
});
