/**
 * Measures what compiling and running the corpus costs today, and derives
 * from each module's plan what the design fixes about the cost of the
 * compiled path (`cost-model.ts`). Nothing executes a plan, so the
 * compiled side has a measured compile time and no measured run time or
 * storage.
 *
 * Run from the repository root, after `cargo build --release` in
 * `base/pattern-compiler`, each with
 * `deno run -A --no-check base/pattern-compiler/compare/cost.ts <command>`:
 *
 * - `closures <closures.json>`: the files of each module's program.
 * - `compile <closures.json> <compile.jsonl>`: today's compile, in this
 *   process, three times per module.
 * - `processes <closures.json> <processes.jsonl>`: one process per module
 *   and pipeline.
 * - `run <run.jsonl>`: today's run of each module's generated scenario.
 * - `scale <scale.jsonl>`: the run of each module with a `map` over an
 *   array of its argument, at two lengths of the array.
 *
 * The crate's side of the compile time is its own command,
 * `pattern-compiler time <patterns directory> <closures.json>`.
 */
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../logger/src/logger.ts";
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import type { Artifact } from "../exec/executor.ts";
import { eventOrder, executorOf } from "./corpus.ts";
import {
  type CostPlan,
  ENTRY_BYTES,
  eventCost,
  settledCost,
  type Sizes,
} from "./cost-model.ts";
import { generateEvent, generateInputs, type Schemas } from "./generate.ts";
import {
  type LabeledInput,
  type Plan,
  type Probe,
  runScenario,
  scenarioAudience,
} from "./harness.ts";

const repository = fromFileUrl(new URL("../../../", import.meta.url));
const patterns = `${repository}patterns`;
const crate =
  `${repository}base/pattern-compiler/target/release/pattern-compiler`;

type CorpusModule = {
  module: string;
  patterns: {
    name: string;
    plan: Plan & CostPlan & {
      argumentSchema?: string;
      operations: { kind?: string; within?: unknown[] }[];
    };
    schemas: Schemas;
    unsupported: unknown[];
    /** The value code of the plan, which the executor runs. */
    code?: Artifact["code"];
  }[];
};

/**
 * The modules the comparison over the corpus runs: every module the crate
 * accepts and emits a plan for with no unsupported construct
 * (`corpus.ts`), each with its value code.
 */
const corpusModules = async (only?: string): Promise<CorpusModule[]> => {
  const { success, stdout, stderr } = await new Deno.Command(crate, {
    args: ["emit", "--corpus", "."],
    cwd: patterns,
  }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  const modules: CorpusModule[] = new TextDecoder().decode(stdout).split("\n")
    .filter((line) => line.length > 0).map((line) => JSON.parse(line));
  return modules.filter((module) =>
    module.patterns.length > 0 &&
    module.patterns.every((pattern) => pattern.unsupported.length === 0) &&
    (only === undefined || module.module.includes(only))
  );
};

/** The pattern of a module that the comparison runs (`corpus.ts`). */
const mainPattern = async (module: CorpusModule) => {
  const source = await Deno.readTextFile(`${patterns}${module.module}`);
  const byName = source.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;/)
    ?.[1];
  const main = module.patterns.find((pattern) =>
    pattern.name === "default" || pattern.name === byName
  );
  const named = module.patterns.find((pattern) =>
    new RegExp(`export\\s+const\\s+${pattern.name}\\b`).test(source)
  );
  const pattern = main ?? named;
  return pattern === undefined
    ? undefined
    : { pattern, exported: pattern === main ? undefined : pattern.name };
};

const signer = () => Identity.fromPassphrase("pattern-compiler-cost");

const newRuntime = async () => {
  const identity = await signer();
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
  });
  return { runtime, storageManager, space: identity.did() };
};

const append = (file: string, record: unknown) =>
  Deno.writeTextFile(file, `${JSON.stringify(record)}\n`, { append: true });

