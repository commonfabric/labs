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
 * Deno-only: it walks and reads the source tree. Deno source runs call this
 * module through `getCompileCacheRuntimeVersion()`. Binary builds use it to
 * write a fingerprint literal before `deno compile`.
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
 * Render {@link COMPILE_FINGERPRINT_INPUTS} as path globs. A directory input
 * becomes a `<dir>/**` tree; a file input, which is one with a `.` in its last
 * path segment, is passed through. `tasks/compile-cache-state.ts` matches a
 * run's changed files against these to decide whether its compile cache went
 * cold, which is the same question the fingerprint answers by hashing them.
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
const FINGERPRINT_LENGTH = 16;

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

/** The full `cf/esm-compile/<fingerprint>` version string for `repoRoot`. */
export async function computeCompilerVersion(
  repoRoot: string,
  inputs: readonly string[] = COMPILE_FINGERPRINT_INPUTS,
): Promise<string> {
  const fingerprint = await computeCompilerFingerprint(repoRoot, inputs);
  return `${VERSION_NAMESPACE}/${fingerprint}`;
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
