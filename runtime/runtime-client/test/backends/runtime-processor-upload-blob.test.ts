import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { Runtime } from "@commonfabric/runner";
import {
  blobDocumentId,
  type BlobRecord,
  encodedBlobRecordBytes,
  MAX_BLOB_RECORD_BYTES,
} from "@commonfabric/runner/blob-record";
import {
  EmulatedStorageManager,
  namesInstancesByDefault,
} from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { RuntimeProcessor } from "../../src/backends/runtime-processor.ts";
import { RequestType } from "../../src/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const owner = await Identity.fromPassphrase("upload-blob owner");
const writer = await Identity.fromPassphrase("upload-blob writer");
const reader = await Identity.fromPassphrase("upload-blob reader");

/** A blob of a few bytes, as an upload of `photo.png` stores it. */
const photo: BlobRecord = {
  type: "image/png",
  body: new FabricBytes(new Uint8Array([137, 80, 78, 71])),
  name: "photo.png",
};

describe("runtime-processor", () => {
  describe("handleUploadBlob()", () => {
    let server: Server;
    let space: MemorySpace;
    let cleanups: (() => Promise<void>)[];

    beforeEach(async () => {
      cleanups = [];
      server = new Server({
        namesInstances: namesInstancesByDefault,
        authorizeSessionOpen: authorizeLoopbackSessionOpen,
        sessionOpenAuth: { audience: "did:key:z6Mk-upload-blob-audience" },
        acl: { mode: "enforce" },
        subscriptionRefreshDelayMs: 0,
      });
      const creator = EmulatedStorageManager.connectTo(server, { as: owner });
      try {
        space = await creator.createSpace({
          [owner.did()]: "OWNER",
          [writer.did()]: "WRITE",
          [reader.did()]: "READ",
        });
      } finally {
        await creator.close();
      }
    });

    afterEach(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
      await server.close();
    });

    /** Returns a processor whose runtime acts as `user`. */
    function processorFor(user: Identity): {
      processor: RuntimeProcessor;
      runtime: Runtime;
    } {
      const storageManager = EmulatedStorageManager.connectTo(server, {
        as: user,
      });
      const runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test/base"),
        storageManager,
      });
      cleanups.push(async () => {
        await runtime.dispose();
        await storageManager.close();
      });
      return { processor: buildProcessor({ runtime }), runtime };
    }

    /** Returns the value the space's store holds for the blob `blobId`. */
    async function storedRecord(blobId: string): Promise<unknown> {
      return (await server.readDocument(space, blobDocumentId(blobId)))?.value;
    }

    it("stores the record in its space under the id it returns, and returns the URL the space's host serves it at", async () => {
      const { processor } = processorFor(writer);

      const upload = await processor.handleUploadBlob({
        type: RequestType.UploadBlob,
        space,
        contentType: photo.type,
        body: photo.body,
        name: photo.name,
      });

      // The id is the hash of the whole record, which is the id the blob
      // store's route gives the same record.
      const id = hashOf(photo).toString();
      expect(upload).toEqual({
        id,
        url: `http://toolshed.test/${space}/blobs/${
          id.slice("fid1:".length)
        }.png`,
      });
      expect(await storedRecord(id)).toEqual(photo);
    });

    it("stores a record with no `name` key for a request that names no file, served under the requested suffix", async () => {
      const { processor } = processorFor(writer);
      const unnamed: BlobRecord = { type: photo.type, body: photo.body };

      const upload = await processor.handleUploadBlob({
        type: RequestType.UploadBlob,
        space,
        contentType: unnamed.type,
        body: unnamed.body,
        suffix: ".webp",
      });

      const id = hashOf(unnamed).toString();
      expect(upload.id).toBe(id);
      expect(upload.url.endsWith(`/blobs/${id.slice("fid1:".length)}.webp`))
        .toBe(true);
      // Strict, so that a `name` key holding `undefined` fails it: the id is
      // the hash of exactly the record stored.
      expect(await storedRecord(id)).toStrictEqual(unnamed);
    });

    it("returns a URL with the requested suffix over the name's own extension", async () => {
      const { processor } = processorFor(writer);

      const upload = await processor.handleUploadBlob({
        type: RequestType.UploadBlob,
        space,
        contentType: photo.type,
        body: photo.body,
        name: photo.name,
        suffix: "webp",
      });

      const hash = hashOf(photo).toString().slice("fid1:".length);
      expect(upload.url).toBe(
        `http://toolshed.test/${space}/blobs/${hash}.webp`,
      );
    });

    it("returns a URL on the host that serves the blob's space", async () => {
      const { processor, runtime } = processorFor(writer);
      using _host = stub(
        runtime,
        "hostForSpace",
        (target) =>
          new URL(
            target === space
              ? "http://space-host.test/"
              : "http://other-host.test/",
          ),
      );

      const upload = await processor.handleUploadBlob({
        type: RequestType.UploadBlob,
        space,
        contentType: photo.type,
        body: photo.body,
        name: photo.name,
      });

      const hash = hashOf(photo).toString().slice("fid1:".length);
      expect(upload.url).toBe(
        `http://space-host.test/${space}/blobs/${hash}.png`,
      );
    });

    it("throws for an uploader the space's access list grants only `READ`, and stores nothing", async () => {
      const { processor } = processorFor(reader);

      await expect(
        processor.handleUploadBlob({
          type: RequestType.UploadBlob,
          space,
          contentType: photo.type,
          body: photo.body,
          name: photo.name,
        }),
      ).rejects.toThrow(`lacks WRITE on space ${space}`);
      expect(await storedRecord(hashOf(photo).toString())).toBeUndefined();
    });

    it("throws for a record over `MAX_BLOB_RECORD_BYTES` encoded, and stores nothing", async () => {
      const { processor } = processorFor(writer);
      // The encoding takes four characters per three bytes, so this many
      // bytes take one more than the bound.
      const large: BlobRecord = {
        type: "application/octet-stream",
        body: new FabricBytes(
          new Uint8Array(Math.ceil(MAX_BLOB_RECORD_BYTES * 3 / 4)),
        ),
      };
      expect(encodedBlobRecordBytes(large)).toBeGreaterThan(
        MAX_BLOB_RECORD_BYTES,
      );

      await expect(
        processor.handleUploadBlob({
          type: RequestType.UploadBlob,
          space,
          contentType: large.type,
          body: large.body,
        }),
      ).rejects.toThrow(
        `a blob takes at most ${MAX_BLOB_RECORD_BYTES} bytes encoded`,
      );
      expect(await storedRecord(hashOf(large).toString())).toBeUndefined();
    });

    it("throws for a request whose media type is not a string", async () => {
      const { processor } = processorFor(writer);

      await expect(
        processor.handleUploadBlob({
          type: RequestType.UploadBlob,
          space,
          contentType: 7 as never,
          body: photo.body,
        }),
      ).rejects.toThrow("uploadBlob requires a media type");
    });

    it("throws for a request whose name is not one a blob may hold", async () => {
      const { processor } = processorFor(writer);

      await expect(
        processor.handleUploadBlob({
          type: RequestType.UploadBlob,
          space,
          contentType: photo.type,
          body: photo.body,
          name: "",
        }),
      ).rejects.toThrow(
        "The name given is not one a blob may hold",
      );
    });
  });
});
