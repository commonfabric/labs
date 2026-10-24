/**
 * A read with no shape of its own, where it crosses a stored link carrying a
 * schema: the view behind the link reads the keys that schema names through
 * views of their own and the rest as stored, following no link under them; a
 * host's read-out reads the same; and a subscription through it depends on
 * nothing a link under an unnamed key reaches.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { type Cell, hostValueOf, sinkProjected } from "../src/cell.ts";
import { isSigilLink } from "../src/link-types.ts";
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
  it("reads the keys the schema names, and the rest as stored with no link followed", async () => {
    await using docs = await documents();
    const view = docs.message.get() as { authorProfile: Profile };

    expect(Object.keys(view.authorProfile)).toEqual([
      "avatar",
      "extra",
      "inbox",
      "name",
    ]);
    expect(view.authorProfile.name).toBe("an author");
    expect(view.authorProfile.extra).toBe("not declared");
    // The unnamed `inbox` holds a link, which stays one: the inbox is not
    // read, so nothing of it, or of the catalog it links, is here.
    expect(isSigilLink(view.authorProfile.inbox)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(view.authorProfile, "inbox")?.value,
    ).toEqual(view.authorProfile.inbox);
  });

  it("reads out for a host the same way", async () => {
    await using docs = await documents();
    const value = hostValueOf(docs.message.get()) as {
      authorProfile: Profile;
      body: string;
    };

    expect(value.body).toBe("hello");
    expect(Object.keys(value.authorProfile)).toEqual([
      "avatar",
      "extra",
      "inbox",
      "name",
    ]);
    expect(value.authorProfile.name).toBe("an author");
    expect(isSigilLink(value.authorProfile.inbox)).toBe(true);
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

  it("follows every link where the schema admits additional properties", async () => {
    await using docs = await documents({
      ...profileSchema,
      additionalProperties: true,
    });

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

  it("subscribes through the link to nothing an unnamed key links", async () => {
    await using docs = await documents();
    const names: unknown[] = [];
    const cancel = sinkProjected(
      docs.message.key("authorProfile"),
      hostValueOf,
      (value) => {
        names.push((value as Profile).name);
      },
    );
    try {
      expect(names).toEqual(["an author"]);

      // What the unnamed `inbox` links changes, and what that links: nothing
      // is delivered.
      await docs.write(elsewhere, "catalog", { entries: { added: true } });
      await docs.write(elsewhere, "inbox", {
        catalog: docs.runtime.getCell(elsewhere, "catalog").getAsLink(),
        offers: [{ from: "someone" }],
      });
      expect(names).toEqual(["an author"]);

      // A named key changes: the new value is delivered.
      await docs.write(space, "profile", {
        name: "a renamed author",
        avatar: "a",
        extra: "not declared",
        inbox: docs.runtime.getCell(elsewhere, "inbox").getAsLink(),
      }, profileSchema);
      expect(names).toEqual(["an author", "a renamed author"]);
    } finally {
      cancel();
    }
  });
});
