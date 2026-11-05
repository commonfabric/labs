import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path/join";
import { Builder } from "./builder.ts";
import { Config, ResolvedConfig } from "./interface.ts";

// Unique markers so we can tell, from a bundle's bytes alone, whether a
// dynamically-imported module was inlined into its entry or peeled into a
// separate chunk.
const PLAIN_MARKER = "PLAIN_LAZY_MARKER_9c1e";
const SPLIT_MARKER = "SPLIT_LAZY_MARKER_7f3a";

/**
 * Write a hermetic fixture project: a plain entry and a split entry, each with
 * a single dynamic import of its own "lazy" module. Returns the project root.
 */
async function writeFixture(root: string): Promise<void> {
  const write = (name: string, body: string) =>
    Deno.writeTextFile(join(root, name), body);

  await write(
    "plain-lazy.ts",
    `export const marker = ${JSON.stringify(PLAIN_MARKER)};\n`,
  );
  await write(
    "split-lazy.ts",
    `export const marker = ${JSON.stringify(SPLIT_MARKER)};\n`,
  );
  // Exported + assigned to a global so neither the dynamic import nor its
  // module is tree-shaken away.
  await write(
    "plain-entry.ts",
    `export async function load() {\n` +
      `  const mod = await import("./plain-lazy.ts");\n` +
      `  return mod.marker;\n` +
      `}\n` +
      `(globalThis as Record<string, unknown>).__loadPlain = load;\n`,
  );
  await write(
    "split-entry.ts",
    `export async function load() {\n` +
      `  const mod = await import("./split-lazy.ts");\n` +
      `  return mod.marker;\n` +
      `}\n` +
      `(globalThis as Record<string, unknown>).__loadSplit = load;\n`,
  );
}

async function listChunks(scriptsDir: string): Promise<string[]> {
  const chunks: string[] = [];
  for await (const entry of Deno.readDir(scriptsDir)) {
    if (entry.isFile && /^chunk-.*\.js$/.test(entry.name)) {
      chunks.push(entry.name);
    }
  }
  return chunks.sort();
}

function fixtureConfig(metafile?: string): Config {
  return {
    entries: [
      { in: "plain-entry.ts", out: "scripts/plain" },
      { in: "split-entry.ts", out: "scripts/split", splitting: true },
    ],
    outDir: "dist",
    esbuild: {
      chunkNames: "scripts/chunk-[hash]",
      metafile,
      tsconfigRaw: {},
    },
  };
}

