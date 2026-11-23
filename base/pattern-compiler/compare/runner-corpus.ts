/**
 * Runs the corpus on the runner path: every module the crate emits a plan
 * for, each with the generated inputs and events of `corpus.ts`, as a
 * compiled piece started with `startCompiledPiece` in a runtime of its own
 * on emulated storage, and beside it on the executor with its documents in
 * memory (`ExecutorRun`), which is what the value comparison of
 * `values-corpus.ts` holds against today's runtime.
 *
 * Run from the repository root, after `cargo build --release` in
 * `base/pattern-compiler`:
 *
 * `deno run -A --no-check base/pattern-compiler/compare/runner-corpus.ts run <results.jsonl> [part of a module path] [--resume] [--serving] [--references] [--evaluate=function] [--wishes=table] [--detail]`
 * `deno run -A --no-check base/pattern-compiler/compare/runner-corpus.ts report <results.jsonl>`
 *
 * With `--resume`, a second runtime on the same memory server takes the
 * piece over after the first half of the events (`resumeCompiledPieceFromBasis`):
 * the first runtime is disposed, the second starts the piece from what the
 * storage holds and handles the other half. The run then also says how
 * many documents the resume wrote.
 *
 * With `--serving`, each module runs under the serving loop: a memory
 * server that listens on a websocket of this process, with a serving loop
 * on this thread, and one client with server execution on that sets the
 * piece up (`setUpCompiledPiece`) and appends each event with `Cell.send`
 * on the entity of its stream. The piece is the one the serving runtime
 * runs, and its values are compared as above. With `--resume` as well,
 * another serving loop takes the space over after the first half of the
 * events (`CompiledServingMemoryServer.restart`): the event behind the
 * takeover wakes the piece in the serving runtime of that loop, whose
 * replica reads from the store, so the wake leaves the rows it can as
 * stored (`resumeCompiledPieceByUnits`). The values compared are then what
 * that runtime derived and, for a row it left, what the storage holds.
 *
 * With `--serving --resume`, the run also says for each module how many
 * of its collections have rows in documents of their own, how many of
 * those `storedRowCollections` takes, how many rows the wake left as
 * stored, and how many entries and bodies the piece that woke evaluated
 * through the first event behind the takeover, beside how many the load
 * evaluated: a whole resume evaluates at its wake what the load did.
 *
 * With `--references` under `--serving`, the client writes each array of
 * records that a member of the argument holds through a cell of its own,
 * where the argument schema declares that member as references. The
 * runtime stores each record in an entity of its own, so the array is an
 * array of references, which is what a wake can leave the rows of as
 * stored. Without it the array is in the argument document, as plain
 * values in place. The executor in memory is given the plain argument in
 * both cases, so a result that holds a reference to an element differs
 * from it with `--references`.
 *
 * `run` appends one line per module and leaves out a module the file
 * already has. The inputs are plain values in the argument, so the run
 * says whether a piece starts, takes its events through the scheduler and
 * holds the values the executor in memory holds, and says little of
 * labels. An event is queued with the scheduler for the entity that holds
 * the stream's marker, which is where `Cell.send` on the member of the
 * result arrives.
 *
 * The value code of a piece is evaluated in a compartment
 * (`compartmentEvaluator`), and with `--evaluate=function` in the realm of
 * the harness, as the executor in memory evaluates it.
 *
 * A `wish` of the piece is answered by the runtime's own `wish`, against
 * the home that `seedHome()` of `wish-home.ts` writes into the storage of
 * the run. The executor in memory is answered from the table of
 * `wish-home.ts`, which simulates the same home; where the table has no
 * answer for a `wish` of the module, the piece is run and its values are
 * not compared. With `--wishes=table` the piece is handed the table as the
 * option `wishes`, as the rounds before round thirteen ran it, and a module
 * whose `wish` the table does not simulate is left out. A module with a
 * `wish` is left out under `--serving`, where no client of the harness
 * seeds the home, and under `--resume` with the table. The built-ins the
 * runtime answers (`runtimeBuiltins`) are the runtime's own, for the one
 * user of the run, in a space with no access list. A module that requests
 * an effect is left out: the runtime's fetch built-ins would answer four
 * of the effects, with requests to the addresses the generated inputs hold.
 */
