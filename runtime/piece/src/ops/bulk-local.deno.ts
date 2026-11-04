/**
 * Turning a retarget row's `source` into the identity it produces, from the
 * local filesystem. Deno-only — it resolves files from disk — and therefore
 * behind its own export (`@commonfabric/piece/ops/bulk-local`) rather than in
 * the ops barrel, which browser-hosted callers import.
 *
 * The identity is the pin on a retarget row: the plan records the identity
 * the named source produces, computed here without compiling, and the apply
 * recomputes it from the source it actually resolved, refusing the row on a
 * mismatch. `rev` is a label for readers, never enforced. A source that
 * mounts other patterns over `cf:` fabric imports is the one shape this
 * cannot compute — the identity walk refuses it — and takes the compile path
 * instead.
 */

import {
  computeEntryIdentity,
  ensureCompilerStack,
  type Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";

import type { RetargetOp, RetargetSource } from "./bulk-plan.ts";

/** A retarget request whose identity has not been computed yet. */
export interface LocalRetargetRequest {
  source: RetargetSource;
  rev?: string;
  allowIncompatible?: boolean;
}

/**
 * Resolve `request.source` from disk and return the retarget op carrying the
 * identity that source produces. The resolution is the same one the apply
 * uses — `resolveLocalProgram`, so attached data files are part of the
 * closure and nothing is silently dropped.
 */
export async function localRetargetOp(
  runtime: Runtime,
  request: LocalRetargetRequest,
): Promise<RetargetOp> {
  // The resolver drops a falsy export and runs the default, so an empty
  // `mainExport` normalizes to absent here — the op the codec accepts is the
  // op the apply performs.
  const { mainExport, ...withoutExport } = request.source;
  const source = mainExport ? request.source : withoutExport;
  const program = await resolveLocalSourceProgram(runtime, source);
  return {
    kind: "retarget",
    source,
    ...(request.rev === undefined ? {} : { rev: request.rev }),
    patternIdentity: await programEntryIdentity(program),
    symbol: program.mainExport ?? "default",
    ...(request.allowIncompatible === undefined
      ? {}
      : { allowIncompatible: request.allowIncompatible }),
  };
}

/** Resolve a retarget source into the program the apply would run. */
export function resolveLocalSourceProgram(
  runtime: Runtime,
  source: RetargetSource,
): Promise<RuntimeProgram> {
  return resolveLocalProgram((resolver) => runtime.harness.resolve(resolver), {
    main: source.main,
    ...(source.root === undefined ? {} : { root: source.root }),
    ...(source.testPaths === undefined ? {} : { testPaths: source.testPaths }),
    ...(source.dataFilePaths === undefined
      ? {}
      : { dataFilePaths: source.dataFilePaths }),
    ...(source.mainExport === undefined
      ? {}
      : { mainExport: source.mainExport }),
  });
}

/**
 * The identity a resolved program's entry is stored under, computed from its
 * authored sources without compiling them. Source roots and data files fold
 * into the identity exactly as the compiler folds them, so a program carrying
 * either pins the same value the engine stores. The program's own lists decide
 * which files are roots and which are data, as they do when it compiles.
 */
export async function programEntryIdentity(
  program: RuntimeProgram,
): Promise<string> {
  await ensureCompilerStack();
  return computeEntryIdentity(program.main, program.files, {
    ...(program.sourceRoots === undefined
      ? {}
      : { sourceRoots: program.sourceRoots }),
    ...(program.dataFiles === undefined
      ? {}
      : { dataFiles: program.dataFiles }),
  });
}
