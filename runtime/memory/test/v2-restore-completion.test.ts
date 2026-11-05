import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

describe("v2-restore-completion", () => {
  it("keeps restoration pending across a failed attempt until a successful restore", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://restore-completion"),
    });
    const client = await connect({ transport: loopback(server) });
    const session = await client.mount(
      "did:key:z6Mk-restore-completion",
      {},
      testSessionOpenAuthFactory,
    );
    const failedOpen = Promise.withResolvers<never>();
    const opening = Promise.withResolvers<void>();
    const error = new Error("injected reconnect failure");
    const held = stub(client, "openSession", () => {
      opening.resolve();
      return failedOpen.promise;
    });
    try {
      const first = session.restore();
      const failed = expect(first).rejects.toBe(error);
      let result = "pending";
      const ready = session.whenRestored().then(() => {
        result = "restored";
      }, () => {
        result = "rejected";
      });
      await opening.promise;
      failedOpen.reject(error);
      await failed;
      expect(result).toBe("pending");
      held.restore();
      await session.restore();
      await ready;
      expect(result).toBe("restored");
    } finally {
      if (!held.restored) held.restore();
      await client.close();
      await server.close();
    }
  });

  it("rejects a pending restoration barrier when its session closes", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://restore-closed"),
    });
    const client = await connect({ transport: loopback(server) });
    const session = await client.mount(
      "did:key:z6Mk-restore-closed",
      {},
      testSessionOpenAuthFactory,
    );
    const failedOpen = Promise.withResolvers<never>();
    const opening = Promise.withResolvers<void>();
    const error = new Error("injected reconnect failure");
    const held = stub(client, "openSession", () => {
      opening.resolve();
      return failedOpen.promise;
    });
    try {
      const first = session.restore();
      const failed = expect(first).rejects.toBe(error);
      const ready = session.whenRestored().then(
        () => undefined,
        (failure) => failure,
      );
      await opening.promise;
      failedOpen.reject(error);
      await failed;
      await session.close();
      expect(await ready).toBe(session.closeError);
      await expect(session.whenRestored()).rejects.toBe(session.closeError);
    } finally {
      held.restore();
      await client.close();
      await server.close();
    }
  });
});