const done = async (file: string): Promise<Set<string>> => {
  try {
    return new Set(
      (await Deno.readTextFile(file)).split("\n").filter((line) => line !== "")
        .map((line) => JSON.parse(line).module as string),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return new Set();
  }
};

/** The total time and the count of each timing key that begins with a prefix. */
const timings = (
  prefixes: string[],
): Record<string, { count: number; milliseconds: number }> => {
  const found: Record<string, { count: number; milliseconds: number }> = {};
  for (const [logger, keys] of Object.entries(getTimingStatsBreakdown())) {
    for (const [key, stats] of Object.entries(keys)) {
      const name = `${logger}/${key}`;
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
      found[name] = { count: stats.count, milliseconds: stats.totalTime };
    }
  }
  return found;
};

// ---------------------------------------------------------------------
// Compile time

/**
 * The files of each module's program, as today's pipeline resolves them
 * (`resolveLocalProgram` in
 * `runtime/runner/src/harness/local-program.deno.ts`): the module and the
 * modules it imports by path, each written from the patterns directory,
 * without the data files. A module with a file outside that directory is
 * left out.
 */
const closures = async (file: string, only?: string) => {
  const { runtime, storageManager } = await newRuntime();
  const entries: {
    module: string;
    files: string[];
    dataFiles: number;
    exported?: string;
  }[] = [];
  try {
    for (const module of await corpusModules(only)) {
      const chosen = await mainPattern(module);
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: `${patterns}${module.module}`, root: repository },
      );
      // A file that is no TypeScript module is data, which today's
      // pipeline stores and does not compile, and which the crate's
      // corpus does not read.
      const files = program.files.map((entry) => entry.name).filter((name) =>
        name.endsWith(".ts") || name.endsWith(".tsx")
      );
      if (!files.every((name) => name.startsWith("/patterns/"))) {
        console.error(`${module.module}: a file outside patterns/`);
        continue;
      }
      entries.push({
        module: module.module,
        files: files.map((name) => name.slice("/patterns".length)),
        dataFiles: program.files.length - files.length,
        // The export that is compiled where the module has no default one.
        ...(chosen?.exported === undefined
          ? {}
          : { exported: chosen.exported }),
      });
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
  await Deno.writeTextFile(file, JSON.stringify(entries, null, 1));
};

const COMPILE_PHASES = [
  "engine/",
  "js-compiler/phase/",
  "pattern-manager/compile-cache/",
  "compiled-bundle-verifier/classifyModuleItems/statements",
];

/**
 * One compile of a module by today's pipeline in a runtime of its own:
 * the program is resolved from disk (`resolveLocalProgram`), compiled and
 * evaluated to a pattern (`PatternManager.compilePattern` in
 * `runtime/runner/src/pattern-manager.ts`, which the harness and `cf`
 * call), and compiled a second time in the same runtime.
 */
const compileOnce = async (module: string, exported?: string) => {
  const { runtime, storageManager, space } = await newRuntime();
  try {
    resetAllTimingStats();
    const started = performance.now();
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: `${patterns}${module}`,
        root: repository,
        ...(exported === undefined ? {} : { mainExport: exported }),
      },
    );
    const resolved = performance.now();
    await runtime.patternManager.compilePattern(program, { space });
    const compiled = performance.now();
    const phases = timings(COMPILE_PHASES);
    await runtime.patternManager.compilePattern(program, { space });
    const again = performance.now();
    return {
      files: program.files.length,
      sourceBytes: program.files.reduce(
        (bytes, file) => bytes + file.contents.length,
        0,
      ),
      resolve: resolved - started,
      compile: compiled - resolved,
      again: again - compiled,
      phases,
    };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

const compile = async (manifest: string, file: string, only?: string) => {
  const entries: { module: string; exported?: string }[] = JSON.parse(
    await Deno.readTextFile(manifest),
  );
  const finished = await done(file);
  for (const { module, exported } of entries) {
    if (
      finished.has(module) || (only !== undefined && !module.includes(only))
    ) {
      continue;
    }
    console.error(module);
    const runs = [];
    try {
      for (let run = 0; run < 3; run++) {
        runs.push(await compileOnce(module, exported));
      }
      await append(file, { module, runs });
    } catch (error) {
      await append(file, {
        module,
        failed: `${(error as Error)?.message ?? error}`.split("\n")[0],
      });
    }
  }
};

/**
 * One process per module for each pipeline. Today's is this script with
 * `compile-one`, which compiles the module once and prints its figures.
 * The crate's is `pattern-compiler plan` with the files of the module's
 * program, five times. Both are started from this process, and the wall
 * time is from the start of the process to its end.
 */
const processes = async (manifest: string, file: string, only?: string) => {
  const entries: { module: string; files: string[]; exported?: string }[] = JSON
    .parse(await Deno.readTextFile(manifest));
  const finished = await done(file);
  for (const { module, files, exported } of entries) {
    if (
      finished.has(module) || (only !== undefined && !module.includes(only))
    ) {
      continue;
    }
    console.error(module);
    const crateRuns: number[] = [];
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      const { success } = await new Deno.Command(crate, {
        args: ["plan", ...files.map((name) => name.slice(1))],
        cwd: patterns,
        stdout: "piped",
        stderr: "null",
      }).output();
      crateRuns.push(performance.now() - started);
      if (!success) crateRuns.push(NaN);
    }
    const started = performance.now();
    const { success, stdout } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--no-check",
        import.meta.filename!,
        "compile-one",
        module,
        ...(exported === undefined ? [] : [exported]),
      ],
      cwd: repository,
      stdout: "piped",
      stderr: "null",
    }).output();
    const today = performance.now() - started;
    await append(file, {
      module,
      crate: crateRuns,
      today,
      ...(success
        // The figures are the last line the process prints. The runtime
        // logs to the same stream.
        ? {
          inside: JSON.parse(
            new TextDecoder().decode(stdout).trim().split("\n").at(-1)!,
          ),
        }
        : { failed: true }),
    });
  }
};

