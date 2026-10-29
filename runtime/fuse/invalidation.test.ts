import { assert, assertEquals } from "@std/assert";
import {
  type ReverseInvalidationDeps,
  ReverseInvalidationQueue,
} from "./invalidation.ts";

const decoder = new TextDecoder();

interface Recorder {
  entryCalls: { parentIno: bigint; name: string; nameLen: bigint }[];
  inodeCalls: bigint[];
  logs: string[];
  warns: string[];
}

function setup(overrides: Partial<ReverseInvalidationDeps> = {}) {
  const rec: Recorder = { entryCalls: [], inodeCalls: [], logs: [], warns: [] };
  const deps: ReverseInvalidationDeps = {
    invalidateEntry: (parentIno, nameBuf, nameLen) => {
      const name = decoder.decode(nameBuf).replace(/\0$/, "");
      rec.entryCalls.push({ parentIno, name, nameLen });
      return 0;
    },
    invalidateInode: (ino) => {
      rec.inodeCalls.push(ino);
      return 0;
    },
    isUnmounting: () => false,
    debug: false,
    log: (m) => rec.logs.push(m),
    warn: (m) => rec.warns.push(m),
    ...overrides,
  };
  const queue = new ReverseInvalidationQueue(deps);
  return { queue, rec };
}

