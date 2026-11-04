/**
 * Runs one projection against a persistent synthetic store. Takes three
 * positional arguments: mode (`seed`, `read`, or `change`), store directory,
 * and frame-log path. Writes one JSON line to stdout containing the selected
 * values, runtime errors, and storage effects for the parent test to inspect.
 */

import { toFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { type URI } from "@commonfabric/memory/interface";
import { Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  deriveSelectedValue,
  parseSelectProjection,
} from "../../lib/cell-selection.ts";

/** The frame fields needed to observe projection writes and storage verdicts. */
interface Frame {
  /** Direction relative to the client. */
  dir: string;

  /** Protocol message type. */
  type: string;

  /** Identity joining a request to its response. */
  requestId?: string;

  /** Storage rejection carried by a response. */
  error?: { name: string; message: string };

  /** Write operations in a transaction request. */
  commit?: { operations: { id: URI; scope: string }[] };
}

const [mode, directory, framesPath] = Deno.args;
if (Deno.args.length !== 3 || !directory || !framesPath) {
  throw new Error("Expected replay mode, store directory, and frame-log path");
}
if (mode !== "seed" && mode !== "read" && mode !== "change") {
  throw new Error(`Unknown replay mode: \`${mode}\``);
}
// The logger appends frames; an empty observation window is a valid log.
await Deno.writeTextFile(framesPath, "");
const signer = await Identity.fromPassphrase("cli-projection-replay");
const space = signer.did();
const server = newLoopbackServer({
  store: toFileUrl(`${directory}/`),
  subscriptionRefreshDelayMs: 0,
});
const storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
const errors: string[] = [];
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager,
  experimental: { serverExecution: false },
  errorHandlers: [(error) => errors.push(error.message)],
});
const itemSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    createdAt: { type: "number" },
    lastActivityAt: { type: "number" },
    commentCount: { type: "number" },
  },
  required: ["title", "createdAt", "lastActivityAt", "commentCount"],
} as const;
const schema = { type: "array", items: itemSchema } as const;

/** Reads the structural frame log captured by this process. */
async function readFrames(): Promise<Frame[]> {
  return (await Deno.readTextFile(framesPath)).split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Frame);
}

/** Counts mutable shared writes in an observed frame window. */
function countMutableSharedWrites(frames: Frame[]): number {
  return frames.filter((frame) =>
    frame.dir === "out" && frame.type === "transact"
  ).flatMap((frame) => frame.commit?.operations ?? []).filter((operation) =>
    operation.scope === "space" && !operation.id.startsWith("cid:")
  ).length;
}

try {
  if (mode === "seed") {
    const tx = runtime.edit();
    const rows = Array.from({ length: 8 }, (_, index) => {
      const row = runtime.getCell(space, { row: index }, itemSchema, tx);
      row.set({
        title: `Row ${index}`,
        createdAt: index,
        lastActivityAt: index,
        commentCount: index,
      });
      return row.getAsLink();
    });
    runtime.getCell<unknown>(space, "survey", schema, tx).setRaw(rows);
    const committed = await tx.commit().settled;
    if (committed.error) throw committed.error;
    await storageManager.synced();
  }
  if (mode === "change") {
    const row = runtime.getCell(space, { row: 3 }, itemSchema);
    await row.pull();
    const tx = runtime.edit();
    row.withTx(tx).key("title").set("Updated row");
    row.withTx(tx).key("commentCount").set(99);
    const committed = await tx.commit().settled;
    if (committed.error) throw committed.error;
    await storageManager.synced();
  }
  const source = runtime.getCell(space, "survey", schema);
  await source.pull();
  const setupFrames = await readFrames();
  const before = setupFrames.length;
  const value = await deriveSelectedValue(runtime, space, source, {
    projection: parseSelectProjection(
      "@,title,createdAt,lastActivityAt,commentCount",
    ),
  });
  await runtime.idle();
  await storageManager.synced();
  const frames = (await readFrames()).slice(before);
  const requests = frames.filter((frame) =>
    frame.dir === "out" && frame.type === "transact"
  );
  const responses = new Map(
    frames.filter((frame) => frame.dir === "in" && frame.requestId)
      .map((frame) => [frame.requestId, frame]),
  );
  console.log(JSON.stringify({
    value,
    errors,
    rejected: requests.flatMap((request) => {
      const error = responses.get(request.requestId)?.error;
      return error ? [error] : [];
    }),
    unanswered: requests.filter((request) =>
      !responses.has(request.requestId)
    ).length,
    setupMutableSharedWrites: countMutableSharedWrites(setupFrames),
    mutableSharedWrites: countMutableSharedWrites(frames),
  }));
} finally {
  await runtime.dispose();
  await storageManager.close();
  await server.close();
}