// ---------------------------------------------------------------------
// Run time and storage

const utf8 = new TextEncoder();
const bytesOf = (value: unknown): number =>
  value === undefined ? 0 : utf8.encode(JSON.stringify(value)).length;

/** What a set of stored documents holds. */
export type Stored = {
  documents: number;
  /** The bytes of the JSON of each document's `value`. */
  valueBytes: number;
  /** The bytes of the members beside `value` and `cfc`: the meta fields. */
  metaBytes: number;
  /** The documents with a `cfc` envelope. */
  envelopes: number;
  /** The entries of the label maps of the envelopes. */
  labelEntries: number;
  /** The bytes of the envelopes as the replica holds them, labels in place. */
  envelopeBytes: number;
  /**
   * The bytes of the envelopes with each label above 128 bytes held as a
   * reference of 63 bytes (`CFC_LABEL_INLINE_LIMIT` in
   * `runtime/runner/src/cfc/label-documents.ts`), and the labels so
   * referenced counted once each in `labelDocuments` and
   * `labelDocumentBytes`.
   */
  envelopeBytesByReference: number;
  labelDocuments: number;
  labelDocumentBytes: number;
};

const REFERENCE_BYTES = 63;
const INLINE_LIMIT = 128;

/** The kinds a document of today's layout is counted in (ES §4.8). */
export type Kind =
  /** Holds an `argument` meta link: the result document of an instance. */
  | "result"
  /** What the `argument` link of a result document names. */
  | "argument"
  /** Holds a `result` meta link and is no argument document. */
  | "internal"
  /** Has an identifier of the `computed:` scheme: a derived document. */
  | "computed"
  /** Has a `cid:` identifier: a schema, shared and immutable. */
  | "schema"
  /** Everything else: the scenario's inputs, records, receipts. */
  | "other";

export const KINDS: Kind[] = [
  "result",
  "argument",
  "internal",
  "computed",
  "schema",
  "other",
];

type Document = Record<string, unknown> & {
  cfc?: { labelMap?: { entries?: { label?: unknown }[] } };
};

/** Adds up `documents`, with the labels above the inline limit shared. */
export const stored = (documents: Document[]): Stored => {
  const labels = new Map<string, number>();
  const total: Stored = {
    documents: documents.length,
    valueBytes: 0,
    metaBytes: 0,
    envelopes: 0,
    labelEntries: 0,
    envelopeBytes: 0,
    envelopeBytesByReference: 0,
    labelDocuments: 0,
    labelDocumentBytes: 0,
  };
  for (const document of documents) {
    const { value, cfc, ...meta } = document;
    total.valueBytes += bytesOf(value);
    total.metaBytes += Object.keys(meta).length === 0 ? 0 : bytesOf(meta);
    if (cfc === undefined) continue;
    total.envelopes += 1;
    const whole = bytesOf(cfc);
    total.envelopeBytes += whole;
    let byReference = whole;
    for (const entry of cfc.labelMap?.entries ?? []) {
      total.labelEntries += 1;
      const text = JSON.stringify(entry.label ?? null);
      const size = utf8.encode(text).length;
      if (size <= INLINE_LIMIT) continue;
      byReference += REFERENCE_BYTES - size;
      labels.set(text, size);
    }
    total.envelopeBytesByReference += byReference;
  }
  total.labelDocuments = labels.size;
  total.labelDocumentBytes = [...labels.values()].reduce((a, b) => a + b, 0);
  return total;
};

