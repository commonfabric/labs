import { assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { Runtime } from "@commonfabric/runner";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import { describe, it } from "@commonfabric/test-support/test";
import {
  startIndexedCollectionHost,
  stopIndexedCollectionHost,
} from "@/lib/indexed-collection-host.ts";

const config = {
  MEMORY_URL: "http://toolshed.test",
  API_URL: "http://toolshed.test",
  API_INTERNAL_URL: undefined,
};

/** Returns a reader of `values`, as the environment would be read. */
const envOf = (values: Record<string, string>) => (name: string) =>
  values[name];

describe("indexed-collection-host", () => {
  it("starts nothing under server execution", async () => {
    const server = new MemoryServer({
      store: new URL(`memory://indexed-collection-host-${crypto.randomUUID()}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-indexed-collection-host" },
    });
    try {
      expect(
        startIndexedCollectionHost({
          server,
          identity: await Identity.fromPassphrase("indexed collection host"),
          config,
          envGet: envOf({ EXPERIMENTAL_SERVER_EXECUTION: "true" }),
        }),
      ).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("returns a host with server execution off, which builds no runtime before a space lists a collection", async () => {
    const server = new MemoryServer({
      store: new URL(`memory://indexed-collection-host-${crypto.randomUUID()}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-indexed-collection-host" },
    });
    try {
      const host = startIndexedCollectionHost({
        server,
        identity: await Identity.fromPassphrase("indexed collection host"),
        config,
        envGet: envOf({ EXPERIMENTAL_SERVER_EXECUTION: "false" }),
      });

      expect(host).toBeDefined();
      expect(host?.runtime).toBeUndefined();
    } finally {
      await stopIndexedCollectionHost();
      await server.close();
    }
  });

  it("builds its runtime from this toolshed's options, signed by the service, once a space lists a collection", async () => {
    const server = new MemoryServer({
      store: new URL(`memory://indexed-collection-host-${crypto.randomUUID()}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-indexed-collection-host" },
    });
    const identity = await Identity.fromPassphrase("indexed collection host");
    const alice = await Identity.fromPassphrase("indexed collection alice");
    const space = alice.did();
    const client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: LoopbackStorageManager.connect(server, { as: alice }),
      experimental: { serverExecution: false },
      indexedCollectionMaintenance: "none",
    });
    /** Commits `value` to the document `cause` names in alice's space. */
    const write = async (cause: string, value: Record<string, string>) => {
      const tx = client.edit();
      client.getCell<Record<string, string>>(space, cause, undefined, tx).set(
        value,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
    };
    try {
      const host = startIndexedCollectionHost({
        server,
        identity,
        config,
        envGet: envOf({
          EXPERIMENTAL_SERVER_EXECUTION: "false",
          EXPERIMENTAL_AGENT_BUILTIN: "true",
        }),
      });
      assertExists(host);

      // A space whose registry is unwritten lists no collection.
      await write("unrelated", { note: "no collection here" });
      await Promise.all(host.accessForTestingOnly.reads);
      expect(host.runtime).toBeUndefined();

      // The space's registry of indexed collections is the document of this
      // cause; any write to it marks the space as listing a collection.
      await write("indexed-collection-registry", {});
      const runtime = host.runtime;
      assertExists(runtime);
      expect(runtime.apiUrl.href).toBe(new URL(config.MEMORY_URL).href);
      expect(runtime.storageManager.as.did()).toBe(identity.did());
      expect(runtime.experimental.serverExecution).toBe(false);
      expect(runtime.experimental.agentBuiltin).toBe(true);
      await runtime.settled();
    } finally {
      await stopIndexedCollectionHost();
      await client.dispose();
      await server.close();
    }
  });
});
