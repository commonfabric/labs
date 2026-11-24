/**
 * Measures one event of a list under server execution, from the send on a
 * client until the result is visible on that client and on a second one,
 * for a piece from a compiled pattern and for today's piece of the same
 * pattern (milestone 6 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * `deno run -A --no-check base/pattern-compiler/compare/serving-path.ts [--arms=compiled,today] [--events=<n>] [--progress] [--profile=<file>] [lengths]`
 *
 * Each arm and length runs against a memory server of its own that listens
 * on a websocket of this process, with a serving loop on this thread whose
 * runtimes run compiled pieces (`listenCompiledServingMemoryServer`). Two
 * clients connect over the websocket with server execution on, so neither
 * runs a handler or a derivation of the piece: the sender commits the
 * append of the event, the serving loop handles it in a wave, and both
 * clients read the result through sync.
 *
 * The pattern is `fixtures/serving-list.tsx`: a `map` over an array that
 * the type declares as references, given as an array of references, each
 * to an item in a document of its own. The events are `rename`, which
 * writes the title of one item, and `add`, which appends an item. A client
 * watches the label of the one row the event changes, so what is timed
 * does not include a read of the whole result.
 *
 * `load` is the time from the commit of the setup on the sender until the
 * second client reads the label of the last row.
 *
 * After the events, another serving loop takes the space over. `resume`
 * holds the time until a client that holds nothing reads the last row
 * (`read`) and until the loop is quiescent, whether the piece was found
 * current by its basis, how many documents that comparison read, how many
 * evaluations the serving runtime had made by then, and the time of the
 * first and of the second event after it: the first starts the executor of
 * a compiled piece.
 *
 * The lists of links of the result are documents of their own, as a
 * serving runtime stores them by default (`CompiledPieceOptions.lists`), and
 * a list of more than `LIST_WHOLE` rows is read by a client as an array of
 * its chunks. A client of such a list then watches the whole list and reads
 * the row in its chunk, which is a read of every chunk. `SCALE_WATCH=chunk`
 * has a client watch the row of a rename through the chunk that holds it.
 * With `SCALE_LISTS=in-place` the links are in the result document, and
 * `SCALE_LIST_WHOLE` gives the most rows one list document holds
 * (`CompiledPieceOptions.listWhole`); with either a client watches the one
 * row. A client of today's piece always watches the one row.
 *
 * With `--profile=<file>`, the sampling profile of the process over the
 * appends is written to the file, in the format of the V8 inspector.
 *
 * `memory` holds what the process says of itself at the end of each step,
 * in megabytes: the resident set and the V8 heap in use as the step left
 * them, and the heap in use after a collection, where the process was
 * started with `--v8-flags=--expose-gc`. The process holds the memory
 * server, the serving loop and both clients, so each figure is of all of
 * them. `before` is read ahead of the setup, `load` once both clients read
 * the last row, `events` after the events, `takeover` once the loop that
 * took the space over is quiescent, which is after the comparison of the
 * basis and before any executor, and `firstEvent` and `secondEvent` once
 * the loop is quiescent behind each.
 */
// deno-lint-ignore no-external-import -- The sampling profiler is reached through this Node builtin alone.
import inspector from "node:inspector";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";

import type { Cell, MemorySpace } from "../../../runtime/runner/src/cell.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../../runtime/runner/src/compiled/serving-memory-server.deno.ts";
import type { ResumedPiece } from "../../../runtime/runner/src/compiled/resume.ts";
import { setUpCompiledPiece } from "../../../runtime/runner/src/compiled/setup.ts";
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";

type Arm = "compiled" | "today";
type Item = { id: string; title: string; done: boolean };
type List = { rows: { label: string; done: boolean }[]; events: number };

const repository = fromFileUrl(new URL("../../../", import.meta.url));
const round = (milliseconds: number) => Math.round(milliseconds * 10) / 10;
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** What the process holds, in megabytes (`measure`, `memory`). */
type Memory = { rss: number; heap: number; retained?: number };

/**
 * The resident set and the V8 heap in use, and the heap in use after a
 * collection where the process exposes one.
 */
const memoryNow = (): Memory => {
  const megabytes = (bytes: number) => Math.round(bytes / 104_857.6) / 10;
  const { rss, heapUsed } = Deno.memoryUsage();
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) {
    return { rss: megabytes(rss), heap: megabytes(heapUsed) };
  }
  collect();
  return {
    rss: megabytes(rss),
    heap: megabytes(heapUsed),
    retained: megabytes(Deno.memoryUsage().heapUsed),
  };
};

