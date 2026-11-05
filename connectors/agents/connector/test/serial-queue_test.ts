import { assertEquals } from "@std/assert";
import { AsyncSerialQueue } from "../src/serial-queue.ts";

Deno.test("two-session shared-index updates are serialized without lost entries", async () => {
  const queue = new AsyncSerialQueue();
  let sharedIndex: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => releaseFirst = resolve);
  const started: string[] = [];

  const update = (sessionId: string) =>
    queue.run(async () => {
      started.push(sessionId);
      const next = [...sharedIndex, sessionId];
      if (sessionId === "session-1") await firstBlocked;
      sharedIndex = next;
    });

  const first = update("session-1");
  const second = update("session-2");
  await Promise.resolve();
  assertEquals(started, ["session-1"]);
  releaseFirst();
  await Promise.all([first, second]);
  assertEquals(sharedIndex, ["session-1", "session-2"]);
});
