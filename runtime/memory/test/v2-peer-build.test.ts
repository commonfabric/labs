import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
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
});
