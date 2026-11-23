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
 * disposed, so the two measured clients hold no query over the tree.
 *
 * With `SCALE_TAKEOVER` set, another serving loop then takes the space
 * over: `takeover` holds the time until a client that holds nothing reads
 * `topicCount` and until the loop is quiescent, whether the basis found the
 * piece current, how many documents the comparison read, and the
 * evaluations by then; `after takeover 0` and `after takeover 1` are two
 * edits of the title of the first topic after it.
 *
 * The topics and the inputs are under no label and the serving runtime
 * stores no flow labels, as in `../serving-path.ts`, so the figures are not
 * those of the arm `runner`, which stores labels.
 *
 * The crate's check refuses the two measured boards (a handle declared as
 * a view of the type the cell holds), so the serving runtime of the arm
 * compiles with `emit` and not with `emit --accepted`, as the arm `runner`
 * does.
 */
import { Identity } from "@commonfabric/identity";
import { dirname, fromFileUrl, join } from "@std/path";

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
      { args: ["emit", ...names], cwd: directory },
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

/** The mark of the caption of a card (`cardTextOf` of `card-text.ts`). */
const CAPTION = " comments · by ";

/** Where the caption of a card stands in a rendered tree. */
type CaptionPath = {
  /** The path of the array of cards. */
  cards: (string | number)[];
  /** The path of the caption below a card. */
  caption: (string | number)[];
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
  const signer = await Identity.fromPassphrase(`topics-serving ${size}`);
  const space: MemorySpace = signer.did();
  const resumed: ResumedPiece[] = [];
  const failures: string[] = [];
  const serving: CompiledServingMemoryServer =
    await listenCompiledServingMemoryServer({
      compile: emitProgram,
      pieces: {
        piece: { now: 1_000_000 },
        resumed: (_result, piece) => resumed.push(piece),
        failed: (_result, error) => failures.push(`${error}`),
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
  try {
    // Every cell exists before any is set, since a topic may mention one
    // after it.
    // deno-lint-ignore no-explicit-any
    const cells: any[] = board.topics.map((_, index) =>
      sender.getCell(space, `topic ${index}`)
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
        const input = sender.getCell(space, { scaleInput: name });
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
        reads: running.transactions.counts.reads,
        writes: running.transactions.counts.writes,
        recordsGiven: running.transactions.counts.recordsGiven,
      };
    };
    const measure = async (
      step: string,
      path: readonly (string | number)[],
      test: (value: unknown) => boolean,
      change: () => void | Promise<void>,
    ) => {
      const before = countsOf();
      const visible = [sender, reader].map((runtime) =>
        seen(runtime, result, path, test)
      );
      const began = performance.now();
      await change();
      const [first, second] = await Promise.all(visible);
      await serving.host.whenQuiescent();
      const quiescent = performance.now();
      if (failures.length > 0) {
        throw new Error(`The serving runtime failed: ${failures[0]}`);
      }
      const after = countsOf();
      record({
        arm,
        size,
        step,
        sender: round(first - began),
        reader: round(second - began),
        quiescent: round(quiescent - began),
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
      ["mentionable", last, "title"],
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
        ["mentionable", at, "title"],
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
      ["crossrefs", 0, "mentionedBy", 2],
      (value) => value !== undefined && value !== null,
      () =>
        commit((tx) => {
          cells[middle].withTx(tx).key("mentions").set([cells[0]]);
        }),
    );
    await measure(
      `edit shortName ${middle}`,
      ["mentionable", middle, "shortName"],
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
        ordered ? 0 : middle,
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
    for (let turn = 0; turn < 3; turn++) {
      await measure(
        `create ${turn}`,
        ["topicCount"],
        (value) => value === size + turn + 1,
        () => addTopic.send(board.created(turn) as never),
      );
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
          (value) => value === size + 3,
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
            ["mentionable", 0, "title"],
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
    await serving.host.close();
    await sender.dispose();
    await reader.dispose();
    await serving.close();
  }
};