import { Identity } from "@commonfabric/identity";

import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../../runtime/runner/src/compiled/piece.ts";
import { sendEvent } from "../../../runtime/runner/src/cell.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { resumeCompiledPieceFromBasis } from "../../../runtime/runner/src/compiled/resume.ts";
import { listenCompiledServingMemoryServer } from "../../../runtime/runner/src/compiled/serving-memory-server.deno.ts";
import { setUpCompiledPiece } from "../../../runtime/runner/src/compiled/setup.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "../../../runtime/runner/src/storage/cache.deno.ts";
import {
  type Artifact,
  evaluateWithFunction,
  type ModuleEvaluator,
} from "../exec/executor.ts";
import { rowDocumentCollections } from "../exec/row-documents.ts";
import type { Schema } from "../exec/store.ts";
import { storedRowCollections } from "../exec/stored-units.ts";
import {
  artifactsOf,
  type CorpusModule,
  corpusModules,
  eventOrder,
  mainPattern,
  sourceOf,
} from "./corpus.ts";
import { generateEvent, generateInputs } from "./generate.ts";
import { scenarioAudience } from "./harness.ts";
import { argumentOf, categoryOf, ExecutorRun, normalize } from "./values.ts";
import { hasWish, homeStubs, memoryHome, seedHome } from "./wish-home.ts";

type EmittedModule = Omit<CorpusModule, "patterns"> & {
  patterns: Artifact[];
};

/** What became of one module on the runner path. */
type Outcome = {
  module: string;
  pattern?: string;
  /** Why the module was not run. */
  skipped?: string;
  /** Whether the plan of the pattern has a `wish`. */
  wish?: boolean;
  /** Why the values were not compared, where they were not. */
  notCompared?: string;
  /** Whether the piece started and its first commit was taken. */
  started?: boolean;
  /** Why it did not start: the class, and the first line of the reason. */
  startFailure?: { category: string; detail: string };
  /** The events of the scenario, and what became of them. */
  events?: { sent: number; handled: number; failures: string[] };
  /** The reasons of the commits of the piece that the storage refused. */
  refusals?: string[];
  /**
   * Whether the piece holds, after the events, the values the executor in
   * memory holds, and where the first difference is where it does not.
   */
  equal?: boolean;
  difference?: string;
  /** With `--detail`: what each of the two holds at the difference. */
  detail?: { here: string; there: string };
  /**
   * With `--resume`: the events the first runtime handled before the
   * second took the piece over, the documents the resume wrote, or why the
   * piece did not resume.
   */
  resume?: {
    after: number;
    /** Whether the basis of the piece matched the storage. */
    current?: boolean;
    /** How many documents the comparison of the basis read. */
    checked?: number;
    documents?: number;
    failure?: string;
    /**
     * Under the serving loop: the collections of the plan whose rows are
     * documents, and how many of them a wake can leave the rows of as
     * stored by what the plan says (`storedRowCollections`).
     */
    rows?: number;
    taken?: number;
    /** The rows the wake left as stored. */
    left?: number;
    /** The entries and the bodies that the load evaluated. */
    load?: { evaluations: number; bodies: number };
    /**
     * The entries and the bodies that the piece which woke evaluated
     * through the first event behind the takeover.
     */
    wake?: { evaluations: number; bodies: number };
  };
};

/**
 * A value as text, with the members of each record in the order of their
 * names: a record the storage gave has them in that order, and one the
 * process wrote has them in the order they were written.
 */
const ordered = (value: unknown): string =>
  JSON.stringify(
    value,
    (_name, member) =>
      typeof member === "object" && member !== null && !Array.isArray(member)
        ? Object.fromEntries(
          Object.entries(member).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        )
        : member,
  ) ?? "undefined";