/** Whether the links of the rows are in the result document. */
const IN_PLACE = Deno.env.get("SCALE_LISTS") === "in-place";

/**
 * The most rows whose links one list document holds
 * (`CompiledPieceOptions.listWhole`), where `SCALE_LIST_WHOLE` gives one.
 */
const LIST_WHOLE = Deno.env.get("SCALE_LIST_WHOLE") === undefined
  ? undefined
  : Number(Deno.env.get("SCALE_LIST_WHOLE"));

/**
 * How a client finds a row: `row`, the one path of the row; `chunk`, the
 * path of the row through the chunk that holds it, found from the list as
 * the client reads it when the watch begins; `list`, the whole list, with
 * the row found among the members of its chunks.
 */
type Watch = "row" | "chunk" | "list";

/** How a client of the compiled arm finds a row (`SCALE_WATCH`). */
const WATCH: Watch = (Deno.env.get("SCALE_WATCH") as Watch | undefined) ??
  (IN_PLACE || LIST_WHOLE !== undefined ? "row" : "list");

/** The inputs one transaction of the setup holds at most. */
const ITEMS_PER_TRANSACTION = 1_000;

/** How many times a sink on a whole list was called back. */
const listReads = { calls: 0 };

/**
 * Resolves with the time at which `runtime` reads `label` at the row `at`
 * of the result: the callback of a sink on the path `watch` names. A list
 * in chunks is read by a client as an array of its chunks.
 */
const visible = (
  runtime: Runtime,
  result: Cell<List>,
  at: number,
  label: string,
  watch: Watch,
): Promise<number> => {
  const rows = runtime.getCellFromLink<List>(result.getAsNormalizedFullLink())
    .key("rows") as unknown as Cell<unknown>;
  let path: (string | number)[] = [at];
  if (watch === "chunk") {
    const read = rows.get() as unknown[] | undefined;
    if (Array.isArray(read) && read.every((one) => Array.isArray(one))) {
      let offset = at;
      let chunk = 0;
      while (
        chunk < read.length - 1 && offset >= (read[chunk] as unknown[]).length
      ) {
        offset -= (read[chunk] as unknown[]).length;
        chunk += 1;
      }
      path = [chunk, offset];
    }
  }
  // deno-lint-ignore no-explicit-any
  let cell: Cell<any> = rows;
  if (watch !== "list") {
    for (const segment of [...path, "label"]) cell = cell.key(segment);
  }
  const labelOf = (value: unknown): unknown =>
    watch !== "list"
      ? value
      : ((value ?? []) as unknown[]).flatMap((member) =>
        Array.isArray(member) ? member : [member]
      ).map((row) => (row as { label?: string } | undefined)?.label)[at];
  return new Promise((resolve) => {
    let done = false;
    const cancel: () => void = cell.sink((value: unknown) => {
      if (watch === "list") listReads.calls += 1;
      if (done || labelOf(value) !== label) return;
      done = true;
      resolve(performance.now());
      // The sink calls back before it returns the cancel the first time.
      queueMicrotask(() => cancel());
    });
  });
};