/** The kind of each of `documents`, by identifier. */
export const kinds = (documents: Map<string, Document>): Map<string, Kind> => {
  const argumentIds = new Set<string>();
  for (const document of documents.values()) {
    if (document.argument === undefined) continue;
    for (
      const [, id] of JSON.stringify(document.argument).matchAll(
        /"id":"([^"]+)"/g,
      )
    ) argumentIds.add(id);
  }
  const found = new Map<string, Kind>();
  for (const [key, document] of documents) {
    const id = JSON.parse(key)[0] as string;
    found.set(
      key,
      id.startsWith("cid:")
        ? "schema"
        : document.argument !== undefined
        ? "result"
        : argumentIds.has(id)
        ? "argument"
        : id.startsWith("computed:")
        ? "computed"
        : document.result !== undefined
        ? "internal"
        : "other",
    );
  }
  return found;
};

const LINK = "link@1";

/** The identifier and the path a stored link names, where `value` is one. */
const linkOf = (
  value: unknown,
): { id?: string; path: string[] } | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const inner = (value as { "/"?: Record<string, unknown> })["/"];
  if (inner === null || typeof inner !== "object") return undefined;
  const link = inner[LINK] as { id?: string; path?: string[] } | undefined;
  return link === undefined || typeof link !== "object"
    ? undefined
    : { id: link.id, path: link.path ?? [] };
};

/**
 * The value of the document `id` with every link to a document of `owned`
 * replaced by what the link names, and so on through those documents. A
 * link to any other document stays a link, and so does a link that leads
 * back to a place being replaced.
 *
 * With `owned` the documents today's layout gives the nodes, the
 * sub-patterns and the elements of an instance, this is the instance's
 * result as one value: what the compiled layout stores in the result
 * document and its parts (ES §4.2, §4.5), where a value the instance
 * computed is stored in place and a reference passed through is a link.
 */
export const inlined = (
  id: string,
  documents: Map<string, Record<string, unknown>>,
  owned: Set<string>,
): unknown => {
  const open = new Set<string>();
  const walk = (value: unknown, at: string): unknown => {
    const link = linkOf(value);
    if (link !== undefined) {
      const target = link.id ?? at;
      const key = JSON.stringify([target, link.path]);
      if (!owned.has(target) || open.has(key)) return value;
      let found: unknown = documents.get(target)?.value;
      for (const segment of link.path) {
        // A link on the way is followed first, so that the rest of the
        // path is read below what it names.
        for (let hops = 0; hops < 16; hops++) {
          const through = linkOf(found);
          const next = through?.id ?? target;
          if (through === undefined || !owned.has(next)) break;
          found = through.path.reduce<unknown>(
            (inner, key) =>
              inner !== null && typeof inner === "object"
                ? (inner as Record<string, unknown>)[key]
                : undefined,
            documents.get(next)?.value,
          );
        }
        found = found !== null && typeof found === "object"
          ? (found as Record<string, unknown>)[segment]
          : undefined;
      }
      if (found === undefined) return value;
      open.add(key);
      const result = walk(found, target);
      open.delete(key);
      return result;
    }
    if (Array.isArray(value)) return value.map((inner) => walk(inner, at));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, walk(inner, at)]),
      );
    }
    return value;
  };
  const key = JSON.stringify([id, []]);
  open.add(key);
  return walk(documents.get(id)?.value, id);
};

type Counters = {
  /** Wall time since the last point, without the time a probe took. */
  milliseconds: number;
  /** Transactions the storage committed (`storage.v2.transaction`). */
  transactions: number;
  /** Commits the scheduler asked for, those with nothing to write included. */
  schedulerCommits: number;
  /** Runs of a scheduler action (`scheduler/run/action`). */
  actions: number;
  /** Calls of an authored JavaScript body. */
  bodies: number;
  /** Events the scheduler handled. */
  events: number;
  /** CFC commit preparations. */
  preparations: number;
  /** Reads in the journals of the transactions whose commit was called. */
  reads: number;
  /** Write attempts of those transactions. */
  writes: number;
};

