/**
 * The messages between a realm and its compile worker (`compile-worker.ts`),
 * and their encoding over a structured clone. Both ends are the same build,
 * so a message that does not decode is a fault in this module and fails
 * loudly. A compile's result and the error a compile threw are encoded here,
 * since a source map, a `CompilerError` or a `TransformerError` does not
 * survive a structured clone as itself.
 *
 * The worker posts `ready` once its listener is installed, and the realm
 * sends nothing before that, since a message posted to a worker that has no
 * listener yet is dropped. Every request carries an id its answer repeats.
 * Each compile's answer carries a snapshot of the worker realm's loggers,
 * which hold the compiler's own phase timings; that realm does nothing but
 * compile, so the snapshot after its latest compile is current.
 */

import type {
  CompilationErrorFields,
  CompiledTypeScriptModule,
  Source,
  TransformerDiagnosticInfo,
} from "@commonfabric/js-compiler";
import {
  CompilerError,
  TransformerError,
} from "@commonfabric/js-compiler/errors";
import { parseSourceMap } from "@commonfabric/js-compiler/source-map";
import {
  isPlainObject,
  type ReadonlyRecord,
} from "@commonfabric/js-values/types";
import type {
  CDFPoint,
  LogCounts,
  SlowTiming,
  TimingStats,
  TimingStatsBreakdown,
} from "@commonfabric/logger";
import { isBuilderSourceSitesV1 } from "@commonfabric/ts-transformers/runtime-contract";

import type { FabricMount } from "../sandbox/module-record-compiler.ts";
import {
  authoredSourceForCompile,
  type ModuleCompileRequest,
} from "./module-compile.ts";

/** A compile the realm asks its worker for. */
export interface CompileWorkerRequest {
  /** The number the answer repeats, unique within one realm's worker. */
  readonly id: number;

  /** The compile to run. */
  readonly request: ModuleCompileRequest;
}

/** The worker realm's loggers, as they stood when it answered a compile. */
export interface WorkerDiagnostics {
  /**
   * The worker's `performance.timeOrigin`, which the timestamps in
   * `timingStats` count from.
   */
  readonly timeOrigin: number;

  /** The worker realm's timing statistics. */
  readonly timingStats: TimingStatsBreakdown;

  /** The worker realm's log counts, by logger name and message key. */
  readonly loggerCounts: Record<string, Record<string, LogCounts>>;
}

/** What a compile worker posts to its realm. */
export type CompileWorkerAnswer =
  | { readonly kind: "ready" }
  | {
    readonly kind: "compiled";
    readonly id: number;
    readonly modules: readonly (readonly [string, EncodedModule])[];
    readonly diagnostics: WorkerDiagnostics;
  }
  | {
    readonly kind: "failed";
    readonly id: number;
    readonly failure: EncodedCompileFailure;
    readonly diagnostics: WorkerDiagnostics;
  };

/** A compiled module as it crosses, its source map as JSON text. */
export interface EncodedModule {
  /** The emitted JavaScript. */
  readonly js: string;

  /** The module's source map, as JSON text. */
  readonly sourceMap?: string;

  /** Where the module's builders were written in its authored source. */
  readonly builderSourceSites?: CompiledTypeScriptModule["builderSourceSites"];

  /** The policy manifests the transformer collected from the module. */
  readonly policyManifests?: readonly unknown[];
}

/** The error a compile threw, as it crosses. */
export type EncodedCompileFailure =
  | {
    readonly kind: "compiler";
    readonly errors: readonly CompilationErrorFields[];
  }
  | {
    readonly kind: "transformer";
    readonly diagnostics: readonly TransformerDiagnosticInfo[];
  }
  | {
    readonly kind: "error";
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };

/** Encodes the modules a compile emitted. */
export function encodeModules(
  modules: ReadonlyMap<string, CompiledTypeScriptModule>,
): (readonly [string, EncodedModule])[] {
  return [...modules].map(([name, module]) => [name, {
    js: module.js,
    ...(module.sourceMap === undefined
      ? {}
      : { sourceMap: JSON.stringify(module.sourceMap) }),
    ...(module.builderSourceSites === undefined
      ? {}
      : { builderSourceSites: module.builderSourceSites }),
    ...(module.policyManifests === undefined
      ? {}
      : { policyManifests: module.policyManifests }),
  }]);
}

