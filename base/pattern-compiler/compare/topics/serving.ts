/**
 * The arms `serving` and `serving-today` of `scale.ts`: a Topics board
 * under the serving loop, measured on two clients.
 *
 * A memory server listens on a websocket of this process with the serving
 * loop on this thread (`listenCompiledServingMemoryServer`). Two clients
 * connect with server execution on. The sender writes the topics and the
 * two inputs of the board, and sets the board up: on the arm `serving` as
 * a compiled piece (`setUpCompiledPiece`), whose source the serving runtime
 * compiles and runs, and on the arm `serving-today` as today's piece
 * (`Runtime.run`). Neither client runs the board of the arm `serving`.
 *
 * Each step is timed from the sender's call until the sender and the
 * second client, the reader, each read the one value the step changes,
 * through a sink on that one path:
 *
 * - `load`: from the commit of the setup until the title of the last topic
 *   stands in its row of `mentionable`.
 * - `edit topic <n>`: the sender writes the title of a topic, and the title
 *   stands in the topic's row of `mentionable`.
 * - `edit mentions <n>`: the sender writes the mentions of the middle topic
 *   to the first topic alone, and the row of the first topic in `crossrefs`
 *   holds a third member of `mentionedBy`.
 * - `edit shortName <n>`: the `shortName` stands in the row of `mentionable`.
 * - `edit lastActivityAt <n>`: the caption of the topic's card changes. On
 *   a board that orders its cards by last activity, that is the first card.
 * - `create <n>`: the sender sends `addTopic`, and `topicCount` is one more.
 *
 * The path of the caption in the rendered tree is found before the steps
 * by a third client that reads the tree down to the first card and is then
 * disposed, so the two measured clients hold no query over the tree. The
 * reader then holds, beside the sink of each step, a sink on the caption of
 * each of the first 20 cards, as a reader that shows the first screen of
 * the board does.
 *
 * With `SCALE_TAKEOVER` set, another serving loop then takes the space
 * over: `takeover` holds the time until a client that holds nothing reads
 * `topicCount` and until the loop is quiescent, whether the basis found the
 * piece current, how many documents the comparison read, and the
 * evaluations by then; `after takeover 0` and `after takeover 1` are two
 * edits of the title of the first topic after it.
 *
 * `SCALE_CREATES` is the number of creates, three by default. With
 * `SCALE_SCOPES` set, each step lists the scope instances the executor of
 * the piece holds, each with its size as JSON.
 *
 * With `SCALE_PROFILE_STEP` naming a step and `SCALE_CPU_PROFILE` a file,
 * the sampling profile of the process over that step is written there.
 *
 * The serving runtime and the clients run with the runtime's default dials
 * of Contextual Flow Control, under which flow labels are stored. Without
 * `ServingBoard.labels` the topics and the inputs are under no label, so
 * nothing the board derives has a label to store. With it, which
 * `SCALE_SERVING_LABELS` gives, each topic and each input is written under
 * the schema with the clause the arm `runner` writes it under.
 *
 * The crate's check refuses the two measured boards (a handle declared as
 * a view of the type the cell holds), so the serving runtime of the arm
 * compiles with `emit --unchecked` and not with `emit --accepted`, as the
 * arm `runner` does.
 */
// deno-lint-ignore no-external-import -- The sampling profiler is reached through this Node builtin alone.
import inspector from "node:inspector";
import { Identity } from "@commonfabric/identity";
import { dirname, fromFileUrl, join } from "@std/path";

import { getTimingStatsBreakdown } from "../../../logger/src/logger.ts";
import type { JSONSchema } from "../../../../runtime/runner/src/builder/types.ts";
import type { Cell, MemorySpace } from "../../../../runtime/runner/src/cell.ts";
import type { CompiledPiece } from "../../../../runtime/runner/src/compiled/piece.ts";
import type { ResumedPiece } from "../../../../runtime/runner/src/compiled/resume.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../../../runtime/runner/src/compiled/serving-memory-server.deno.ts";
import type {
  CompilePatternProgram,
  PatternProgram,
} from "../../../../runtime/runner/src/compiled/serving.ts";
import { setUpCompiledPiece } from "../../../../runtime/runner/src/compiled/setup.ts";
import { readStoredCfcMetadata } from "../../../../runtime/runner/src/cfc/metadata.ts";
import type { NormalizedFullLink } from "../../../../runtime/runner/src/link-types.ts";
import {
  isCellLink,
  parseLink,
} from "../../../../runtime/runner/src/link-utils.ts";
import { resolveLocalProgram } from "../../../../runtime/runner/src/harness/local-program.deno.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";
import type { Artifact } from "../../exec/executor.ts";