/** The path of the first difference between two values, as text. */
const firstDifference = (
  a: unknown,
  b: unknown,
  path = "",
): string | undefined => {
  if (ordered(a) === ordered(b)) return undefined;
  if (
    typeof a === "object" && a !== null && typeof b === "object" &&
    b !== null && Array.isArray(a) === Array.isArray(b)
  ) {
    const names = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const name of names) {
      const found = firstDifference(
        (a as Record<string, unknown>)[name],
        (b as Record<string, unknown>)[name],
        `${path}/${name}`,
      );
      if (found !== undefined) return found;
    }
  }
  return path === "" ? "/" : path;
};

/** What a value holds at a path that `firstDifference` gave, as text. */
const valueAt = (value: unknown, path: string): string => {
  let at = value;
  for (const segment of path.split("/").slice(1)) {
    if (segment === "") continue;
    at = (at as Record<string, unknown> | undefined)?.[segment];
  }
  return (JSON.stringify(at) ?? "undefined").slice(0, 600);
};

/** Why a plan cannot run on the runner path, where it cannot. */
const needs = (plan: Artifact["plan"]): string | undefined => {
  const operations =
    (plan as { operations?: { kind?: string }[] }).operations ?? [];
  if (operations.some(({ kind }) => kind === "effect")) {
    return "requests an effect";
  }
  return undefined;
};