/** Decodes the modules {@link encodeModules} encoded. */
export function decodeModules(
  modules: readonly (readonly [string, EncodedModule])[],
): Map<string, CompiledTypeScriptModule> {
  return new Map(modules.map(([name, module]) => [name, {
    js: module.js,
    ...(module.sourceMap === undefined
      ? {}
      : { sourceMap: parseSourceMap(module.sourceMap) }),
    ...(module.builderSourceSites === undefined
      ? {}
      : { builderSourceSites: module.builderSourceSites }),
    ...(module.policyManifests === undefined
      ? {}
      : { policyManifests: module.policyManifests }),
  }]));
}

/** Encodes what a compile threw. */
export function encodeCompileFailure(error: unknown): EncodedCompileFailure {
  if (error instanceof CompilerError) {
    return {
      kind: "compiler",
      errors: error.errors.map((
        { source, file, line, column, message, type },
      ) => ({
        source,
        file,
        line,
        column,
        message,
        type,
      })),
    };
  }
  if (error instanceof TransformerError) {
    return { kind: "transformer", diagnostics: error.diagnostics };
  }
  if (error instanceof Error) {
    return {
      kind: "error",
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { kind: "error", name: "Error", message: String(error) };
}

/**
 * Rebuilds the error {@link encodeCompileFailure} encoded, as the compiler
 * threw it for `request`. A `TransformerError`'s message quotes the sources
 * around each diagnostic, which the request holds, so it is formatted again
 * here rather than carried.
 */
export function decodeCompileFailure(
  failure: EncodedCompileFailure,
  request: ModuleCompileRequest,
): Error {
  switch (failure.kind) {
    case "compiler":
      return new CompilerError(failure.errors);
    case "transformer":
      return new TransformerError(
        [...failure.diagnostics],
        new Map(
          request.program.files.map((file) => [file.name, file.contents]),
        ),
        authoredSourceForCompile({
          id: request.id,
          mounts: request.mounts,
          sourceFiles: request.authoredSources,
        }),
      );
    case "error": {
      const error = new Error(failure.message);
      error.name = failure.name;
      if (failure.stack !== undefined) error.stack = failure.stack;
      return error;
    }
  }
}

/**
 * Decodes a request a compile worker received.
 *
 * @throws Error when `data` is not a {@link CompileWorkerRequest}.
 */
export function decodeCompileWorkerRequest(
  data: unknown,
): CompileWorkerRequest {
  if (!isPlainObject(data) || typeof data.id !== "number") {
    throw new Error("A compile worker received a message with no request id");
  }
  return { id: data.id, request: decodeRequest(data.request) };
}

/**
 * Decodes an answer a realm received from its compile worker.
 *
 * @throws Error when `data` is not a {@link CompileWorkerAnswer}.
 */
export function decodeCompileWorkerAnswer(data: unknown): CompileWorkerAnswer {
  if (!isPlainObject(data)) {
    throw protocolError("an answer that is not a record");
  }
  if (data.kind === "ready") return { kind: "ready" };
  if (typeof data.id !== "number") {
    throw protocolError("an answer with no request id");
  }
  if (data.kind === "compiled") {
    return {
      kind: "compiled",
      id: data.id,
      modules: arrayOf(data.modules, "modules", decodeModuleEntry),
      diagnostics: decodeWorkerDiagnostics(data.diagnostics),
    };
  }
  if (data.kind === "failed") {
    return {
      kind: "failed",
      id: data.id,
      failure: decodeFailure(data.failure),
      diagnostics: decodeWorkerDiagnostics(data.diagnostics),
    };
  }
  throw protocolError("an answer of no known kind");
}

function decodeWorkerDiagnostics(value: unknown): WorkerDiagnostics {
  if (!isPlainObject(value)) {
    throw protocolError("worker diagnostics that are not a record");
  }
  return {
    timeOrigin: numberField(value, "timeOrigin"),
    timingStats: decodeTimingStatsBreakdown(value.timingStats),
    loggerCounts: decodeLoggerCounts(value.loggerCounts),
  };
}

function decodeLoggerCounts(
  value: unknown,
): Record<string, Record<string, LogCounts>> {
  if (!isPlainObject(value)) {
    throw protocolError("log counts that are not a record");
  }
  const byLogger: Record<string, Record<string, LogCounts>> = {};
  for (const [loggerName, byKey] of Object.entries(value)) {
    if (!isPlainObject(byKey)) {
      throw protocolError("a logger's log counts that are not a record");
    }
    const counts: Record<string, LogCounts> = {};
    for (const [key, entry] of Object.entries(byKey)) {
      if (!isPlainObject(entry)) {
        throw protocolError("log counts for a key that are not a record");
      }
      counts[key] = {
        debug: numberField(entry, "debug"),
        info: numberField(entry, "info"),
        warn: numberField(entry, "warn"),
        error: numberField(entry, "error"),
        total: numberField(entry, "total"),
      };
    }
    byLogger[loggerName] = counts;
  }
  return byLogger;
}

function decodeTimingStatsBreakdown(value: unknown): TimingStatsBreakdown {
  if (!isPlainObject(value)) {
    throw protocolError("timing statistics that are not a record");
  }
  const breakdown: TimingStatsBreakdown = {};
  for (const [loggerName, byKey] of Object.entries(value)) {
    if (!isPlainObject(byKey)) {
      throw protocolError("a logger's timing statistics that are not a record");
    }
    const stats: Record<string, TimingStats> = {};
    for (const [key, entry] of Object.entries(byKey)) {
      stats[key] = decodeTimingStats(entry);
    }
    breakdown[loggerName] = stats;
  }
  return breakdown;
}

function decodeTimingStats(value: unknown): TimingStats {
  if (!isPlainObject(value)) {
    throw protocolError("timing statistics for a key that are not a record");
  }
  const cdfSinceBaseline = value.cdfSinceBaseline;
  return {
    count: numberField(value, "count"),
    min: numberField(value, "min"),
    max: numberField(value, "max"),
    totalTime: numberField(value, "totalTime"),
    average: numberField(value, "average"),
    countSinceBaseline: numberField(value, "countSinceBaseline"),
    totalTimeSinceBaseline: numberField(value, "totalTimeSinceBaseline"),
    averageSinceBaseline: numberField(value, "averageSinceBaseline"),
    p50: numberField(value, "p50"),
    p95: numberField(value, "p95"),
    lastTime: numberField(value, "lastTime"),
    lastTimestamp: numberField(value, "lastTimestamp"),
    slowest: arrayOf(value.slowest, "slowest timings", decodeSlowTiming),
    cdf: arrayOf(value.cdf, "CDF points", decodeCDFPoint),
    cdfSinceBaseline: cdfSinceBaseline === null
      ? null
      : arrayOf(cdfSinceBaseline, "CDF points", decodeCDFPoint),
  };
}

function decodeSlowTiming(value: unknown): SlowTiming {
  if (!isPlainObject(value)) {
    throw protocolError("a slow timing that is not a record");
  }
  return {
    elapsed: numberField(value, "elapsed"),
    at: numberField(value, "at"),
    epochMs: numberField(value, "epochMs"),
    ...(value.detail === undefined
      ? {}
      : { detail: stringField(value, "detail") }),
  };
}

function decodeCDFPoint(value: unknown): CDFPoint {
  if (!isPlainObject(value)) {
    throw protocolError("a CDF point that is not a record");
  }
  return { x: numberField(value, "x"), y: numberField(value, "y") };
}

function decodeRequest(value: unknown): ModuleCompileRequest {
  if (!isPlainObject(value)) {
    throw protocolError("a request that is not a record");
  }
  const program = value.program;
  if (!isPlainObject(program) || typeof program.main !== "string") {
    throw protocolError("a request whose program has no entry");
  }
  const diagnosticMessages = value.diagnosticMessages;
  if (
    diagnosticMessages !== "typescript" && diagnosticMessages !== "reactive" &&
    diagnosticMessages !== "reactive-verbose"
  ) {
    throw protocolError("a request with no diagnostic message style");
  }
  return {
    program: {
      main: program.main,
      files: arrayOf(program.files, "program files", decodeSource),
    },
    authoredSources: arrayOf(
      value.authoredSources,
      "authored sources",
      decodeSource,
    ),
    ...(value.id === undefined ? {} : { id: stringField(value, "id") }),
    mounts: arrayOf(value.mounts, "mounts", decodeMount),
    moduleIdentities: stringMap(value.moduleIdentities, "module identities"),
    specifierAliases: stringMap(value.specifierAliases, "specifier aliases"),
    storedSource: booleanField(value, "storedSource"),
    noCheck: booleanField(value, "noCheck"),
    diagnosticMessages,
    instanceNames: booleanField(value, "instanceNames"),
  };
}

function decodeSource(value: unknown): Source {
  if (!isPlainObject(value)) {
    throw protocolError("a source that is not a record");
  }
  return {
    name: stringField(value, "name"),
    contents: stringField(value, "contents"),
  };
}

function decodeMount(value: unknown): FabricMount {
  if (!isPlainObject(value)) {
    throw protocolError("a mount that is not a record");
  }
  return {
    entryIdentity: stringField(value, "entryIdentity"),
    entryPath: stringField(value, "entryPath"),
    specifiers: arrayOf(value.specifiers, "mount specifiers", decodeString),
  };
}

function decodeModuleEntry(value: unknown): readonly [string, EncodedModule] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw protocolError("a module entry that is not a pair");
  }
  const [name, module] = value;
  if (typeof name !== "string" || !isPlainObject(module)) {
    throw protocolError("a module entry with no name or no module");
  }
  const builderSourceSites = module.builderSourceSites;
  if (
    builderSourceSites !== undefined &&
    !isBuilderSourceSitesV1(builderSourceSites)
  ) {
    throw protocolError("a module whose builder source sites do not decode");
  }
  const policyManifests = module.policyManifests;
  if (policyManifests !== undefined && !Array.isArray(policyManifests)) {
    throw protocolError("a module whose policy manifests are not a list");
  }
  return [name, {
    js: stringField(module, "js"),
    ...(module.sourceMap === undefined
      ? {}
      : { sourceMap: stringField(module, "sourceMap") }),
    ...(builderSourceSites === undefined ? {} : { builderSourceSites }),
    ...(policyManifests === undefined ? {} : { policyManifests }),
  }];
}