const repository = fromFileUrl(new URL("../../../../", import.meta.url));

/** What `runServing()` is given of `scale.ts`. */
export type ServingBoard = {
  /** The module of the board, relative to `patterns/`. */
  module: string;
  /** The files of the program, relative to `patterns/`. */
  files: readonly string[];
  topics: {
    mentions: number[];
    title: string;
    [name: string]: unknown;
  }[];
  /** Each name with the index of the topic it names. */
  names: Record<string, number>;
  /** The event of the create of a turn. */
  created: (turn: number) => unknown;
  /** The topics whose titles the edits write. */
  edited: number[];
  /**
   * With it, the inputs are written under labels, as the arm `runner`
   * writes them: the identity whose space the board is in, the schema each
   * topic is written under, and the schema of the cell of each input.
   */
  labels?: {
    signer: Identity;
    topic: (index: number) => JSONSchema;
    input: (name: string) => JSONSchema;
  };
};

/** One measured step of a serving arm. */
export type ServingStep = {
  arm: "serving" | "serving-today";
  size: number;
  step: string;
  /** Until the sender reads what the step changes, in milliseconds. */
  sender: number;
  /** Until the second client reads it. */
  reader: number;
  /** Until the serving loop is quiescent after that. */
  quiescent: number;
  /** On the arm `serving`: what the compiled piece did in the step. */
  compiled?: Record<string, number>;
  /** The reason of each commit of the piece the storage refused so far. */
  refusals?: string[];
  /**
   * The preparations of Contextual Flow Control that the process made in
   * the step, the clients' and the serving runtime's together, and their
   * time in milliseconds.
   */
  preparations: number;
  prepareMs: number;
  /**
   * After the load: how many entries of a label the storage holds for the
   * result document, for the first row of `mentionable` and for the first
   * topic.
   */
  storedLabels?: { result: number; row: number; topic: number };
  /**
   * With `SCALE_COMMITS` set: each document a change of which the reader
   * was delivered in the step, with the size of what the reader holds of
   * it as JSON text, largest first.
   */
  documents?: { id: string; bytes: number }[];
};

/** What another serving loop that takes the space over did. */
export type ServingTakeover = {
  arm: "serving" | "serving-today";
  size: number;
  step: "takeover";
  /** Until a client that holds nothing reads `topicCount`. */
  read: number;
  /** Until the loop is quiescent. */
  quiescent: number;
  /** Whether the basis of each resumed piece matched the storage. */
  current: boolean[];
  /** How many documents each comparison brought into the replica. */
  checked: number[];
  /** The evaluations the serving runtime had made by then. */
  evaluations: number;
};

const round = (milliseconds: number) => Math.round(milliseconds * 10) / 10;

/** The topics one transaction of the seed holds at most. */
const TOPICS_PER_TRANSACTION = 500;

/**
 * What compiles the program a client wrote, for the serving runtime of the
 * arm: the crate's release binary with `emit`, over the files of the
 * program written to a directory of their own.
 */
const emitProgram: CompilePatternProgram = async (program: PatternProgram) => {
  const directory = await Deno.makeTempDir({ prefix: "cf-topics-serving-" });
  try {
    const names = program.files.map(({ name }) => name.replace(/^\/+/, ""));
    for (const [index, { contents }] of program.files.entries()) {
      const path = join(directory, names[index]);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, contents);
    }
    const { success, stdout, stderr } = await new Deno.Command(
      `${repository}base/pattern-compiler/target/release/pattern-compiler`,
      { args: ["emit", "--unchecked", ...names], cwd: directory },
    ).output();
    if (!success) throw new Error(new TextDecoder().decode(stderr));
    const modules = JSON.parse(new TextDecoder().decode(stdout)) as {
      module: string;
      patterns: Artifact[];
    }[];
    const known = new Map<string, Artifact>();
    let main: Artifact | undefined;
    const mainModule = program.main.replace(/^\/+/, "");
    for (const { module, patterns } of modules) {
      for (const pattern of patterns) {
        const id = (pattern.plan as { patterns?: string[] }).patterns?.[0];
        if (id !== undefined) known.set(id, pattern);
        if (
          module === mainModule &&
          pattern.name === (program.mainExport ?? "default")
        ) main = pattern;
      }
    }
    if (main === undefined) throw new Error("The crate emitted no board.");
    return { main, artifacts: (id) => known.get(id) };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
};

