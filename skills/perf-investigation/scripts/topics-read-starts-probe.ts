/**
 * How many topics a client's reads of a Topics board start on a serving
 * runtime, and what the reads give. Makes a board, files `<k>` topics through
 * `addTopic`, then reads the board's `index` and then its `topics`, each
 * through the schema the board declares and from a client that has read
 * nothing of the board. Prints one JSON line: how many topics run on the
 * serving runtime after the creates and once it is quiescent after each read,
 * which of the first topic's outputs are `computed:` documents that hold no
 * value after the creates, and the author each read gives each topic.
 *
 * `WATCH_BOARD=index` has a client watch the board's `index` while the topics
 * are filed, and `WATCH_BOARD=ui` its `[UI]`, as a browser showing the board
 * does.
 *
 *   deno run -A --config deno.jsonc \
 *     skills/perf-investigation/scripts/topics-read-starts-probe.ts <k>
 *
 * Run from the repository root.
 */

import { fromFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import {
  type Cell,
  pullFromServer,
  Runtime,
  type RuntimeProgram,
  UI,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { startServingMemoryServer } from "@commonfabric/runner/executor/serving-memory-server.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  confirmServedInstantiate,
  PiecesController,
  servedInstantiatePiece,
} from "@commonfabric/piece/ops";
import { sendVerbEvent } from "@commonfabric/piece/verb-call";

const k = Number(Deno.args[0] ?? "5");
const root = fromFileUrl(new URL("../../../", import.meta.url)).replace(
  /\/$/,
  "",
);
const serviceSigner = await Identity.fromPassphrase("topics read service");
const userSigner = await Identity.fromPassphrase("topics read user");
const space = userSigner.did() as MemorySpace;

const serving = await startServingMemoryServer({
  apiUrl: new URL(import.meta.url),
  serviceIdentity: serviceSigner,
  policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
  worker: false,
});
const host = serving.host.host!;
const session = createSession({
  identity: serviceSigner,
  spaceDid: space as DID,
});
const cleanups: Array<() => Promise<void>> = [];
const clientPieces = async (): Promise<PiecesController> => {
  const manager = EmulatedStorageManager.connectTo(serving.server, {
    as: userSigner,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
    experimental: { serverExecution: true },
  });
  cleanups.push(async () => {
    await runtime.dispose();
    await manager.close();
  });
  const pieces = new PiecesController(session, runtime, {
    deferSpaceCellSync: true,
  });
  await pieces.ready;
  return pieces;
};

const writer = await clientPieces();
const program: RuntimeProgram = await resolveLocalProgram(
  (resolver) => writer.runtime.harness.resolve(resolver),
  { main: `${root}/patterns/apps/topics/main.tsx`, root },
);
const { pieceId } = await host.runLifecycleVerb(space, {
  name: "instantiate",
  run: (runtime) =>
    servedInstantiatePiece(
      new PiecesController(session, runtime, { deferSpaceCellSync: true }),
      { source: { program }, actingUser: userSigner.did() },
    ),
  confirm: (runtime, receipt) =>
    confirmServedInstantiate(runtime, space, receipt, userSigner.did()),
});
const boardOf = async (pieces: PiecesController) =>
  pieces.getResult(
    await pieces.getPieceCell(pieceId, { reconcile: false, start: false }),
  );
const addTopic = (await boardOf(writer)).key("addTopic" as never)
  .asSchemaFromLinks() as Cell<unknown>;
// With WATCH_BOARD=1 a client watches the board's survey while the topics
// are filed, as a browser showing the board does.
const watched = Deno.env.get("WATCH_BOARD");
if (watched !== undefined) {
  const viewer = await clientPieces();
  const key = watched === "ui" ? UI : watched;
  const view = (await boardOf(viewer)).key(key as never)
    .asSchemaFromLinks() as Cell<any>;
  view.sink(() => {});
  await view.sync();
}
for (let index = 1; index <= k; index++) {
  const sent = await sendVerbEvent(addTopic, {
    title: `Probe topic ${index}`,
    body: "Filed by the read probe.",
    agentName: "Claude",
  }, { invocation: { id: `probe-${index}`, session: "probe" }, echo: false });
  if (sent.status !== "committed") throw new Error(sent.error.message);
  const handled = await sent.handled();
  if (handled.status !== "handled") throw new Error(JSON.stringify(handled));
}
await host.whenQuiescent();

const listLink = (await boardOf(writer)).key("topics" as never)
  .getAsNormalizedFullLink();
const topicLinks = await host.runLifecycleVerb(space, {
  name: "list",
  run: async (runtime) => {
    const list = runtime.getCellFromLink(listLink) as Cell<any>;
    await list.sync();
    return Array.from(
      { length: k },
      (_, index) => list.key(index).resolveAsCell().getAsNormalizedFullLink(),
    );
  },
});
const running = () =>
  host.runLifecycleVerb(space, {
    name: "count running",
    run: (runtime) =>
      Promise.resolve(
        topicLinks.filter((link) =>
          runtime.runner.isRunning(runtime.getCellFromLink(link))
        ).length,
      ),
  });

// Which of the first topic's outputs are `computed:` documents that hold no
// value once the creates have settled.
const valuelessFields = await host.runLifecycleVerb(space, {
  name: "valueless fields",
  run: async (runtime) => {
    const topic = runtime.getCellFromLink(topicLinks[0]) as Cell<any>;
    await topic.sync();
    const raw = topic.getRaw() as Record<string, unknown>;
    const fields: string[] = [];
    for (const [key, value] of Object.entries(raw ?? {})) {
      const id = (value as any)?.["/"]?.["link@1"]?.id;
      if (typeof id !== "string" || !id.startsWith("computed:")) continue;
      const stored = await serving.server.readDocument(space, id);
      if (stored === null || !("value" in stored)) fields.push(key);
    }
    return fields;
  },
});
const report: Record<string, unknown> = {
  k,
  runningAfterCreates: await running(),
  valuelessFields,
};
for (const field of ["index", "topics"]) {
  const reader = await clientPieces();
  const cell = (await boardOf(reader)).key(field as never)
    .asSchemaFromLinks() as Cell<any>;
  if (!await pullFromServer(reader.runtime, cell)) {
    throw new Error(`The server did not answer the read of ${field}`);
  }
  await cell.sync();
  await host.whenQuiescent();
  const value = cell.get();
  report[field] = {
    runningAfter: await running(),
    authors: Array.isArray(value)
      ? value.map((row: any) => row?.createdBy?.name ?? null)
      : undefined,
  };
}
console.log(JSON.stringify(report));

await host.close();
for (const cleanup of cleanups.reverse()) await cleanup();
await serving.close();
Deno.exit(0);