export const runOne = async (
  module: EmittedModule,
  artifacts: (id: string) => Artifact | undefined,
  resume: boolean,
  serving = false,
  evaluate: ModuleEvaluator | undefined = undefined,
  wishTable = false,
  references = false,
): Promise<Outcome> => {
  const chosen = await mainPattern(module);
  if (chosen === undefined) {
    return { module: module.module, skipped: "exports no pattern" };
  }
  const artifact = chosen.pattern;
  const wishes = hasWish(artifact.plan);
  const base = {
    module: module.module,
    pattern: artifact.name,
    ...(wishes ? { wish: true } : {}),
  };
  if ((artifact.code?.unsupported ?? []).length > 0) {
    return {
      ...base,
      skipped: `no value code: ${artifact.code.unsupported[0].kind}`,
    };
  }
  const needed = needs(artifact.plan);
  if (needed !== undefined) return { ...base, skipped: needed };
  const { plan, schemas } = artifact;
  const inputs = generateInputs(plan, schemas, await scenarioAudience());
  const argument = argumentOf({ argument: {}, inputs });
  const events = eventOrder(plan, "outside first").map((binding) => ({
    binding,
    event: generateEvent(plan, schemas, binding),
  }));
  const now = Date.now();
  // A `wish` is answered against the seeded home of `wish-home.ts` on
  // both sides: the executor in memory from a table over documents it is
  // given, and the piece by the runtime's `wish` over the same documents
  // written into its storage, or from the table with `--wishes=table`.
  if (wishes && (serving || (resume && wishTable))) {
    return { ...base, skipped: "needs `wish`" };
  }
  const takeover = serving && resume;

  // The executor with its documents in memory.
  const stubs = wishes ? homeStubs(await memoryHome()) : undefined;
  const alone = new ExecutorRun(artifact, argument, artifacts, {
    completion: () => undefined,
    now,
    ...(stubs === undefined ? {} : { home: stubs }),
  } as never);
  alone.start(undefined);
  const unsimulated = stubs === undefined || stubs.unsimulated.length === 0
    ? undefined
    : `${
      stubs.unsimulated.map((query) => `\`${query}\``).join(", ")
    } is not simulated`;
  if (unsimulated !== undefined && wishTable) {
    return { ...base, skipped: `needs \`wish\`: ${unsimulated}` };
  }
  events.forEach(({ binding, event }, index) => {
    const [held] = alone.held(binding);
    if (held !== undefined) {
      alone.committed(index, binding, event, held.elements);
    }
  });

  if (serving) {
    try {
      return await runServed(
        base,
        artifact,
        argument,
        events,
        alone,
        artifacts,
        now,
        takeover,
        references,
      );
    } catch (error) {
      return { ...base, started: false, startFailure: categoryOf(error) };
    }
  }
  const signer = await Identity.fromPassphrase("pattern-compiler-compare");
  const space = signer.did();
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const session = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
  let runtime = session();
  let piece: CompiledPiece | undefined;
  let resumed: Outcome["resume"];
  try {
    const result = runtime.getCell<unknown>(space, "corpus on the runner");
    const home = wishes ? await seedHome(runtime, space) : undefined;
    const seeded = home !== undefined && wishTable
      ? homeStubs(home)
      : undefined;
    // The runtime of the run has no serving loop, which is what names the
    // principal a run acts for: the runtime's `wish` and its built-ins
    // read it.
    // The harness is host code and vouches for the artifacts the crate
    // emitted (`CompiledPieceOptions.attested`).
    const actsFor = {
      attested: true,
      ...(wishTable ? {} : { actsFor: space }),
    };
    const tx = runtime.edit();
    try {
      piece = startCompiledPiece(
        runtime,
        tx,
        artifact,
        argument,
        result.withTx(tx),
        {
          artifacts,
          now,
          ...(evaluate === undefined ? {} : { evaluate }),
          ...(seeded === undefined ? {} : { wishes: seeded.wishes }),
          ...actsFor,
        },
      );
    } catch (error) {
      tx.abort();
      return { ...base, started: false, startFailure: categoryOf(error) };
    }
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    await runtime.scheduler.idleWithPendingCommits();
    if (error !== undefined) {
      return {
        ...base,
        started: false,
        startFailure: {
          category: `the first commit was refused: ${error.name}`,
          detail: `${error.message}`.split("\n")[0].slice(0, 200),
        },
        refusals: [...piece.refusals],
      };
    }
    let handled = 0;
    const failures: string[] = [];
    const half = Math.floor(events.length / 2);
    for (const [index, { binding, event }] of events.entries()) {
      if (resume && index === half) {
        // The second runtime takes the piece over from the storage.
        piece.stop();
        await runtime.scheduler.idleWithPendingCommits();
        await runtime.storageManager.synced();
        await runtime.dispose();
        piece = undefined;
        runtime = session();
        const written = new Set<string>();
        runtime.storageManager.subscribe({
          next(notification) {
            if (notification.type === "commit") {
              for (const { address } of notification.changes) {
                written.add(address.id);
              }
            }
            return undefined;
          },
        });
        try {
          // The piece is resumed from its basis first, which evaluates
          // nothing where the stored result is current, and then woken for
          // the events that follow.
          const fromBasis = await resumeCompiledPieceFromBasis(
            runtime,
            artifact,
            runtime.getCellFromLink(result.getAsNormalizedFullLink()),
            {
              artifacts,
              now,
              ...(evaluate === undefined ? {} : { evaluate }),
              ...actsFor,
            },
          );
          piece = await fromBasis.wake();
          await runtime.scheduler.idleWithPendingCommits();
          await runtime.storageManager.synced();
          resumed = {
            after: half,
            current: fromBasis.current,
            checked: fromBasis.checked,
            documents: written.size,
          };
        } catch (error) {
          return {
            ...base,
            started: true,
            resume: {
              after: half,
              failure: `${categoryOf(error).category}: ${
                categoryOf(error).detail
              }`,
            },
          };
        }
      }
      const stream = piece.instance.streams().find((held) =>
        held.binding === binding && held.instance === undefined &&
        held.elements !== undefined
      );
      const entity = stream === undefined
        ? undefined
        : piece.transactions.entityOfStream({
          binding: stream.binding,
          keys: stream.keys,
        });
      if (entity === undefined) {
        failures.push("no stream of the binding is stored");
        continue;
      }
      const before = piece.counts;
      runtime.scheduler.queueEvent(
        { space, id: entity, path: [], scope: "space" },
        piece.transactions.encode(event),
      );
      await runtime.scheduler.idleWithPendingCommits();
      const after = piece.counts;
      if (
        after.events > before.events &&
        after.eventsRefused === before.eventsRefused
      ) handled += 1;
      else failures.push("the handler did not commit");
    }
    if (unsimulated !== undefined) {
      return {
        ...base,
        started: true,
        events: { sent: events.length, handled, failures },
        refusals: [...piece.refusals].map((reason) => reason.slice(0, 200)),
        notCompared: unsimulated,
        ...(resumed === undefined ? {} : { resume: resumed }),
      };
    }
    const here = normalize(piece.instance.result());
    const there = normalize(alone.result());
    const difference = firstDifference(here, there);
    return {
      ...base,
      started: true,
      events: { sent: events.length, handled, failures },
      refusals: [...piece.refusals].map((reason) => reason.slice(0, 200)),
      equal: difference === undefined,
      ...(difference === undefined ? {} : { difference }),
      ...(difference === undefined || !Deno.args.includes("--detail") ? {} : {
        detail: {
          here: valueAt(here, difference),
          there: valueAt(there, difference),
        },
      }),
      ...(resumed === undefined ? {} : { resume: resumed }),
    };
  } catch (error) {
    return {
      ...base,
      started: piece !== undefined,
      startFailure: categoryOf(error),
    };
  } finally {
    piece?.stop();
    await runtime.dispose();
    await server.close();
  }
};