Deno.test("Builder: a split entry peels its dynamic import into a co-located chunk; a plain entry inlines it", async () => {
  const root = await Deno.makeTempDir({ prefix: "felt-split-test-" });
  try {
    await writeFixture(root);
    await new Builder(new ResolvedConfig(fixtureConfig(), root)).build();

    const scriptsDir = join(root, "dist", "scripts");
    const plainJs = await Deno.readTextFile(join(scriptsDir, "plain.js"));
    const splitJs = await Deno.readTextFile(join(scriptsDir, "split.js"));
    const chunks = await listChunks(scriptsDir);

    // The split pass emits exactly one chunk (the lazy module); the plain pass
    // emits none — proving `splitting` is scoped per entry, not the whole build.
    assertEquals(
      chunks.length,
      1,
      `expected exactly one chunk, got: ${chunks.join(", ")}`,
    );
    const chunkJs = await Deno.readTextFile(join(scriptsDir, chunks[0]!));

    // Split entry: the lazy module's bytes moved out of the entry and into the
    // chunk, and the entry reaches it through a dynamic import.
    assert(
      !splitJs.includes(SPLIT_MARKER),
      "split entry must not inline its dynamically-imported module",
    );
    assert(
      chunkJs.includes(SPLIT_MARKER),
      "the emitted chunk must hold the split entry's lazy module",
    );
    assert(
      /import\(\s*"\.\/chunk-[A-Za-z0-9]+\.js"\s*\)/.test(splitJs),
      "split entry must dynamically import its chunk",
    );

    // Plain entry: unsplit, so its lazy module is inlined and nothing leaks
    // into the chunk.
    assert(
      plainJs.includes(PLAIN_MARKER),
      "plain entry must inline its dynamically-imported module",
    );
    assert(
      !chunkJs.includes(PLAIN_MARKER),
      "the plain entry's module must not appear in the split pass's chunk",
    );

    // The manifest still hashes entries only; the chunk is content-addressed by
    // its own name and needs no manifest entry.
    const manifest = JSON.parse(
      await Deno.readTextFile(join(root, "dist", "build-manifest.json")),
    );
    assertEquals(
      Object.keys(manifest).sort(),
      ["scripts/plain.js", "scripts/split.js"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Builder: metafiles from plain and split passes are merged", async () => {
  const root = await Deno.makeTempDir({ prefix: "felt-metafile-test-" });
  try {
    await writeFixture(root);
    await new Builder(
      new ResolvedConfig(fixtureConfig("meta.json"), root),
    ).build();

    const metafile = JSON.parse(
      await Deno.readTextFile(join(root, "meta.json")),
    ) as { outputs: Record<string, { entryPoint?: string }> };
    const entryPoints = Object.values(metafile.outputs)
      .flatMap((output) => output.entryPoint ? [output.entryPoint] : []);

    assert(
      entryPoints.some((entry) => entry.endsWith("plain-entry.ts")),
      "combined metafile must include the plain-pass entry",
    );
    assert(
      entryPoints.some((entry) => entry.endsWith("split-entry.ts")),
      "combined metafile must include the split-pass entry",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Builder: repeated builds retain one prior split generation and prune older chunks", async () => {
  const root = await Deno.makeTempDir({ prefix: "felt-split-prune-test-" });
  try {
    await writeFixture(root);
    const builder = new Builder(new ResolvedConfig(fixtureConfig(), root));
    await builder.build();

    const scriptsDir = join(root, "dist", "scripts");
    const firstChunks = await listChunks(scriptsDir);
    assertEquals(firstChunks.length, 1);

    const rebuiltMarker = `${SPLIT_MARKER}_REBUILT`;
    await Deno.writeTextFile(
      join(root, "split-lazy.ts"),
      `export const marker = ${JSON.stringify(rebuiltMarker)};\n`,
    );
    await builder.build();

    const rebuiltChunks = await listChunks(scriptsDir);
    assertEquals(rebuiltChunks.length, 2);
    assert(
      rebuiltChunks.includes(firstChunks[0]!),
      "the immediately previous chunk generation must remain available",
    );
    const rebuiltChunk = rebuiltChunks.find((chunk) =>
      chunk !== firstChunks[0]
    )!;
    assert(
      rebuiltChunk !== firstChunks[0],
      "changed split content must produce a new content-hashed chunk",
    );
    assert(
      (await Deno.readTextFile(join(scriptsDir, rebuiltChunk))).includes(
        rebuiltMarker,
      ),
      "the current chunk must contain the rebuilt split module",
    );

    const twiceRebuiltMarker = `${SPLIT_MARKER}_TWICE_REBUILT`;
    await Deno.writeTextFile(
      join(root, "split-lazy.ts"),
      `export const marker = ${JSON.stringify(twiceRebuiltMarker)};\n`,
    );
    await builder.build();

    const twiceRebuiltChunks = await listChunks(scriptsDir);
    assertEquals(twiceRebuiltChunks.length, 2);
    assert(
      !twiceRebuiltChunks.includes(firstChunks[0]!),
      "the oldest chunk generation must be pruned",
    );
    assert(
      twiceRebuiltChunks.includes(rebuiltChunk),
      "the immediately previous chunk generation must still be retained",
    );
    const retainedContents = await Promise.all(
      twiceRebuiltChunks.map((chunk) =>
        Deno.readTextFile(join(scriptsDir, chunk))
      ),
    );
    assert(
      retainedContents.some((content) => content.includes(twiceRebuiltMarker)),
      "the retained generations must include the twice-rebuilt module",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
