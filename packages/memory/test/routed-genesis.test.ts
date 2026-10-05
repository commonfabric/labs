import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import { Identity } from "@commonfabric/identity";

import type { MemorySpace } from "../interface.ts";
import type { ServerMessage } from "../v2.ts";
import { encodeMemoryBoundary, getMemoryProtocolFlags } from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

const did = async (seed: number) =>
  (await Identity.fromRaw(new Uint8Array(32).fill(seed))).did();
const owner = await did(41);
const stranger = await did(42);
const audience = await did(44);
const hello = {
  type: "hello",
  protocol: "memory",
  flags: getMemoryProtocolFlags(),
};

/** A Mode A server on a file store that owns every DID. */
function modeA(
  { createsSpace, serviceDids }: {
    createsSpace?: (space: string) => boolean;
    serviceDids?: string[];
  } = {},
) {
  const root = Deno.makeTempDirSync();
  const store = toFileUrl(`${root}/`);
  const server = new Server({
    store,
    subscriptionRefreshDelayMs: "manual",
    authorizeSessionOpen: () => undefined,
    authorizeConnection: () => undefined,
    sessionOpenAuth: { audience },
    ownsSpace: () => true,
    requireExplicitAcl: true,
    createsSpace,
    acl: { mode: "enforce", serviceDids },
  });
  return {
    server,
    store,
    storeExists(space: string) {
      try {
        Deno.statSync(resolveSpaceStoreUrl(store, space as MemorySpace));
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await server.close();
      Deno.removeSync(root, { recursive: true });
    },
  };
}

/** A routed connection that has authenticated `principal`. */
async function connect(server: Server, principal: string) {
  const out: ServerMessage[] = [];
  const connection = server.connectRouted((m) => out.push(m), () => true);
  await connection.receive(encodeMemoryBoundary(hello));
  connection.admitRoutedPrincipal(
    principal,
    Math.floor(Date.now() / 1000) + 600,
  );
  let next = 0;
  const request = async (body: Record<string, unknown>) => {
    const requestId = `r${next++}`;
    await connection.receive(encodeMemoryBoundary({ ...body, requestId }));
    const response = out.find((m) =>
      m.type === "response" && m.requestId === requestId
    );
    if (response?.type !== "response") {
      throw new Error(`no response to ${body.type}`);
    }
    return response;
  };
  return {
    request,
    open: (space: string) =>
      request({ type: "session.open", space, principal, session: {} }),
    write: (space: string, sessionId: string, id: string, value: unknown) =>
      request({
        type: "transact",
        space,
        sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id, value: { value } }],
        },
      }),
  };
}

const sessionOf = (response: { ok?: unknown }) =>
  (response.ok as { sessionId: string }).sessionId;

