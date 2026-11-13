/**
 * An address-only read of a collection that a piece's result holds behind a
 * link: `cf cell get --piece <id> blockedOn --schema
 * '{"type":"array","items":{"$link":true}}'`, where `blockedOn` stores a write
 * redirect to the document a pattern-local `Writable` keeps its array in.
 *
 * The reader is a client that ran nothing, the way `cf` reads under server
 * execution: the serving runtime wrote the documents, and the reader holds the
 * container behind the link only if the read loads it. A storage manager asks
 * for a link target once per document, the first time a read crosses to it, so
 * the read cannot count on crossing the link to load the container: in `cf`,
 * an earlier read of the same process has already taken that one request. The
 * reader here takes it before the read, which is the state the read meets.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type JSONSchema,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  deriveSelectedValue,
  parseSelectionProjection,
} from "../lib/cell-selection.ts";

const signer = await Identity.fromPassphrase("cf-select-addresses-behind-link");
const space = signer.did();

const itemSchema = {
  type: "object",
  properties: { title: { type: "string" } },
} as const satisfies JSONSchema;

const itemsSchema = {
  type: "array",
  items: itemSchema,
} as const satisfies JSONSchema;

const boardSchema = {
  type: "object",
  properties: {
    blockedOn: itemsSchema,
    inline: itemsSchema,
    empty: itemsSchema,
    dangling: itemsSchema,
  },
} as const satisfies JSONSchema;

describe("deriveSelectedValue() of addresses behind a link", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storages: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let items: Cell<unknown>[];

  /** A runtime over its own connection to the one server, as `cf` opens. */
  const connect = (): Runtime => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    storages.push(storage);
    const runtime = new Runtime(runtimePresets.remoteClient({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: {},
    }));
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(async () => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    storages = [];
    runtimes = [];

    const writer = connect();
    const tx = writer.edit();
    items = ["a", "b"].map((suffix) => {
      const item = writer.getCell(space, `item-${suffix}`, itemSchema, tx);
      item.set({ title: suffix });
      return item;
    });
    const container = writer.getCell(space, "blocked-on", itemsSchema, tx);
    container.setRaw(items.map((item) => item.getAsLink()) as never);
    writer.getCell(space, "board", boardSchema, tx).setRaw({
      blockedOn: container.getAsWriteRedirectLink({ includeSchema: true }),
      inline: items.map((item) => item.getAsLink()),
      // A link to a document nobody wrote.
      dangling: writer.getCell(space, "never-written", itemsSchema, tx)
        .getAsWriteRedirectLink({ includeSchema: true }),
    } as never);
    expect((await tx.commit().settled).ok).toBeDefined();
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const storage of storages) await storage.close();
    await server.close();
  });

  /**
   * The addresses a client that holds nothing reads at `field`, after the
   * link-target requests for the documents named by `reserved` are taken.
   */
  async function addressesAt(
    field: string,
    reserved: string[] = [],
  ): Promise<unknown> {
    const reader = connect();
    for (const cause of reserved) {
      const { id } = reader.getCell(space, cause).getAsNormalizedFullLink();
      expect(reader.storageManager.shouldPullDoc?.(space, id, "space"))
        .toBe(true);
    }
    return await deriveSelectedValue(
      reader,
      space,
      reader.getCell(space, "board", boardSchema).key(field) as Cell<unknown>,
      {
        projection: await parseSelectionProjection(
          '{"type":"array","items":{"$link":true}}',
        ),
      },
    );
  }

  const addressOf = (cell: Cell<unknown>) =>
    createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space);

  it("loads the container the link names, though crossing the link asks for nothing", async () => {
    expect(await addressesAt("blockedOn", ["blocked-on"])).toEqual(
      items.map((item) => ({ $link: addressOf(item) })),
    );
  });

  it("reads each element's address out of the container the link names", async () => {
    expect(await addressesAt("blockedOn")).toEqual(
      items.map((item) => ({ $link: addressOf(item) })),
    );
  });

  it("reads an array stored in the document itself the same way", async () => {
    expect(await addressesAt("inline")).toEqual(
      items.map((item) => ({ $link: addressOf(item) })),
    );
  });

  it("answers an unset collection with no addresses", async () => {
    expect(await addressesAt("empty")).toEqual([]);
  });

  it("answers a link to a document nobody wrote with no addresses", async () => {
    expect(await addressesAt("dangling", ["never-written"])).toEqual([]);
  });
});