/** One arm at one length. `progress` is told of each step that is done. */
const measure = async (
  arm: Arm,
  length: number,
  events: number,
  progress: (step: string) => void,
  /** Where the profile of the appends is written, where one is taken. */
  profile?: string,
) => {
  const signer = await Identity.fromPassphrase("pattern-compiler-serving");
  const space: MemorySpace = signer.did();
  // The pieces a serving runtime resumed from their basis.
  const resumed: ResumedPiece[] = [];
  const serving: CompiledServingMemoryServer =
    await listenCompiledServingMemoryServer({
      pieces: {
        resumed: (_result, piece) => resumed.push(piece),
        piece: {
          ...(IN_PLACE ? { lists: "in-place" as const } : {}),
          ...(LIST_WHOLE === undefined ? {} : { listWhole: LIST_WHOLE }),
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
  try {
    const items = sender.getCell<Item[]>(space, "items");
    const members: Cell<Item>[] = [];
    for (let from = 0; from < length; from += ITEMS_PER_TRANSACTION) {
      const tx = sender.edit();
      const to = Math.min(length, from + ITEMS_PER_TRANSACTION);
      for (let index = from; index < to; index++) {
        const member = sender.getCell<Item>(
          space,
          `item ${index}`,
          undefined,
          tx,
        );
        member.set({ id: `i${index}`, title: `t${index}`, done: false });
        members.push(member);
      }
      const { error } = await tx.commit().settled;
      if (error !== undefined) throw error;
    }
    {
      const tx = sender.edit();
      items.withTx(tx).set(members as never);
      const { error } = await tx.commit().settled;
      if (error !== undefined) throw error;
    }
    const result = sender.getCell<List>(space, "list");
    const memory: Record<string, Memory> = { before: memoryNow() };
    const began = performance.now();
    const tx = sender.edit();
    if (arm === "compiled") {
      // The serving runtime compiles the source with the crate's release
      // binary, which is part of the load.
      const name = "/serving-list.tsx";
      const contents = await Deno.readTextFile(
        new URL("./fixtures/serving-list.tsx", import.meta.url),
      );
      setUpCompiledPiece(
        sender,
        tx,
        { main: name, files: [{ name, contents }] },
        { items },
        result.withTx(tx),
      );
    } else {
      const program = await resolveLocalProgram(
        (resolver) => sender.harness.resolve(resolver),
        {
          main:
            `${repository}base/pattern-compiler/compare/fixtures/serving-list.tsx`,
          root: repository,
        },
      );
      const pattern = await sender.patternManager.compilePattern(program, {
        space,
      });
      sender.run(tx, pattern, { items }, result.withTx(tx));
    }
    const { error } = await tx.commit().settled;
    if (error !== undefined) throw error;
    progress("the setup is committed");
    // Today's piece keeps the rows in its result, and a client watches the
    // one row. A client of a list in chunks watches a row through its chunk
    // only where it already holds the list and the row stays where it is,
    // as for a rename.
    const watchOf = (stays: boolean): Watch =>
      arm === "today" ? "row" : WATCH === "chunk" && !stays ? "list" : WATCH;
    const loaded = await visible(
      reader,
      result,
      length - 1,
      `t${length - 1}!`,
      watchOf(false),
    );
    await visible(
      sender,
      result,
      length - 1,
      `t${length - 1}!`,
      watchOf(false),
    );
    const load = round(loaded - began);
    progress("both clients read the last row");
    await serving.host.whenQuiescent();
    memory.load = memoryNow();

    // The sender holds the marker of each stream, by which a send to the
    // member of the result is the append of an event.
    const streams = new Map<string, Cell<unknown>>();
    for (const name of ["rename", "add"]) {
      const cell = sender.getCellFromLink<List>(
        result.getAsNormalizedFullLink(),
      ).key(name as never) as Cell<unknown>;
      // The document the member links to holds the marker, and the sink
      // keeps it in the replica.
      await cell.sync();
      await cell.resolveAsCell().sync();
      cell.sink(() => {});
      streams.set(name, cell);
    }
    const stream = (name: string) => streams.get(name)!;
    progress("the sender holds the streams");
    const timed = async (
      name: string,
      event: unknown,
      at: number,
      label: string,
    ) => {
      const stays = name === "rename";
      const onSender = visible(sender, result, at, label, watchOf(stays));
      const onReader = visible(reader, result, at, label, watchOf(stays));
      const sent = performance.now();
      stream(name).send(event as never);
      const [first, second] = await Promise.all([onSender, onReader]);
      return { sender: first - sent, reader: second - sent };
    };
    const renames: { sender: number; reader: number }[] = [];
    for (let turn = 0; turn < events; turn++) {
      // Rows spread over the list, the first and the last among them.
      const at = events === 1
        ? 0
        : Math.floor((turn * (length - 1)) / (events - 1));
      renames.push(
        await timed(
          "rename",
          { at, title: `renamed ${turn}` },
          at,
          `renamed ${turn}!`,
        ),
      );
    }
    const adds: { sender: number; reader: number }[] = [];
    const stopProfile = profile === undefined
      ? undefined
      : await startProfile(profile);
    for (let turn = 0; turn < events; turn++) {
      adds.push(
        await timed(
          "add",
          { id: `added ${turn}`, title: `added ${turn}` },
          length + turn,
          `added ${turn}!`,
        ),
      );
    }
    await stopProfile?.();
    const [piece] = serving.pieces();
    const counts = piece === undefined ? undefined : {
      events: piece.counts.events,
      derivations: piece.counts.derivations,
      ownMs: round(piece.counts.ownMs),
      refusals: piece.refusals.length,
      sources: piece.sources,
    };
    // Another serving loop takes the space over. A client that holds
    // nothing reads the last row, which is the demand that has the loop
    // reach the piece, and the sender then sends one more event.
    await serving.host.whenQuiescent();
    memory.events = memoryNow();
    const restarted = performance.now();
    await serving.restart();
    const late = client();
    const last = length + events - 1;
    const read = await visible(
      late,
      result,
      last,
      `added ${events - 1}!`,
      watchOf(false),
    );
    await serving.host.whenQuiescent();
    const quiescent = performance.now();
    const afterRead = serving.pieces()[0];
    const resume = {
      read: round(read - restarted),
      quiescent: round(quiescent - restarted),
      current: resumed.map(({ current }) => current),
      checked: resumed.map(({ checked }) => checked),
      evaluations: afterRead?.instance.counts.evaluations ?? 0,
    };
    memory.takeover = memoryNow();
    progress("another serving loop serves the piece");
    const first = await timed(
      "rename",
      { at: 0, title: "after the resume" },
      0,
      "after the resume!",
    );
    await serving.host.whenQuiescent();
    memory.firstEvent = memoryNow();
    const woken = serving.pieces()[0];
    const second = await timed(
      "rename",
      { at: 0, title: "second after the resume" },
      0,
      "second after the resume!",
    );
    await serving.host.whenQuiescent();
    memory.secondEvent = memoryNow();
    await late.dispose();
    const summary = (runs: { sender: number; reader: number }[]) => ({
      runs: runs.length,
      sender: {
        median: round(median(runs.map((run) => run.sender))),
        min: round(Math.min.apply(null, runs.map((run) => run.sender))),
        max: round(Math.max.apply(null, runs.map((run) => run.sender))),
      },
      reader: {
        median: round(median(runs.map((run) => run.reader))),
        min: round(Math.min.apply(null, runs.map((run) => run.reader))),
        max: round(Math.max.apply(null, runs.map((run) => run.reader))),
      },
    });
    return {
      arm,
      length,
      load,
      rename: summary(renames),
      add: summary(adds),
      memory,
      ...(counts === undefined ? {} : { piece: counts }),
      ...(listReads.calls === 0 ? {} : { listReads: listReads.calls }),
      resume: {
        ...resume,
        firstEvent: {
          sender: round(first.sender),
          reader: round(first.reader),
        },
        secondEvent: {
          sender: round(second.sender),
          reader: round(second.reader),
        },
        evaluationsOfTheWake: woken?.instance.counts.evaluations ?? 0,
        refusals: woken?.refusals.length ?? 0,
      },
    };
  } finally {
    await serving.host.close();
    await sender.dispose();
    await reader.dispose();
    await serving.close();
  }
};

/**
 * Starts the sampling profiler of the process and returns what stops it
 * and writes the profile to `file`.
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
  await post("Profiler.setSamplingInterval", { interval: 200 });
  await post("Profiler.start");
  return async () => {
    const { profile } = await post("Profiler.stop") as { profile: unknown };
    await Deno.writeTextFile(file, JSON.stringify(profile));
  };
};

if (import.meta.main) {
  const flags = Deno.args.filter((argument) => argument.startsWith("--"));
  const given = Deno.args.filter((argument) => !argument.startsWith("--"));
  const flag = (name: string) =>
    flags.find((one) => one.startsWith(`--${name}=`))?.split("=")[1];
  const lengths = given.length > 0 ? given.map(Number) : [100, 1_000];
  const arms = (flag("arms") ?? "compiled,today").split(",") as Arm[];
  const events = Number(flag("events") ?? 5);
  console.log(JSON.stringify({ load: Deno.loadavg(), events }));
  for (const length of lengths) {
    for (const arm of arms) {
      const progress = (step: string) => {
        if (flags.includes("--progress")) {
          console.error(`${arm} ${length}: ${step}`);
        }
      };
      console.log(
        JSON.stringify(
          await measure(arm, length, events, progress, flag("profile")),
        ),
      );
    }
  }
  console.log(JSON.stringify({ load: Deno.loadavg() }));
}
