import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path/join";
import { toFileUrl } from "@std/path/to-file-url";
import { describe, it } from "@std/testing/bdd";

import { Builder, resolveOtelBrowserPlatform } from "./builder.ts";
import { Config, ResolvedConfig } from "./interface.ts";
import { build } from "./mod.ts";

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

    // A consumer can retain the complete graph, including deferred chunks.
    const manifest = JSON.parse(
      await Deno.readTextFile(join(root, "dist", "build-manifest.json")),
    );
    assertEquals(
      Object.keys(manifest).sort(),
      [
        "scripts/plain.js",
        "scripts/split.js",
        ...chunks.map((name) => `scripts/${name}`),
      ].sort(),
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

/** Runs `body` with a fresh temporary directory, removed afterwards. */
async function withTempDir(body: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "felt-builder-test-" });
  try {
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** A builder of the single entry `entry.ts` in `root`, into `dist/main.js`. */
function entryBuilder(root: string): Builder {
  return new Builder(
    new ResolvedConfig({
      entries: [{ in: "entry.ts", out: "main" }],
      outDir: "dist",
      esbuild: { tsconfigRaw: {} },
    }, root),
  );
}

/** Counts the `build` events `builder` dispatches. */
function countBuilds(builder: Builder): { readonly count: number } {
  const builds = { count: 0 };
  builder.addEventListener("build", () => builds.count++);
  return builds;
}

describe("builder", () => {
  describe("Builder.watch()", () => {
    it("builds once for each change reported while no build is running", async () => {
      await withTempDir(async (root) => {
        await Deno.writeTextFile(join(root, "entry.ts"), `console.log(1);\n`);
        const builder = entryBuilder(root);
        const builds = countBuilds(builder);
        const built = Promise.withResolvers<void>();
        builder.addEventListener("build", () => built.resolve(), {
          once: true,
        });

        await builder.watch((async function* () {
          yield "change";
          await built.promise;
          yield "change";
        })());

        expect(builds.count).toBe(2);
      });
    });

    it("builds once more for any number of changes reported during a build", async () => {
      await withTempDir(async (root) => {
        await Deno.writeTextFile(join(root, "entry.ts"), `console.log(1);\n`);
        const builder = entryBuilder(root);
        const builds = countBuilds(builder);

        // The first change starts a build, which cannot finish before the
        // generator, which never waits, has reported the other two.
        await builder.watch((async function* () {
          yield "change";
          yield "change";
          yield "change";
        })());

        expect(builds.count).toBe(2);
      });
    });

    it("reports a failed build and builds again on the next change", async () => {
      await withTempDir(async (root) => {
        const entry = join(root, "entry.ts");
        await Deno.writeTextFile(entry, `console.log(;\n`);
        const builder = entryBuilder(root);
        const builds = countBuilds(builder);
        const errors: string[] = [];
        const reported = Promise.withResolvers<void>();
        const consoleError = console.error;
        console.error = (...data: unknown[]) => {
          errors.push(data.join(" "));
          if (errors.some((line) => line.includes("Error:"))) {
            reported.resolve();
          }
        };
        try {
          await builder.watch((async function* () {
            yield "change";
            await reported.promise;
            await Deno.writeTextFile(entry, `console.log(2);\n`);
            yield "change";
          })());
        } finally {
          console.error = consoleError;
        }

        expect(errors.join("\n")).toContain("Expression expected");
        expect(builds.count).toBe(1);
        expect(await Deno.readTextFile(join(root, "dist", "main.js")))
          .toContain("console.log(2)");
      });
    });

    it("builds nothing when no change is reported", async () => {
      await withTempDir(async (root) => {
        await Deno.writeTextFile(join(root, "entry.ts"), `console.log(1);\n`);
        const builder = entryBuilder(root);
        const builds = countBuilds(builder);

        await builder.watch((async function* () {})());

        expect(builds.count).toBe(0);
      });
    });
  });

  describe("Builder.build()", () => {
    it("rejects, dispatching no build event, when an entry fails to compile", async () => {
      await withTempDir(async (root) => {
        await Deno.writeTextFile(join(root, "entry.ts"), `console.log(;\n`);
        const builder = entryBuilder(root);
        const builds = countBuilds(builder);

        await expect(builder.build()).rejects.toThrow("Build failed");

        expect(builds.count).toBe(0);
      });
    });

    it("replaces a defined name with its string value, or undefined", async () => {
      await withTempDir(async (root) => {
        await Deno.writeTextFile(
          join(root, "entry.ts"),
          `console.log(DEFINED, UNSET);\n`,
        );
        await new Builder(
          new ResolvedConfig({
            entries: [{ in: "entry.ts", out: "main" }],
            outDir: "dist",
            esbuild: {
              define: { DEFINED: "value", UNSET: undefined },
              tsconfigRaw: {},
            },
          }, root),
        ).build();

        expect(await Deno.readTextFile(join(root, "dist", "main.js")))
          .toContain(`console.log("value", void 0)`);
      });
    });

    it("leaves out of the build manifest an entry that emits no JavaScript", async () => {
      await withTempDir(async (root) => {
        await Deno.writeTextFile(join(root, "entry.ts"), `console.log(1);\n`);
        await Deno.writeTextFile(join(root, "style.css"), `a { color: red }\n`);
        await new Builder(
          new ResolvedConfig({
            entries: [
              { in: "entry.ts", out: "main" },
              { in: "style.css", out: "style" },
            ],
            outDir: "dist",
            esbuild: { tsconfigRaw: {} },
          }, root),
        ).build();

        const manifest = JSON.parse(
          await Deno.readTextFile(join(root, "dist", "build-manifest.json")),
        );
        expect(Object.keys(manifest)).toEqual(["main.js"]);
        expect(await Deno.readTextFile(join(root, "dist", "style.css")))
          .toContain("color: red");
      });
    });

    it("keeps a split chunk that a retained generation still emits", async () => {
      await withTempDir(async (root) => {
        await writeFixture(root);
        const builder = new Builder(new ResolvedConfig(fixtureConfig(), root));
        const scriptsDir = join(root, "dist", "scripts");
        await builder.build();
        const chunks = await listChunks(scriptsDir);

        await builder.build();
        await builder.build();

        expect(chunks).toHaveLength(1);
        expect(await listChunks(scriptsDir)).toEqual(chunks);
      });
    });

    it("prunes past a stale split chunk that is already gone", async () => {
      await withTempDir(async (root) => {
        await writeFixture(root);
        const builder = new Builder(new ResolvedConfig(fixtureConfig(), root));
        const scriptsDir = join(root, "dist", "scripts");
        const lazy = join(root, "split-lazy.ts");
        await builder.build();
        const [first] = await listChunks(scriptsDir);
        await Deno.writeTextFile(lazy, `export const marker = "second";\n`);
        await builder.build();
        await Deno.remove(join(scriptsDir, first!));
        await Deno.writeTextFile(lazy, `export const marker = "third";\n`);

        await builder.build();

        expect(await listChunks(scriptsDir)).toHaveLength(2);
      });
    });

    it("rejects when a stale split chunk cannot be removed", async () => {
      await withTempDir(async (root) => {
        await writeFixture(root);
        const builder = new Builder(new ResolvedConfig(fixtureConfig(), root));
        const scriptsDir = join(root, "dist", "scripts");
        const lazy = join(root, "split-lazy.ts");
        await builder.build();
        const [first] = await listChunks(scriptsDir);
        await Deno.writeTextFile(lazy, `export const marker = "second";\n`);
        await builder.build();
        // A non-empty directory where the oldest chunk was.
        await Deno.remove(join(scriptsDir, first!));
        await Deno.mkdir(join(scriptsDir, first!, "contents"), {
          recursive: true,
        });
        await Deno.writeTextFile(lazy, `export const marker = "third";\n`);

        await expect(builder.build()).rejects.toThrow(/not empty/i);
      });
    });

    it("refuses to remove a stale split chunk outside the output directory", async () => {
      await withTempDir(async (root) => {
        await writeFixture(root);
        const config = fixtureConfig();
        config.esbuild!.chunkNames = "../escaped/chunk-[hash]";
        const builder = new Builder(new ResolvedConfig(config, root));
        const escaped = join(root, "escaped");
        const lazy = join(root, "split-lazy.ts");
        await builder.build();
        const [first] = await listChunks(escaped);
        await Deno.writeTextFile(lazy, `export const marker = "second";\n`);
        await builder.build();
        await Deno.writeTextFile(lazy, `export const marker = "third";\n`);

        await expect(builder.build()).rejects.toThrow(
          "Refusing to remove output outside outDir",
        );

        expect(await listChunks(escaped)).toContain(first);
      });
    });
  });

  describe("build()", () => {
    it("bundles a text import as a string, an empty file included", async () => {
      await withTempDir(async (root) => {
        await Deno.writeTextFile(join(root, "full.md"), "text-contents");
        await Deno.writeTextFile(join(root, "empty.md"), "");
        await Deno.writeTextFile(
          join(root, "entry.ts"),
          `import full from "./full.md" with { type: "text" };\n` +
            `import empty from "./empty.md" with { type: "text" };\n` +
            `export default [full, empty];\n`,
        );
        const outfile = join(root, "out.js");

        await build({ entryPoints: [join(root, "entry.ts")], outfile });

        const bundle = await import(toFileUrl(outfile).href);
        expect(bundle.default).toEqual(["text-contents", ""]);
      });
    });
  });

  describe("resolveOtelBrowserPlatform()", () => {
    /** The resolve arguments for `./platform` imported from `importerDir`. */
    const platformImport = (importerDir: string) => ({
      importer: join(importerDir, "index.js"),
      resolveDir: importerDir,
      path: "./platform",
    });

    it("returns the browser index of an @opentelemetry package that has one", async () => {
      await withTempDir(async (root) => {
        const pkg = join(root, "@opentelemetry", "core");
        await Deno.mkdir(join(pkg, "platform", "browser"), { recursive: true });
        await Deno.writeTextFile(
          join(pkg, "platform", "browser", "index.js"),
          "",
        );

        expect(resolveOtelBrowserPlatform(platformImport(pkg))).toEqual({
          path: join(pkg, "platform", "browser", "index.js"),
        });
      });
    });

    it("returns undefined for an @opentelemetry package with no browser platform", async () => {
      await withTempDir(async (root) => {
        const pkg = join(root, "@opentelemetry", "core");
        await Deno.mkdir(join(pkg, "platform", "node"), { recursive: true });

        expect(resolveOtelBrowserPlatform(platformImport(pkg))).toBeUndefined();
      });
    });

    it("returns undefined for an importer outside @opentelemetry", async () => {
      await withTempDir(async (root) => {
        const pkg = join(root, "other", "core");
        await Deno.mkdir(join(pkg, "platform", "browser"), { recursive: true });
        await Deno.writeTextFile(
          join(pkg, "platform", "browser", "index.js"),
          "",
        );

        expect(resolveOtelBrowserPlatform(platformImport(pkg))).toBeUndefined();
      });
    });

    it("throws when the browser index cannot be looked up", async () => {
      await withTempDir(async (root) => {
        const pkg = join(root, "@opentelemetry", "core");
        await Deno.mkdir(pkg, { recursive: true });
        await Deno.writeTextFile(join(pkg, "platform"), "");

        expect(() => resolveOtelBrowserPlatform(platformImport(pkg)))
          .toThrow(Deno.errors.NotADirectory);
      });
    });
  });
});
