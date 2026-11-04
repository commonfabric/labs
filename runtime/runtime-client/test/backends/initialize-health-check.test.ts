import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { RuntimeProcessor } from "@/backends/runtime-processor.ts";
import { ownerClient } from "@/backends/worker-client.ts";
import {
  type InitializationData,
  type IPCRemotePost,
  NotificationType,
  RuntimeErrorCode,
} from "@/protocol/mod.ts";
import { stubWorkerBoot } from "./stub-worker-boot.ts";

const signer = await Identity.fromPassphrase("initialize-health-check-user");
const apiUrl = "http://initialize-health-check.test/";
const spaceHost = "http://space.initialize-health-check.test/";
const federatedSpace = "did:key:z6MkInitializeHealthCheckFederated";

/**
 * Stands a processor up over emulated storage, with `healthCheck` standing in
 * for the backend's answer. The boot stubs are back in place by the time this
 * settles, either way it settles.
 */
async function initialize(
  healthCheck: () => Promise<boolean>,
  data: Partial<InitializationData> = {},
): Promise<RuntimeProcessor> {
  const restore = stubWorkerBoot(
    ({ as }) => StorageManager.emulate({ as }),
    healthCheck,
  );
  try {
    return await RuntimeProcessor.initialize({
      apiUrl,
      identity: signer.keyPair,
      spaceDid: signer.did(),
      ...data,
    });
  } finally {
    restore();
  }
}

describe("runtime-processor", () => {
  describe("initialize()", () => {
    let notices: IPCRemotePost[];
    let post: { restore(): void };

    beforeEach(() => {
      notices = [];
      post = stub(ownerClient, "post", (notice) => {
        notices.push(notice);
        return true;
      });
    });

    afterEach(() => post.restore());

    it("returns the processor before the health check settles", async () => {
      const check = Promise.withResolvers<boolean>();
      let asked = 0;
      const processor = await initialize(() => {
        asked++;
        return check.promise;
      });
      try {
        expect(asked).toBe(1);
        check.resolve(true);
        expect(await processor.accessForTestingOnly.health).toBe(true);
        expect(notices).toEqual([]);
      } finally {
        await processor.dispose();
      }
    });

    it("reports a host the check cannot reach as an `ErrorReport` naming every host", async () => {
      const processor = await initialize(() => Promise.resolve(false), {
        spaceHostMap: { [federatedSpace]: spaceHost },
      });
      try {
        expect(await processor.accessForTestingOnly.health).toBe(false);
        expect(notices).toEqual([{
          type: NotificationType.ErrorReport,
          code: RuntimeErrorCode.HostUnreachable,
          message: `Could not connect to "${apiUrl}" or to a space host ` +
            `("${spaceHost}")`,
        }]);
      } finally {
        await processor.dispose();
      }
    });

    it("reports a check that rejects as an unreachable host", async () => {
      const processor = await initialize(() =>
        Promise.reject(new Error("the probe itself failed"))
      );
      try {
        expect(await processor.accessForTestingOnly.health).toBe(false);
        expect(notices).toEqual([{
          type: NotificationType.ErrorReport,
          code: RuntimeErrorCode.HostUnreachable,
          message: `Could not connect to "${apiUrl}"`,
        }]);
      } finally {
        await processor.dispose();
      }
    });

    it("names a space host as the check parses it, and the backend once", async () => {
      const processor = await initialize(() => Promise.resolve(false), {
        spaceHostMap: {
          [federatedSpace]: "http://space.initialize-health-check.test",
          "did:key:z6MkInitializeHealthCheckHome":
            "http://initialize-health-check.test",
        },
      });
      try {
        expect(await processor.accessForTestingOnly.health).toBe(false);
        expect(notices).toEqual([{
          type: NotificationType.ErrorReport,
          code: RuntimeErrorCode.HostUnreachable,
          message: `Could not connect to "${apiUrl}" or to a space host ` +
            `("${spaceHost}")`,
        }]);
      } finally {
        await processor.dispose();
      }
    });

    it("posts no notice for a check that fails after the processor was disposed", async () => {
      const check = Promise.withResolvers<boolean>();
      const processor = await initialize(() => check.promise);
      await processor.dispose();
      check.resolve(false);
      expect(await processor.accessForTestingOnly.health).toBe(false);
      expect(notices).toEqual([]);
    });

    it("rejects with the unreachable host when `awaitHealth` is set and the check fails", async () => {
      await expect(initialize(() => Promise.resolve(false), {
        awaitHealth: true,
      })).rejects.toThrow(`Could not connect to "${apiUrl}"`);
      expect(notices).toEqual([]);
    });
  });
});
