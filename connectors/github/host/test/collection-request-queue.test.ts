import { assertEquals } from "@std/assert";
import { CollectionRequestQueue } from "../src/collection-request-queue.ts";

Deno.test("GitHub collection requests coalesce while collection runs", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const reasons: string[] = [];
  const queue = new CollectionRequestQueue(async (reason) => {
    reasons.push(reason);
    if (reasons.length === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else {
      secondStarted.resolve();
    }
  });

  assertEquals(queue.request("periodic"), "started");
  await firstStarted.promise;
  assertEquals(queue.request("SIGHUP"), "queued");
  assertEquals(queue.request("periodic"), "already-queued");

  releaseFirst.resolve();
  await secondStarted.promise;
  await queue.close();

  assertEquals(reasons, ["periodic", "SIGHUP"]);
  assertEquals(queue.request("periodic"), "closed");
});

Deno.test("GitHub collection requests retain an empty reason", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const reasons: string[] = [];
  const queue = new CollectionRequestQueue(async (reason) => {
    reasons.push(reason);
    if (reasons.length === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else {
      secondStarted.resolve();
    }
  });

  assertEquals(queue.request("periodic"), "started");
  await firstStarted.promise;
  assertEquals(queue.request(""), "queued");
  releaseFirst.resolve();
  await secondStarted.promise;
  await queue.close();

  assertEquals(reasons, ["periodic", ""]);
});

Deno.test("closing drops a pending GitHub collection request", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reasons: string[] = [];
  const queue = new CollectionRequestQueue(async (reason) => {
    reasons.push(reason);
    started.resolve();
    await release.promise;
  });

  queue.request("periodic");
  await started.promise;
  queue.request("SIGHUP");
  const closed = queue.close();
  release.resolve();
  await closed;

  assertEquals(reasons, ["periodic"]);
});

Deno.test("a rejected collection does not block its successor", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const reasons: string[] = [];
  const queue = new CollectionRequestQueue(async (reason) => {
    reasons.push(reason);
    if (reasons.length === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new Error("collection rejected");
    }
    secondStarted.resolve();
  });

  queue.request("periodic");
  await firstStarted.promise;
  queue.request("SIGHUP");
  releaseFirst.resolve();
  await secondStarted.promise;
  await queue.close();

  assertEquals(reasons, ["periodic", "SIGHUP"]);
});
