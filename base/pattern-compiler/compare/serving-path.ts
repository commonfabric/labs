/**
 * Measures one event of a list under server execution, from the send on a
 * client until the result is visible on that client and on a second one,
 * for a piece from a compiled pattern and for today's piece of the same
 * pattern (milestone 6 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * `deno run -A --no-check base/pattern-compiler/compare/serving-path.ts [--arms=compiled,today] [--events=<n>] [--progress] [lengths]`
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
 */
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";

import type { Cell, MemorySpace } from "../../../runtime/runner/src/cell.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../../runtime/runner/src/compiled/serving-memory-server.deno.ts";
import { setUpCompiledPiece } from "../../../runtime/runner/src/compiled/setup.ts";
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import type { Artifact } from "../exec/executor.ts";

type Arm = "compiled" | "today";
type Item = { id: string; title: string; done: boolean };
type List = { rows: { label: string; done: boolean }[]; events: number };

const repository = fromFileUrl(new URL("../../../", import.meta.url));
const round = (milliseconds: number) => Math.round(milliseconds * 10) / 10;
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** The inputs one transaction of the setup holds at most. */
const ITEMS_PER_TRANSACTION = 1_000;

/**
 * Resolves with the time at which `runtime` reads `label` at the row `at`
 * of the result: the callback of a sink on that one path.
 */
const visible = (
  runtime: Runtime,
  result: Cell<List>,
  at: number,
  label: string,
): Promise<number> => {
  const cell = runtime.getCellFromLink<List>(result.getAsNormalizedFullLink())
    .key("rows").key(at).key("label");
  return new Promise((resolve) => {
    let done = false;
    const cancel: () => void = cell.sink((value) => {
      if (done || value !== label) return;
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
) => {
  const signer = await Identity.fromPassphrase("pattern-compiler-serving");
  const space: MemorySpace = signer.did();
  const serving: CompiledServingMemoryServer =
    await listenCompiledServingMemoryServer();
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
    const began = performance.now();
    const tx = sender.edit();
    if (arm === "compiled") {
      const [{ patterns }] = JSON.parse(
        await Deno.readTextFile(
          new URL("./fixtures/serving-list.emit.json", import.meta.url),
        ),
      ) as { patterns: Artifact[] }[];
      setUpCompiledPiece(sender, tx, patterns[0], { items }, result.withTx(tx));
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
    const loaded = await visible(
      reader,
      result,
      length - 1,
      `t${length - 1}!`,
    );
    await visible(sender, result, length - 1, `t${length - 1}!`);
    const load = round(loaded - began);
    progress("both clients read the last row");

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
      const onSender = visible(sender, result, at, label);
      const onReader = visible(reader, result, at, label);
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
    const [piece] = serving.pieces();
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
      ...(piece === undefined ? {} : {
        piece: {
          events: piece.counts.events,
          derivations: piece.counts.derivations,
          ownMs: round(piece.counts.ownMs),
          refusals: piece.refusals.length,
        },
      }),
    };
  } finally {
    await serving.host.close();
    await sender.dispose();
    await reader.dispose();
    await serving.close();
  }
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
        JSON.stringify(await measure(arm, length, events, progress)),
      );
    }
  }
  console.log(JSON.stringify({ load: Deno.loadavg() }));
}