function decodeFailure(value: unknown): EncodedCompileFailure {
  if (!isPlainObject(value)) {
    throw protocolError("a failure that is not a record");
  }
  switch (value.kind) {
    case "compiler":
      return {
        kind: "compiler",
        errors: arrayOf(value.errors, "compile errors", decodeCompilationError),
      };
    case "transformer":
      return {
        kind: "transformer",
        diagnostics: arrayOf(
          value.diagnostics,
          "transformer diagnostics",
          decodeTransformerDiagnostic,
        ),
      };
    case "error":
      return {
        kind: "error",
        name: stringField(value, "name"),
        message: stringField(value, "message"),
        ...(value.stack === undefined
          ? {}
          : { stack: stringField(value, "stack") }),
      };
  }
  throw protocolError("a failure of no known kind");
}

function decodeCompilationError(value: unknown): CompilationErrorFields {
  if (!isPlainObject(value)) {
    throw protocolError("a compile error that is not a record");
  }
  const type = value.type;
  if (type !== "MODULE_NOT_FOUND" && type !== "ERROR") {
    throw protocolError("a compile error of no known type");
  }
  return {
    ...(value.source === undefined
      ? {}
      : { source: stringField(value, "source") }),
    ...(value.file === undefined ? {} : { file: stringField(value, "file") }),
    ...(value.line === undefined ? {} : { line: numberField(value, "line") }),
    ...(value.column === undefined
      ? {}
      : { column: numberField(value, "column") }),
    message: stringField(value, "message"),
    type,
  };
}