const COUNTED: [keyof Counters, string][] = [
  ["transactions", "storage.v2.transaction/commit/commitNative"],
  ["schedulerCommits", "scheduler/scheduler/run/commit"],
  ["actions", "scheduler/scheduler/run/action"],
  ["bodies", "runner/action/invokeJavaScriptImplementation"],
  ["events", "scheduler/scheduler/execute/event"],
  ["preparations", "extended-storage-transaction/prepareCfc"],
];

type Snapshot = {
  byKind: Record<Kind, Stored>;
  total: Stored;
  /**
   * The bytes of the result document's value with every link to a
   * document of the instance replaced by what it names (`inlined`).
   */
  resultInlinedBytes: number;
  /** The documents the compile stored, which are counted in no kind. */
  compileCache: Stored;
};

type Measured = {
  /** From the compiled pattern to every kept output read. */
  settle: Counters;
  settled: Snapshot;
  events: (Counters & { binding: number; outcome?: string })[];
  /** After the last event, where the scenario has one. */
  afterEvents?: Snapshot;
};

/**
 * A probe that records, between the points of a run, the wall time and
 * what the runtime's own timing counters and the transactions' journals
 * count, and at the points the documents the run stored. It reads the
 * replica of the scenario's space, and changes nothing but the
 * runtime's `edit`, which it wraps to read each transaction's journal
 * when its commit is called.
 */
const measuring = (): { probe: Probe; result: () => Measured } => {
  const addresses = new Map<string, { id: string; scope?: string }>();
  let cache = new Set<string>();
  let journal = { reads: 0, writes: 0 };
  let resumed = 0;
  let before: Record<string, { count: number }> = {};
  const measured: Partial<Measured> & { events: Measured["events"] } = {
    events: [],
  };
  const counters = (entered: number): Counters => {
    const now = timings(COUNTED.map(([, key]) => key));
    const counts = Object.fromEntries(
      COUNTED.map((
        [name, key],
      ) => [name, (now[key]?.count ?? 0) - (before[key]?.count ?? 0)]),
    ) as Omit<Counters, "milliseconds" | "reads" | "writes">;
    return { milliseconds: entered - resumed, ...counts, ...journal };
  };
  const probe: Probe = {
    at: (
      point,
      { runtime, storageManager, space, result, binding, outcome },
    ) => {
      const entered = performance.now();
      const snapshot = (): Snapshot => {
        // deno-lint-ignore no-explicit-any
        const replica = storageManager.open(space as any).replica as any;
        const documents = new Map<string, Document>();
        const cached: Document[] = [];
        for (const [key, { id, scope }] of addresses) {
          const document = replica.getDocument(id, scope) as
            | Document
            | undefined;
          if (document === undefined) continue;
          if (cache.has(key)) cached.push(document);
          else documents.set(key, document);
        }
        const kind = kinds(documents);
        const of = (wanted: Kind) =>
          stored(
            [...documents].filter(([key]) => kind.get(key) === wanted).map((
              [, document],
            ) => document),
          );
        return {
          byKind: Object.fromEntries(
            KINDS.map((wanted) => [wanted, of(wanted)]),
          ) as Record<Kind, Stored>,
          total: stored([...documents.values()]),
          resultInlinedBytes: result === undefined ? 0 : bytesOf(
            inlined(
              result,
              new Map(
                [...documents].map((
                  [key, document],
                ) => [JSON.parse(key)[0] as string, document]),
              ),
              new Set(
                [...documents.keys()].filter((key) =>
                  ["result", "argument", "internal", "computed"].includes(
                    kind.get(key)!,
                  )
                ).map((key) => JSON.parse(key)[0] as string),
              ),
            ),
          ),
          compileCache: stored(cached),
        };
      };
      if (point === "created") {
        resetAllTimingStats();
        storageManager.subscribe({
          // deno-lint-ignore no-explicit-any
          next(notification: any) {
            if (notification.type !== "commit") return undefined;
            for (const change of notification.changes) {
              const { id, scope } = change.address;
              addresses.set(JSON.stringify([id, scope]), { id, scope });
            }
            return undefined;
          },
        });
        const edit = runtime.edit.bind(runtime);
        // deno-lint-ignore no-explicit-any
        (runtime as any).edit = (...args: unknown[]) => {
          // deno-lint-ignore no-explicit-any
          const tx = (edit as any)(...args);
          const commit = tx.commit.bind(tx);
          tx.commit = () => {
            for (const _ of tx.getReadActivities?.() ?? []) journal.reads++;
            journal.writes += tx.getWriteAttemptLog?.().length ?? 0;
            return commit();
          };
          return tx;
        };
      } else if (point === "compiled") {
        cache = new Set(addresses.keys());
      } else if (point === "settled") {
        measured.settle = counters(entered);
        measured.settled = snapshot();
      } else if (point === "after event") {
        measured.events.push({
          ...counters(entered),
          binding: binding!,
          ...(outcome === undefined ? {} : { outcome }),
        });
        measured.afterEvents = snapshot();
      }
      before = timings(COUNTED.map(([, key]) => key));
      journal = { reads: 0, writes: 0 };
      resumed = performance.now();
    },
  };
  return { probe, result: () => measured as Measured };
};

