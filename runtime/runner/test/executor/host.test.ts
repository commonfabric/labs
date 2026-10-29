import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { ServerExecutionObserver } from "@commonfabric/memory/v2/server";
import { defer } from "@commonfabric/utils/defer";
import { ExecutorHost } from "../../src/executor/host.ts";
import { inServingContext } from "../../src/executor/serving-context.ts";
import { servingRuntimeFactory } from "../../src/executor/serving-runtime.ts";
import { newLoopbackServer } from "../../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("executor host service");
const owner = await Identity.fromPassphrase("executor host owner");

describe("ExecutorHost", () => {
  describe("constructor()", () => {
    it("activates the space an admitted commit names in the serving context, though called from outside it", async () => {
      // A warm notice activates its space with no session open on it, so the
      // admission hook is the only thing that starts the activation.
      const server = newLoopbackServer();
      let observer: ServerExecutionObserver | undefined;
      const setObserver = server.setServerExecutionObserver.bind(server);
      server.setServerExecutionObserver = (next) => {
        observer = next;
        setObserver(next);
      };
      const factory = servingRuntimeFactory({
        server,
        identity: service,
        apiUrl: new URL(import.meta.url),
      });
      const builds: boolean[] = [];
      const settled = defer<string>();
      const host = new ExecutorHost({
        server,
        serviceIdentity: service.did(),
        ensureSpaceRoots: false,
        createRuntime: (space, context) => {
          builds.push(inServingContext());
          return factory(space, context);
        },
        onActivationSettled: (_space, outcome) => settled.resolve(outcome),
      });
      try {
        observer!.commitAdmitted!({
          space: owner.did(),
          seq: 1,
          class: "authored",
          sessionId: "executor-host-test",
          writes: [],
          warm: true,
        });
        expect(await settled.promise).toBe("active");
      } finally {
        await host.close();
        await server.close();
      }
      expect(builds).toStrictEqual([true]);
    });
  });
});
