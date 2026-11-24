/**
 * The output-based compile-cache version a source checkout records for
 * itself, and the version a Deno source run of that checkout resolves.
 *
 * A built artifact has the output-based version baked into it when it is
 * built (`compile-cache-output-version.deno.ts`), because the artifact is
 * frozen from then on. A source checkout is not frozen: checkouts and edits
 * move it, so a version written into one of its tracked files could outlive
 * the compiler it names. A source checkout keeps a memo instead, in a file
 * git ignores: the output version, beside a key that fingerprints everything
 * the version depends on, which is the compiler inputs
 * (`COMPILE_FINGERPRINT_INPUTS`) and what computing the output version adds
 * to them (`OUTPUT_VERSION_INPUTS`).
 *
 * A source run fingerprints the compiler inputs in any case. When the tree
 * records a memo, it fingerprints the rest as well, and takes the memo's
 * version only while the key still matches the tree; otherwise it takes the
 * compiler-input version. A memo the tree has moved away from is never read.
 * So a checkout that runs as it stands, as loom's vendored copy of this
 * repository does, keeps the compiled documents of every construct the corpus
 * exercises across a compiler change that compiles the corpus to the same
 * output, and falls back to the compiler-input version as soon as anything
 * the memo depends on changes. With a memo, such a checkout takes on the
 * output version's blind spot too: a compiler change confined to a construct
 * the corpus does not exercise leaves the version where it was, which the
 * corpus's breadth and `COMPILE_CACHE_EPOCH` answer, as they do for a built
 * artifact.
 *
 * `deno task compile-cache-version --memo` records the memo. Reading it
 * compiles nothing, so the runtime reaches this module from
 * `getCompileCacheRuntimeVersion()`. Deno-only: it walks and reads the tree.
 */

import { fromFileUrl, join } from "@std/path";
import { hashStringOf } from "@commonfabric/data-model";
import {
  COMPILE_FINGERPRINT_INPUTS,
  computeCompilerFingerprint,
  FINGERPRINT_LENGTH,
  VERSION_NAMESPACE,
  versionOfFingerprint,
} from "./compiler-fingerprint.deno.ts";

/**
 * The corpus the output version compiles: a frozen copy of pattern sources,
 * repository-relative, whose entries `compile-cache-output-version.deno.ts`
 * names. The version names the bytes the compiler emits for these, so what is
 * here decides which compiler changes the cache survives. A construct the
 * corpus lacks is one the version cannot see a change to; the corpus is wide
 * for that reason, and an edit to it, including refreshing a file from
 * `patterns`, moves the version of the next build. The memo's key
 * covers it, which is why the path is defined here.
 */
export const CORPUS_DIR = "runtime/runner/test/fixtures/compile-cache-corpus";

/** Where a source checkout records its memo, repository-relative. */
export const OUTPUT_VERSION_MEMO_PATH =
  "runtime/runner/src/compilation-cache/.compile-cache-output-version.json";

/**
 * What the output version depends on beyond the compiler inputs: the module
 * that compiles and hashes the corpus, and with it the corpus's entry list and
 * `COMPILE_CACHE_EPOCH`; the persisted cache variants it compiles under; this
 * module, so that a change to how the key is computed retires every memo; and
 * the corpus itself.
 */
export const OUTPUT_VERSION_INPUTS: readonly string[] = [
  "runtime/runner/src/compilation-cache/compile-cache-output-version.deno.ts",
  "runtime/runner/src/compilation-cache/cache-variants.ts",
  "runtime/runner/src/compilation-cache/compile-cache-output-memo.deno.ts",
  CORPUS_DIR,
];

const MEMO_TAG = "cf/compile-output-memo/v1";

/** A version as `versionOfFingerprint()` renders one, the source marker excluded. */
const VERSION_SHAPE = new RegExp(
  `^${VERSION_NAMESPACE}/[A-Za-z0-9_-]{${FINGERPRINT_LENGTH}}$`,
);

/** The output version a tree recorded, and the tree it was recorded for. */
export interface OutputVersionMemo {
  /** The fingerprint of the tree the version was computed for. */
  readonly key: string;

  /** The output-based version that tree's compiler earned. */
  readonly version: string;
}

/**
 * The input lists a memo's key covers. Every caller but a test takes the
 * defaults, `COMPILE_FINGERPRINT_INPUTS` and `OUTPUT_VERSION_INPUTS`.
 */
export interface MemoInputs {
  readonly compilerInputs?: readonly string[];
  readonly outputInputs?: readonly string[];
}

/** What `memoizeOutputVersion()` did. */
export interface MemoizedOutputVersion {
  readonly version: string;

  /** False when the tree already recorded a memo for itself. */
  readonly recorded: boolean;
}

