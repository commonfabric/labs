/**
 * What a client's read of a list of pieces costs a serving runtime, and how
 * many of the pieces it starts. A parent's one event adds `<n>` children, each
 * deriving three values from its title; the serving runtime releases them once
 * the event commits, as it releases every piece a handler starts. A client
 * that has read nothing of the parent then reads its `children` as a view
 * (`pullFromServer`) under one of three schemas:
 *
 * - **title**: each child's stored title only;
 * - **derived-unwritten**: each child's derived values, which no run has
 *   written;
 * - **derived-written**: the same values, after each child derived them on the
 *   serving runtime and stopped.
 *
 * Prints one JSON line: the read's wall and CPU time, the process heap after a
 * forced collection before and after the read, how many children run on the
 * serving runtime before the read and once it is quiescent after it, and how
 * many children the read found a value for.
 *
 *   deno run -A --config deno.jsonc --v8-flags=--expose-gc \
 *     skills/perf-investigation/scripts/served-list-read-probe.ts <n> <scenario>
 *
 * Run from the repository root. The serving loop and the client share this
 * thread and its heap, so compare the numbers between two builds rather than
 * reading them as a toolshed worker's.
 */

// deno-lint-ignore no-external-import -- the process's CPU time comes from this Node builtin alone.
import process from "node:process";
import { createSession, Identity } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import {
  type Cell,
  pullFromServer,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { startServingMemoryServer } from "@commonfabric/runner/executor/serving-memory-server.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  confirmServedInstantiate,
  PiecesController,
  servedInstantiatePiece,
} from "@commonfabric/piece/ops";
import { sendVerbEvent } from "@commonfabric/piece/verb-call";

const [nArgument, scenario] = Deno.args;
const n = Number(nArgument);
if (
  !Number.isInteger(n) || n <= 0 ||
  !["title", "derived-unwritten", "derived-written"].includes(scenario)
) {
  console.error("usage: served-list-read-probe.ts <n> <scenario>");
  Deno.exit(2);
}
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) {
  console.error("run with --v8-flags=--expose-gc");
  Deno.exit(2);
}

const serviceSigner = await Identity.fromPassphrase("board scale service");
const aliceSigner = await Identity.fromPassphrase("board scale alice");
const space = aliceSigner.did() as MemorySpace;

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { computed, handler, NAME, pattern, Writable } from "commonfabric";

const Child = pattern<{ title: Writable<string> }>(({ title }) => {
  const upper = computed(() => title.get().toUpperCase());
  const lower = computed(() => title.get().toLowerCase());
  const size = computed(() => title.get().length);
  return { [NAME]: "Child", title, upper, lower, size };
});

const addChildren = handler<
  { titles: string[] },
  { children: Writable<unknown[]> }
>((event, state) => {
  for (const name of event.titles) {
    const title = new Writable<string>(name).for(name);
    state.children.push(Child({ title }));
  }
});