/** A promise plus its resolver, for holding a flush mid-await. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

Deno.test("flushes queued entry invalidations off-thread with the name length excluding NUL", async () => {
  const { queue, rec } = setup();
  assert(queue.addEntry(1n, ["alpha", "beta"]));
  assertEquals(queue.pendingEntryCount, 1);
  await queue.flush();
  assertEquals(rec.entryCalls, [
    { parentIno: 1n, name: "alpha", nameLen: 5n },
    { parentIno: 1n, name: "beta", nameLen: 4n },
  ]);
  assertEquals(queue.pendingEntryCount, 0);
});

Deno.test("coalesces repeated names and parents before flushing", async () => {
  const { queue, rec } = setup();
  queue.addEntry(1n, ["a"]);
  queue.addEntry(1n, ["a", "b"]);
  queue.addEntry(2n, ["c"]);
  assertEquals(queue.pendingEntryCount, 2);
  await queue.flush();
  assertEquals(
    rec.entryCalls.map((c) => `${c.parentIno}:${c.name}`),
    ["1:a", "1:b", "2:c"],
  );
});

Deno.test("flushes queued inode invalidations", async () => {
  const { queue, rec } = setup();
  assert(queue.addInode(5n));
  assert(queue.addInode(5n));
  assert(queue.addInode(6n));
  assertEquals(queue.pendingInodeCount, 2);
  await queue.flush();
  assertEquals(rec.inodeCalls, [5n, 6n]);
  assertEquals(queue.pendingInodeCount, 0);
});

Deno.test("flush with nothing queued issues no notify calls", async () => {
  const { queue, rec } = setup();
  await queue.flush();
  assertEquals(rec.entryCalls.length, 0);
  assertEquals(rec.inodeCalls.length, 0);
});

Deno.test("queue additions are rejected while unmounting", () => {
  const { queue } = setup({ isUnmounting: () => true });
  assertEquals(queue.addEntry(1n, ["a"]), false);
  assertEquals(queue.addInode(2n), false);
  assertEquals(queue.pendingEntryCount, 0);
  assertEquals(queue.pendingInodeCount, 0);
});

Deno.test("an unsupported entry notify disables further entry invalidation and logs once", async () => {
  const { queue, rec } = setup({
    invalidateEntry: () => -38, // -ENOSYS
  });
  queue.addEntry(1n, ["a", "b"]);
  queue.addEntry(2n, ["c"]);
  await queue.flush();
  assertEquals(queue.entryNotifySupported, false);
  assertEquals(
    rec.logs,
    ["notify_inval_entry not supported; skipping entry invalidation"],
  );
  // Later additions are refused now that the provider lacks the op.
  assertEquals(queue.addEntry(3n, ["d"]), false);
});

Deno.test("an entry notify that throws disables entry invalidation and warns", async () => {
  const { queue, rec } = setup({
    invalidateEntry: () => {
      throw new Error("boom");
    },
  });
  queue.addEntry(1n, ["a"]);
  await queue.flush();
  assertEquals(queue.entryNotifySupported, false);
  assertEquals(rec.warns.length, 1);
  assert(rec.warns[0].includes("notify_inval_entry failed"));
});

Deno.test("an unsupported inode notify disables further inode invalidation without logging", async () => {
  const { queue, rec } = setup({
    invalidateInode: () => -38,
  });
  queue.addInode(9n);
  await queue.flush();
  assertEquals(queue.inodeNotifySupported, false);
  assertEquals(rec.logs.length, 0);
  assertEquals(queue.addInode(10n), false);
});

Deno.test("an inode notify that throws disables inode invalidation and warns", async () => {
  const { queue, rec } = setup({
    invalidateInode: () => {
      throw new Error("nope");
    },
  });
  queue.addInode(9n);
  await queue.flush();
  assertEquals(queue.inodeNotifySupported, false);
  assert(rec.warns[0].includes("notify_inval_inode failed"));
});

Deno.test("debug logs a nonzero entry result but stays quiet on success", async () => {
  const results = [7, 0];
  const { queue, rec } = setup({
    debug: true,
    invalidateEntry: () => results.shift() ?? 0,
  });
  queue.addEntry(1n, ["a", "b"]);
  await queue.flush();
  assertEquals(rec.logs, ["notify_inval_entry(parent=1, name=a) => 7"]);
});

Deno.test("debug logs every inode result, including zero", async () => {
  const { queue, rec } = setup({ debug: true });
  queue.addInode(4n);
  await queue.flush();
  assertEquals(rec.logs, ["notify_inval_inode(ino=4) => 0"]);
});

Deno.test("the drain loop picks up work queued while an await is outstanding", async () => {
  const rec: Recorder = { entryCalls: [], inodeCalls: [], logs: [], warns: [] };
  const queue = new ReverseInvalidationQueue({
    invalidateEntry: (parentIno, nameBuf, nameLen) => {
      const name = decoder.decode(nameBuf).replace(/\0$/, "");
      rec.entryCalls.push({ parentIno, name, nameLen });
      // Enqueue more work during the first notify; the snapshot-and-clear loop
      // must pick it up in a later pass rather than drop it.
      if (rec.entryCalls.length === 1) queue.addEntry(2n, ["x"]);
      return Promise.resolve(0);
    },
    invalidateInode: () => 0,
    isUnmounting: () => false,
    debug: false,
  });
  queue.addEntry(1n, ["a"]);
  await queue.flush();
  assertEquals(
    rec.entryCalls.map((c) => `${c.parentIno}:${c.name}`),
    ["1:a", "2:x"],
  );
});

Deno.test("a re-entrant flush returns the running flush instead of starting a second", async () => {
  const gate = deferred<number>();
  let calls = 0;
  const { queue, rec } = setup({
    invalidateEntry: (parentIno, nameBuf, nameLen) => {
      calls++;
      const name = decoder.decode(nameBuf).replace(/\0$/, "");
      rec.entryCalls.push({ parentIno, name, nameLen });
      return calls === 1 ? gate.promise : 0;
    },
  });
  queue.addEntry(1n, ["a"]);
  const first = queue.flush();
  const second = queue.flush();
  assertEquals(first, second);
  assertEquals(queue.active(), first);
  gate.resolve(0);
  await first;
  assertEquals(calls, 1);
});

Deno.test("unmounting mid-flush stops issuing and clears the queue", async () => {
  let unmounting = false;
  const { queue, rec } = setup({
    isUnmounting: () => unmounting,
    invalidateEntry: (parentIno, nameBuf, nameLen) => {
      const name = decoder.decode(nameBuf).replace(/\0$/, "");
      rec.entryCalls.push({ parentIno, name, nameLen });
      unmounting = true; // tear-down begins after the first notify
      return Promise.resolve(0);
    },
  });
  queue.addEntry(1n, ["a", "b"]);
  queue.addEntry(3n, ["c"]);
  await queue.flush();
  // Only the first name went out; the remaining name, the second parent, and
  // the inode pass are all skipped once unmounting is observed.
  assertEquals(rec.entryCalls.map((c) => c.name), ["a"]);
  assertEquals(queue.pendingEntryCount, 0);
});

Deno.test("a disabled entry kind is skipped while the inode kind still flushes", async () => {
  const { queue, rec } = setup({ invalidateEntry: () => -38 });
  queue.addEntry(1n, ["a"]);
  await queue.flush();
  assertEquals(queue.entryNotifySupported, false);
  // A later inode flush must still run even though the entry op is disabled.
  assert(queue.addInode(5n));
  await queue.flush();
  assertEquals(rec.inodeCalls, [5n]);
});

Deno.test("active() resolves before any flush and tracks the latest flush after", async () => {
  const { queue } = setup();
  await queue.active(); // the initial resolved promise
  queue.addEntry(1n, ["a"]);
  const flush = queue.flush();
  assertEquals(queue.active(), flush);
  await flush;
});

Deno.test("close refuses further additions and reports closed", () => {
  const { queue } = setup();
  assert(!queue.closed);
  queue.close();
  assert(queue.closed);
  assertEquals(queue.addEntry(1n, ["a"]), false);
  assertEquals(queue.addInode(2n), false);
});

Deno.test("a flush after close is a no-op that issues nothing", async () => {
  const { queue, rec } = setup();
  queue.addEntry(1n, ["a"]);
  queue.addInode(2n);
  queue.close();
  await queue.flush();
  assertEquals(rec.entryCalls.length, 0);
  assertEquals(rec.inodeCalls.length, 0);
});

Deno.test("close during an in-flight flush halts the remaining notifies", async () => {
  const gate = deferred<number>();
  let calls = 0;
  const { queue, rec } = setup({
    invalidateEntry: (parentIno, nameBuf, nameLen) => {
      calls++;
      const name = decoder.decode(nameBuf).replace(/\0$/, "");
      rec.entryCalls.push({ parentIno, name, nameLen });
      return calls === 1 ? gate.promise : 0;
    },
  });
  queue.addEntry(1n, ["a", "b"]);
  queue.addInode(9n);
  const flush = queue.flush();
  // Close while the first notify is still outstanding on the FFI thread.
  queue.close();
  gate.resolve(0);
  await flush;
  // Only the first name went out; "b" and the inode pass are skipped, and the
  // queue is drained.
  assertEquals(rec.entryCalls.map((c) => c.name), ["a"]);
  assertEquals(rec.inodeCalls.length, 0);
  assertEquals(queue.pendingEntryCount, 0);
  assertEquals(queue.pendingInodeCount, 0);
});

Deno.test("both synchronous and asynchronous notify results are drained", async () => {
  const { queue, rec } = setup({
    invalidateEntry: (parentIno, nameBuf, nameLen) => {
      const name = decoder.decode(nameBuf).replace(/\0$/, "");
      rec.entryCalls.push({ parentIno, name, nameLen });
      return name === "sync" ? 0 : Promise.resolve(0);
    },
  });
  queue.addEntry(1n, ["sync", "async"]);
  await queue.flush();
  assertEquals(rec.entryCalls.map((c) => c.name), ["sync", "async"]);
});