/** An array of an input with `length` elements made from the two it has. */
export const widened = (value: unknown, length: number): unknown => {
  if (!Array.isArray(value) || value.length === 0) return value;
  const renamed = (element: unknown, suffix: string): unknown =>
    typeof element === "string"
      ? `${element}${suffix}`
      : Array.isArray(element)
      ? element.map((inner) => renamed(inner, suffix))
      : element !== null && typeof element === "object"
      ? Object.fromEntries(
        Object.entries(element).map((
          [key, inner],
        ) => [key, renamed(inner, suffix)]),
      )
      : element;
  return Array.from(
    { length },
    (_, index) =>
      index < value.length
        ? value[index]
        : renamed(value[index % value.length], `-${index}`),
  );
};

/**
 * The number of element keys of each collection of `plan` in a scenario
 * with `inputs`, where the plan and the inputs give it: the length of the
 * array at the path of an `argument` slot, of the array at the path of an
 * `element` slot in the first element of that slot's collection, and the
 * size of the collection another collection is derived from, which bounds
 * a `filter` from above. A collection over a computed array, a state
 * cell or the result of an operation has no size here, and is given
 * `assumed`.
 */
export const sizesOf = (
  plan: CostPlan,
  inputs: Record<string, { value: unknown }>,
  assumed: number,
): { size: Sizes; unknown: number } => {
  const walk = (value: unknown, path: string[]): unknown =>
    path.reduce<unknown>(
      (at, key) =>
        at !== null && typeof at === "object"
          ? (at as Record<string, unknown>)[key]
          : undefined,
      value,
    );
  const source = (collection: number, depth = 0): unknown[] | undefined => {
    const from = plan.collections[collection]?.source;
    if (from === undefined || depth > 8) return undefined;
    if (from.collection !== undefined) {
      return source(from.collection, depth + 1);
    }
    const slot = plan.slots[from.slot ?? -1];
    if (slot === undefined) return undefined;
    const value = slot.root.kind === "argument"
      ? walk(inputs[slot.path[0]]?.value, slot.path.slice(1))
      : slot.root.kind === "element"
      ? walk(source(slot.root.collection!, depth + 1)?.[0], slot.path)
      : undefined;
    return Array.isArray(value) ? value : undefined;
  };
  const sizes = plan.collections.map((_, index) => source(index)?.length);
  return {
    size: (collection) => sizes[collection] ?? assumed,
    unknown: sizes.filter((size) => size === undefined).length,
  };
};

const NEEDS: Record<string, string> = {
  wish: "needs `wish`",
  effect: "requests an effect",
};

const range = (
  a: { min: number; max: number },
  b: { min: number; max: number },
) => ({ min: a.min + b.min, max: a.max + b.max });

