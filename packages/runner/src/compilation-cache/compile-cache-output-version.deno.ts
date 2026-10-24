import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { hashStringOf } from "@commonfabric/data-model";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { resolveLocalProgram } from "../harness/local-program.deno.ts";
import type { CacheableModule } from "../harness/types.ts";
import { PatternCoverageCollector } from "../pattern-coverage.ts";
import { Runtime } from "../runtime.ts";
import { StorageManager } from "../storage/cache.deno.ts";
import {
  cacheVariantName,
  type CacheVariantOptions,
  PERSISTED_CACHE_VARIANTS,
} from "./cache-variants.ts";
import {
  FINGERPRINT_LENGTH,
  versionOfFingerprint,
} from "./compiler-fingerprint.deno.ts";

/**
 * The compile-cache version of a built artifact: a hash of what the compiler
 * emits for a fixed corpus of patterns, under every persisted cache variant.
 *
 * The durable compile cache keys every compiled pattern by the compiler's
 * version (`compileCache:<version>/<identity>`), and a version move
 * recompiles every pattern in every space on every machine the next time it
 * loads. A version named by the compiler's output rather than its source
 * moves only when that output does: a change to the compiler that compiles
 * the corpus to the same documents, body, stored fields and import edges
 * alike, keeps the compiled documents of every construct the corpus
 * exercises valid across it, in every space. A construct
 * the corpus lacks is the version's blind spot, which is what the corpus's
 * breadth and {@link COMPILE_CACHE_EPOCH} are for. A build computes this
 * version for the tree it builds from and bakes it
 * into the artifact (`tasks/build-binaries.ts` into a binary,
 * `packages/shell/felt.config.ts` into the worker bundle's define, loom into
 * its vendored `compile-cache-version.ts`), so the version always names the
 * compiler actually running. Source runs keep the compiler-input fingerprint
 * (`compiler-fingerprint.deno.ts`), which costs nothing to compute and needs
 * no corpus.
 *
 * Deno-only: it compiles the corpus through the runtime harness, which takes
 * about two minutes.
 */

/**
 * The corpus: a frozen copy of pattern sources, repository-relative. The
 * version names what the compiler emits for these, so what is here
 * decides which compiler changes the cache survives. A construct the corpus
 * lacks is one the version cannot see a change to; the corpus is wide for
 * that reason, and an edit to it, including refreshing a file from
 * `packages/patterns`, moves the version of the next build.
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

/**
 * A number folded into the version beside the corpus output.
 *
 * The version moves on its own when the corpus's compiled output moves. Bump
 * this for a change the corpus cannot see but stored compiled documents cannot
 * survive: a contract between emitted code and the runtime modules it calls
 * into, say, changed on both sides at once so that the corpus still compiles
 * to the same output while documents compiled earlier no longer run. The bump
 * moves
 * the version of every later build, and every compiled document recompiles
 * once.
 */
export const COMPILE_CACHE_EPOCH = 1;

const OUTPUT_TAG = "cf/compile-output-fingerprint/v1";

/** What the output fingerprint covers of one compiled module. */
export interface CompiledOutput {
  /** The module's corpus-relative name. */
  readonly filename: string;

  /** The emitted JavaScript body. */
  readonly js: string;

  /**
   * The module's internal import edges, specifier to the imported module's
   * identity, in specifier order. The compiled document stores them and the
   * loader follows them to the dependency documents, so an edge the compiler
   * emits differently is a difference the version has to see.
   */
  readonly imports: readonly (readonly [specifier: string, identity: string])[];

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

/**
 * Reduce a compiled module to the fields the output fingerprint covers: what
 * its compiled document stores, less the source map. The identity is the
 * document's key, which the cache's identity axis names rather than its
 * version, and the source is the source set's document, so neither is here.
 */
export function compiledOutputOf(module: CacheableModule): CompiledOutput {
  const {
    js,
    sourceMap: _sourceMap,
    source: _source,
    identity: _identity,
    filename,
    imports,
    ...artifact
  } = module;
  const fields = artifact as Record<string, unknown>;
  const keys = Object.keys(fields).filter((key) => fields[key] !== undefined)
    .sort();
  return {
    filename,
    js,
    imports: imports
      .map((edge) => [edge.specifier, edge.targetIdentity] as const)
      .sort((a, b) => utf8Compare(a[0], b[0]) || utf8Compare(a[1], b[1])),
    artifact: keys.length === 0 ? "" : JSON.stringify(
      Object.fromEntries(keys.map((key) => [key, fields[key]])),
    ),
  };
}

/**
 * The output fingerprint of the corpus compiled under each variant: a hash
 * over every variant's every module's emitted body, import edges and stored
 * artifact fields, in a fixed order, folded with `epoch`. It covers the whole
 * stored output rather than the body alone, since a document whose edges or
 * stored fields changed is read differently whatever its body. The same
 * output in every mode, the same fingerprint, whatever compiled it.
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
            .map((module) => [
              module.filename,
              module.js,
              module.imports,
              module.artifact,
            ]),
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

/**
 * The compile-cache version the compiler in the repository at `repoRoot`
 * earns: `cf/esm-compile/` followed by the output fingerprint of its corpus.
 */
export async function computeCompilerOutputVersion(
  repoRoot: string,
  epoch: number = COMPILE_CACHE_EPOCH,
): Promise<string> {
  const compiled = await compileCorpusVariants(join(repoRoot, CORPUS_DIR));
  return versionOfFingerprint(outputFingerprintOf(compiled, epoch));
}
