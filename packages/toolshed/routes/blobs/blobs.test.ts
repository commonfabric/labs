import { expect } from "@std/expect";
import { afterAll, afterEach, beforeAll, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";
import { hashOf } from "@commonfabric/data-model";
import { newDefaultJsonCodecEngine } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  encodeMemoryBoundary,
  MAX_UNTRUSTED_MESSAGE_SLOTS,
} from "@commonfabric/memory/v2";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import router from "./blobs.index.ts";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import { memoryServer } from "@/routes/storage/memory.ts";
import memory from "@/routes/storage/memory/memory.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp()
  .route("/", memory)
  .route("/", router);

const encodeBlobPayload = (payload: { type: string; body: FabricBytes }) =>
  encodeMemoryBoundary(payload);

const blobUploadCodec = newDefaultJsonCodecEngine();

describe("Blob Routes", () => {
  let server: Deno.HttpServer;
  let base: URL;

  beforeAll(() => {
    server = Deno.serve({ port: 0, onListen: () => {} }, app.fetch);
    const address = server.addr as Deno.NetAddr;
    base = new URL(`http://${address.hostname}:${address.port}`);
  });

  afterEach(async () => {
    await memoryServer.flushSessions();
  });

  afterAll(async () => {
    // The toolshed `memoryServer` is a module-level singleton constructed when
    // memory.ts is imported. Deno isolates each test file's module graph, so
    // this instance is owned by this file alone. Closing it releases its SQLite
    // handles, engine map, and refresh timer.
    await server.shutdown();
    await memoryServer.close();
  });

  const bootstrapHomeSpace = async (identity: Identity) => {
    const storageManager = StorageManager.open({
      as: identity,
      memoryHost: base,
    });
    try {
      const aclId = `of:${identity.did()}` as URI;
      const sync = await storageManager.open(identity.did()).sync(aclId);
      expect(sync).toEqual({ ok: {} });
    } finally {
      await storageManager.close();
    }
  };

  it("stores and serves a FabricBytes blob by content id", async () => {
    const identity = await Identity.fromPassphrase("toolshed-blob-route");
    await bootstrapHomeSpace(identity);
    const bytes = new Uint8Array([71, 73, 70, 56, 57, 97]);
    const contents = {
      type: "image/gif",
      body: new FabricBytes(bytes),
    };
    const id = hashOf(contents).toString();
    const hash = id.slice("fid1:".length);

    const post = await app.request(`/${identity.did()}/blobs/image.gif`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBlobPayload(contents),
    });
    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({
      id,
      url: `blobs/${hash}.gif`,
    });

    const get = await app.request(`/${identity.did()}/blobs/${hash}.png`);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("image/gif");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("accepts blob upload encoding from an explicit codec", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-explicit-codec",
    );
    await bootstrapHomeSpace(identity);
    const bytes = new Uint8Array([71, 73, 70, 56, 57, 97]);
    const contents = {
      type: "image/gif",
      body: new FabricBytes(bytes),
    };
    const id = hashOf(contents).toString();
    const hash = id.slice("fid1:".length);

    const post = await app.request(`/${identity.did()}/blobs/image.gif`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: blobUploadCodec.encode(contents),
    });
    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({
      id,
      url: `blobs/${hash}.gif`,
    });

    const get = await app.request(`/${identity.did()}/blobs/${hash}.gif`);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("stores blob contents as a cell document value", async () => {
    const identity = await Identity.fromPassphrase("toolshed-blob-cell");
    await bootstrapHomeSpace(identity);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const contents = {
      type: "image/png",
      body: new FabricBytes(bytes),
    };
    const id = hashOf(contents).toString();
    const cid = `cid:${id}` as const;
    const hash = id.slice("fid1:".length);

    const post = await app.request(`/${identity.did()}/blobs/image.png`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBlobPayload(contents),
    });
    expect(post.status).toBe(201);

    const document = await memoryServer.readDocument(
      identity.did(),
      cid,
    );
    expect(document?.value).toEqual(contents);

    const runtime = new Runtime({
      apiUrl: base,
      storageManager: StorageManager.open({
        as: identity,
        memoryHost: new URL(base),
      }),
    });

    try {
      const provider = runtime.storageManager.open(identity.did());
      const sync = await provider.sync(cid, {
        path: [],
        schema: false,
      });
      expect(sync).toEqual({ ok: {} });

      const cell = runtime.getCellFromLink<{
        type: string;
        body: FabricBytes;
      }>({
        id: cid,
        path: [],
        space: identity.did(),
      });
      await cell.sync();
      await runtime.storageManager.synced();

      const value = cell.get();
      expect(value.type).toBe("image/png");
      expect(value.body).toBeTruthy();
      expect(value.body.constructor.name).toBe("FabricBytes");
      expect((await post.json()).url).toBe(`blobs/${hash}.png`);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns 404 for an absent blob", async () => {
    const identity = await Identity.fromPassphrase("toolshed-blob-route-404");
    const get = await app.request(`/${identity.did()}/blobs/missing.png`);
    expect(get.status).toBe(404);
  });

  it("returns 400 for a malformed blob name", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-bad-name",
    );
    const get = await app.request(`/${identity.did()}/blobs/.png`);
    expect(get.status).toBe(400);
  });

  it("falls back to the MIME default for invalid upload suffixes", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-suffix",
    );
    await bootstrapHomeSpace(identity);
    const contents = {
      type: "image/png",
      body: new FabricBytes(new Uint8Array([1, 2, 3])),
    };
    const id = hashOf(contents).toString();
    const hash = id.slice("fid1:".length);

    const post = await app.request(`/${identity.did()}/blobs/image.toolonggg`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBlobPayload(contents),
    });

    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({
      id,
      url: `blobs/${hash}.png`,
    });
  });

  it("rejects oversized blob uploads before decoding", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-too-large",
    );

    const post = await app.request(`/${identity.did()}/blobs/image.png`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(10 * 1024 * 1024 + 1),
      },
      body: "not decoded",
    });

    expect(post.status).toBe(413);
  });

  it("serves unsafe blob MIME types as octet-stream", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-unsafe-mime",
    );
    await bootstrapHomeSpace(identity);
    const bytes = new TextEncoder().encode("<script>alert(1)</script>");
    const contents = {
      type: "text/html",
      body: new FabricBytes(bytes),
    };
    const id = hashOf(contents).toString();
    const hash = id.slice("fid1:".length);

    const post = await app.request(`/${identity.did()}/blobs/page.html`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeBlobPayload(contents),
    });
    expect(post.status).toBe(201);

    const get = await app.request(`/${identity.did()}/blobs/${hash}.html`);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("refuses an upload whose body is an array of numbers", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-number-array",
    );
    const post = await app.request(`/${identity.did()}/blobs/image.gif`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeMemoryBoundary({ type: "image/gif", body: [71, 73, 70] }),
    });
    expect(post.status).toBe(400);
  });

  it("refuses an upload standing for more slots than a memory message may", async () => {
    // The body is valid bytes; the extra member is what the limit refuses,
    // since nothing else about the upload reads it.
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-slot-limit",
    );
    const padding: FabricValue[] = [];
    padding[MAX_UNTRUSTED_MESSAGE_SLOTS] = 1;
    const post = await app.request(`/${identity.did()}/blobs/image.gif`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeMemoryBoundary({
        type: "image/gif",
        body: new FabricBytes(new Uint8Array([71, 73, 70])),
        padding,
      }),
    });
    expect(post.status).toBe(400);
  });

  it("serves a stored blob whose body is an array of numbers", async () => {
    const identity = await Identity.fromPassphrase(
      "toolshed-blob-route-stored-array",
    );
    await bootstrapHomeSpace(identity);
    const contents = { type: "image/gif", body: [71, 73, 70] };
    const id = hashOf(contents).toString();
    await memoryServer.writeDocument(identity.did(), `cid:${id}`, contents);

    const get = await app.request(
      `/${identity.did()}/blobs/${id.slice("fid1:".length)}.gif`,
    );
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(
      new Uint8Array([71, 73, 70]),
    );
  });

  it("rejects invalid blob payloads", async () => {
    const identity = await Identity.fromPassphrase("toolshed-blob-route-400");
    const post = await app.request(`/${identity.did()}/blobs/image.gif`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "image/gif", body: "not-bytes" }),
    });
    expect(post.status).toBe(400);
  });
});
