import { walk } from "@std/fs";
import { fromFileUrl, join, relative } from "@std/path";
import { hashStringOf } from "@commonfabric/data-model";
import { utf8Compare } from "@commonfabric/utils/utf8";
import {
  COMMITTED_COMPILE_CACHE_VERSION,
  COMMITTED_COMPILE_CACHE_VERSION_INPUTS,
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
} from "./compile-cache-version.ts";

/**
 * The compile-cache version a source checkout resolves to, and the
 * compiler-input fingerprint that decides whether the committed one applies.
 *
 * The durable compile cache keys compiled documents by
 * `compileCache:<version>/<identity>`, where `<identity>` is a Merkle hash of a
 * module's authored source plus its imports' identities. That identity
 * deliberately does NOT cover the compiler, transformer, schema-generator, or
 * the root compiler options, so the `<version>` axis is the only thing that
 * invalidates the compiled set when any of those change.
 *
 * The version is a hash of what the compiler EMITS, not of its source: the
 * output of a fixed corpus of patterns under every persisted cache variant
 * (`cache-variants.ts`), minted into `compile-cache-version.ts` by
 * `deno task compile-cache-version` and held there by the
 * `check-compile-cache-version` gate. A change to the compiler that emits the
 * same bytes for the corpus in every mode keeps the version, and every
 * compiled document in every space stays valid across it; a change that moves
 * any emitted byte in any mode moves the version and invalidates them all.
 *
 * The compiler-input fingerprint, a content hash over
 * {@link COMPILE_FINGERPRINT_INPUTS}, is what makes the committed version safe
 * to trust: the committed module records the fingerprint the version was
 * minted against, and a checkout whose inputs hash differently is running a
 * compiler nobody has measured, so it falls back to a version of its own,
 * `cf/esm-compile/<input fingerprint>`, which no committed compiler shares.
 * That is the state of a working tree with an unminted compiler edit, and of
 * a pull request that touched the inputs before `--write` was run.
 *
 * Deno-only: it walks and reads the source tree. Deno source runs call this
 * module through `getCompileCacheRuntimeVersion()`. Binary builds use it to
 * write the resolved version literal before `deno compile`, and the shell's
 * bundle build defines it into the worker.
 */

/**
 * Repo-relative inputs hashed into the compiler-input fingerprint: the source
 * that determines the compiler's emitted bytes and cached coverage span
 * metadata, plus the lockfile and root compiler options. Directory inputs are
 * hashed whole, so the fingerprint also moves when a test, fixture, or doc
 * under them changes, and the whole-file `deno.lock` moves it on any dependency
 * bump. The fingerprint over-invalidates rather than under-invalidates: a
 * compiler nobody has measured is never mistaken for one somebody has.
 *
 * This is the single definition of the input set. CI keys its pattern compile
 * byte caches on the fingerprint itself, which `tasks/compile-cache-key.ts`
 * prints and a workflow step hands to the cache action, and the committed
 * compile-cache version records the fingerprint it was minted against.
 *
 *  - `packages/ts-transformers` — the CF transformer pipeline, including the
 *    `SchemaGeneratorTransformer` that bakes schemas into the emitted bytes;
 *  - `packages/js-compiler` — the TypeScript-to-JS compiler driver;
 *  - `packages/runner/src/harness` — runner code that prepares resolved
 *    programs before they reach the compiler;
 *  - `packages/runner/src/pattern-coverage.ts` — coverage span mapping stored
 *    beside coverage-transformed bytes;
 *  - `packages/runner/src/sandbox` — module-record assembly and verification
 *    used before cached compiled bodies execute;
 *  - this module — the fingerprint's own source, so that changing how the
 *    fingerprint is computed moves it, and so that a reader of the input set
 *    can see everything the value depends on;
 *  - `packages/schema-generator` — schema emission consumed by the pipeline;
 *  - `packages/api` — the pattern-facing types (`Default`, `Cell`, ...) the
 *    schema-generator lowers into the baked schemas, so a type change there
 *    changes emitted bytes;
 *  - `packages/static/assets/types` — declaration files loaded into the
 *    in-memory TypeScript compiler;
 *  - `deno.jsonc` — the root compiler options (jsx / jsxImportSource);
 *  - `deno.lock` — pins the TypeScript version the compiler runs.
 */
