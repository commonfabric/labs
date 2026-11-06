/**
 * Cross-origin requests to the blob routes, made against the whole toolshed
 * app rather than the blob router alone. Which `cors()` answers a request
 * turns on the order the app mounts its routers, so only the app as
 * `app.ts` composes it shows the policy a browser actually gets.
 */

import { expect } from "@std/expect";
import { afterAll, afterEach, beforeAll, describe, it } from "@std/testing/bdd";

import { hashOf } from "@commonfabric/data-model";
import { newDefaultJsonCodecEngine } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type { DID, URI } from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import app from "@/app.ts";
import env from "@/env.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const FOREIGN_ORIGIN = "https://elsewhere.example";

const blobUploadCodec = newDefaultJsonCodecEngine();

describe("blobs.index", () => {
  let server: Deno.HttpServer;
  let base: URL;
  let space: DID;

  beforeAll(async () => {
    server = Deno.serve({ port: 0, onListen: () => {} }, app.fetch);
    const address = server.addr as Deno.NetAddr;
    base = new URL(`http://${address.hostname}:${address.port}`);

    // An upload is refused into a space with no ACL genesis, so the space's
    // owner opens it first, the way a client does.
    const owner = await Identity.fromPassphrase("toolshed-blob-cors");
    space = owner.did();
    const storageManager = StorageManager.open({
      as: owner,
      memoryHost: base,
    });
    try {
      const sync = await storageManager.open(space).sync(
        `of:${space}` as URI,
      );
      expect(sync).toEqual({ ok: {} });
    } finally {
      await storageManager.close();
    }
  });

  afterEach(async () => {
    await memoryServer.flushSessions();
  });

  afterAll(async () => {
    await server.shutdown();
    await memoryServer.close();
  });

  /** Uploads `bytes` as a PNG blob from `FOREIGN_ORIGIN`. */
  const upload = (bytes: number[]) =>
    fetch(new URL(`/${space}/blobs`, base), {
      method: "POST",
      headers: {
        Origin: FOREIGN_ORIGIN,
        "Content-Type": "application/json",
      },
      body: blobUploadCodec.encode({
        type: "image/png",
        body: new FabricBytes(new Uint8Array(bytes)),
      }),
    });

  describe("cross-origin requests", () => {
    it("answers a preflight for an upload by allowing `POST` and admitting `Content-Type` alone", async () => {
      const response = await fetch(new URL(`/${space}/blobs`, base), {
        method: "OPTIONS",
        headers: {
          Origin: FOREIGN_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, x-unlisted",
        },
      });
      await response.body?.cancel();

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(
        response.headers.get("access-control-allow-methods")?.split(","),
      ).toContain("POST");
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "Content-Type",
      );
    });

    it("gives an upload's reply an `Access-Control-Allow-Origin` of `*`", async () => {
      const contents = {
        type: "image/png",
        body: new FabricBytes(new Uint8Array([1, 2, 3])),
      };
      const response = await upload([1, 2, 3]);

      expect(response.status).toBe(201);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect((await response.json()).id).toBe(hashOf(contents).toString());
    });

    it("gives a blob's bytes an `Access-Control-Allow-Origin` of `*`", async () => {
      const stored = await upload([4, 5, 6]);
      const { url } = await stored.json();
      const response = await fetch(new URL(`/${space}/${url}`, base), {
        headers: { Origin: FOREIGN_ORIGIN },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array([4, 5, 6]),
      );
    });
  });
});
