import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity, legacySpaceDid } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import { readSpaceKind } from "@commonfabric/memory/v2/genesis-root";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { type Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { InSpaceTargetUnresolved } from "../src/scheduler/retry-immediately.ts";
import type { ACL, MemorySpace, URI } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("in-space allocation signer");
const home = signer.did();

const recordSchema = {
  type: "object",
  properties: { did: { type: "string" } },
} as const;

describe("in-space allocation", () => {
  let server: MemoryV2Server.Server;
  let runtime: Runtime;
  const opened: Runtime[] = [];

  /**
   * A runtime of its own over this test's server, as another process, with
   * server execution on when `serverExecution` says so. Such a runtime is a
   * client: none here takes the serving posture.
   */
  const openRuntime = (serverExecution = false): Runtime => {
    const next = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      ...(serverExecution ? { experimental: { serverExecution: true } } : {}),
    });
    opened.push(next);
    return next;
  };

  /** The DID the allocation record `space` holds for `name`, if any. */
  const recorded = async (
    reader: Runtime,
    space: MemorySpace,
    name: string,
  ): Promise<string | undefined> => {
    const record = reader.getCell(
      space,
      { inSpaceAllocation: { space, name } },
      recordSchema,
    );
    await record.sync();
    return record.get()?.did;
  };

  /** Writes the allocation record `space` holds for `name`. */
  const writeRecord = async (
    space: MemorySpace,
    name: string,
    did: string,
  ): Promise<void> => {
    const result = await runtime.editWithRetry((tx) => {
      runtime.getCell(
        space,
        { inSpaceAllocation: { space, name } },
        recordSchema,
        tx,
      ).set({ did });
    });
    expect(result.error).toBeUndefined();
    await runtime.storageManager.synced();
  };

  /** The access-control document of `space`, as the server holds it. */
  const aclOf = async (space: MemorySpace): Promise<unknown> =>
    (await server.readDocument(space, aclDocId(space) as URI))?.value;

  /**
   * Runs a root pattern whose `create` handler appends one child per call of
   * `inSpace` it makes, and returns a way to send it events and read the
   * spaces its children landed in.
   */
  const spawnRoot = async (
    make: (Child: any, value: string) => unknown[],
  ) => {
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const create = handler<
      { value: string },
      { children: Cell<unknown[]> }
    >({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    }, {
      type: "object",
      properties: { children: { asCell: ["cell"] } },
      required: ["children"],
    }, ({ value }, { children }) => {
      for (const child of make(Child, value)) children.push(child);
    });
    const Root = pattern<{ children: Cell<unknown[]> }>(
      ({ children }) => ({ children, create: create({ children }) }),
      {
        type: "object",
        properties: { children: { asCell: ["cell"] } },
        required: ["children"],
      } as const,
    );
    const tx = runtime.edit();
    const children = runtime.getCell<unknown[]>(
      home,
      `in-space allocation children ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    children.set([]);
    const result = runtime.run(
      tx,
      Root,
      { children },
      runtime.getCell(
        home,
        `in-space allocation root ${crypto.randomUUID()}`,
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    return {
      send: async (value: string) => {
        result.key("create").send({ value });
        await runtime.idle();
        await runtime.storageManager.synced();
      },
      spaces: async (): Promise<string[]> => {
        await children.pull();
        return (children.getRaw() as unknown[]).map((raw) =>
          parseLink(raw, children)!.space!
        );
      },
    };
  };

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = openRuntime();
  });

  afterEach(async () => {
    for (const each of opened.splice(0)) await each.dispose();
    await server.close();
  });

  it("puts a named child in the space the calling space's record names", async () => {
    const root = await spawnRoot((Child, value) => [
      Child.inSpace("notebook")({ value }),
    ]);
    await root.send("first");

    const [space] = await root.spaces();
    expect(space).toBe(await recorded(runtime, home, "notebook"));
    expect(space).not.toBe(home);
    expect(space).not.toBe(await legacySpaceDid("notebook"));
    expect(await runtime.spaceExists(space as MemorySpace)).toBe(true);
  });

  it("creates one space for a name two calls in one handler use, with the grants of the first", async () => {
    const create = runtime.createSpace.bind(runtime);
    let created = 0;
    runtime.createSpace = (options) => {
      created++;
      return create(options);
    };
    const root = await spawnRoot((Child, value) => [
      Child.inSpace("shared", { grants: { "*": "READ" } })({ value }),
      Child.inSpace("shared")({ value }),
    ]);
    await root.send("pair");

    const [first, second] = await root.spaces();
    expect(second).toBe(first);
    expect(created).toBe(1);
    expect(await aclOf(first as MemorySpace)).toEqual({
      "*": "READ",
      [signer.did()]: "OWNER",
    });
  });

  it("puts two anonymous calls in one handler in two spaces", async () => {
    const root = await spawnRoot((Child, value) => [
      Child.inSpace()({ value }),
      Child.inSpace()({ value }),
    ]);
    await root.send("pair");

    const spaces = await root.spaces();
    expect(spaces.length).toBe(2);
    expect(spaces[0]).not.toBe(spaces[1]);
  });

  it("puts the children of two events with identical inputs in two spaces", async () => {
    const root = await spawnRoot((Child, value) => [
      Child.inSpace()({ value }),
    ]);
    await root.send("same");
    await root.send("same");

    const spaces = await root.spaces();
    expect(spaces.length).toBe(2);
    expect(spaces[0]).not.toBe(spaces[1]);
  });

  it("puts a name used from two calling spaces in two spaces", async () => {
    const other = (await Identity.generate()).did();

    const fromHome = await runtime.resolveInSpaceName(home, "shared");
    const fromOther = await runtime.resolveInSpaceName(other, "shared");

    expect(fromHome).not.toBe(fromOther);
  });

  it("creates a space for each distinct request for an unrecorded name, and returns each request its own", async () => {
    const readable = { "*": "READ" } as const;
    const [open, closed, again] = await Promise.all([
      runtime.resolveInSpaceName(home, "raced", { grants: readable }),
      runtime.resolveInSpaceName(home, "raced"),
      runtime.resolveInSpaceName(home, "raced", { grants: readable }),
    ]);

    expect(again).toBe(open);
    expect(closed).not.toBe(open);
    expect(await aclOf(open)).toEqual({
      "*": "READ",
      [signer.did()]: "OWNER",
    });
    expect(await aclOf(closed)).toEqual({ [signer.did()]: "OWNER" });
    const resolvedSync = (grants?: ACL) => {
      const tx = runtime.edit();
      try {
        return runtime.resolveInSpaceNameSync(home, "raced", tx, { grants });
      } finally {
        tx.abort();
      }
    };
    expect(resolvedSync(readable)).toBe(open);
    expect(resolvedSync()).toBe(closed);
  });

  it("hands a later request nothing from a record an aborted transaction wrote", async () => {
    const readable = { "*": "READ" } as const;
    const open = await runtime.resolveInSpaceName(home, "aborted", {
      grants: readable,
    });
    const tx = runtime.edit();
    expect(
      runtime.resolveInSpaceNameSync(home, "aborted", tx, { grants: readable }),
    ).toBe(open);
    expect(
      runtime.resolveInSpaceNameSync(home, "aborted", tx, { grants: readable }),
    ).toBe(open);
    tx.abort();

    const later = runtime.edit();
    try {
      expect(runtime.resolveInSpaceNameSync(home, "aborted", later))
        .toBeUndefined();
    } finally {
      later.abort();
    }
    expect(await recorded(runtime, home, "aborted")).toBeUndefined();
  });

  it("returns the recorded space to a later process resolving the name", async () => {
    const root = await spawnRoot((Child, value) => [
      Child.inSpace("notebook")({ value }),
    ]);
    await root.send("first");
    const [space] = await root.spaces();

    const later = openRuntime();
    expect(await later.resolveInSpaceName(home, "notebook")).toBe(space);
  });

  it("returns a written record's space without writing another", async () => {
    const existing = await runtime.createSpace();
    await writeRecord(home, "kept", existing);

    expect(await runtime.resolveInSpaceName(home, "kept")).toBe(existing);
    const tx = runtime.edit();
    try {
      expect(runtime.resolveInSpaceNameSync(home, "kept", tx)).toBe(existing);
    } finally {
      tx.abort();
    }
    expect(await recorded(runtime, home, "kept")).toBe(existing);
  });

  describe("under server execution", () => {
    /** Counts the spaces `reader`'s storage manager creates. */
    const countCreatedSpaces = (reader: Runtime): () => number => {
      const manager = reader.storageManager as {
        createSpace: (...args: never[]) => Promise<MemorySpace>;
      };
      const original = manager.createSpace.bind(manager);
      let created = 0;
      manager.createSpace = (...args) => {
        created++;
        return original(...args);
      };
      return () => created;
    };

    it("leaves a name with no record unresolved on a client, and creates no space for it", async () => {
      const client = openRuntime(true);
      const created = countCreatedSpaces(client);

      await expect(client.resolveInSpaceName(home, "client-unrecorded"))
        .rejects.toThrow(InSpaceTargetUnresolved);
      expect(created()).toBe(0);
      expect(await recorded(client, home, "client-unrecorded"))
        .toBeUndefined();
    });

    it("returns a recorded space to a client", async () => {
      const existing = await runtime.createSpace();
      await writeRecord(home, "client-recorded", existing);
      const client = openRuntime(true);
      const created = countCreatedSpaces(client);

      expect(await client.resolveInSpaceName(home, "client-recorded"))
        .toBe(existing);
      expect(created()).toBe(0);
    });

    it("creates a space for a name with no record when server execution is off", async () => {
      const created = countCreatedSpaces(runtime);

      expect(await runtime.resolveInSpaceName(home, "off-unrecorded"))
        .toBeDefined();
      expect(created()).toBe(1);
    });
  });

  it("throws for a record that names a DID no space answers to", async () => {
    const missing = (await Identity.generate()).did();
    await writeRecord(home, "dangling", missing);

    await expect(runtime.resolveInSpaceName(home, "dangling")).rejects
      .toThrow("no space has that DID");
    expect(await runtime.spaceExists(missing)).toBe(false);
  });

  it("throws the failure of a load that decides whether the recorded space exists", async () => {
    const existing = await runtime.createSpace();
    await writeRecord(home, "unreadable", existing);
    const provider = runtime.storageManager.open(existing);
    const sync = provider.sync.bind(provider);
    provider.sync = (uri, ...rest) =>
      uri === aclDocId(existing)
        ? Promise.resolve({ error: new Error("the load failed") })
        : sync(uri, ...rest);

    await expect(runtime.resolveInSpaceName(home, "unreadable")).rejects
      .toThrow("the load failed");
  });

  it("resolves a resolved name again without suspending", async () => {
    const tx = runtime.edit();
    try {
      expect(runtime.resolveInSpaceNameSync(home, "later", tx)).toBe(
        undefined,
      );
    } finally {
      tx.abort();
    }
    const space = await runtime.resolveInSpaceName(home, "later");

    for (let attempt = 0; attempt < 3; attempt++) {
      const retry = runtime.edit();
      try {
        expect(runtime.resolveInSpaceNameSync(home, "later", retry)).toBe(
          space,
        );
      } finally {
        retry.abort();
      }
    }
  });

  it("creates the space with the grants the call names", async () => {
    const space = await runtime.resolveInSpaceName(home, "readable", {
      grants: { "*": "READ" },
    });

    expect(await aclOf(space)).toEqual({
      "*": "READ",
      [signer.did()]: "OWNER",
    });
  });

  it("creates a space whose grants name another principal OWNER, with the creator an OWNER too", async () => {
    const member = (await Identity.generate()).did();
    const root = await spawnRoot((Child, value) => [
      Child.inSpace("co-owned", { grants: { [member]: "OWNER" } })({ value }),
    ]);
    await root.send("first");

    const [space] = await root.spaces();
    expect(await aclOf(space as MemorySpace)).toEqual({
      [member]: "OWNER",
      [signer.did()]: "OWNER",
    });
  });

  it("creates a space whose creator is an OWNER when the grants name it at a lower level", async () => {
    const member = (await Identity.generate()).did();
    const space = await runtime.resolveInSpaceName(home, "demoted", {
      grants: { [signer.did()]: "READ", [member]: "OWNER" },
    });

    expect(await aclOf(space)).toEqual({
      [member]: "OWNER",
      [signer.did()]: "OWNER",
    });
  });

  describe("a declared space kind", () => {
    /** The kind the genesis receipt of `space` declares, as the server reads it. */
    const sealedKindOf = async (space: string) =>
      readSpaceKind(await server.engineForSpace(space));

    it("declares the kind the call names in the genesis of the space it creates, with `root` and without", async () => {
      const root = await spawnRoot((Child, value) => [
        value === "room"
          ? Child.inSpace("room", { spaceKind: "fabrichat-room" })({ value })
          : value === "notebook"
          ? Child.inSpace(undefined, { root: true, spaceKind: "notebook" })({
            value,
          })
          : Child.inSpace("plain")({ value }),
      ]);
      await root.send("room");
      await root.send("notebook");
      await root.send("plain");

      const [room, notebook, plain] = await root.spaces();
      expect(await sealedKindOf(room)).toBe("fabrichat-room");
      expect(await sealedKindOf(notebook)).toBe("notebook");
      expect(await sealedKindOf(plain)).toBeUndefined();
      const reader = openRuntime();
      expect(await reader.spaceKind(room as MemorySpace)).toBe(
        "fabrichat-room",
      );
      expect(await reader.spaceKind(notebook as MemorySpace)).toBe("notebook");
      expect(await reader.spaceKind(plain as MemorySpace)).toBeUndefined();
    });

    it("creates a space for each kind requested for an unrecorded name, and returns each request its own", async () => {
      const [room, plain, again, notebook] = await Promise.all([
        runtime.resolveInSpaceName(home, "kinded", {
          spaceKind: "fabrichat-room",
        }),
        runtime.resolveInSpaceName(home, "kinded"),
        runtime.resolveInSpaceName(home, "kinded", {
          spaceKind: "fabrichat-room",
        }),
        runtime.resolveInSpaceName(home, "kinded", { spaceKind: "notebook" }),
      ]);

      expect(again).toBe(room);
      expect(new Set([room, plain, notebook]).size).toBe(3);
      expect(await sealedKindOf(room)).toBe("fabrichat-room");
      expect(await sealedKindOf(plain)).toBeUndefined();
      expect(await sealedKindOf(notebook)).toBe("notebook");
      const resolvedSync = (spaceKind?: string) => {
        const tx = runtime.edit();
        try {
          return runtime.resolveInSpaceNameSync(home, "kinded", tx, {
            ...(spaceKind === undefined ? {} : { spaceKind }),
          });
        } finally {
          tx.abort();
        }
      };
      expect(resolvedSync("fabrichat-room")).toBe(room);
      expect(resolvedSync()).toBe(plain);
      expect(resolvedSync("notebook")).toBe(notebook);
    });

    it("returns the space a name's record names, whatever kind a later request names", async () => {
      const space = await runtime.resolveInSpaceName(home, "unkinded");
      await writeRecord(home, "unkinded", space);

      expect(
        await runtime.resolveInSpaceName(home, "unkinded", {
          spaceKind: "fabrichat-room",
        }),
      ).toBe(space);
      expect(await sealedKindOf(space)).toBeUndefined();
    });

    it("throws for a kind with a space named by its DID or by a cell", () => {
      const { pattern } = createTrustedBuilder(runtime).commonfabric;
      const Child = pattern<{ value: string }>(({ value }) => ({ value }));
      const cell = runtime.getCell(home, "in-space kind target");

      for (const target of [home, cell]) {
        expect(() => Child.inSpace(target, { spaceKind: "notebook" })).toThrow(
          "declares the kind only of a space it creates",
        );
        expect(() => Child.inSpace(target)).not.toThrow();
      }
    });

    it("throws for a kind that is not lowercase words joined by hyphens, whatever the caller's type says", () => {
      const { pattern } = createTrustedBuilder(runtime).commonfabric;
      const Child = pattern<{ value: string }>(({ value }) => ({ value }));

      for (
        const spaceKind of ["Notebook", "", "fabrichat room", "k".repeat(33)]
      ) {
        expect(() => Child.inSpace("room", { spaceKind })).toThrow(
          "declares a space kind of lowercase words joined by hyphens",
        );
      }
      expect(() => Child.inSpace("room", { spaceKind: 7 as unknown as string }))
        .toThrow("declares a space kind of lowercase words joined by hyphens");
      expect(() => Child.inSpace("room", { spaceKind: "fabrichat-room" })).not
        .toThrow();
    });
  });

  it("throws for a grant beyond READ, WRITE, or OWNER, whatever the caller's type says", () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const grants = { "*": "ADMIN" } as unknown as Record<string, "READ">;

    expect(() => Child.inSpace("admin", { grants })).toThrow(
      "grants READ, WRITE, or OWNER only",
    );
    expect(() => Child.inSpace("read", { grants: { "*": "READ" } })).not
      .toThrow();
  });

  it("throws for an OWNER grant to `*`, whatever the caller's type says", () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const grants = { "*": "OWNER" } as unknown as Record<string, "READ">;

    expect(() => Child.inSpace("owned", { grants })).toThrow(
      "grants OWNER only to a principal DID",
    );
  });

  it("throws for an OWNER grant to a principal that is not a DID, whatever the caller's type says", () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const grants = { alice: "OWNER" } as unknown as Record<string, "READ">;

    expect(() => Child.inSpace("owned", { grants })).toThrow(
      "grants OWNER only to a principal DID",
    );
  });

  it("creates the space with the grants as they were when `inSpace()` was called", async () => {
    const root = await spawnRoot((Child, value) => {
      const grants: Record<string, string> = { "*": "READ" };
      const Mutated = Child.inSpace("mutated", { grants });
      grants["*"] = "OWNER";
      return [Mutated({ value })];
    });
    await root.send("first");

    const [space] = await root.spaces();
    expect(await aclOf(space as MemorySpace)).toEqual({
      "*": "READ",
      [signer.did()]: "OWNER",
    });
  });

  it("settles two processes resolving one name on one record", async () => {
    const second = openRuntime();
    const record = async (writer: Runtime) => {
      await writer.resolveInSpaceName(home, "contended");
      const result = await writer.editWithRetry((tx) =>
        writer.resolveInSpaceNameSync(home, "contended", tx)
      );
      expect(result.error).toBeUndefined();
      await writer.storageManager.synced();
    };

    await Promise.all([record(runtime), record(second)]);

    const winner = await recorded(runtime, home, "contended");
    expect(winner).toBeDefined();
    expect(await recorded(second, home, "contended")).toBe(winner);
    for (const each of [runtime, second]) {
      const tx = each.edit();
      try {
        expect(each.resolveInSpaceNameSync(home, "contended", tx)).toBe(
          winner,
        );
      } finally {
        tx.abort();
      }
    }
  });
});