/**
 * One module under the serving loop: `events` are those of the scenario,
 * and `alone` the executor in memory that handled them.
 */
const runServed = async (
  base: { module: string; pattern: string | undefined },
  artifact: Artifact,
  argument: unknown,
  events: { binding: number; event: unknown }[],
  alone: ExecutorRun,
  artifacts: (id: string) => Artifact | undefined,
  now: number,
  /** Whether another serving loop takes over after half of the events. */
  takeover = false,
  /** Whether the arrays the plan declares as references are written as such. */
  references = false,
): Promise<Outcome> => {
  const signer = await Identity.fromPassphrase("pattern-compiler-compare");
  const space = signer.did();
  // The piece the serving runtime starts, or why it did not start.
  let loaded = Promise.withResolvers<CompiledPiece>();
  loaded.promise.catch(() => {});
  // Whether the loop that took over found the piece current by its basis.
  let current: boolean | undefined;
  let resumed: Outcome["resume"];
  const main = `/${base.module.replace(/^\/+/, "")}`;
  const program = {
    main,
    files: [{
      name: main,
      contents: await Deno.readTextFile(sourceOf(base.module)),
    }],
  };
  const serving = await listenCompiledServingMemoryServer({
    // The crate compiled the corpus in one run (`emit --corpus`). What
    // compiles here gives the artifact of that run for the module the
    // client wrote the main file of, and no other.
    compile: (given) =>
      given.main === main
        ? Promise.resolve({ main: artifact, artifacts })
        : Promise.reject(new Error(`Not the module of the run: ${given.main}`)),
    pieces: {
      piece: { now },
      started: (piece) => loaded.resolve(piece),
      failed: (_result, error) => loaded.reject(error),
      resumed: (_result, piece) => {
        current = piece.current;
      },
    },
  });
  const client = new Runtime({
    apiUrl: serving.url,
    storageManager: StorageManager.open({
      as: signer,
      memoryHost: serving.url,
    }),
    experimental: { serverExecution: true },
  });
  try {
    const result = client.getCell<unknown>(space, "corpus on the runner");
    let given = argument;
    if (references) {
      const written = client.edit();
      given = referencesOf(client, written, space, artifact, argument);
      const refused = (await written.commit().settled).error;
      if (refused !== undefined) {
        return {
          ...base,
          started: false,
          startFailure: {
            category: `the inputs were refused: ${refused.name}`,
            detail: `${refused.message}`.split("\n")[0].slice(0, 200),
          },
        };
      }
    }
    const tx = client.edit();
    setUpCompiledPiece(client, tx, program, given, result.withTx(tx));
    const { error } = await tx.commit().settled;
    if (error !== undefined) {
      return {
        ...base,
        started: false,
        startFailure: {
          category: `the setup was refused: ${error.name}`,
          detail: `${error.message}`.split("\n")[0].slice(0, 200),
        },
      };
    }
    // The client's read of the result is the demand that has the serving
    // loop start the piece.
    const read = client.getCellFromLink(result.getAsNormalizedFullLink());
    const cancel = read.sink(() => {});
    let piece: CompiledPiece;
    try {
      piece = await loaded.promise;
    } catch (error) {
      cancel();
      return { ...base, started: false, startFailure: categoryOf(error) };
    }
    await serving.host.whenQuiescent();
    const load = {
      evaluations: piece.instance.counts.evaluations,
      bodies: piece.instance.counts.elementEvaluations,
    };
    const rowDocuments = rowDocumentCollections(artifact);
    let handled = 0;
    const failures: string[] = [];
    const half = Math.floor(events.length / 2);
    for (const [index, { binding, event }] of events.entries()) {
      // The piece the event wakes in the loop that took over.
      let woken: Promise<CompiledPiece> | undefined;
      if (takeover && index === half && index > 0) {
        loaded = Promise.withResolvers<CompiledPiece>();
        loaded.promise.catch(() => {});
        woken = loaded.promise;
        await serving.restart();
      }
      // The result is read as the client reads it: a stream that stands in
      // an output of a scope is in the instance of the client's identity.
      const stream = piece.transactions.actingFor(
        client.scopeKeyIdentity,
        () =>
          piece.instance.streams().find((held) =>
            held.binding === binding && held.instance === undefined &&
            held.elements !== undefined
          ),
      );
      const entity = stream === undefined
        ? undefined
        : piece.transactions.entityOfStream({
          binding: stream.binding,
          keys: stream.keys,
        });
      if (entity === undefined) {
        failures.push("no stream of the binding is stored");
        continue;
      }
      const before = piece.counts;
      const target = client.getCellFromLink({
        space,
        id: entity,
        path: [],
        scope: "space",
      });
      await target.sync();
      const appended = Promise.withResolvers<void>();
      try {
        sendEvent(
          target,
          piece.transactions.encode(event) as never,
          undefined,
          { onAppended: () => appended.resolve() },
        );
      } catch (error) {
        failures.push(
          `the client did not append: ${categoryOf(error).detail}`,
        );
        continue;
      }
      await appended.promise;
      if (woken !== undefined) {
        try {
          piece = await woken;
          resumed = { after: index, current };
        } catch (error) {
          resumed = { after: index, failure: categoryOf(error).detail };
          failures.push("the piece did not wake");
          break;
        }
        await serving.host.whenQuiescent();
        resumed = {
          ...resumed,
          rows: rowDocuments.size,
          taken: storedRowCollections(artifact, rowDocuments).size,
          left: piece.instance.counts.rowsLeftStored,
          load,
          wake: {
            evaluations: piece.instance.counts.evaluations,
            bodies: piece.instance.counts.elementEvaluations,
          },
        };
        if (piece.counts.events > 0 && piece.counts.eventsRefused === 0) {
          handled += 1;
        } else failures.push("the handler did not commit");
        continue;
      }
      await serving.host.whenQuiescent();
      const after = piece.counts;
      if (
        after.events > before.events &&
        after.eventsRefused === before.eventsRefused
      ) handled += 1;
      else failures.push("the handler did not commit");
    }
    cancel();
    const here = normalize(
      piece.transactions.actingFor(
        client.scopeKeyIdentity,
        () => piece.instance.result(),
      ),
    );
    const there = normalize(alone.result());
    const difference = firstDifference(here, there);
    return {
      ...base,
      started: true,
      events: { sent: events.length, handled, failures },
      refusals: [...piece.refusals].map((reason) => reason.slice(0, 200)),
      equal: difference === undefined,
      ...(difference === undefined ? {} : { difference }),
      ...(resumed === undefined ? {} : { resume: resumed }),
    };
  } finally {
    await serving.host.close();
    await client.dispose();
    await serving.close();
  }
};

