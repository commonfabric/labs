import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { SessionRegistry } from "@commonfabric/memory/v2/server";
import { ProcessModuleByteCache } from "@commonfabric/test-support/compile-byte-cache";
import { servingRuntimeFactory } from "../../src/executor/serving-runtime.ts";
import { newLoopbackServer } from "../../src/storage/v2-emulate.ts";

describe("servingRuntimeFactory()", () => {
  it("carries the host build into its serving session", async () => {
    const identity = await Identity.fromPassphrase(
      "serving runtime attribution",
    );
    const sessions = new SessionRegistry();
    const server = newLoopbackServer({ sessions });
    const clientBuild = { application: "toolshed", gitSha: "b".repeat(40) };
    const createRuntime = servingRuntimeFactory({
      server,
      identity,
      apiUrl: new URL("http://localhost:9999/"),
      clientBuild,
    });
    const space = identity.did() as MemorySpace;
    const { runtime, dispose } = await createRuntime(space, {});
    try {
      const result = await runtime.storageManager.open(space).sync(
        "of:serving-identity",
        { path: [], schema: false },
      );
      expect(result.error).toBeUndefined();
      const registered = sessions.sessionsForSpace(space);
      // Admission probes share the serving runtime's report too.
      expect(registered.length).toBeGreaterThan(0);
      for (const session of registered) {
        expect(session.client).toMatchObject(clientBuild);
      }
      expect(
        new Set(registered.map((session) => session.client?.instanceId)).size,
      ).toBe(1);
    } finally {
      await dispose();
      await server.close();
    }
  });

  it("builds every serving runtime over the one module byte cache it is given", async () => {
    const identity = await Identity.fromPassphrase("serving runtime factory");
    const server = newLoopbackServer({
      store: new URL(`memory://serving-runtime-${crypto.randomUUID()}`),
    });
    const moduleByteCache = new ProcessModuleByteCache();
    const createRuntime = servingRuntimeFactory({
      server,
      identity,
      apiUrl: new URL("http://localhost:9999/"),
      moduleByteCache,
    });
    const spaces = await Promise.all(
      [1, 2].map(async () => (await Identity.generate()).did() as MemorySpace),
    );
    const built = await Promise.all(
      spaces.map((space) => createRuntime(space, {})),
    );
    try {
      for (const { runtime } of built) {
        expect(runtime.moduleByteCache).toBe(moduleByteCache);
      }
    } finally {
      for (const { dispose } of built) await dispose();
      await server.close();
    }
  });
});
