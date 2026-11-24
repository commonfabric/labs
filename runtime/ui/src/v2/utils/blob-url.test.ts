import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeClient } from "@commonfabric/runtime-client";

import { BlobUrlResolver } from "./blob-url.ts";

const SPACE = "did:key:z6Mk-blob-url";

/** A runtime whose `blobUrl()` answers each call with `answers`' next. */
const runtimeAnswering = (...answers: Promise<string>[]) => {
  const calls: unknown[] = [];
  return {
    calls,
    runtime: {
      blobUrl: (options: unknown) => {
        calls.push(options);
        return answers.shift()!;
      },
    } as unknown as RuntimeClient,
  };
};

/** A host that counts the updates it is asked for. */
const countingHost = () => {
  const host = { updates: 0, requestUpdate: () => host.updates++ };
  return host;
};

describe("blob-url", () => {
  describe("BlobUrlResolver", () => {
    it("returns the URL the runtime gives, and updates its host", async () => {
      const answer = Promise.resolve("http://host/space/blobs/abc");
      const { calls, runtime } = runtimeAnswering(answer);
      const host = countingHost();
      const resolver = new BlobUrlResolver(host);

      resolver.resolve(runtime, { space: SPACE, id: "fid1:abc" });
      expect(resolver.url).toBeNull();
      await answer;

      expect(calls).toEqual([{ space: SPACE, id: "fid1:abc" }]);
      expect(resolver.url).toBe("http://host/space/blobs/abc");
      expect(host.updates).toBe(1);
    });

    it("returns the latest reference's URL when an earlier answer arrives later", async () => {
      let answerFirst!: (url: string) => void;
      const first = new Promise<string>((resolve) => answerFirst = resolve);
      const second = Promise.resolve("http://host/space/blobs/second");
      const { runtime } = runtimeAnswering(first, second);
      const resolver = new BlobUrlResolver(countingHost());

      resolver.resolve(runtime, { space: SPACE, id: "fid1:first" });
      resolver.resolve(runtime, { space: SPACE, id: "fid1:second" });
      await second;
      answerFirst("http://host/space/blobs/first");
      await first;

      expect(resolver.url).toBe("http://host/space/blobs/second");
    });

    it("returns `null` for a reference that names no blob, without asking", () => {
      const { calls, runtime } = runtimeAnswering();
      const resolver = new BlobUrlResolver(countingHost());

      resolver.resolve(runtime, { space: "not a did", id: "fid1:abc" });
      resolver.resolve(runtime, { space: SPACE, id: 7 });
      resolver.resolve(runtime, undefined);
      resolver.resolve(undefined, { space: SPACE, id: "fid1:abc" });

      expect(calls).toEqual([]);
      expect(resolver.url).toBeNull();
    });

    it("asks for the URL to save the blob from when made for downloads", async () => {
      const answer = Promise.resolve("http://host/space/blobs/abc?download");
      const { calls, runtime } = runtimeAnswering(answer);
      const resolver = new BlobUrlResolver(countingHost(), { download: true });

      resolver.resolve(runtime, { space: SPACE, id: "fid1:abc" });
      await answer;

      expect(calls).toEqual([{ space: SPACE, id: "fid1:abc", download: true }]);
      expect(resolver.url).toBe("http://host/space/blobs/abc?download");
    });

    it("returns `null` when the runtime cannot give a URL", async () => {
      const answer = Promise.reject(new Error("no host"));
      const { runtime } = runtimeAnswering(answer);
      const resolver = new BlobUrlResolver(countingHost());

      resolver.resolve(runtime, { space: SPACE, id: "fid1:abc" });
      await answer.catch(() => {});

      expect(resolver.url).toBeNull();
    });
  });
});