describe("Mode A space creation", () => {
  it("lets a new space's own DID write its genesis ACL, which then governs", async () => {
    const mode = modeA();
    try {
      const space = await did(43);
      const creator = await connect(mode.server, space);
      const opened = await creator.open(space);
      expect(opened.error).toBeUndefined();
      const genesis = await creator.write(
        space,
        sessionOf(opened),
        `of:${space}`,
        { [owner]: "OWNER" },
      );
      expect(genesis.error).toBeUndefined();
      expect(mode.storeExists(space)).toBe(true);

      const asOwner = await connect(mode.server, owner);
      const ownerSession = await asOwner.open(space);
      expect(ownerSession.error).toBeUndefined();
      const write = await asOwner.write(
        space,
        sessionOf(ownerSession),
        "of:profile",
        { name: "owner" },
      );
      expect(write.error).toBeUndefined();
      const refused = await (await connect(mode.server, stranger)).open(space);
      expect(refused.error?.name).toBe("AuthorizationError");
    } finally {
      await mode.close();
    }
  });

  it("refuses anyone else's open of a DID with no store, and creates none", async () => {
    const mode = modeA();
    try {
      const space = await did(45);
      const refused = await (await connect(mode.server, stranger)).open(space);
      expect(refused.error?.name).toBe("AuthorizationError");
      expect(mode.storeExists(space)).toBe(false);
    } finally {
      await mode.close();
    }
  });

  it("admits only the space's own DID, and only for an ACL, until its genesis lands", async () => {
    const mode = modeA();
    try {
      const space = await did(46);
      const creator = await connect(mode.server, space);
      const opened = await creator.open(space);
      expect(opened.error).toBeUndefined();
      expect(mode.storeExists(space)).toBe(true);
      // The store now exists with no history; it still admits nobody else.
      const refused = await (await connect(mode.server, stranger)).open(space);
      expect(refused.error?.name).toBe("AuthorizationError");
      // An ordinary first write would leave the space without an owner.
      const ordinary = await creator.write(
        space,
        sessionOf(opened),
        "of:data",
        { value: 1 },
      );
      expect(ordinary.error?.name).toBe("AuthorizationError");
    } finally {
      await mode.close();
    }
  });

  it("refuses to create a listed space whose store is not here, even to its own DID", async () => {
    const listed = await did(48);
    const mode = modeA({ createsSpace: (space) => space !== listed });
    try {
      const refused = await (await connect(mode.server, listed)).open(listed);
      expect(refused.error?.name).toBe("AuthorizationError");
      expect(mode.storeExists(listed)).toBe(false);
    } finally {
      await mode.close();
    }
  });

  it("refuses disk sources on a routed connection, before and after genesis", async () => {
    const mode = modeA();
    const outside = Deno.makeTempFileSync({ suffix: ".sqlite" });
    try {
      const space = await did(49);
      const creator = await connect(mode.server, space);
      const opened = await creator.open(space);
      const register = (sessionId: string) =>
        creator.request({
          type: "sqlite.register-disk-source",
          space,
          sessionId,
          id: "of:outside",
          path: outside,
        });
      expect((await register(sessionOf(opened))).error?.name).toBe(
        "AuthorizationError",
      );
      const genesis = await creator.write(
        space,
        sessionOf(opened),
        `of:${space}`,
        { [space]: "OWNER" },
      );
      expect(genesis.error).toBeUndefined();
      expect((await register(sessionOf(opened))).error?.name).toBe(
        "AuthorizationError",
      );
    } finally {
      Deno.removeSync(outside);
      await mode.close();
    }
  });

  it("registers disk sources only for service DIDs, on any connection", async () => {
    const service = await did(50);
    const mode = modeA({ serviceDids: [service] });
    const outside = Deno.makeTempFileSync({ suffix: ".sqlite" });
    const database = new Database(outside);
    database.exec("CREATE TABLE lookup (value TEXT)");
    database.close();
    try {
      const space = await did(51);
      const creator = await connect(mode.server, space);
      const opened = await creator.open(space);
      const genesis = await creator.write(
        space,
        sessionOf(opened),
        `of:${space}`,
        { [space]: "OWNER" },
      );
      expect(genesis.error).toBeUndefined();
      // The server method stands for a direct connection's request.
      const register = (sessionId: string) =>
        mode.server.sqliteRegisterDiskSource({
          type: "sqlite.register-disk-source",
          requestId: crypto.randomUUID(),
          space,
          sessionId,
          id: "of:outside",
          path: outside,
        });
      expect((await register(sessionOf(opened))).error?.name).toBe(
        "AuthorizationError",
      );
      const operator = await (await connect(mode.server, service)).open(space);
      expect(operator.error).toBeUndefined();
      expect((await register(sessionOf(operator))).error).toBeUndefined();
    } finally {
      Deno.removeSync(outside);
      await mode.close();
    }
  });

  it("refuses a populated space without an ACL, even to its own DID", async () => {
    const mode = modeA();
    try {
      const space = await did(47);
      const url = resolveSpaceStoreUrl(mode.store, space as MemorySpace);
      Deno.mkdirSync(dirname(fromFileUrl(url)), { recursive: true });
      const engine = await Engine.open({ url });
      Engine.applyCommit(engine, {
        sessionId: "legacy",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:legacy",
            value: { value: { written: "before ACLs" } },
          }],
        },
      });
      Engine.close(engine);
      const refused = await (await connect(mode.server, space)).open(space);
      expect(refused.error?.name).toBe("AuthorizationError");
    } finally {
      await mode.close();
    }
  });
});