/** Runs one module's scenario and derives the plan's side of it. */
const runModule = async (
  module: CorpusModule,
  options: { length?: number; events: boolean },
) => {
  const chosen = await mainPattern(module);
  if (chosen === undefined) {
    return { module: module.module, skipped: "exports no pattern" };
  }
  const { plan, schemas } = chosen.pattern;
  for (const operation of plan.operations ?? []) {
    const reason = NEEDS[operation.kind ?? ""];
    if (reason !== undefined) return { module: module.module, skipped: reason };
  }
  const inputs: Record<string, LabeledInput> = generateInputs(
    plan,
    schemas,
    await scenarioAudience(),
  );
  if (options.length !== undefined) {
    for (const input of Object.values(inputs)) {
      input.value = widened(input.value, options.length);
    }
  }
  const events = options.events
    ? eventOrder(plan, "outside first").map((binding) => ({
      binding,
      event: generateEvent(plan, schemas, binding),
    }))
    : [];
  const { probe, result } = measuring();
  // The executor's record of where each stream is stored, by which the
  // harness sends the events (`Scenario.streams`).
  const streams = options.events
    ? executorOf(chosen.pattern, inputs)
    : undefined;
  const { error: consoleError, warn: consoleWarn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    await runScenario({
      program: {
        main: `${patterns}${module.module}`,
        root: repository,
        ...(chosen.exported === undefined ? {} : { export: chosen.exported }),
      },
      plan,
      argument: {},
      inputs,
      events,
      probe,
      ...(streams === undefined ? {} : { streams }),
    });
  } catch (error) {
    const message = `${(error as Error)?.message ?? error}`.split("\n")[0];
    return {
      module: module.module,
      skipped: `the run fails: ${message.slice(0, 100)}`,
    };
  } finally {
    console.error = consoleError;
    console.warn = consoleWarn;
  }
  const measured = result();
  // The derivation, with a collection of no known size taken as empty
  // (`known`) and as having the two elements every generated array has
  // (`assumed`).
  const derive = (assumed: number) => {
    const { size, unknown } = sizesOf(plan, inputs, assumed);
    const settled = settledCost(plan, size);
    const perEvent = measured.events.map(({ binding }) =>
      eventCost(plan, binding, size)
    );
    return {
      unknownSizes: unknown,
      settled,
      events: {
        transactions: perEvent.map((event) => event.transactions).reduce(
          range,
          { min: 0, max: 0 },
        ),
        coneEvaluations: perEvent.map((event) => event.coneEvaluations)
          .reduce(range, { min: 0, max: 0 }),
        streamDocuments: new Set(measured.events.map(({ binding }) => binding))
          .size,
      },
      labelEnvelopeBytes: {
        min: settled.labelEntries.min * ENTRY_BYTES,
        max: settled.labelEntries.max * ENTRY_BYTES,
      },
    };
  };
  return {
    module: module.module,
    inputs: Object.keys(inputs).length,
    ...(options.length === undefined ? {} : { length: options.length }),
    measured,
    derived: { known: derive(0), assumed: derive(2) },
  };
};

const run = async (file: string, only?: string) => {
  const finished = await done(file);
  for (const module of await corpusModules(only)) {
    if (finished.has(module.module)) continue;
    console.error(module.module);
    await append(file, await runModule(module, { events: true }));
  }
};

/** The two lengths `scale` runs each module at. */
export const SCALE = [2, 10] as const;

/**
 * Runs each module that has a `map` over an array of its argument at the
 * two lengths of `SCALE`, with no events, so that the difference between
 * the two runs is the cost of the elements added.
 */
const scale = async (file: string, only?: string) => {
  const finished = await done(file);
  for (const module of await corpusModules(only)) {
    if (finished.has(module.module)) continue;
    const chosen = await mainPattern(module);
    const plan: CostPlan | undefined = chosen?.pattern.plan;
    const overArgument = (plan?.collections ?? []).some((collection) =>
      collection.construct === "map" &&
      plan!.slots[collection.source?.slot ?? -1]?.root.kind === "argument"
    );
    if (!overArgument) continue;
    console.error(module.module);
    const runs = [];
    for (const length of SCALE) {
      runs.push(await runModule(module, { length, events: false }));
    }
    await append(file, { module: module.module, runs });
  }
};

if (import.meta.main) {
  const [command, ...rest] = Deno.args;
  const only = rest.find((argument) => argument.startsWith("--only="))
    ?.slice("--only=".length);
  const operands = rest.filter((argument) => !argument.startsWith("--"));
  if (command === "closures" && operands.length === 1) {
    await closures(operands[0], only);
  } else if (command === "compile" && operands.length === 2) {
    await compile(operands[0], operands[1], only);
  } else if (command === "compile-one" && operands.length >= 1) {
    console.log(JSON.stringify(await compileOnce(operands[0], operands[1])));
  } else if (command === "processes" && operands.length === 2) {
    await processes(operands[0], operands[1], only);
  } else if (command === "run" && operands.length === 1) {
    await run(operands[0], only);
  } else if (command === "scale" && operands.length === 1) {
    await scale(operands[0], only);
  } else {
    console.error(
      "usage: cost.ts closures <closures.json> | compile <closures.json> <out.jsonl> | processes <closures.json> <out.jsonl> | run <out.jsonl> | scale <out.jsonl>, each with --only=<text>",
    );
    Deno.exit(2);
  }
  Deno.exit(0);
}
