import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
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
});
