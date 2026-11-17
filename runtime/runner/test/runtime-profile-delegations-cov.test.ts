import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import {
  delegationsCause,
  Runtime,
  writeOverrideBanner,
} from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("runtime profile delegations");

describe("runtime", () => {
  describe("loadProfileDelegations()", () => {
    let server: MemoryV2Server.Server;
    let storageManager: EmulatedStorageManager;
    let runtime: Runtime;

    beforeEach(() => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
      await server.close();
    });

    it("holds the delegation of a profile listed after entries that hold no link", async () => {
      // Each entry is read as a cell; one that holds no link of its own is a
      // cell in Home, which names no profile space.

      const { space, delegation } = await runtime.createSelfOwnedSpace();
      const written = await runtime.editWithRetry((tx) => {
        const home = runtime.getHomeSpaceCell(tx);
        runtime.getCell(home.space, delegationsCause(space), undefined, tx)
          .set({ delegations: [new FabricBytes(delegation)] });
        home.key("defaultPattern").set({
          profiles: [
            null,
            42,
            "text",
            { name: "not a link" },
            [1],
            runtime.getCell(space, "profile", undefined, tx),
          ],
        });
      });
      expect(written.error).toBeUndefined();

      expect(await runtime.loadProfileDelegations()).toBe(1);
    });
  });

  describe("writeOverrideBanner()", () => {
    it("writes the banner as a line to the standard error it is given, and nothing to the console", () => {
      const written: string[] = [];
      using log = stub(console, "log");
      writeOverrideBanner("Experimental flag overrides: a=1", {
        writeSync: (bytes) => {
          written.push(new TextDecoder().decode(bytes));
          return bytes.length;
        },
      });

      expect(written).toEqual(["Experimental flag overrides: a=1\n"]);
      expect(log.calls).toEqual([]);
    });

    it("logs the banner to the console where there is no standard error", () => {
      using log = stub(console, "log");
      writeOverrideBanner("Experimental flag overrides: a=1", undefined);

      expect(log.calls.map((call) => call.args)).toEqual([
        ["Experimental flag overrides: a=1"],
      ]);
    });
  });
});