/**
 * Resolves with the time at which `runtime` reads, at `path` of the result,
 * a value `test` accepts: the callback of a sink on that one path.
 */
const seen = (
  runtime: Runtime,
  result: Cell<unknown>,
  path: readonly (string | number)[],
  test: (value: unknown) => boolean,
): Promise<number> => {
  // deno-lint-ignore no-explicit-any
  let cell: any = runtime.getCellFromLink(result.getAsNormalizedFullLink());
  for (const segment of path) cell = cell.key(segment);
  return new Promise((resolve) => {
    let done = false;
    const cancel: () => void = cell.sink((value: unknown) => {
      if (done || !test(value)) return;
      done = true;
      resolve(performance.now());
      // The sink calls back before it returns the cancel the first time.
      queueMicrotask(() => cancel());
    });
  });
};

/**
 * Starts the sampling profiler of the process and returns what stops it
 * and writes the profile to `file`, in the format of the V8 inspector.
 */
const startProfile = async (file: string): Promise<() => Promise<void>> => {
  const session = new inspector.Session();
  session.connect();
  const post = (method: string, params?: object) =>
    new Promise<unknown>((resolve, reject) =>
      session.post(
        method,
        params,
        (error: Error | null, result?: unknown) =>
          error === null ? resolve(result) : reject(error),
      )
    );
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 500 });
  await post("Profiler.start");
  return async () => {
    const { profile } = await post("Profiler.stop") as { profile: unknown };
    await Deno.writeTextFile(file, JSON.stringify(profile));
  };
};

/** How many cards a reader of the board holds: one screen of them. */
const FIRST_SCREEN = 20;

/** The mark of the caption of a card (`cardTextOf` of `card-text.ts`). */
const CAPTION = " comments · by ";

/** Where the caption of a card stands in a rendered tree. */
type CaptionPath = {
  /** The path of the array of cards. */
  cards: (string | number)[];
  /** The path of the caption below a card. */
  caption: (string | number)[];
  /**
   * Where the array of cards is stored in chunks (unless `SCALE_LISTS` is
   * `in-place`, for more cards than one list document holds): how many
   * cards each chunk held when the path was found. The array then holds
   * the chunks, and a card stands in its chunk.
   */
  chunks?: number[];
};

/**
 * The path of the row at `index` below an array of rows of a board that
 * was loaded with `size` topics: the index, or, unless `SCALE_LISTS` is
 * `in-place`, for more topics than one list document holds
 * (`SCALE_LIST_WHOLE`, or 128), the chunk and the place in it. A load lays
 * the rows out in chunks of 48 (`LIST_FILL` of
 * `runtime/runner/src/compiled/transactions.ts`), and a topic that is
 * appended afterwards moves none of them.
 */
const rowAt = (
  arm: string,
  size: number,
  index: number,
): (string | number)[] =>
  arm === "serving" && Deno.env.get("SCALE_LISTS") !== "in-place" &&
    size > Number(Deno.env.get("SCALE_LIST_WHOLE") ?? 128)
    ? [Math.floor(index / 48), index % 48]
    : [index];

/** The path of the card at `index`, below the array of cards. */
const cardAt = (
  { chunks }: CaptionPath,
  index: number,
): (string | number)[] => {
  if (chunks === undefined) return [index];
  let chunk = 0;
  while (chunk < chunks.length - 1 && index >= chunks[chunk]) {
    index -= chunks[chunk];
    chunk += 1;
  }
  return [chunk, index];
};

/**
 * Finds, in the rendered tree of the board whose result is at `result`,
 * the path of the array of cards and the path of the caption below a card:
 * the first array of at least `size` members that holds, below its first
 * member, a string with the mark of a caption. It reads the stored
 * documents one by one through `runtime` and follows a link only on the
 * way to the first card, so it reads no topic and no other card.
 */
