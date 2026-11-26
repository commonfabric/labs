import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { getPatternIdentityRef } from "../src/index.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const owner = await Identity.fromPassphrase("runner session pointer");
const space = owner.did();

describe("runner", () => {
  describe("setup over a keyless piece on a serving runtime", () => {
    // A keyless piece has only a session-side pointer. A setup that stamps a
    // durable pointer over it removes the session pointer in the same
    // transaction.

    let server: ReturnType<typeof newLoopbackServer>;
    let storage: EmulatedStorageManager;
    let runtime: Runtime;
    let lease: ExecutionLeaseCycle;

    beforeEach(async () => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      const holder = executionLeaseHolder(owner.did());
      storage = EmulatedStorageManager.connectTo(server, {
        as: owner,
        id: holder,
      });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      const engine = await server.engineForSpace(space);
      lease = new ExecutionLeaseCycle({
        leases: engine.executionLeases,
        space,
        holder,
      });
      expect(await lease.acquire()).toBe(true);
    });

    afterEach(async () => {
      await runtime.dispose();
      await lease.release();
      await storage.close();
      await server.close();
    });

    it("drops the session pointer once a keyed setup commits", async () => {
      const keyed = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
import { computed, pattern } from "commonfabric";
export default pattern<{ value: number }>(
  ({ value }) => ({ doubled: computed(() => value * 3) }),
);
`,
        }],
      }, { space });
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const keyless = pattern<{ value: number }>(({ value }) => ({
        doubled: lift((input: number) => input * 2)(value),
      }));
      const result = runtime.getCell<{ doubled: number }>(space, "keyed-over");
      const first = runtime.edit();
      runtime.run(first, keyless, { value: 2 }, result);
      expect((await first.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(runtime.runner.sessionPatternPointerFor(result)).toBeDefined();
      expect(getPatternIdentityRef(result)).toBeUndefined();

      const keyedRef = runtime.patternManager.getArtifactEntryRef(keyed)!;
      const second = runtime.edit();
      runtime.run(second, keyed, { value: 2 }, result);
      expect((await second.commit().settled).error).toBeUndefined();
      await runtime.idle();

      expect(runtime.runner.sessionPatternPointerFor(result)).toBeUndefined();
      expect(getPatternIdentityRef(result)).toEqual(keyedRef);
    });
  });
});