/**
 * `argument` with each top-level member that holds an array of records,
 * and that the argument schema of `artifact` declares as references, as a
 * cell that `tx` writes the array through.
 */
const referencesOf = (
  client: Runtime,
  tx: ReturnType<Runtime["edit"]>,
  space: ReturnType<Identity["did"]>,
  artifact: Artifact,
  argument: unknown,
): unknown => {
  if (typeof argument !== "object" || argument === null) return argument;
  const schemas = new Map(
    artifact.schemas.map(({ id, schema }) => [id, schema as Schema]),
  );
  const declared = schemas.get(artifact.plan.argumentSchema as string);
  const properties = typeof declared === "object"
    ? declared.properties ?? {}
    : {};
  const given: Record<string, unknown> = { ...argument };
  for (const [name, value] of Object.entries(given)) {
    const member = properties[name];
    if (
      !Array.isArray(value) || value.length === 0 ||
      typeof member !== "object" ||
      (member.asCell === undefined &&
        (typeof member.items !== "object" ||
          member.items.asCell === undefined)) ||
      !value.every((one) =>
        typeof one === "object" && one !== null && !Array.isArray(one)
      )
    ) continue;
    const cell = client.getCell<unknown[]>(
      space,
      `corpus input ${name}`,
      undefined,
      tx,
    );
    cell.set(value);
    given[name] = cell;
  }
  return given;
};

