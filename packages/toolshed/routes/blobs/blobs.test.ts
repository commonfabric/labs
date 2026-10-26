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
    expect(get.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(get.headers.get("Content-Disposition")).toBe("inline");
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
    expect(get.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(get.headers.get("Content-Disposition")).toBe("attachment");
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

  describe("named blobs", () => {
    const bytes = new Uint8Array([71, 73, 70, 56, 57, 97]);

    const uploadTo = async (path: string, payload: FabricValue) =>
      await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: encodeMemoryBoundary(payload),
      });

    it("gives the same bytes a different id under a name than under none", async () => {
      const identity = await Identity.fromPassphrase("toolshed-blob-named-id");
      await bootstrapHomeSpace(identity);
      const unnamed = { type: "image/gif", body: new FabricBytes(bytes) };
      const named = { ...unnamed, name: "photo.gif" };

      const postUnnamed = await uploadTo(
        `/${identity.did()}/blobs/image.gif`,
        unnamed,
      );
      const postNamed = await uploadTo(
        `/${identity.did()}/blobs/image.gif`,
        named,
      );

      const unnamedId = (await postUnnamed.json()).id;
      const namedId = (await postNamed.json()).id;
      expect(unnamedId).toBe(hashOf(unnamed).toString());
      expect(namedId).toBe(hashOf(named).toString());
      expect(namedId).not.toBe(unnamedId);
      const document = await memoryServer.readDocument(
        identity.did(),
        `cid:${namedId}`,
      );
      expect(document?.value).toEqual(named);
    });

    it("serves a blob of a type it serves as itself inline, under its name", async () => {
      const identity = await Identity.fromPassphrase(
        "toolshed-blob-named-inline",
      );
      await bootstrapHomeSpace(identity);
      const contents = {
        type: "image/gif",
        body: new FabricBytes(bytes),
        name: "café (1).gif",
      };
      const hash = hashOf(contents).toString().slice("fid1:".length);

      const post = await uploadTo(
        `/${identity.did()}/blobs/image.gif`,
        contents,
      );
      expect(post.status).toBe(201);

      const get = await app.request(`/${identity.did()}/blobs/${hash}.gif`);
      expect(get.status).toBe(200);
      expect(get.headers.get("Content-Disposition")).toBe(
        `inline; filename="caf_ (1).gif"; ` +
          `filename*=UTF-8''caf%C3%A9%20%281%29.gif`,
      );
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
    });

    it("serves a blob of a type it serves as itself as an attachment when asked to download it", async () => {
      const identity = await Identity.fromPassphrase(
        "toolshed-blob-named-download",
      );
      await bootstrapHomeSpace(identity);
      const contents = {
        type: "image/gif",
        body: new FabricBytes(bytes),
        name: "photo.gif",
      };
      const hash = hashOf(contents).toString().slice("fid1:".length);

      const post = await uploadTo(
        `/${identity.did()}/blobs/image.gif`,
        contents,
      );
      expect(post.status).toBe(201);

      const get = await app.request(
        `/${identity.did()}/blobs/${hash}.gif?download`,
      );
      expect(get.headers.get("Content-Type")).toBe("image/gif");
      expect(get.headers.get("Content-Disposition")).toBe(
        `attachment; filename="photo.gif"; filename*=UTF-8''photo.gif`,
      );
    });

    it("serves a blob of a type it serves as octet-stream as an attachment, under its name", async () => {
      const identity = await Identity.fromPassphrase(
        "toolshed-blob-named-attachment",
      );
      await bootstrapHomeSpace(identity);
      const contents = {
        type: "application/pdf",
        body: new FabricBytes(bytes),
        name: `say "hi".pdf`,
      };
      const hash = hashOf(contents).toString().slice("fid1:".length);

      const post = await uploadTo(`/${identity.did()}/blobs/doc.pdf`, contents);
      expect(post.status).toBe(201);

      const get = await app.request(`/${identity.did()}/blobs/${hash}.pdf`);
      expect(get.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(get.headers.get("Content-Disposition")).toBe(
        `attachment; filename="say _hi_.pdf"; ` +
          `filename*=UTF-8''say%20%22hi%22.pdf`,
      );
    });

    it("takes the URL suffix from the name when the upload path names no blob", async () => {
      const identity = await Identity.fromPassphrase(
        "toolshed-blob-named-suffix",
      );
      await bootstrapHomeSpace(identity);
      const contents = {
        type: "application/pdf",
        body: new FabricBytes(bytes),
        name: "report.pdf",
      };
      const hash = hashOf(contents).toString().slice("fid1:".length);

      const post = await uploadTo(`/${identity.did()}/blobs`, contents);

      expect(post.status).toBe(201);
      expect((await post.json()).url).toBe(`blobs/${hash}.pdf`);
    });

    it("returns 400 for an upload whose name is not a non-empty well-formed string of at most 1024 bytes", async () => {
      const identity = await Identity.fromPassphrase(
        "toolshed-blob-named-invalid",
      );
      const names: FabricValue[] = [
        "",
        "\ud800.gif",
        "é".repeat(512) + "x",
        7,
        ["photo.gif"],
      ];
      for (const name of names) {
        const post = await uploadTo(`/${identity.did()}/blobs/image.gif`, {
          type: "image/gif",
          body: new FabricBytes(bytes),
          name,
        });
        expect({ name, status: post.status }).toEqual({ name, status: 400 });
      }
    });

    it("returns 201 for an upload whose name is 1024 bytes as UTF-8", async () => {
      const identity = await Identity.fromPassphrase(
        "toolshed-blob-named-longest",
      );
      await bootstrapHomeSpace(identity);

      const post = await uploadTo(`/${identity.did()}/blobs/image.gif`, {
        type: "image/gif",
        body: new FabricBytes(bytes),
        name: "é".repeat(512),
      });

      expect(post.status).toBe(201);
    });

    it("serves a name holding control characters encoded in the header", async () => {
      const identity = await Identity.fromPassphrase(
        "toolshed-blob-named-control",
      );
      await bootstrapHomeSpace(identity);
      const contents = {
        type: "image/gif",
        body: new FabricBytes(bytes),
        name: "a\r\nSet-Cookie: x=1.gif",
      };
      const hash = hashOf(contents).toString().slice("fid1:".length);

      const post = await uploadTo(
        `/${identity.did()}/blobs/image.gif`,
        contents,
      );
      expect(post.status).toBe(201);

      const get = await app.request(`/${identity.did()}/blobs/${hash}.gif`);
      expect(get.headers.get("Set-Cookie")).toBeNull();
      expect(get.headers.get("Content-Disposition")).toBe(
        `inline; filename="a__Set-Cookie: x=1.gif"; ` +
          `filename*=UTF-8''a%0D%0ASet-Cookie%3A%20x%3D1.gif`,
      );
    });

    it("serves a stored blob whose name is not a file name with a `Content-Disposition` naming no file", async () => {
      const identity = await Identity.fromPassphrase(
        "toolshed-blob-named-stored-invalid",
      );
      await bootstrapHomeSpace(identity);
      const contents = {
        type: "image/gif",
        body: new FabricBytes(bytes),
        name: "",
      };
      const id = hashOf(contents).toString();
      await memoryServer.writeDocument(identity.did(), `cid:${id}`, contents);

      const get = await app.request(
        `/${identity.did()}/blobs/${id.slice("fid1:".length)}.gif`,
      );

      expect(get.status).toBe(200);
      expect(get.headers.get("Content-Disposition")).toBe("inline");
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
    });
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