const captionPathOf = async (
  runtime: Runtime,
  result: NormalizedFullLink,
  size: number,
): Promise<CaptionPath | undefined> => {
  type Path = (string | number)[];
  const rootOf = async (link: NormalizedFullLink): Promise<unknown> => {
    const root = { ...link, path: [] };
    await runtime.getCellFromLink(root, false as JSONSchema).sync();
    const tx = runtime.edit();
    try {
      return tx.readValueOrThrow(root);
    } finally {
      tx.abort();
    }
  };
  /** What stands where `value`, read at `base`, leads through links. */
  const resolved = async (
    value: unknown,
    base: NormalizedFullLink,
  ): Promise<{ value: unknown; base: NormalizedFullLink }> => {
    for (let hops = 0; hops < 8 && isCellLink(value); hops++) {
      const link = parseLink(value, base) as NormalizedFullLink;
      let at = await rootOf(link);
      let from: NormalizedFullLink = { ...link, path: [] };
      for (const segment of link.path) {
        ({ value: at, base: from } = await resolved(at, from));
        at = (at as Record<string, unknown> | undefined)?.[segment];
        from = { ...from, path: [...from.path, segment] };
      }
      value = at;
      base = from;
    }
    return { value, base };
  };
  const below = async (
    given: unknown,
    at: NormalizedFullLink,
    depth: number,
  ): Promise<Path | undefined> => {
    const { value, base } = await resolved(given, at);
    if (typeof value === "string") {
      return value.includes(CAPTION) ? [] : undefined;
    }
    if (typeof value !== "object" || value === null || depth > 8) {
      return undefined;
    }
    for (const [name, member] of Object.entries(value)) {
      // A card links to its topic, which holds no caption.
      if (name === "$cell") continue;
      const found = await below(
        member,
        { ...base, path: [...base.path, name] },
        depth + 1,
      );
      if (found !== undefined) {
        return [Array.isArray(value) ? Number(name) : name, ...found];
      }
    }
    return undefined;
  };
  const walk = async (
    given: unknown,
    at: NormalizedFullLink,
    path: Path,
  ): Promise<CaptionPath | undefined> => {
    const { value, base } = await resolved(given, at);
    if (typeof value !== "object" || value === null || path.length > 12) {
      return undefined;
    }
    if (Array.isArray(value) && value.length >= size) {
      if (size === 0) return undefined;
      const caption = await below(
        value[0],
        { ...base, path: [...base.path, "0"] },
        0,
      );
      return caption === undefined ? undefined : { cards: path, caption };
    }
    // An array of cards that is stored in chunks holds the chunks, each an
    // array of cards.
    if (Array.isArray(value) && value.length > 0 && size > 0) {
      const first = await resolved(value[0], {
        ...base,
        path: [...base.path, "0"],
      });
      if (Array.isArray(first.value) && first.value.length > 0) {
        const chunks = [first.value.length];
        for (let at = 1; at < value.length; at++) {
          const chunk = await resolved(value[at], {
            ...base,
            path: [...base.path, `${at}`],
          });
          chunks.push(Array.isArray(chunk.value) ? chunk.value.length : 0);
        }
        if (chunks.reduce((sum, length) => sum + length, 0) >= size) {
          const caption = await below(
            first.value[0],
            { ...first.base, path: [...first.base.path, "0"] },
            0,
          );
          return caption === undefined
            ? undefined
            : { cards: path, caption, chunks };
        }
      }
    }
    for (const [name, member] of Object.entries(value)) {
      if (name === "$cell") continue;
      const found = await walk(
        member,
        { ...base, path: [...base.path, name] },
        [...path, Array.isArray(value) ? Number(name) : name],
      );
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const root = await rootOf(result);
  return walk((root as Record<string, unknown> | undefined)?.$UI, {
    ...result,
    path: ["$UI"],
  }, []);
};

/**
 * Runs one board under the serving loop. `record` is given each step as it
 * is measured.
 */
export const runServing = async (
  board: ServingBoard,
  arm: "serving" | "serving-today",
  record: (step: ServingStep | ServingTakeover) => void,
): Promise<void> => {
  const size = board.topics.length;
  const signer = board.labels?.signer ??
    await Identity.fromPassphrase(`topics-serving ${size}`);
  const space: MemorySpace = signer.did();
  const resumed: ResumedPiece[] = [];
  const failures: string[] = [];
  const failure = Promise.withResolvers<never>();
  failure.promise.catch(() => {});
  const serving: CompiledServingMemoryServer =
    await listenCompiledServingMemoryServer({
      compile: emitProgram,
      // The serving runtime reads its space from the store, as a toolshed's
      // does by default. `SCALE_READ_THROUGH=off` has it read over its
      // session.
      ...(Deno.env.get("SCALE_READ_THROUGH") === "off"
        ? {}
        : { policy: { storeReadThrough: true } }),
      pieces: {
        // `SCALE_LISTS=in-place` stores the links to the rows and to the
        // buckets of the board in the result document, and
        // `SCALE_LIST_WHOLE` is the most rows whose links one list
        // document holds.
        piece: {
          now: 1_000_000,
          ...(Deno.env.get("SCALE_LISTS") === "in-place"
            ? { lists: "in-place" as const }
            : {}),
          ...(Deno.env.get("SCALE_LIST_WHOLE") === undefined
            ? {}
            : { listWhole: Number(Deno.env.get("SCALE_LIST_WHOLE")) }),
        },
        resumed: (_result, piece) => resumed.push(piece),
        failed: (_result, error) => {
          failures.push(`${error}`);
          failure.reject(
            new Error(`The serving runtime failed: ${error}`),
          );
        },
      },
    });
  const client = () =>
    new Runtime({
      apiUrl: serving.url,
      storageManager: StorageManager.open({
        as: signer,
        memoryHost: serving.url,
      }),
      experimental: { serverExecution: true },
    });
  const sender = client();
  const reader = client();
  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = sender.edit();
    write(tx);
    const { error } = await tx.commit().settled;
    if (error !== undefined) throw error;
  };
  /** What ends the sinks the reader holds on the first screen of cards. */
  const screenSinks: (() => void)[] = [];
  try {
    // Every cell exists before any is set, since a topic may mention one
    // after it.
    // deno-lint-ignore no-explicit-any
    const cells: any[] = board.topics.map((_, index) =>
      sender.getCell(space, `topic ${index}`, board.labels?.topic(index))
    );
    for (let from = 0; from < size; from += TOPICS_PER_TRANSACTION) {
      await commit((tx) => {
        const to = Math.min(size, from + TOPICS_PER_TRANSACTION);
        for (let index = from; index < to; index++) {
          const { mentions, ...rest } = board.topics[index];
          cells[index].withTx(tx).set({
            ...rest,
            mentions: mentions.map((target) => cells[target]),
          });
        }
      });
    }
    // Each input of the board is a cell of its own, as on the arm `runner`.
    const held: Record<string, unknown> = {
      topics: cells,
      names: Object.fromEntries(
        Object.entries(board.names).map((
          [name, index],
        ) => [name, cells[index]]),
      ),
    };
    const argument: Record<string, Cell<unknown>> = {};
    await commit((tx) => {
      for (const [name, value] of Object.entries(held)) {
        const input = sender.getCell(
          space,
          { scaleInput: name },
          board.labels?.input(name),
        );
        input.withTx(tx).set(value as never);
        argument[name] = input;
      }
    });
    const result = sender.getCell<unknown>(space, "topics scale");
    const piece = (): CompiledPiece | undefined => serving.pieces()[0];
    const countsOf = () => {
      const running = piece();
      return running === undefined ? undefined : {
        events: running.counts.events,
        derivations: running.counts.derivations,
        ownMs: running.counts.ownMs,
        evaluations: running.instance.counts.evaluations,
        // Every count of the executor and of the transactions, by name.
        ...Object.fromEntries(
          [
            ...Object.entries(running.instance.counts).map((
              [name, count],
            ) => [`i.${name}`, count]),
            ...Object.entries(running.transactions.counts).map((
              [name, count],
            ) => [`t.${name}`, count]),
          ].filter((entry): entry is [string, number] =>
            typeof entry[1] === "number"
          ),
        ),
        reads: running.transactions.counts.reads,
        writes: running.transactions.counts.writes,
        recordsGiven: running.transactions.counts.recordsGiven,
      };
    };
    /** The preparations the process made so far, and their time. */
    const prepared = (): { count: number; ms: number } => {
      const stats = getTimingStatsBreakdown()["extended-storage-transaction"]
        ?.["prepareCfc"];
      return { count: stats?.count ?? 0, ms: stats?.totalTime ?? 0 };
    };
    /** How many entries of a label the store holds for a document. */
    const labelEntriesOf = (id: string): number => {
      const [runtime] = serving.runtimes();
      if (runtime === undefined) return 0;
      const tx = runtime.edit();
      try {
        const metadata = readStoredCfcMetadata(tx, {
          space,
          id: id as `${string}:${string}`,
          scope: "space",
        });
        return metadata?.labelMap.entries.length ?? 0;
      } finally {
        tx.abort();
      }
    };
    /**
     * How the serving runtime holds the list at the member `name` of the
     * result: the number of links of the list document, and where those
     * link to chunks, the number of links of each chunk.
     */
    const layoutOf = (name: string): unknown => {
      const [runtime] = serving.runtimes();
      if (runtime === undefined) return "no serving runtime";
      const at = result.getAsNormalizedFullLink();
      const tx = runtime.edit();
      try {
        const follow = (link: unknown): unknown => {
          const { id, path } = parseLink(link as never, at);
          return tx.readValueOrThrow({
            ...at,
            id: id as typeof at.id,
            path: [...(path ?? [])],
          });
        };
        const held = tx.readValueOrThrow({ ...at, path: [name] });
        if (!isCellLink(held)) {
          return Array.isArray(held) ? { inPlace: held.length } : "no list";
        }
        const list = follow(held);
        if (!Array.isArray(list)) return "no list document";
        const members = list.slice(0, 4096).map((member) =>
          isCellLink(member) ? follow(member) : undefined
        );
        return members.length > 0 &&
            members.every((member) => Array.isArray(member))
          ? { chunks: members.map((member) => (member as unknown[]).length) }
          : { links: list.length };
      } finally {
        tx.abort();
      }
    };
    const storedLabels = () => {
      const [runtime] = serving.runtimes();
      const at = result.getAsNormalizedFullLink();
      let row = 0;
      if (runtime !== undefined) {
        const tx = runtime.edit();
        try {
          const first = tx.readValueOrThrow({
            ...at,
            path: ["mentionable", "0"],
          });
          if (isCellLink(first)) {
            row = labelEntriesOf(parseLink(first, at).id ?? "");
          }
        } finally {
          tx.abort();
        }
      }
      return {
        result: labelEntriesOf(at.id),
        row,
        topic: labelEntriesOf(cells[0].getAsNormalizedFullLink().id),
      };
    };
    const measure = async (
      step: string,
      path: readonly (string | number)[],
      test: (value: unknown) => boolean,
      change: () => void | Promise<void>,
    ) => {
      const before = countsOf();
      const preparedBefore = prepared();
      const stopProfile = Deno.env.get("SCALE_PROFILE_STEP") === step
        ? await startProfile(Deno.env.get("SCALE_CPU_PROFILE") ?? "")
        : undefined;
      // With `SCALE_COMMITS` set: the documents whose changes the reader
      // was delivered in the step.
      const delivered = new Set<string>();
      const deliveries = {
        next(
          notification: Parameters<
            Parameters<Runtime["storageManager"]["subscribe"]>[0]["next"]
          >[0],
        ) {
          if (notification.type === "reset") return undefined;
          for (const { address } of notification.changes) {
            delivered.add(address.id);
          }
          return undefined;
        },
      };
      const logged = Deno.env.get("SCALE_COMMITS") !== undefined;
      if (logged) reader.storageManager.subscribe(deliveries);
      const visible = [sender, reader].map((runtime) =>
        seen(runtime, result, path, test)
      );
      const began = performance.now();
      await change();
      // With `SCALE_LAYOUT` set: once the serving runtime is quiescent,
      // how the list the step waits on is laid out, how many pieces that
      // runtime runs, and the refusals and failures so far, on the error
      // stream.
      if (Deno.env.get("SCALE_LAYOUT") !== undefined) {
        void serving.host.whenQuiescent().then(() =>
          console.error(
            JSON.stringify({
              step,
              path,
              layout: layoutOf(`${path[0]}`),
              pieces: serving.pieces().length,
              refusals: piece()?.refusals.length ?? 0,
              failures: failures.length,
            }),
          )
        );
      }
      // A piece the serving runtime did not start never shows the value.
      const [first, second] = await Promise.race([
        Promise.all(visible),
        failure.promise,
      ]);
      await serving.host.whenQuiescent();
      const quiescent = performance.now();
      await stopProfile?.();
      if (failures.length > 0) {
        throw new Error(`The serving runtime failed: ${failures[0]}`);
      }
      const after = countsOf();
      const preparedAfter = prepared();
      if (logged) reader.storageManager.unsubscribe?.(deliveries);
      const documents = [...delivered].map((id) => {
        const tx = reader.edit();
        try {
          const held = tx.readValueOrThrow({
            space,
            id: id as `${string}:${string}`,
            path: [],
            scope: "space",
          });
          return { id, bytes: JSON.stringify(held ?? null).length };
        } finally {
          tx.abort();
        }
      }).sort((a, b) => b.bytes - a.bytes);
      record({
        arm,
        size,
        step,
        ...(logged ? { documents } : {}),
        sender: round(first - began),
        reader: round(second - began),
        quiescent: round(quiescent - began),
        preparations: preparedAfter.count - preparedBefore.count,
        prepareMs: round(preparedAfter.ms - preparedBefore.ms),
        ...(step === "load" ? { storedLabels: storedLabels() } : {}),
        // With `SCALE_SCOPES` set: each scope instance the executor of the
        // piece holds, by its name, with its size as JSON.
        ...(Deno.env.get("SCALE_SCOPES") === undefined ? {} : {
          scopes: Object.fromEntries(
            [...(piece()?.instance.store.docs ?? [])]
              .filter(([, { kind }]) => kind === "scope instance")
              .map((
                [id, { value }],
              ) => [id, JSON.stringify(value ?? null).length]),
          ),
        }),
        ...(after === undefined ? {} : {
          compiled: Object.fromEntries(
            Object.entries(after).map(([name, value]) => [
              name,
              round(
                value - (before?.[name as keyof typeof after] ?? 0),
              ),
            ]),
          ),
          refusals: piece()?.refusals.slice(0, 3) ?? [],
        }),
      });
    };
    const last = size - 1;
    await measure(
      "load",
      ["mentionable", ...rowAt(arm, size, last), "title"],
      (value) => value === board.topics[last].title,
      async () => {
        const tx = sender.edit();
        if (arm === "serving") {
          const files = await Promise.all(board.files.map(async (name) => ({
            name: `/${name}`,
            contents: await Deno.readTextFile(
              `${repository}patterns/${name}`,
            ),
          })));
          setUpCompiledPiece(
            sender,
            tx,
            { main: `/${board.module}`, files },
            argument,
            result.withTx(tx),
          );
        } else {
          const program = await resolveLocalProgram(
            (resolver) => sender.harness.resolve(resolver),
            { main: `${repository}patterns/${board.module}`, root: repository },
          );
          const pattern = await sender.patternManager.compilePattern(program, {
            space,
          });
          sender.run(tx, pattern, argument, result.withTx(tx));
        }
        const { error } = await tx.commit().settled;
        if (error !== undefined) throw error;
      },
    );

    // The path of the caption of a card, read by a client of its own.
    const probe = client();
    let captionAt: CaptionPath | undefined;
    try {
      captionAt = await captionPathOf(
        probe,
        result.getAsNormalizedFullLink(),
        size,
      );
    } finally {
      await probe.dispose();
    }

    // The reader holds what a reader of the board holds: the result
    // document, and the first screen of cards, each by a sink on its
    // caption, which follows the link to the card's document and no link
    // of the card. It holds no topic and no query over every card.
    if (captionAt !== undefined) {
      const screen = Math.min(size, FIRST_SCREEN);
      for (let card = 0; card < screen; card++) {
        // deno-lint-ignore no-explicit-any
        let caption: any = reader.getCellFromLink(
          result.getAsNormalizedFullLink(),
        ).key("$UI" as never);
        for (
          const segment of [
            ...captionAt.cards,
            ...cardAt(captionAt, card),
            ...captionAt.caption,
          ]
        ) caption = caption.key(segment);
        screenSinks.push(caption.sink(() => {}));
      }
    }

    // The sender holds the marker of the stream, by which a send to the
    // member of the result is the append of an event.
    const addTopic = sender.getCellFromLink(result.getAsNormalizedFullLink())
      .key("addTopic" as never) as Cell<unknown>;
    await addTopic.sync();
    await addTopic.resolveAsCell().sync();
    addTopic.sink(() => {});

    for (const at of board.edited) {
      await measure(
        `edit topic ${at}`,
        ["mentionable", ...rowAt(arm, size, at), "title"],
        (value) => value === `Edited topic ${at}`,
        () =>
          commit((tx) => {
            cells[at].withTx(tx).key("title").set(`Edited topic ${at}`);
          }),
      );
    }
    const middle = Math.floor(size / 2);
    await measure(
      `edit mentions ${middle}`,
      ["crossrefs", ...rowAt(arm, size, 0), "mentionedBy", 2],
      (value) => value !== undefined && value !== null,
      () =>
        commit((tx) => {
          cells[middle].withTx(tx).key("mentions").set([cells[0]]);
        }),
    );
    await measure(
      `edit shortName ${middle}`,
      ["mentionable", ...rowAt(arm, size, middle), "shortName"],
      (value) => value === `renamed-${middle}`,
      () =>
        commit((tx) => {
          cells[middle].withTx(tx).key("shortName").set(`renamed-${middle}`);
        }),
    );
    if (captionAt === undefined) {
      console.error(
        JSON.stringify({ arm, size, skipped: "edit lastActivityAt" }),
      );
    } else {
      // The card of the middle topic: where it stands in filing order, and
      // otherwise the first card, which the most recently active topic has.
      const ordered = !board.module.endsWith("board-filing-order.tsx");
      const card = [
        ...captionAt.cards,
        ...cardAt(captionAt, ordered ? 0 : middle),
        ...captionAt.caption,
      ];
      // deno-lint-ignore no-explicit-any
      let held: any = sender.getCellFromLink(result.getAsNormalizedFullLink())
        .key("$UI" as never);
      for (const segment of card) held = held.key(segment);
      await held.sync();
      const captionBefore = held.get();
      await measure(
        `edit lastActivityAt ${middle}`,
        ["$UI", ...card],
        (value) =>
          typeof value === "string" && value.includes(CAPTION) &&
          value !== captionBefore,
        () =>
          commit((tx) => {
            cells[middle].withTx(tx).key("lastActivityAt").set(
              4_000_000_000_000,
            );
          }),
      );
    }
    // `SCALE_CREATES` is the number of creates, three by default.
    const creates = Number(Deno.env.get("SCALE_CREATES") ?? 3);
    for (let turn = 0; turn < creates; turn++) {
      await measure(
        `create ${turn}`,
        ["topicCount"],
        (value) => value === size + turn + 1,
        () => addTopic.send(board.created(turn) as never),
      );
    }

    // With `SCALE_PROFILE_EDITS` naming a kind of edit, that edit is made
    // `SCALE_PROFILE_ROUNDS` times on the middle topic, each awaited as a
    // step is, under one sampling profile written to `SCALE_CPU_PROFILE`.
    const profiled = Deno.env.get("SCALE_PROFILE_EDITS");
    if (profiled !== undefined) {
      const rounds = Number(Deno.env.get("SCALE_PROFILE_ROUNDS") ?? 20);
      const file = Deno.env.get("SCALE_CPU_PROFILE");
      const stopProfile = file === undefined
        ? undefined
        : await startProfile(file);
      for (let turn = 0; turn < rounds; turn++) {
        if (profiled === "title") {
          await measure(
            `repeated title ${turn}`,
            ["mentionable", ...rowAt(arm, size, middle), "title"],
            (value) => value === `Repeated ${turn}`,
            () =>
              commit((tx) => {
                cells[middle].withTx(tx).key("title").set(`Repeated ${turn}`);
              }),
          );
        } else if (profiled === "shortName") {
          await measure(
            `repeated shortName ${turn}`,
            ["mentionable", ...rowAt(arm, size, middle), "shortName"],
            (value) => value === `again-${turn}`,
            () =>
              commit((tx) => {
                cells[middle].withTx(tx).key("shortName").set(`again-${turn}`);
              }),
          );
        } else if (profiled === "mentions") {
          // The mention of the first topic is taken away and given back.
          const gone = turn % 2 === 0;
          await measure(
            `repeated mentions ${turn}`,
            ["crossrefs", ...rowAt(arm, size, 0), "mentionedBy", 2],
            (value) => (value === undefined || value === null) === gone,
            () =>
              commit((tx) => {
                cells[middle].withTx(tx).key("mentions").set(
                  gone ? [] : [cells[0]],
                );
              }),
          );
        } else {
          throw new Error(`SCALE_PROFILE_EDITS names no edit: ${profiled}.`);
        }
      }
      await stopProfile?.();
    }

    if (Deno.env.get("SCALE_TAKEOVER") !== undefined) {
      await serving.host.whenQuiescent();
      const restarted = performance.now();
      await serving.restart();
      const late = client();
      try {
        const read = await seen(
          late,
          result,
          ["topicCount"],
          (value) => value === size + creates,
        );
        await serving.host.whenQuiescent();
        const quiescent = performance.now();
        record({
          arm,
          size,
          step: "takeover",
          read: round(read - restarted),
          quiescent: round(quiescent - restarted),
          current: resumed.map(({ current }) => current),
          checked: resumed.map(({ checked }) => checked),
          evaluations: piece()?.instance.counts.evaluations ?? 0,
        });
        for (let turn = 0; turn < 2; turn++) {
          await measure(
            `after takeover ${turn}`,
            ["mentionable", ...rowAt(arm, size, 0), "title"],
            (value) => value === `After the takeover ${turn}`,
            () =>
              commit((tx) => {
                cells[0].withTx(tx).key("title").set(
                  `After the takeover ${turn}`,
                );
              }),
          );
        }
      } finally {
        await late.dispose();
      }
    }
  } finally {
    for (const cancel of screenSinks.splice(0)) cancel();
    await serving.host.close();
    await sender.dispose();
    await reader.dispose();
    await serving.close();
  }
};