const readResults = async (file: string): Promise<Outcome[]> => {
  try {
    return (await Deno.readTextFile(file)).split("\n").filter((line) =>
      line.length > 0
    ).map((line) => JSON.parse(line));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
};

const run = async (
  file: string,
  part: string | undefined,
  resume: boolean,
  serving: boolean,
  evaluate: ModuleEvaluator | undefined,
  wishTable: boolean,
  references: boolean,
) => {
  const modules = await corpusModules() as EmittedModule[];
  const artifacts = artifactsOf(modules as unknown as CorpusModule[]);
  const done = new Set((await readResults(file)).map(({ module }) => module));
  for (const module of modules) {
    if (done.has(module.module)) continue;
    if (part !== undefined && !module.module.includes(part)) continue;
    let outcome: Outcome;
    try {
      outcome = await runOne(
        module,
        artifacts,
        resume,
        serving,
        evaluate,
        wishTable,
        references,
      );
    } catch (error) {
      outcome = {
        module: module.module,
        started: false,
        startFailure: categoryOf(error),
      };
    }
    await Deno.writeTextFile(file, `${JSON.stringify(outcome)}\n`, {
      append: true,
    });
  }
};

const report = async (file: string) => {
  const outcomes = await readResults(file);
  const count = (of: (outcome: Outcome) => string | undefined) => {
    const counts = new Map<string, number>();
    for (const outcome of outcomes) {
      const key = of(outcome);
      if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort(([, a], [, b]) => b - a);
  };
  const ran = outcomes.filter(({ skipped }) => skipped === undefined);
  const started = ran.filter((outcome) => outcome.started);
  const allHandled = started.filter(({ events }) =>
    events !== undefined && events.handled === events.sent
  );
  console.log(`modules: ${outcomes.length}`);
  console.log(`not run: ${outcomes.length - ran.length}`);
  for (const [reason, n] of count(({ skipped }) => skipped)) {
    console.log(`  ${n}  ${reason}`);
  }
  console.log(`run: ${ran.length}`);
  console.log(`started: ${started.length}`);
  for (
    const [reason, n] of count(({ startFailure }) => startFailure?.category)
  ) console.log(`  did not start, ${n}: ${reason}`);
  console.log(`every event handled: ${allHandled.length}`);
  console.log(
    `no commit refused: ${
      started.filter(({ refusals }) => (refusals ?? []).length === 0).length
    }`,
  );
  console.log(
    `equal to the executor in memory: ${
      started.filter(({ equal }) => equal).length
    }`,
  );
  const wishing = outcomes.filter(({ wish }) => wish);
  if (wishing.length > 0) {
    const ranWishing = wishing.filter(({ skipped }) => skipped === undefined);
    const startedWishing = ranWishing.filter(({ started }) => started);
    console.log(`with a \`wish\`: ${wishing.length}`);
    console.log(`  run: ${ranWishing.length}`);
    console.log(`  started: ${startedWishing.length}`);
    console.log(
      `  every event handled: ${
        startedWishing.filter(({ events }) =>
          events !== undefined && events.handled === events.sent
        ).length
      }`,
    );
    console.log(
      `  compared with the executor in memory: ${
        startedWishing.filter(({ equal }) => equal !== undefined).length
      }, equal: ${startedWishing.filter(({ equal }) => equal).length}`,
    );
  }
  const resumes = outcomes.flatMap(({ resume }) => resume ?? []);
  if (resumes.length > 0) {
    const taken = resumes.filter(({ failure }) => failure === undefined);
    console.log(`resumed by a second runtime: ${taken.length}`);
    console.log(
      `  the basis matched the storage, and nothing was evaluated before the wake: ${
        taken.filter(({ current }) => current).length
      }`,
    );
    console.log(
      `  the resume wrote no document: ${
        taken.filter(({ documents }) => documents === 0).length
      }`,
    );
    for (
      const [reason, n] of count(({ resume }) =>
        resume?.failure?.replaceAll(/of:[\w:-]+/g, "<entity>").slice(0, 110)
      )
    ) console.log(`  did not resume, ${n}: ${reason}`);
    // What the wake of each module with rows in documents evaluated
    // through its first event, beside what its load evaluated.
    const counted = outcomes.filter(({ resume }) =>
      resume?.wake !== undefined && (resume.rows ?? 0) > 0
    );
    if (counted.length > 0) {
      console.log(
        `  woken with rows in documents: ${counted.length}, of which a wake left rows as stored in ${
          counted.filter(({ resume }) => (resume?.left ?? 0) > 0).length
        }`,
      );
      console.log(
        "  module | collections with rows in documents | taken by the plan | rows left as stored | entries, wake / load | bodies, wake / load",
      );
      for (const { module, resume } of counted) {
        console.log(
          `  ${module} | ${resume?.rows} | ${resume?.taken} | ${resume?.left} | ${resume?.wake?.evaluations} / ${resume?.load?.evaluations} | ${resume?.wake?.bodies} / ${resume?.load?.bodies}`,
        );
      }
    }
  }
  for (
    const [reason, n] of count(({ events }) => events?.failures[0])
  ) console.log(`  an event failed, ${n}: ${reason}`);
  for (
    const [reason, n] of count(({ refusals }) =>
      refusals?.[0]?.replaceAll(/of:[\w:-]+/g, "<entity>").slice(0, 110)
    )
  ) console.log(`  a commit refused, ${n}: ${reason}`);
};

if (import.meta.main) {
  const [command, file, part] = Deno.args.filter((one) =>
    !one.startsWith("--")
  );
  const resume = Deno.args.includes("--resume");
  const evaluate = Deno.args.includes("--evaluate=function")
    ? evaluateWithFunction
    : undefined;
  if (command === "run" && file !== undefined) {
    await run(
      file,
      part,
      resume,
      Deno.args.includes("--serving"),
      evaluate,
      Deno.args.includes("--wishes=table"),
      Deno.args.includes("--references"),
    );
  } else if (command === "report" && file !== undefined) await report(file);
  else {
    console.error(
      "usage: runner-corpus.ts run <results.jsonl> [part of a module path] [--resume | --serving] | report <results.jsonl>",
    );
    Deno.exit(2);
  }
}
