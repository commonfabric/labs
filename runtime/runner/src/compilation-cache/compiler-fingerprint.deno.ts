import { walk } from "@std/fs";
import { fromFileUrl, join, relative } from "@std/path";
import { hashStringOf } from "@commonfabric/data-model";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { SOURCE_COMPILE_CACHE_RUNTIME_VERSION } from "./compile-cache-version.ts";

/**
 * Build-time fingerprint of the inputs that shape the compiler's emitted bytes.
 *
 * The durable compile cache keys compiled documents by
 * `compileCache:<version>/<identity>`, where `<identity>` is a Merkle hash of a
 * module's authored source plus its imports' identities. That identity
 * deliberately does NOT cover the compiler, transformer, schema-generator, or
 * the root compiler options, so the `<version>` axis is the only thing that
 * invalidates the compiled set when any of those change. This module computes
 * that version as a content hash of the compiler inputs, so it moves
 * automatically instead of being bumped by hand.
 *
 * This is the version of a source run, which cannot afford to compile anything
 * at startup. A built artifact names its compiler by what it emits instead:
 * `compile-cache-output-version.deno.ts` hashes the compiler's output for a
 * fixed corpus, and a build bakes that version into the binary or the worker
 * bundle's define, while a source checkout can record it as a memo that its
 * source runs take while the memo matches the tree
 * (`compile-cache-output-memo.deno.ts`), so
 * that a compiler change that compiles the corpus to the same output keeps
 * the compiled documents of every construct the corpus exercises valid across
 * it. A construct the corpus lacks is that version's blind spot; the corpus
 * is wide for that reason, and `COMPILE_CACHE_EPOCH` is the hand-turned move
 * for a change the corpus cannot see.
 *
 * Deno-only: it walks and reads the source tree. Deno source runs reach this
 * module from `getCompileCacheRuntimeVersion()`, through
 * `compile-cache-output-memo.deno.ts`.
 */

/**
 * Repo-relative inputs hashed into the fingerprint: the source that determines
 * the compiler's emitted bytes and cached coverage span metadata, plus the
 * lockfile and root compiler options. Directory inputs are hashed whole, so the
 * version also moves when a test, fixture, or doc under them changes, and the
 * whole-file `deno.lock` moves it on any dependency bump. The result
 * over-invalidates rather than under-invalidates: a redundant recompile, never
 * a stale read.
 *
 * This is the single definition of the input set. CI keys its pattern compile
 * byte caches on the fingerprint itself, which `tasks/compile-cache-key.ts`
 * prints and a workflow step hands to the cache action. The runtime's version
 * axis is `cf/esm-compile/` followed by that same fingerprint, so the two move
 * together rather than describing one list of inputs twice.
 *
 *  - `base/ts-transformers` — the CF transformer pipeline, including the
 *    `SchemaGeneratorTransformer` that bakes schemas into the emitted bytes;
 *  - `base/js-compiler` — the TypeScript-to-JS compiler driver;
 *  - `runtime/runner/src/harness` — runner code that prepares resolved
 *    programs before they reach the compiler;
 *  - `runtime/runner/src/pattern-coverage.ts` — coverage span mapping stored
 *    beside coverage-transformed bytes;
 *  - `runtime/runner/src/sandbox` — module-record assembly and verification
 *    used before cached compiled bodies execute;
 *  - this module — the fingerprint's own source, so that changing how the
 *    fingerprint is computed moves it, and so that a reader of the input set
 *    can see everything the value depends on;
 *  - `base/schema-generator` — schema emission consumed by the pipeline;
 *  - `base/api` — the pattern-facing types (`Default`, `Cell`, ...) the
 *    schema-generator lowers into the baked schemas, so a type change there
 *    changes emitted bytes;
 *  - `base/static/assets/types` — declaration files loaded into the
 *    in-memory TypeScript compiler;
 *  - `deno.jsonc` — the root compiler options (jsx / jsxImportSource);
 *  - `deno.lock` — pins the TypeScript version the compiler runs.
 */
export const COMPILE_FINGERPRINT_INPUTS: readonly string[] = [
  "base/ts-transformers",
  "base/js-compiler",
  "runtime/runner/src/harness",
  "runtime/runner/src/pattern-coverage.ts",
  "runtime/runner/src/sandbox",
  "runtime/runner/src/compilation-cache/compiler-fingerprint.deno.ts",
  "base/schema-generator",
  "base/api",
  "base/static/assets/types",
  "deno.jsonc",
  "deno.lock",
];

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

/** What a build names its compiler by: what it emits for the corpus, or its inputs. */
export type CompileCacheVersionSource = "output" | "inputs";

/**
 * The version source `CF_COMPILE_CACHE_VERSION` names, given its value:
 * `output` for the corpus output a shipped build earns, `inputs` for the
 * compiler-input fingerprint a test fixture keeps, and `fallback` when it is
 * unset. The binary build and the shell bundle both read the variable through
 * here, so one spelling means one thing to both, and any other spelling is
 * refused rather than read as either.
 */
export function compileCacheVersionSourceOf(
  value: string | undefined,
  fallback: CompileCacheVersionSource,
): CompileCacheVersionSource {
  if (value === undefined) return fallback;
  if (value === "output" || value === "inputs") return value;
  throw new Error(
    `CF_COMPILE_CACHE_VERSION is ${
      JSON.stringify(value)
    }; it takes "output" or "inputs".`,
  );
}

/** The full `cf/esm-compile/<fingerprint>` version string for `repoRoot`. */
export async function computeCompilerVersion(
  repoRoot: string,
  inputs: readonly string[] = COMPILE_FINGERPRINT_INPUTS,
): Promise<string> {
  const fingerprint = await computeCompilerFingerprint(repoRoot, inputs);
  return versionOfFingerprint(fingerprint);
}

/** The compiler-input version for the repository containing this module. */
export async function computeCurrentCompilerVersion(): Promise<string> {
  const repoRoot = fromFileUrl(new URL("../../../../", import.meta.url));
  return await computeCompilerVersion(repoRoot);
}

/**
 * Render the full text of `compile-cache-version.ts` for a given active
 * version. The checked-in source marker and the binary build output use this
 * format. Output is `deno fmt`-clean so the committed file and the rendering
 * stay byte-identical.
 */
export function renderVersionModule(version: string): string {
  const activeVersionDeclaration =
    version === SOURCE_COMPILE_CACHE_RUNTIME_VERSION
      ? `export const COMPILE_CACHE_RUNTIME_VERSION =
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION;`
      : `export const COMPILE_CACHE_RUNTIME_VERSION = ${
        JSON.stringify(version)
      };`;
  return `// Version axis of the durable compile cache: the \`<version>\` segment of
// \`compileCache:<version>/<identity>\` keys. The checked-in value is a stable
// source marker. Deno source runs resolve it to the current compiler-input
// fingerprint at runtime. Runtimes without repository file access skip the
// compiled cache until a binary build writes the computed fingerprint here.
export const SOURCE_COMPILE_CACHE_RUNTIME_VERSION = ${
    JSON.stringify(SOURCE_COMPILE_CACHE_RUNTIME_VERSION)
  };
${activeVersionDeclaration}
`;
}

function relPosix(root: string, abs: string): string {
  return relative(root, abs).replaceAll("\\", "/");
}

async function readNormalized(path: string): Promise<string> {
  const text = await Deno.readTextFile(path);
  return text.replace(/\r\n/g, "\n");
}
