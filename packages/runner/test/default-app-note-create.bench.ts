/**
 * Integration-shaped "default-app note create" benchmark.
 *
 * Reproduces the hot cycle of the default-app shell integration test
 * (packages/patterns/integration/default-app.test.ts) inside a single Deno
 * process so the full event → preflight → handler → commit → settle →
 * recompute path can be profiled and optimized without a browser:
 *
 * - a home doc holds a list of LINKS to per-note docs (like pieceRegistry),
 * - a lifted view derives display rows from the list (reads every note:
 *   link resolution + schema traverse + hashing, the integration's read mix),
 * - a live sink subscribes to the derived view (like the home UI),
 * - an event handler creates a new note doc and pushes its link (like the
 *   "New Note" flow), then a second event removes it again so the list size
 *   stays constant across bench iterations.
 *
 * The @0/@32/@128 size variants show how the cost of a create+remove cycle
 * moves with the existing note count.
 *
 * Complements:
 * - scheduler-event-preflight.bench.ts (synthetic preflight shape)
 * - push-pull-patterns.bench.ts (map/filter builtins)
 * - data-model/bench/value-identity-shapes.bench.ts (hash/freeze leafs)
 *
 * Run with:
 *   deno bench --allow-read --allow-write --allow-net --allow-ffi \
 *     --allow-env --no-check test/default-app-note-create.bench.ts
 */

import type { Cell, JSONSchema } from "../src/builder/types.ts";
import type { EventHandler } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  benchSpace,
  createSchedulerBenchEnv,
  type SchedulerBenchEnv,
} from "./scheduler-bench-helpers.ts";

const noteSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    content: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  // All three fields are always populated by noteValue(); marking them required
  // makes the schema-materialized callback input match the `Note` type under
  // lift's function-first schema-mode overload.
  required: ["title", "content", "tags"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const noteListSchema = {
  type: "array",
  items: noteSchema,
} as const satisfies JSONSchema;

// Same list, but elements kept as links (for structural edits that shouldn't
// deep-resolve every note).
const noteLinkListSchema = {
  type: "array",
  items: { ...noteSchema, asCell: ["cell"] },
} as const satisfies JSONSchema;

const homeArgumentSchema = {
  type: "object",
  properties: {
    items: noteListSchema,
  },
  required: ["items"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const homeResultSchema = {
  type: "object",
  properties: {
    titles: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
} as const satisfies JSONSchema;

type Note = { title: string; content: string; tags: string[] };

function noteValue(i: number): Note {
  return {
    title: `📝 New Note #${i.toString(36)}`,
    content: `Note body ${i} — `.repeat(8),
    tags: ["#note", `#tag-${i % 7}`],
  };
}

type NoteCreateGraph = {
  env: SchedulerBenchEnv;
  itemsCell: Cell<Note[]>;
  eventStream: Cell<unknown>;
  result: Cell<{ titles: string[] }>;
  cancels: Array<() => void>;
};

let causeCounter = 0;

async function setupNoteCreateGraph(
  prefix: string,
  initialNotes: number,
): Promise<NoteCreateGraph> {
  const env = createSchedulerBenchEnv();
  const { runtime } = env;
  const { commonfabric } = createTrustedBuilder(runtime);
  const { lift, pattern } = commonfabric;

  const tx = runtime.edit();
  const itemsCell = runtime.getCell<Note[]>(
    benchSpace,
    `${prefix}:items`,
    noteListSchema,
    tx,
  );
  itemsCell.set([]);

  // Seed the initial notes as separate linked docs, like pieces in a space.
  for (let i = 0; i < initialNotes; i++) {
    const note = runtime.getCell<Note>(
      benchSpace,
      `${prefix}:note:${causeCounter++}`,
      noteSchema,
      tx,
    );
    note.set(noteValue(i));
    itemsCell.push(note);
  }

  // Derived home view: reads (and therefore resolves + traverses) every note.
  const titlesOf = lift(
    (items: Note[]) =>
      items.map((note) => `${note.title} (${note.tags?.length ?? 0})`),
    noteListSchema,
    { type: "array", items: { type: "string" } } as const satisfies JSONSchema,
  );
  const homeView = pattern<{ items: Note[] }, unknown>(
    ({ items }) => ({ titles: titlesOf(items) }),
    homeArgumentSchema,
    homeResultSchema,
  );

  const resultCell = runtime.getCell<{ titles: string[] }>(
    benchSpace,
    `${prefix}:result`,
    homeResultSchema,
    tx,
  );
  const result = runtime.run(
    tx,
    homeView,
    { items: itemsCell },
    resultCell,
  ) as Cell<{ titles: string[] }>;

  const eventStream = runtime.getCell<unknown>(
    benchSpace,
    `${prefix}:events`,
    { asCell: ["stream"] },
    tx,
  );

  await tx.commit();
  await runtime.idle();

  // Live subscription, like the home UI rendering the list.
  const cancels: Array<() => void> = [];
  cancels.push(result.sink(() => {}));
  await runtime.idle();

  // "New Note" / "Remove Note" handler.
  const linkItems = itemsCell.asSchema(noteLinkListSchema);
  const handler = Object.assign(
    ((handlerTx: IExtendedStorageTransaction, event: { kind: string }) => {
      if (event.kind === "create") {
        const note = runtime.getCell<Note>(
          benchSpace,
          `${prefix}:note:${causeCounter++}`,
          noteSchema,
          handlerTx,
        );
        note.set(noteValue(causeCounter));
        itemsCell.withTx(handlerTx).push(note);
      } else {
        const links = linkItems.withTx(handlerTx).get() ?? [];
        linkItems.withTx(handlerTx).set(links.slice(0, -1));
      }
    }) as EventHandler,
    {
      reads: [],
      writes: [itemsCell.getAsNormalizedFullLink()],
      module: { type: "javascript" as const },
      pattern: {} as never,
    },
  );
  cancels.push(
    runtime.scheduler.addEventHandler(
      handler,
      eventStream.getAsNormalizedFullLink(),
    ),
  );

  return { env, itemsCell, eventStream, result, cancels };
}

function noteCreateCycle(graph: NoteCreateGraph): Promise<void> {
  const { env, eventStream } = graph;
  const link = eventStream.getAsNormalizedFullLink();
  env.runtime.scheduler.queueEvent(link, { kind: "create" });
  return env.runtime.idle().then(() => {
    env.runtime.scheduler.queueEvent(link, { kind: "remove" });
    return env.runtime.idle();
  });
}

for (const size of [0, 32, 128]) {
  const graphPromise = setupNoteCreateGraph(
    `default-app:pull:${size}`,
    size,
  );
  Deno.bench({
    name: `note create+remove cycle @${size} notes (pull)`,
    group: "note create (pull)",
    baseline: size === 0,
  }, async () => {
    const graph = await graphPromise;
    await noteCreateCycle(graph);
  });
}

// Note: graphs are deliberately kept alive for the whole bench process (the
// emulated storage holds no external state); the process exit cleans up.
