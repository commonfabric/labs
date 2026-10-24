/**
 * A read with no shape of its own, where it crosses a stored link carrying a
 * schema: the view behind the link shows what that schema names, a host's
 * read-out reads the same, and a subscription through it depends on no more.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { type Cell, hostValueOf, sinkProjected } from "../src/cell.ts";
import { KeepAsCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("view-declared-by-link");
const space = signer.did();
const elsewhere =
  (await Identity.fromPassphrase("view-declared-by-link elsewhere")).did();

/** The part of a profile a message's link declares. */
const profileSchema = {
  type: "object",
  properties: { name: { type: "string" }, avatar: { type: "string" } },
} as const;

type Profile = { name: string; avatar: string; extra: string; inbox: unknown };

/**
 * A runtime holding an inbox that links a catalog, a profile that links the
 * inbox beside fields a message's link does and does not declare, and a
 * message linking the profile under `schema`, or under none for `null`.
 * `write()` stores a document and waits for it to settle.
 */
async function documents(schema: unknown = profileSchema) {
  const profileLinkSchema = schema === null ? undefined : schema;
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  const write = async (
    where: string,
    id: string,
    value: unknown,
    withSchema?: unknown,
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(where as never, id, withSchema as never);
    cell.withTx(tx).setRawUntyped(value as never);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    return runtime.getCell(where as never, id, withSchema as never);
  };
  const catalog = await write(elsewhere, "catalog", { entries: {} });
  const inbox = await write(elsewhere, "inbox", {
    catalog: catalog.getAsLink(),
    offers: [],
  });
  const profile = await write(space, "profile", {
    name: "an author",
    avatar: "a",
    extra: "not declared",
    inbox: inbox.getAsLink(),
  }, profileLinkSchema);
  const message = await write(space, "message", {
    authorProfile: profile.getAsLink({
      includeSchema: true,
      keepAsCell: KeepAsCell.All,
    }),
    body: "hello",
  });
  return {
    runtime,
    write,
    message,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

describe("a view behind a link carrying a schema", () => {
  it("shows the keys the schema names, and no other", async () => {
    await using docs = await documents();
    const view = docs.message.get() as { authorProfile: Profile };

    expect(Object.keys(view.authorProfile)).toEqual(["avatar", "name"]);
    expect(view.authorProfile.name).toBe("an author");
    expect("extra" in view.authorProfile).toBe(false);
    expect(view.authorProfile.extra).toBeUndefined();
    expect(view.authorProfile.inbox).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(view.authorProfile, "extra"),
    ).toBeUndefined();
  });

  it("reads out for a host as the schema names it", async () => {
    await using docs = await documents();

    expect(hostValueOf(docs.message.get())).toEqual({
      authorProfile: { avatar: "a", name: "an author" },
      body: "hello",
    });
  });

  it("shows every key behind a link carrying no schema", async () => {
    await using docs = await documents(null);

    expect(hostValueOf(docs.message.get())).toEqual({
      authorProfile: {
        name: "an author",
        avatar: "a",
        extra: "not declared",
        inbox: { catalog: { entries: {} }, offers: [] },
      },
      body: "hello",
    });
  });

  it("shows every key where the schema admits additional properties", async () => {
    await using docs = await documents({
      ...profileSchema,
      additionalProperties: true,
    });
    const view = docs.message.get() as { authorProfile: Profile };

    expect(Object.keys(view.authorProfile)).toEqual([
      "avatar",
      "extra",
      "inbox",
      "name",
    ]);
    expect(view.authorProfile.extra).toBe("not declared");
  });

  it("subscribes through the link to the named keys alone", async () => {
    await using docs = await documents();
    const values: unknown[] = [];
    const cancel = sinkProjected(
      docs.message.key("authorProfile"),
      hostValueOf,
      (value) => {
        values.push(value);
      },
    );
    try {
      expect(values).toEqual([{ avatar: "a", name: "an author" }]);

      // What the unnamed keys hold or link changes: nothing is delivered.
      await docs.write(elsewhere, "catalog", { entries: { added: true } });
      await docs.write(space, "profile", {
        name: "an author",
        avatar: "a",
        extra: "changed",
        inbox: docs.runtime.getCell(elsewhere, "inbox").getAsLink(),
      }, profileSchema);
      expect(values).toHaveLength(1);

      // A named key changes: the new value is delivered.
      await docs.write(space, "profile", {
        name: "a renamed author",
        avatar: "a",
        extra: "changed",
        inbox: docs.runtime.getCell(elsewhere, "inbox").getAsLink(),
      }, profileSchema);
      expect(values).toEqual([
        { avatar: "a", name: "an author" },
        { avatar: "a", name: "a renamed author" },
      ]);
    } finally {
      cancel();
    }
  });
});
