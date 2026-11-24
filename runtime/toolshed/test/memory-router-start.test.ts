import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { fromFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { RoutedMemoryHost } from "@commonfabric/memory/v2/routed-host";
import { Server } from "@commonfabric/memory/v2/server";
import { identity } from "@/lib/identity.ts";
import { connects } from "@/test/support/connects.ts";
import {
  MemoryRouterPolicy,
  type Repeat,
} from "@/routes/storage/memory-router.ts";

const TLS = new URL("../../memory/test/fixtures/routed-tls/", import.meta.url);

describe("MemoryRouterPolicy", () => {
  describe("instance members", () => {
    describe("start()", () => {
      let root: string;
      let directory: string;
      let space: string;
      let router: string;
      let server: Server;
      const configured = (certificate: string): MemoryRouterPolicy => {
        const path = `${root}/config.json`;
        Deno.writeTextFileSync(
          path,
          JSON.stringify({
            version: 1,
            deployment: "test",
            hostname: "127.0.0.1",
            port: 0,
            certificate,
            key: fromFileUrl(new URL("localhost.key", TLS)),
            directory,
            epochLedger: `${root}/epochs`,
            routers: { [router]: ["127.0.0.1"] },
          }),
        );
        return new MemoryRouterPolicy(path);
      };
      const place = (epoch: number) =>
        Deno.writeTextFileSync(
          directory,
          JSON.stringify({
            version: 1,
            deployment: "test",
            toolsheds: [{ did: identity.did() }],
            spaces: { [space]: { toolshed: 0, epoch } },
          }),
        );
      const certificate = fromFileUrl(new URL("localhost.crt", TLS));

      beforeEach(async () => {
        root = Deno.makeTempDirSync();
        directory = `${root}/directory.json`;
        router = (await Identity.fromRaw(new Uint8Array(32).fill(17))).did();
        space = (await Identity.fromRaw(new Uint8Array(32).fill(18))).did();
        place(1);
        server = new Server({
          store: new URL("memory://memory-router-start"),
          acl: { mode: "enforce" },
          ownsSpace: (did) => did === space,
          requireExplicitAcl: true,
          authorizeSessionOpen: () => undefined,
          sessionOpenAuth: { audience: identity.did() },
        });
      });

      afterEach(async () => {
        await server.close();
        Deno.removeSync(root, { recursive: true });
      });

      it("listens on the configured private address until closed", async () => {
        const listener = await configured(certificate).start(server);

        expect(listener.port).toBeGreaterThan(0);
        expect(listener.port).toBeLessThanOrEqual(65535);
        expect(await connects(listener.port)).toBe(true);
        await listener.close();
        expect(await connects(listener.port)).toBe(false);
      });

      it("fences the host's contexts only when this toolshed's ownership changes", async () => {
        using fence = stub(RoutedMemoryHost.prototype, "fenceOwnership");
        const ticks: (() => void)[] = [];
        let stopped = 0;
        const repeat: Repeat = (tick) => {
          ticks.push(tick);
          return () => stopped++;
        };
        const listener = await configured(certificate).start(server, repeat);
        expect(ticks).toHaveLength(1);
        const [tick] = ticks;

        tick();
        expect(fence.calls).toHaveLength(0);
        place(2);
        tick();
        expect(fence.calls).toHaveLength(1);
        tick();
        expect(fence.calls).toHaveLength(1);

        expect(stopped).toBe(0);
        await listener.close();
        expect(stopped).toBe(1);
      });

      it("rethrows without scheduling the fence when the listener cannot start", async () => {
        let scheduled = false;
        const repeat: Repeat = () => {
          scheduled = true;
          return () => {};
        };

        await expect(
          configured(`${root}/missing.crt`).start(server, repeat),
        ).rejects.toThrow(Deno.errors.NotFound);
        expect(scheduled).toBe(false);
      });
    });

    describe("listsToolshed()", () => {
      let root: string;
      let directory: string;
      let router: string;
      let peer: string;
      let stranger: string;
      const list = (toolsheds: string[]) =>
        Deno.writeTextFileSync(
          directory,
          JSON.stringify({
            version: 1,
            deployment: "test",
            toolsheds: toolsheds.map((did) => ({ did })),
            spaces: {},
          }),
        );
      const configured = (): MemoryRouterPolicy => {
        const path = `${root}/config.json`;
        Deno.writeTextFileSync(
          path,
          JSON.stringify({
            version: 1,
            deployment: "test",
            hostname: "127.0.0.1",
            port: 8444,
            certificate: `${root}/public.crt`,
            key: `${root}/key`,
            directory,
            epochLedger: `${root}/epochs`,
            routers: { [router]: ["127.0.0.1"] },
          }),
        );
        return new MemoryRouterPolicy(path);
      };

      beforeEach(async () => {
        root = Deno.makeTempDirSync();
        directory = `${root}/directory.json`;
        router = (await Identity.fromRaw(new Uint8Array(32).fill(17))).did();
        peer = (await Identity.fromRaw(new Uint8Array(32).fill(19))).did();
        stranger = (await Identity.fromRaw(new Uint8Array(32).fill(20))).did();
      });

      afterEach(() => {
        Deno.removeSync(root, { recursive: true });
      });

      it("returns `true` for each toolshed the directory lists and `false` for any other DID", () => {
        list([identity.did(), peer]);
        const policy = configured();

        expect(policy.listsToolshed(identity.did())).toBe(true);
        expect(policy.listsToolshed(peer)).toBe(true);
        expect(policy.listsToolshed(stranger)).toBe(false);
        expect(policy.listsToolshed(router)).toBe(false);
      });

      it("follows the directory as toolsheds are added and removed", () => {
        list([identity.did()]);
        const policy = configured();
        expect(policy.listsToolshed(peer)).toBe(false);

        list([identity.did(), peer]);
        expect(policy.listsToolshed(peer)).toBe(true);

        list([identity.did()]);
        expect(policy.listsToolshed(peer)).toBe(false);
      });

      it("returns `false` for every DID while the directory lists a router as a toolshed", () => {
        using _logged = stub(console, "error");
        list([identity.did(), peer]);
        const policy = configured();

        list([identity.did(), peer, router]);

        expect(policy.listsToolshed(router)).toBe(false);
        expect(policy.listsToolshed(peer)).toBe(false);
        expect(policy.available).toBe(false);
      });

      it("returns `false` for every DID while the directory cannot be read", () => {
        using _logged = stub(console, "error");
        list([identity.did(), peer]);
        const policy = configured();

        Deno.removeSync(directory);

        expect(policy.listsToolshed(peer)).toBe(false);
        expect(policy.listsToolshed(identity.did())).toBe(false);
      });
    });
  });
});
