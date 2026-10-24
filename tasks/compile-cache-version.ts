#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --allow-net=127.0.0.1

/**
 * Mints the compile-cache version, or fails when the committed one is stale.
 *
 * The durable compile cache keys every compiled pattern by the compiler's
 * version (`compileCache:<version>/<identity>`), and a version move
 * recompiles every pattern in every space on every machine the next time it
 * loads. The version is therefore a hash of what the compiler emits for a
 * fixed corpus of patterns, under every persisted cache variant, rather than
 * of the compiler's source: a change that emits the same bytes in every mode
 * keeps the version and every cache with it, and a change confined to one
 * mode's transform moves it the way any other does.
 *
 * Without `--write`, the task is the gate. It fails when the tree's
 * compiler-input fingerprint is not the one the committed version was minted
 * against, so a pull request that touched the compiler, its types, or the
 * lockfile re-mints before it lands; and it fails when the corpus compiles to
 * bytes other than the ones the committed version names, so neither an edit
 * to the corpus nor a bump of `COMPILE_CACHE_EPOCH` goes unrecorded. With
 * `--write`, it compiles the corpus and writes the version module: the
 * inputs fingerprint it measured, and a version that moves only when the
 * emitted bytes did. Compiling the corpus under every variant takes about
 * two minutes.
 *
 * Usage: deno task compile-cache-version [--write]
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { hashStringOf } from "@commonfabric/data-model";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { PatternCoverageCollector } from "../packages/runner/src/pattern-coverage.ts";
import { Runtime } from "../packages/runner/src/runtime.ts";
import { StorageManager } from "../packages/runner/src/storage/cache.deno.ts";
import { resolveLocalProgram } from "../packages/runner/src/harness/local-program.deno.ts";
import type { CacheableModule } from "../packages/runner/src/harness/types.ts";
import {
  cacheVariantName,
  type CacheVariantOptions,
  PERSISTED_CACHE_VARIANTS,
} from "../packages/runner/src/compilation-cache/cache-variants.ts";
import {
  COMMITTED_COMPILER_VERSION,
  type CommittedCompilerVersion,
  COMPILE_CACHE_EPOCH,
  computeCompilerFingerprint,
  FINGERPRINT_LENGTH,
  renderVersionModule,
  versionOfFingerprint,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import { SOURCE_COMPILE_CACHE_RUNTIME_VERSION } from "../packages/runner/src/compilation-cache/compile-cache-version.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Where the committed version lives, repository-relative. */
export const VERSION_MODULE_PATH =
  "packages/runner/src/compilation-cache/compile-cache-version.ts";

/**
 * The corpus: a frozen copy of pattern sources, repository-relative. The
 * version names the bytes the compiler emits for these, so what is here
 * decides which compiler changes the cache survives. A construct the corpus
 * lacks is one the version cannot see a change to; the corpus is wide for
 * that reason, and an edit to it, including refreshing a file from
 * `packages/patterns`, is a deliberate change that re-mints the version.
 */
export const CORPUS_DIR = "packages/runner/test/fixtures/compile-cache-corpus";

/** The corpus entries compiled, each with its import closure, corpus-relative. */
export const CORPUS_ENTRIES: readonly string[] = [
  "annotation-manager.tsx",
  "cell-link.tsx",
  "chatbot.tsx",
  "deep-research.tsx",
  "dice.tsx",
  "fabrichat/adapter.tsx",
  "fabrichat/manager.tsx",
  "fabrichat/placement.tsx",
  "fabrichat/room.tsx",
  "form-demo.tsx",
  "group-chat-lobby.tsx",
  "map-demo.tsx",
  "self-improving-classifier.tsx",
  "shopping-list.tsx",
  "store-mapper.tsx",
  "system/agent-queue.tsx",
  "system/default-app.tsx",
  "system/home.tsx",
  "system/knowledge-graph.tsx",
  "system/omnibox-fab.tsx",
  "system/private-inbox.tsx",
  "system/profile-create.tsx",
  "system/profile-home.tsx",
  "system/quick-capture.tsx",
  "system/space-overview.tsx",
  "system/suggestion.tsx",
];

const OUTPUT_TAG = "cf/compile-output-fingerprint/v1";

/** What the output fingerprint covers of one compiled module. */
export interface CompiledOutput {
  /** The module's corpus-relative name. */
  readonly filename: string;

  /** The emitted JavaScript body. */
  readonly js: string;

  /**
   * Everything else the compiled document stores for the module, as the
   * artifact's own fields in key order, minus the source map: a source map
   * describes the same bytes for a debugger, and a change to it alone leaves
   * every stored document serving the code it did.
   */
  readonly artifact: string;
}

/** The compiled modules of one corpus entry, as the fingerprint sees them. */
export interface CompiledEntry {
  readonly entry: string;
  readonly modules: readonly CompiledOutput[];
}

/** The corpus compiled under one cache variant. */
export interface CompiledVariant {
  /** The variant's cache-key suffix (`cacheVariantName()`), `""` for plain. */
  readonly variant: string;
  readonly entries: readonly CompiledEntry[];
}

/** Reduce a compiled module to the fields the output fingerprint covers. */
export function compiledOutputOf(module: CacheableModule): CompiledOutput {
  const {
    js,
    sourceMap: _sourceMap,
    source: _source,
    identity: _identity,
    filename,
    imports: _imports,
    ...artifact
  } = module;
  const fields = artifact as Record<string, unknown>;
  const keys = Object.keys(fields).filter((key) => fields[key] !== undefined)
    .sort();
  return {
    filename,
    js,
    artifact: keys.length === 0 ? "" : JSON.stringify(
      Object.fromEntries(keys.map((key) => [key, fields[key]])),
    ),
  };
}

