import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity, legacySpaceDid } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { type Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
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

  /** A runtime of its own over this test's server, as another process. */
  const openRuntime = (): Runtime => {
    const next = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
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
    await tx.commit();
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
        return runtime.resolveInSpaceNameSync(home, "raced", tx, grants);
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
    expect(runtime.resolveInSpaceNameSync(home, "aborted", tx, readable))
      .toBe(open);
    expect(runtime.resolveInSpaceNameSync(home, "aborted", tx, readable))
      .toBe(open);
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