function memoKeyOf(
  compilerFingerprint: string,
  outputFingerprint: string,
): string {
  return hashStringOf({
    v: MEMO_TAG,
    compiler: compilerFingerprint,
    output: outputFingerprint,
  }).slice(0, FINGERPRINT_LENGTH);
}

/** The key a memo for the tree at `repoRoot`, as it stands now, carries. */
export async function computeOutputVersionMemoKey(
  repoRoot: string,
  inputs: MemoInputs = {},
): Promise<string> {
  return memoKeyOf(
    await computeCompilerFingerprint(
      repoRoot,
      inputs.compilerInputs ?? COMPILE_FINGERPRINT_INPUTS,
    ),
    await computeCompilerFingerprint(
      repoRoot,
      inputs.outputInputs ?? OUTPUT_VERSION_INPUTS,
    ),
  );
}

/**
 * The memo the tree at `repoRoot` records, or `undefined` when it records
 * none, the file cannot be read, or it does not hold a well-formed memo. A
 * memo is an optimization over the compiler-input version, so any of these
 * leaves a source run on that version rather than failing it.
 */
export async function readOutputVersionMemo(
  repoRoot: string,
): Promise<OutputVersionMemo | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(repoRoot, OUTPUT_VERSION_MEMO_PATH));
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { key, version } = parsed as Record<string, unknown>;
  return typeof key === "string" && key.length > 0 &&
      typeof version === "string" && VERSION_SHAPE.test(version)
    ? { key, version }
    : undefined;
}

/**
 * Record `memo` for the tree at `repoRoot`. The file is replaced by a rename,
 * so a source run reading it concurrently sees the old memo or the new one.
 */
export async function writeOutputVersionMemo(
  repoRoot: string,
  memo: OutputVersionMemo,
): Promise<void> {
  if (!VERSION_SHAPE.test(memo.version)) {
    throw new Error(
      `${OUTPUT_VERSION_MEMO_PATH}: ${
        JSON.stringify(memo.version)
      } is not a compile-cache version.`,
    );
  }
  const path = join(repoRoot, OUTPUT_VERSION_MEMO_PATH);
  const staged = `${path}.tmp-${Deno.pid}`;
  await Deno.writeTextFile(
    staged,
    `${JSON.stringify({ key: memo.key, version: memo.version }, null, 2)}\n`,
  );
  await Deno.rename(staged, path);
}

/**
 * Record the output version of the tree at `repoRoot` as its memo, computed
 * by `computeVersion`, unless the tree already records a memo for itself, in
 * which case nothing is computed. The key is taken before and after the
 * computation, and a tree that changed in between records nothing, because
 * the version would describe neither state.
 */
export async function memoizeOutputVersion(
  repoRoot: string,
  computeVersion: (repoRoot: string) => Promise<string>,
  inputs: MemoInputs = {},
): Promise<MemoizedOutputVersion> {
  const key = await computeOutputVersionMemoKey(repoRoot, inputs);
  const existing = await readOutputVersionMemo(repoRoot);
  if (existing?.key === key) {
    return { version: existing.version, recorded: false };
  }
  const version = await computeVersion(repoRoot);
  if (await computeOutputVersionMemoKey(repoRoot, inputs) !== key) {
    throw new Error(
      `${OUTPUT_VERSION_MEMO_PATH}: the tree changed while its output version ` +
        `was computed, so nothing was recorded.`,
    );
  }
  await writeOutputVersionMemo(repoRoot, { key, version });
  return { version, recorded: true };
}

/**
 * The compile-cache version a Deno source run of the tree at `repoRoot`
 * resolves: the output version its memo records while the memo's key matches
 * the tree, and the compiler-input version otherwise. A failure to
 * fingerprint the compiler inputs propagates, as it does when no memo is
 * involved; a memo whose key cannot be checked is not used.
 */
export async function computeSourceCompileCacheVersion(
  repoRoot: string,
  inputs: MemoInputs = {},
): Promise<string> {
  const compilerFingerprint = await computeCompilerFingerprint(
    repoRoot,
    inputs.compilerInputs ?? COMPILE_FINGERPRINT_INPUTS,
  );
  const inputVersion = versionOfFingerprint(compilerFingerprint);
  const memo = await readOutputVersionMemo(repoRoot);
  if (memo === undefined) return inputVersion;
  let outputFingerprint: string;
  try {
    outputFingerprint = await computeCompilerFingerprint(
      repoRoot,
      inputs.outputInputs ?? OUTPUT_VERSION_INPUTS,
    );
  } catch {
    return inputVersion;
  }
  return memo.key === memoKeyOf(compilerFingerprint, outputFingerprint)
    ? memo.version
    : inputVersion;
}

/** The source-run version for the repository containing this module. */
export async function computeCurrentSourceCompileCacheVersion(): Promise<
  string
> {
  return await computeSourceCompileCacheVersion(
    fromFileUrl(new URL("../../../../", import.meta.url)),
  );
}
