import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  getGlobalLogFloor,
  getLogger,
  setGlobalLogFloor,
} from "@commonfabric/logger";
import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

describe("memory peer build diagnostics", () => {
  it("reports the serving process and refreshes or clears it on reopen", async () => {
    const options = {
      ...testSessionOpenServerOptions,
      store: new URL("memory://peer-build"),
      serverBuild: "a".repeat(40),
    };
    const server = new Server(options);
    const client = await connect({ transport: loopback(server) });
    try {
      const session = await client.mount(
        "did:key:z6Mk-peer-build",
        {},
        testSessionOpenAuthFactory,
      );
      expect(session.buildDiagnostics.peer).toBe(options.serverBuild);
      // Source client provenance is absent; this is not an incompatibility.
      expect(session.buildDiagnostics.relation).toBe("unknown");
      options.serverBuild = "b".repeat(40);
      await session.restore();
      expect(session.buildDiagnostics.peer).toBe(options.serverBuild);
      options.serverBuild = "invalid-marker";
      await session.restore();
      expect(session.buildDiagnostics.peer).toBeUndefined();
      options.serverBuild = "";
      await session.restore();
      expect(session.buildDiagnostics.peer).toBeUndefined();
      expect(session.closeError).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("logs the space and the peer's build at `debug` on open and on reopen", async () => {
    // The client's logger prints to `console.debug` unless `LOG_TO_STDERR`
    // asks for stderr, so the case clears that and any global floor for its
    // length.

    const logger = getLogger("memory.v2.client");
    const level = logger.level;
    const floor = getGlobalLogFloor();
    const toStderr = Deno.env.get("LOG_TO_STDERR");
    const logged: unknown[][] = [];
    const options = {
      ...testSessionOpenServerOptions,
      store: new URL("memory://peer-build-debug"),
      serverBuild: "c".repeat(40),
    };
    const server = new Server(options);
    const client = await connect({ transport: loopback(server) });
    logger.level = "debug";
    setGlobalLogFloor(undefined);
    Deno.env.delete("LOG_TO_STDERR");
    try {
      using _debug = stub(console, "debug", (...args: unknown[]) => {
        if (args[2] === "peer-build") logged.push(args.slice(3));
      });
      const space = "did:key:z6Mk-peer-build-debug";
      const session = await client.mount(space, {}, testSessionOpenAuthFactory);
      options.serverBuild = "d".repeat(40);
      await session.restore();

      expect(logged).toEqual([
        [space, expect.objectContaining({ peer: "c".repeat(40) })],
        [space, expect.objectContaining({ peer: "d".repeat(40) })],
      ]);
    } finally {
      logger.level = level;
      setGlobalLogFloor(floor);
      if (toStderr !== undefined) Deno.env.set("LOG_TO_STDERR", toStderr);
      await client.close();
      await server.close();
    }
  });
});