export const COMPILE_FINGERPRINT_INPUTS: readonly string[] = [
  "packages/ts-transformers",
  "packages/js-compiler",
  "packages/runner/src/harness",
  "packages/runner/src/pattern-coverage.ts",
  "packages/runner/src/sandbox",
  "packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts",
  "packages/schema-generator",
  "packages/api",
  "packages/static/assets/types",
  "deno.jsonc",
  "deno.lock",
];

/**
 * A number folded into the compile-cache version beside the corpus output.
 *
 * The version moves on its own when the corpus's emitted bytes move. Bump this
 * for a change the corpus cannot see but stored compiled documents cannot
 * survive: a contract between emitted code and the runtime modules it calls
 * into, say, changed on both sides at once so that the corpus still compiles
 * to the same bytes while bytes compiled earlier no longer run. The bump moves
 * the version everywhere, and every compiled document recompiles once.
 */
export const COMPILE_CACHE_EPOCH = 1;

/**
 * Render {@link COMPILE_FINGERPRINT_INPUTS} as path globs. A directory input
 * becomes a `<dir>/**` tree; a file input, which is one with a `.` in its last
 * path segment, is passed through. `tasks/build-binaries.test.ts` builds its
 * fixture tree from these, a file under every input, so that an input added
 * to the list reaches the fixture without an edit there.
 */
export function compileFingerprintGlobs(
  inputs: readonly string[] = COMPILE_FINGERPRINT_INPUTS,
): string[] {
  return inputs.map((input) => {
    const base = input.slice(input.lastIndexOf("/") + 1);
    return base.includes(".") ? input : `${input}/**`;
  });
}

/** Cache-key namespace prefix kept ahead of the fingerprint, for legibility. */
export const VERSION_NAMESPACE = "cf/esm-compile";

const FINGERPRINT_TAG = "cf/compile-fingerprint/v1";

/** Length of the base64url fingerprint kept in the key (96 bits). */
export const FINGERPRINT_LENGTH = 16;

interface FingerprintFile {
  /** Path relative to the repo root, with forward slashes. */
  readonly path: string;

  /** File contents with line endings normalized to `\n`. */
  readonly content: string;
}

/**
 * Compute the compiler-input fingerprint: a stable hash over every file under
 * {@link COMPILE_FINGERPRINT_INPUTS}, resolved against `repoRoot`. Directory
 * inputs are walked recursively; file inputs are hashed directly. Files are
 * sorted by their repo-relative path and line endings normalized, so the value
 * is independent of walk order and CRLF/LF differences. A missing input throws.
 */
export async function computeCompilerFingerprint(
  repoRoot: string,
  inputs: readonly string[] = COMPILE_FINGERPRINT_INPUTS,
): Promise<string> {
  const files: FingerprintFile[] = [];
  for (const input of inputs) {
    const abs = join(repoRoot, input);
    const info = await Deno.stat(abs);
    if (info.isDirectory) {
      for await (
        const entry of walk(abs, {
          includeDirs: false,
          includeFiles: true,
          followSymlinks: false,
          skip: [/(^|[\\/])\.DS_Store$/],
        })
      ) {
        files.push({
          path: relPosix(repoRoot, entry.path),
          content: await readNormalized(entry.path),
        });
      }
    } else {
      files.push({
        path: relPosix(repoRoot, abs),
        content: await readNormalized(abs),
      });
    }
  }

  files.sort((a, b) => utf8Compare(a.path, b.path));
  const digest = hashStringOf({
    v: FINGERPRINT_TAG,
    files: files.map((file) => [file.path, file.content]),
  });
  return digest.slice(0, FINGERPRINT_LENGTH);
}

/** The `cf/esm-compile/<fingerprint>` version string for a fingerprint. */
export function versionOfFingerprint(fingerprint: string): string {
  return `${VERSION_NAMESPACE}/${fingerprint}`;
}

