/**
 * A read with no shape of its own, where it meets a stored link carrying a
 * schema: a read of the position holding the link takes the link's schema as
 * its own and reads what it names, a host's read-out reads each link it
 * follows the same way, and a query-result view reads whatever it is asked
 * for, alike for every reader that reaches it.
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
  const link = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });
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
  }, schema === null ? undefined : schema);
  const message = await write(space, "message", {
    authorProfile: link(profile),
    body: "hello",
  });
  return {
    runtime,
    write,
    link,
    message,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

describe("a shapeless read of a position holding a link carrying a schema", () => {
  it("reads what the link's schema names, and nothing else the target holds", async () => {
    await using docs = await documents();

    expect(docs.message.key("authorProfile").get()).toEqual({
      avatar: "a",
      name: "an author",
    });
  });

  it("reads the same through a slot its reader's schema leaves open", async () => {
    await using docs = await documents();
    const open = docs.runtime.getCell(space, "message", {
      type: "object",
      properties: { authorProfile: true, body: { type: "string" } },
    } as never);

    expect((open.get() as { authorProfile: unknown }).authorProfile).toEqual({
      avatar: "a",
      name: "an author",
    });
  });

  it("reads everything behind a link carrying no schema", async () => {
    await using docs = await documents(null);

    expect(hostValueOf(docs.message.key("authorProfile").get())).toEqual({
      name: "an author",
      avatar: "a",
      extra: "not declared",
      inbox: { catalog: { entries: {} }, offers: [] },
    });
  });

  it("reads everything where the link's schema admits additional properties", async () => {
    await using docs = await documents({
      ...profileSchema,
      additionalProperties: true,
    });

    expect(hostValueOf(docs.message.key("authorProfile").get())).toEqual({
      name: "an author",
      avatar: "a",
      extra: "not declared",
      inbox: { catalog: { entries: {} }, offers: [] },
    });
  });

  it("reads everything behind a link whose schema declares no shape, as a default alone", async () => {
    await using docs = await documents({ default: {} });

    expect(hostValueOf(docs.message.key("authorProfile").get())).toEqual({
      name: "an author",
      avatar: "a",
      extra: "not declared",
      inbox: { catalog: { entries: {} }, offers: [] },
    });
  });

  it("subscribes to what the link's schema names alone", async () => {
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

      // What the profile holds outside its declaration changes, and what its
      // inbox links: nothing is delivered.
      await docs.write(elsewhere, "catalog", { entries: { added: true } });
      await docs.write(elsewhere, "inbox", {
        catalog: docs.runtime.getCell(elsewhere, "catalog").getAsLink(),
        offers: [{ from: "someone" }],
      });
      await docs.write(space, "profile", {
        name: "an author",
        avatar: "a",
        extra: "changed",
        inbox: docs.runtime.getCell(elsewhere, "inbox").getAsLink(),
      }, profileSchema);
      expect(names).toEqual(["an author"]);

      // A named field changes: the new value is delivered.
      await docs.write(space, "profile", {
        name: "a renamed author",
        avatar: "a",
        extra: "changed",
        inbox: docs.runtime.getCell(elsewhere, "inbox").getAsLink(),
      }, profileSchema);
      expect(names).toEqual(["an author", "a renamed author"]);
    } finally {
      cancel();
    }
  });
});

describe("a host's read-out of a link it follows", () => {
  it("reads the target as the link's schema names it", async () => {
    await using docs = await documents();

    expect(hostValueOf(docs.message.get())).toEqual({
      authorProfile: { avatar: "a", name: "an author" },
      body: "hello",
    });
  });

  it("reads each link under its own schema, two links to one target apart", async () => {
    await using docs = await documents();
    // Two declarations naming the same root key and different ones below,
    // in a member and in an array's items, and two naming fields spelled
    // like schema annotations. Each named field holds a link to its text,
    // followed only under the declaration naming it.
    const declaring = (field: string) => ({
      type: "object",
      properties: {
        child: { type: "object", properties: { [field]: { type: "string" } } },
        list: {
          type: "array",
          items: {
            type: "object",
            properties: { [field]: { type: "string" } },
          },
        },
        [field]: { type: "string" },
      },
    });
    const text = (id: string) => docs.write(space, id, `text ${id}`);
    const fields = ["a", "b", "title", "description"];
    const texts = await Promise.all(fields.map(text));
    const record = await docs.write(
      space,
      "record",
      Object.fromEntries(fields.map((f, i) => [f, texts[i].getAsLink()])),
    );
    await docs.write(space, "target", {
      child: record.getAsLink(),
      list: [record.getAsLink()],
      ...Object.fromEntries(fields.map((f, i) => [f, texts[i].getAsLink()])),
    });
    const typed = (field: string) =>
      docs.link(
        docs.runtime.getCell(space, "target", declaring(field) as never),
      );
    await docs.write(
      space,
      "holder",
      Object.fromEntries(fields.map((f) => [f, typed(f)])),
    );

    const out = hostValueOf(
      docs.runtime.getCell(space, "holder").get(),
    ) as Record<string, Record<string, unknown>>;
    for (const field of fields) {
      expect(out[field]).toEqual({
        child: { [field]: `text ${field}` },
        list: [{ [field]: `text ${field}` }],
        [field]: `text ${field}`,
      });
    }
  });

  it("reads a link as the direct read of its position does: a union, a default, a nested handle", async () => {
    const declarations = {
      union: {
        anyOf: [
          {
            type: "object",
            properties: {
              name: { type: "string" },
              avatar: { type: "string" },
            },
          },
          { type: "null" },
        ],
      },
      defaulted: {
        type: "object",
        properties: {
          name: { type: "string" },
          avatar: { type: "string", default: "none" },
        },
      },
      handle: {
        type: "object",
        properties: {
          name: { type: "string" },
          inbox: { type: "object", asCell: ["cell"] },
        },
      },
    } as const;
    for (const [kind, schema] of Object.entries(declarations)) {
      await using docs = await documents(schema);
      if (kind === "defaulted") {
        await docs.write(space, "profile", {
          name: "an author",
          extra: "not declared",
        }, schema);
      }
      const direct = hostValueOf(
        docs.message.key("authorProfile").get(),
      ) as Record<string, unknown>;
      const readOut = (hostValueOf(docs.message.get()) as {
        authorProfile: Record<string, unknown>;
      }).authorProfile;

      expect(readOut).toEqual(direct);
      expect(readOut.extra).toBeUndefined();
      if (kind === "union") expect(readOut.inbox).toBeUndefined();
      if (kind === "defaulted") expect(readOut.avatar).toBe("none");
      if (kind === "handle") expect(isSigilLink(readOut.inbox)).toBe(true);
    }
  });

  it("subscribes through the read-out to nothing a link's schema leaves out", async () => {
    // A union declaration, so the walk has a branch to select.
    await using docs = await documents({
      anyOf: [
        {
          type: "object",
          properties: { name: { type: "string" }, avatar: { type: "string" } },
        },
        { type: "null" },
      ],
    });
    const deliveries: unknown[] = [];
    const cancel = sinkProjected(docs.message, hostValueOf, (value) => {
      deliveries.push(value);
    });
    try {
      expect(deliveries).toHaveLength(1);
      await docs.write(elsewhere, "catalog", { entries: { added: true } });
      await docs.write(elsewhere, "inbox", {
        catalog: docs.runtime.getCell(elsewhere, "catalog").getAsLink(),
        offers: [{ from: "someone" }],
      });
      expect(deliveries).toHaveLength(1);
    } finally {
      cancel();
    }
  });

  it("follows a member's link under the member's own declaration, not the document's", async () => {
    // The profile's `child` is a link carrying no schema to a record whose
    // `title` is a link to its text. The profile's declaration names
    // `child.title` and no `title` of its own, so the record's `title` is
    // read only under the member's declaration.
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        child: {
          type: "object",
          properties: { title: { type: "string" } },
        },
      },
    } as const;
    await using docs = await documents(schema);
    const text = await docs.write(space, "title", "a linked title");
    const child = await docs.write(space, "child", {
      title: text.getAsLink(),
      secret: "s",
    });
    await docs.write(space, "profile", {
      name: "an author",
      child: child.getAsLink(),
    }, schema);

    expect(hostValueOf(docs.message.get())).toEqual({
      authorProfile: { name: "an author", child: { title: "a linked title" } },
      body: "hello",
    });
  });
});

describe("a query-result view behind a link carrying a schema", () => {
  it("is the view every reader of the position gets, whatever link it came through", async () => {
    await using docs = await documents();
    const profile = docs.runtime.getCell(space, "profile");
    await docs.write(space, "both", {
      typed: docs.link(profile),
      plain: profile.getAsLink(),
    });
    const both = docs.runtime.getCell(space, "both").get() as {
      typed: Profile;
      plain: Profile;
    };

    expect(both.typed).toBe(both.plain);
    expect(both.typed.extra).toBe("not declared");
  });
});
