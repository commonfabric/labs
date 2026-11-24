import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";
import { fromFileUrl, toFileUrl } from "@std/path";

import {
  getModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { Server } from "@commonfabric/memory/v2/server";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import {
  closeMemory,
  type MemoryEnvironment,
  memoryServer,
  openMemory,
} from "@/routes/storage/memory.ts";
import { MemoryRouterPolicy } from "@/routes/storage/memory-router.ts";
import { connects } from "@/test/support/connects.ts";
import { freePort } from "@/test/support/free-port.ts";

const TLS = new URL(
  "../../../memory/test/fixtures/routed-tls/",
  import.meta.url,
);

// Something with a `close()` that records the order it was called in, and
// rejects with `failure` when one is given.
const closable = (name: string, order: string[], failure?: Error) => ({
  close(): Promise<void> {
    order.push(name);
    return failure === undefined ? Promise.resolve() : Promise.reject(failure);
  },
});

describe("memory", () => {
  // Importing memory.ts opens the process's own memory server.
  afterAll(async () => {
    await memoryServer.close();
  });

  describe("closeMemory()", () => {
    it("closes the private listener and then the server", async () => {
      const order: string[] = [];

      await closeMemory(
        closable("server", order),
        closable("listener", order),
      );

      expect(order).toEqual(["listener", "server"]);
    });

    it("closes only the server when there is no private listener", async () => {
      const order: string[] = [];

      await closeMemory(closable("server", order), undefined);

      expect(order).toEqual(["server"]);
    });

    it("still closes the server, and throws the listener's failure", async () => {
      const order: string[] = [];
      const failure = new Error("listener stuck");

      await expect(
        closeMemory(
          closable("server", order),
          closable("listener", order, failure),
        ),
      ).rejects.toBe(failure);
      expect(order).toEqual(["listener", "server"]);
    });

    it("throws both failures when the server fails to close too", async () => {
      const listenerFailure = new Error("listener stuck");
      const serverFailure = new Error("store locked");

      const rejection = await closeMemory(
        closable("server", [], serverFailure),
        closable("listener", [], listenerFailure),
      ).then(() => undefined, (error: unknown) => error);

      if (!(rejection instanceof AggregateError)) {
        throw new Error(`Expected an AggregateError, got ${rejection}`);
      }
      expect(rejection.message).toBe("Memory cleanup failed");
      expect(rejection.errors).toEqual([listenerFailure, serverFailure]);
    });
  });

  describe("openMemory()", () => {
    let root: string;
    let store: URL;
    let space: string;
    let logged: string[];
    let logStub: { restore(): void };
    let modernCellRep: boolean;

    // A Mode A configuration file for a private listener on `port`.
    const routerConfig = async (port: number): Promise<string> => {
      const router = await Identity.fromRaw(new Uint8Array(32).fill(17));
      const directory = `${root}/directory.json`;
      Deno.writeTextFileSync(
        directory,
        JSON.stringify({
          version: 1,
          deployment: "test",
          toolsheds: [{ did: identity.did() }],
          spaces: { [space]: { toolshed: 0, epoch: 1 } },
        }),
      );
      const path = `${root}/router.json`;
      Deno.writeTextFileSync(
        path,
        JSON.stringify({
          version: 1,
          deployment: "test",
          hostname: "127.0.0.1",
          port,
          certificate: fromFileUrl(new URL("localhost.crt", TLS)),
          key: fromFileUrl(new URL("localhost.key", TLS)),
          directory,
          epochLedger: `${root}/epochs`,
          routers: { [router.did()]: ["127.0.0.1"] },
        }),
      );
      return path;
    };

    const environment = (
      overrides: Partial<MemoryEnvironment> = {},
    ): MemoryEnvironment => ({
      ...env,
      MEMORY_ROUTER_CONFIG_FILE: "",
      MEMORY_ACL_MODE: "enforce",
      DB_PATH: undefined,
      MEMORY_SERVICE_DIDS: "",
      ...overrides,
    });

    const reading = (values: Record<string, string>) => (name: string) =>
      values[name];

    beforeEach(async () => {
      root = Deno.makeTempDirSync();
      store = toFileUrl(`${root}/store/`);
      space = (await Identity.fromRaw(new Uint8Array(32).fill(18))).did();
      logged = [];
      logStub = stub(console, "log", (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
      modernCellRep = getModernCellRepConfig();
    });

    afterEach(() => {
      setModernCellRepConfig(modernCellRep);
      logStub.restore();
      Deno.removeSync(root, { recursive: true });
    });

    it("refuses Mode A unless ACLs are enforced", async () => {
      using start = spy(MemoryRouterPolicy.prototype, "start");
      const config = await routerConfig(freePort());

      await expect(
        openMemory(
          environment({
            MEMORY_ROUTER_CONFIG_FILE: config,
            MEMORY_ACL_MODE: "observe",
          }),
          reading({}),
          store,
        ),
      ).rejects.toThrow(
        "Mode A requires directory storage and enforced explicit ACLs",
      );
      expect(start.calls).toHaveLength(0);
    });

    it("refuses Mode A over single-file storage", async () => {
      const config = await routerConfig(freePort());

      await expect(
        openMemory(
          environment({
            MEMORY_ROUTER_CONFIG_FILE: config,
            DB_PATH: `${root}/memory.sqlite`,
          }),
          reading({}),
          store,
        ),
      ).rejects.toThrow(
        "Mode A requires directory storage and enforced explicit ACLs",
      );
    });

    it("closes the memory server it built when the Mode A listener cannot start", async () => {
      const config = await routerConfig(freePort());
      const failure = new Error("the listener could not bind");
      using _start = stub(
        MemoryRouterPolicy.prototype,
        "start",
        () => Promise.reject(failure),
      );
      using close = spy(Server.prototype, "close");

      await expect(
        openMemory(
          environment({ MEMORY_ROUTER_CONFIG_FILE: config }),
          reading({}),
          store,
        ),
      ).rejects.toBe(failure);
      expect(close.calls).toHaveLength(1);
    });

    it("starts the Mode A listener at the configured cell representation, and closes it with the server", async () => {
      setModernCellRepConfig(false);
      const port = freePort();
      const config = await routerConfig(port);

      const { server, memory } = await openMemory(
        environment({ MEMORY_ROUTER_CONFIG_FILE: config }),
        reading({ EXPERIMENTAL_MODERN_CELL_REP: "true" }),
        store,
      );

      try {
        expect(getModernCellRepConfig()).toBe(true);
        expect(server.options.requireExplicitAcl).toBe(true);
        expect(server.options.ownsSpace?.(space)).toBe(true);
        expect(server.options.ownsSpace?.(identity.did())).toBe(false);
        expect(server.options.createsSpace?.(space)).toBe(false);
        expect(server.options.authorizeConnection).toBeDefined();
        expect(await connects(port)).toBe(true);
      } finally {
        await memory.close();
      }
      expect(await connects(port)).toBe(false);
    });

    it("leaves the cell representation and space ownership alone without Mode A", async () => {
      setModernCellRepConfig(false);

      const { server, memory } = await openMemory(
        environment(),
        reading({ EXPERIMENTAL_MODERN_CELL_REP: "true" }),
        store,
      );
      await memory.close();

      expect(getModernCellRepConfig()).toBe(false);
      expect(server.options.ownsSpace).toBeUndefined();
      expect(server.options.authorizeConnection).toBeUndefined();
    });

    it("names the process identity a delegating principal under server execution", async () => {
      const { server, memory } = await openMemory(
        environment(),
        reading({ EXPERIMENTAL_SERVER_EXECUTION: "true" }),
        store,
      );
      await memory.close();

      expect(server.options.acl?.delegatingDids).toEqual([identity.did()]);
      expect(logged.some((line) => line.includes("server-execution v2 ON")))
        .toBe(true);
      expect(logged.some((line) => line.includes("Memory: NOTE"))).toBe(false);
    });

    it("notes a process identity the operator also lists as a service principal", async () => {
      const { server, memory } = await openMemory(
        environment({ MEMORY_SERVICE_DIDS: ` ${identity.did()} ,` }),
        reading({ EXPERIMENTAL_SERVER_EXECUTION: "true" }),
        store,
      );
      await memory.close();

      expect(server.options.acl?.serviceDids).toEqual([identity.did()]);
      expect(logged.some((line) => line.includes("Memory: NOTE"))).toBe(true);
    });

    it("logs nothing about server execution with it off", async () => {
      const { server, memory } = await openMemory(
        environment(),
        reading({ EXPERIMENTAL_SERVER_EXECUTION: "false" }),
        store,
      );
      await memory.close();

      expect(server.options.acl?.delegatingDids).toEqual([]);
      expect(logged.some((line) => line.includes("server-execution"))).toBe(
        false,
      );
    });

    it("logs which storage mode it opens", async () => {
      const dbPath = `${root}/memory.sqlite`;

      const single = await openMemory(
        environment({ DB_PATH: dbPath }),
        reading({}),
        store,
      );
      await single.memory.close();
      const directory = await openMemory(
        environment({ MEMORY_DIR: "file:///donuts/" }),
        reading({}),
        store,
      );
      await directory.memory.close();

      expect(logged).toContain(`Memory: Using single database file: ${dbPath}`);
      expect(logged).toContain("Memory: Using directory mode: file:///donuts/");
    });
  });
});
