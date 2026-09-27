import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  encodeMemoryBoundary,
  type SessionEffectMessage,
} from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("own-write-echo-cost");
const space = signer.did();

type Entry = { label: string; nested: { id: string } };

const mapSchema = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      label: { type: "string" },
      nested: { type: "object", properties: { id: { type: "string" } } },
    },
  },
  // deno-lint-ignore no-explicit-any
} as any;

/** A map of `entries` records, the shape a search index holds. */
const map = (entries: number): Record<string, Entry> =>
  Object.fromEntries(
    Array.from({ length: entries }, (_, index) => [
      `k${index}`,
      { label: `entry-${index}`, nested: { id: `id-${index}` } },
    ]),
  );

/** How many objects and arrays `value` holds, itself included. */
const containersIn = (value: unknown): number => {
  if (typeof value !== "object" || value === null) return 0;
  let count = 1;
  for (const child of Object.values(value)) count += containersIn(child);
  return count;
};

/**
 * Commits a change to one entry of a watched map of `entries` records, and
 * reports what the server sent the writing session while that commit
 * settled: how many copies of the map, and the size of every frame, in the
 * bytes the client parses and the containers it builds and freezes to do so.
 *
 * The server is the test's own, so every message it sends a session passes
 * through the wrapper below before the loopback transport encodes it.
 */
const oneEntryCommit = async (entries: number) => {
  const server: MemoryV2Server.Server = newSharedServer({
    subscriptionRefreshDelayMs: "manual",
  });
  const sent: SessionEffectMessage[] = [];
  const connect = server.connect.bind(server);
  server.connect = (send) =>
    connect((message) => {
      if ((message as { type?: string }).type === "session/effect") {
        sent.push(message as SessionEffectMessage);
      }
      send(message);
    });
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  const settle = async () => {
    await server.flushSessions([space]);
    await clock.settle();
    await runtime.storageManager.synced();
    await runtime.idle();
  };
  try {
    const seed = runtime.edit();
    runtime.getCell<Record<string, Entry>>(
      space,
      "own-write-echo-cost",
      mapSchema,
      seed,
    ).set(map(entries));
    await seed.commit({ resolveAt: "verdict" });
    await settle();

    const cell = runtime.getCell<Record<string, Entry>>(
      space,
      "own-write-echo-cost",
      mapSchema,
    );
    await cell.sync();
    const cancel = cell.sink(() => {});
    await settle();

    const id = cell.getAsNormalizedFullLink().id;
    sent.length = 0;
    const tx = runtime.edit();
    cell.withTx(tx).key("k0").key("label").set("changed");
    await tx.commit({ resolveAt: "verdict" });
    await settle();
    cancel();

    return {
      label: cell.get()["k0"].label,
      copies: sent.flatMap((message) => message.effect.upserts)
        .filter((upsert) => upsert.id === id && upsert.doc !== undefined)
        .length,
      bytes: sent.reduce(
        (total, message) => total + encodeMemoryBoundary(message).length,
        0,
      ),
      containers: sent.reduce(
        (total, message) => total + containersIn(message),
        0,
      ),
    };
  } finally {
    await runtime.dispose();
    await storage.close();
    await server.close();
  }
};

describe("own-write echo cost", () => {
  it("sends the writer the same frames for a one-entry patch of a short map as of a long one", async () => {
    // The writer's own patch lands on the document its replica holds, so it
    // reproduces the result by replaying that patch, and the server sends it
    // no copy. What the frames carry is then the commit's marker, the same
    // at any size; a copy of the map would put the whole map in the count.

    const short = await oneEntryCommit(20);
    const long = await oneEntryCommit(400);

    expect(short.label).toBe("changed");
    expect(long.label).toBe("changed");
    expect(short.copies).toBe(0);
    expect(long.copies).toBe(0);
    expect(long.bytes).toBe(short.bytes);
    expect(long.containers).toBe(short.containers);
  });
});
