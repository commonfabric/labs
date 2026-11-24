import { expect } from "@std/expect";
import { fromFileUrl, toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Database } from "@db/sqlite";

import { Identity } from "@commonfabric/identity";

import type { DID } from "../interface.ts";
import { Server } from "../v2/server.ts";
import { authorizeLoopbackSessionOpen } from "../v2/session-open-auth.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

describe("v2-flush-space", () => {
  let directory: string;
  let server: Server;
  let space: DID;
  let path: string;

  beforeEach(async () => {
    directory = await Deno.makeTempDir();
    const store = toFileUrl(directory + "/");
    space = (await Identity.generate()).did();
    path = fromFileUrl(resolveSpaceStoreUrl(store, space));
    server = new Server({
      store,
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: space },
    });
    await server.writeDocument(space, "of:checkpoint-probe", { value: 1 });
  });

  afterEach(async () => {
    await server.close();
    await Deno.remove(directory, { recursive: true });
  });

  it("makes completed writes available from the database after checkpoint", async () => {
    await server.flushSpace(space);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM "commit"').get()?.count)
        .toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects a missing space without creating an empty store", async () => {
    const missing = (await Identity.generate()).did();
    const missingPath = fromFileUrl(resolveSpaceStoreUrl(
      toFileUrl(directory + "/"),
      missing,
    ));
    await expect(server.flushSpace(missing)).rejects.toThrow(
      "Cannot flush an unavailable space",
    );
    await expect(Deno.stat(missingPath)).rejects.toThrow(Deno.errors.NotFound);
  });

  it("rejects an existing store with no committed history", async () => {
    const empty = (await Identity.generate()).did();
    expect(await server.readDocument(empty, "of:checkpoint-probe")).toBeNull();
    await expect(server.flushSpace(empty)).rejects.toThrow(
      "Cannot flush a space without history",
    );
  });

  it("throws while a reader prevents the full checkpoint and succeeds once it releases", async () => {
    const reader = new Database(path, { readonly: true });
    try {
      reader.exec("BEGIN");
      reader.prepare('SELECT COUNT(*) FROM "commit"').get();
      await server.writeDocument(space, "of:checkpoint-probe", { value: 2 });
      await expect(server.flushSpace(space)).rejects.toThrow(
        "Space durability checkpoint could not complete",
      );
      reader.exec("ROLLBACK");
      await server.flushSpace(space);
      expect((await server.readDocument(space, "of:checkpoint-probe"))?.value)
        .toEqual({ value: 2 });
    } finally {
      reader.close();
    }
  });
});