export default pattern<{ seed?: string }>(() => {
  const children = new Writable<unknown[]>([]).for("children");
  return { [NAME]: "Parent", children, addChildren: addChildren({ children }) };
});
`,
  }],
};

const SCHEMAS = {
  title: {
    type: "array",
    items: { type: "object", properties: { title: { type: "string" } } },
  },
  derived: {
    type: "array",
    items: {
      type: "object",
      properties: {
        upper: { type: "string" },
        lower: { type: "string" },
        size: { type: "number" },
      },
    },
  },
} as const;

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
    as: aliceSigner,
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

// The board, and its children, made by one event.
const writer = await clientPieces();
const { pieceId } = await host.runLifecycleVerb(space, {
  name: "instantiate",
  run: (runtime) =>
    servedInstantiatePiece(
      new PiecesController(session, runtime, { deferSpaceCellSync: true }),
      { source: { program: PROGRAM }, actingUser: aliceSigner.did() },
    ),
  confirm: (runtime, receipt) =>
    confirmServedInstantiate(runtime, space, receipt, aliceSigner.did()),
});
const parent = writer.getResult(
  await writer.getPieceCell(pieceId, { reconcile: false, start: false }),
);
const verb = parent.key("addChildren" as never)
  .asSchemaFromLinks() as Cell<unknown>;
const titles = Array.from({ length: n }, (_, index) => `child-${index}`);
const sent = await sendVerbEvent(verb, { titles }, {
  invocation: { id: crypto.randomUUID(), session: "probe" },
  echo: false,
});
if (sent.status !== "committed") throw new Error(sent.error.message);
const handled = await sent.handled();
if (handled.status !== "handled") throw new Error(JSON.stringify(handled));
const listLink = (parent.key("children" as never) as Cell<unknown>)
  .getAsNormalizedFullLink();

const childLinks = await host.runLifecycleVerb(space, {
  name: "list",
  run: async (runtime) => {
    const list = runtime.getCellFromLink(listLink) as Cell<any>;
    await list.sync();
    return Array.from(
      { length: n },
      (_, index) => list.key(index).resolveAsCell().getAsNormalizedFullLink(),
    );
  },
});
const runningChildren = () =>
  host.runLifecycleVerb(space, {
    name: "count running",
    run: (runtime) =>
      Promise.resolve(
        childLinks.filter((link) =>
          runtime.runner.isRunning(runtime.getCellFromLink(link))
        ).length,
      ),
  });

if (scenario === "derived-written") {
  // Each child derives its values on the serving runtime, which then stops it.
  const { stopDeriving } = await host.runLifecycleVerb(space, {
    name: "derive",
    run: async (runtime) => {
      const cancels: Array<() => void> = [];
      const children: Cell<any>[] = [];
      for (const link of childLinks) {
        const child = runtime.getCellFromLink(link) as Cell<any>;
        await runtime.start(child);
        children.push(child);
        for (const key of ["upper", "lower", "size"]) {
          cancels.push(child.key(key).sink(() => {}));
        }
      }
      return {
        stopDeriving: () => {
          for (const cancel of cancels) cancel();
          for (const child of children) runtime.runner.stop(child);
        },
      };
    },
  });
  await host.whenQuiescent();
  await host.runLifecycleVerb(space, {
    name: "stop",
    run: () => Promise.resolve(stopDeriving()),
  });
  await host.whenQuiescent();
}
const runningBefore = await runningChildren();

// The read, from the client that sent the event, which has read nothing of
// the board.
const reader = writer;
gc();
const heapBefore = Deno.memoryUsage().heapUsed;
const cpuBefore = process.cpuUsage();
const wallBefore = performance.now();
const list = (parent.key("children" as never) as Cell<unknown>).asSchema(
  (scenario === "title" ? SCHEMAS.title : SCHEMAS.derived) as never,
) as Cell<any>;
if (!await pullFromServer(reader.runtime, list)) {
  throw new Error("The server did not answer the read");
}
// The answer says the server has settled; the sync brings what it sent.
await list.sync();
const wallMs = performance.now() - wallBefore;
const cpu = process.cpuUsage(cpuBefore);
await host.whenQuiescent();
gc();
const heapAfter = Deno.memoryUsage().heapUsed;
const read = (list.get() ?? []) as Array<Record<string, unknown>>;
const field = scenario === "title" ? "title" : "upper";
const valued = read.filter((item) => item?.[field] !== undefined).length;
const runningAfter = await runningChildren();

console.log(JSON.stringify({
  n,
  scenario,
  wallMs: Math.round(wallMs),
  cpuMs: Math.round((cpu.user + cpu.system) / 1000),
  heapBeforeMB: +(heapBefore / 2 ** 20).toFixed(1),
  heapAfterMB: +(heapAfter / 2 ** 20).toFixed(1),
  heapDeltaMB: +((heapAfter - heapBefore) / 2 ** 20).toFixed(1),
  runningBefore,
  runningAfter,
  valued,
}));

await host.close();
for (const cleanup of cleanups.reverse()) await cleanup();
await serving.close();
Deno.exit(0);