/**
 * The compiler-input version for `repoRoot`: `cf/esm-compile/` followed by its
 * compiler-input fingerprint. It is the version a checkout whose compiler
 * nobody has measured runs under (see {@link resolveCompilerVersion}), and
 * the key CI names its compile byte caches by.
 */
export async function computeCompilerVersion(
  repoRoot: string,
  inputs: readonly string[] = COMPILE_FINGERPRINT_INPUTS,
): Promise<string> {
  const fingerprint = await computeCompilerFingerprint(repoRoot, inputs);
  return versionOfFingerprint(fingerprint);
}

/** The committed compile-cache version and the inputs it was minted against. */
export interface CommittedCompilerVersion {
  /** The output-based version, `cf/esm-compile/<output fingerprint>`. */
  readonly version: string;

  /** The compiler-input fingerprint of the tree the version was minted on. */
  readonly inputs: string;
}

/** What `compile-cache-version.ts` commits. */
export const COMMITTED_COMPILER_VERSION: CommittedCompilerVersion = {
  version: COMMITTED_COMPILE_CACHE_VERSION,
  inputs: COMMITTED_COMPILE_CACHE_VERSION_INPUTS,
};

/**
 * The compile-cache version the compiler at `repoRoot` runs under: the
 * committed output-based version when the tree's compiler-input fingerprint
 * is the one that version was minted against, and otherwise the tree's own
 * compiler-input version, which no committed compiler shares.
 */
export async function resolveCompilerVersion(
  repoRoot: string,
  committed: CommittedCompilerVersion = COMMITTED_COMPILER_VERSION,
  inputs: readonly string[] = COMPILE_FINGERPRINT_INPUTS,
): Promise<string> {
  const fingerprint = await computeCompilerFingerprint(repoRoot, inputs);
  return fingerprint === committed.inputs
    ? committed.version
    : versionOfFingerprint(fingerprint);
}

/** The compile-cache version for the repository containing this module. */
export async function computeCurrentCompilerVersion(): Promise<string> {
  const repoRoot = fromFileUrl(new URL("../../../../", import.meta.url));
  return await resolveCompilerVersion(repoRoot);
}

/**
 * Render the full text of `compile-cache-version.ts` for a given active
 * version and committed record. The checked-in module, which `deno task
 * compile-cache-version` writes, carries the source marker as its active
 * version; a binary build writes the resolved version in its place. Output is
 * `deno fmt`-clean so the committed file and the rendering stay
 * byte-identical.
 */
export function renderVersionModule(
  version: string,
  committed: CommittedCompilerVersion = COMMITTED_COMPILER_VERSION,
): string {
  const activeVersionDeclaration =
    version === SOURCE_COMPILE_CACHE_RUNTIME_VERSION
      ? `export const COMPILE_CACHE_RUNTIME_VERSION =
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION;`
      : `export const COMPILE_CACHE_RUNTIME_VERSION = ${
        JSON.stringify(version)
      };`;
  return `// Version axis of the durable compile cache: the \`<version>\` segment of
// \`compileCache:<version>/<identity>\` keys. The checked-in active value is a
// stable source marker. Deno source runs resolve it to the committed version
// below, or to the current compiler-input fingerprint when the tree's compiler
// is not the one that version was minted against. Runtimes without repository
// file access skip the compiled cache until a binary build writes the resolved
// version here.
//
// The committed version and the inputs it was minted against are written by
// \`deno task compile-cache-version\` and held by \`check-compile-cache-version\`.
export const SOURCE_COMPILE_CACHE_RUNTIME_VERSION = ${
    JSON.stringify(SOURCE_COMPILE_CACHE_RUNTIME_VERSION)
  };
${activeVersionDeclaration}
export const COMMITTED_COMPILE_CACHE_VERSION =
  ${JSON.stringify(committed.version)};
export const COMMITTED_COMPILE_CACHE_VERSION_INPUTS = ${
    JSON.stringify(committed.inputs)
  };
`;
}

function relPosix(root: string, abs: string): string {
  return relative(root, abs).replaceAll("\\", "/");
}

async function readNormalized(path: string): Promise<string> {
  const text = await Deno.readTextFile(path);
  return text.replace(/\r\n/g, "\n");
}