function decodeTransformerDiagnostic(
  value: unknown,
): TransformerDiagnosticInfo {
  if (!isPlainObject(value)) {
    throw protocolError("a transformer diagnostic that is not a record");
  }
  const severity = value.severity;
  if (severity !== "error" && severity !== "warning") {
    throw protocolError("a transformer diagnostic of no known severity");
  }
  return {
    severity,
    type: stringField(value, "type"),
    message: stringField(value, "message"),
    fileName: stringField(value, "fileName"),
    line: numberField(value, "line"),
    column: numberField(value, "column"),
    start: numberField(value, "start"),
    length: numberField(value, "length"),
  };
}

function decodeString(value: unknown): string {
  if (typeof value !== "string") {
    throw protocolError("a string list entry that is not a string");
  }
  return value;
}

function arrayOf<T>(
  value: unknown,
  what: string,
  decode: (entry: unknown) => T,
): T[] {
  if (!Array.isArray(value)) throw protocolError(`${what} that are not a list`);
  return value.map(decode);
}

function stringMap(value: unknown, what: string): Map<string, string> {
  if (!(value instanceof Map)) {
    throw protocolError(`${what} that are not a map`);
  }
  const decoded = new Map<string, string>();
  for (const [key, entry] of value) {
    if (typeof key !== "string" || typeof entry !== "string") {
      throw protocolError(`${what} with an entry that is not two strings`);
    }
    decoded.set(key, entry);
  }
  return decoded;
}

function stringField(record: ReadonlyRecord, name: string): string {
  const value = record[name];
  if (typeof value !== "string") throw protocolError(`no string \`${name}\``);
  return value;
}

function numberField(record: ReadonlyRecord, name: string): number {
  const value = record[name];
  if (typeof value !== "number") throw protocolError(`no number \`${name}\``);
  return value;
}

function booleanField(record: ReadonlyRecord, name: string): boolean {
  const value = record[name];
  if (typeof value !== "boolean") throw protocolError(`no boolean \`${name}\``);
  return value;
}

function protocolError(what: string): Error {
  return new Error(`The compile worker protocol carried ${what}`);
}