/**
 * The output fingerprint of the corpus compiled under each variant: a hash
 * over every variant's every module's emitted body and stored artifact
 * fields, in a fixed order, folded with `epoch`. Same bytes in every mode,
 * same fingerprint, whatever compiled them.
 */
export function outputFingerprintOf(
  variants: readonly CompiledVariant[],
  epoch: number = COMPILE_CACHE_EPOCH,
): string {
  const sorted = [...variants].sort((a, b) =>
    utf8Compare(a.variant, b.variant)
  );
  const digest = hashStringOf({
    v: OUTPUT_TAG,
    epoch,
    variants: sorted.map((variant) => [
      variant.variant,
      [...variant.entries]
        .sort((a, b) => utf8Compare(a.entry, b.entry))
        .map((entry) => [
          entry.entry,
          [...entry.modules]
            .sort((a, b) => utf8Compare(a.filename, b.filename))
            .map((module) => [module.filename, module.js, module.artifact]),
        ]),
    ]),
  });
  return digest.slice(0, FINGERPRINT_LENGTH);
}

/**
 * Compile every corpus entry under `root` in the modes `variant` names, as a
 * runtime in those modes compiles a pattern, and reduce the result to what
 * the output fingerprint covers.
 */
export async function compileCorpus(
  root: string,
  variant: CacheVariantOptions,
  entries: readonly string[] = CORPUS_ENTRIES,
): Promise<CompiledVariant> {
  const signer = await Identity.fromPassphrase("compile-cache version");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://127.0.0.1:0/"),
    storageManager,
    ...(variant.patternCoverage
      ? { patternCoverage: new PatternCoverageCollector() }
      : {}),
    experimental: { instanceNames: variant.instanceNames },
  });
  try {
    const compiled: CompiledEntry[] = [];
    for (const entry of entries) {
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: join(root, entry), root },
      );
      const { modules } = await runtime.harness.compileToRecordGraph(program, {
        fabricImports: { space: signer.did() },
        ...(runtime.patternCoverage === undefined
          ? {}
          : { patternCoverage: runtime.patternCoverage }),
      });
      compiled.push({ entry, modules: modules.map(compiledOutputOf) });
    }
    return { variant: cacheVariantName(variant), entries: compiled };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

/** The corpus under `root` compiled under every persisted cache variant. */
export async function compileCorpusVariants(
  root: string,
  entries: readonly string[] = CORPUS_ENTRIES,
): Promise<CompiledVariant[]> {
  const variants: CompiledVariant[] = [];
  for (const variant of PERSISTED_CACHE_VARIANTS) {
    variants.push(await compileCorpus(root, variant, entries));
  }
  return variants;
}

/** The version and inputs the tree at `repoRoot` mints right now. */
export async function mintCompilerVersion(
  repoRoot: string,
  epoch: number = COMPILE_CACHE_EPOCH,
): Promise<CommittedCompilerVersion> {
  const inputs = await computeCompilerFingerprint(repoRoot);
  const compiled = await compileCorpusVariants(join(repoRoot, CORPUS_DIR));
  return {
    version: versionOfFingerprint(outputFingerprintOf(compiled, epoch)),
    inputs,
  };
}

/** Why a committed record fails the gate, or `undefined` when it holds. */
export function staleness(
  committed: CommittedCompilerVersion,
  minted: CommittedCompilerVersion,
): string | undefined {
  if (committed.inputs !== minted.inputs) {
    return `the compiler inputs changed since the compile-cache version was ` +
      `minted (fingerprint ${minted.inputs}, committed ${committed.inputs})`;
  }
  if (committed.version !== minted.version) {
    return `the compiler emits different bytes for the corpus than the ` +
      `committed compile-cache version names (${minted.version}, committed ` +
      `${committed.version})`;
  }
  return undefined;
}

export async function main(args: readonly string[]): Promise<number> {
  const write = args.includes("--write");
  const minted = await mintCompilerVersion(REPO_ROOT);
  const stale = staleness(COMMITTED_COMPILER_VERSION, minted);
  if (!write) {
    if (stale === undefined) {
      console.log(
        `compile-cache version ${minted.version} holds for inputs ${minted.inputs}.`,
      );
      return 0;
    }
    console.error(
      `check-compile-cache-version: ${stale}.\n` +
        `Run \`deno task compile-cache-version --write\` and commit ${VERSION_MODULE_PATH}.`,
    );
    return 1;
  }
  const modulePath = join(REPO_ROOT, VERSION_MODULE_PATH);
  await Deno.writeTextFile(
    modulePath,
    renderVersionModule(SOURCE_COMPILE_CACHE_RUNTIME_VERSION, minted),
  );
  if (stale === undefined) {
    console.log(`${VERSION_MODULE_PATH} already held ${minted.version}.`);
  } else if (minted.version === COMMITTED_COMPILER_VERSION.version) {
    console.log(
      `${VERSION_MODULE_PATH}: version ${minted.version} kept; the compiler ` +
        `emits the same bytes under inputs ${minted.inputs}.`,
    );
  } else {
    console.log(
      `${VERSION_MODULE_PATH}: version moved to ${minted.version} under ` +
        `inputs ${minted.inputs}; every compiled document recompiles once.`,
    );
  }
  return 0;
}

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) Deno.exit(await main(Deno.args));
// deno-coverage-ignore-stop
