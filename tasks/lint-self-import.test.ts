/// <reference lib="deno.unstable" />

/**
 * Runs the `cf-package/no-self-import` rule over short files and checks which
 * of the two messages, if either, it reports. The rule reads the file's package
 * out of the nearest Deno configuration on disk, so each case writes a package
 * into a temporary directory and names a file inside it.
 */

import { afterAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import plugin from "./lint-self-import.ts";

/** A package written to disk, ready for the rule to read. */
interface Fixture {
  /** The absolute directory the package sits in. */
  readonly root: string;
  /** Lints `source` as the package file at `path`, returning the messages. */
  diagnose(path: string, source: string): string[];
}

/** Every directory `fixture` has made, for `afterAll` to remove. */
const fixtureRoots: string[] = [];

/**
 * Writes a package whose configuration is `config`, and returns a handle that
 * lints files against it. The directory goes under a fresh temporary root, so
 * the walk up from a file cannot reach this repository's own configurations.
 */
function fixture(config: Record<string, unknown>): Fixture {
  const root = Deno.makeTempDirSync({ prefix: "lint-self-import-" });
  fixtureRoots.push(root);
  Deno.writeTextFileSync(
    resolve(root, "deno.jsonc"),
    `// a comment, because this is JSONC\n${JSON.stringify(config)}\n`,
  );
  return {
    root,
    diagnose(path, source) {
      return Deno.lint.runPlugin(plugin, resolve(root, path), source)
        .map((diagnostic) => diagnostic.message);
    },
  };
}

const RUNNER = {
  name: "@commonfabric/runner",
  exports: {
    ".": "./src/index.ts",
    "./traverse": "./src/traverse.ts",
  },
};

/** A package with a `@/` alias over `src/` and a `@` alias for its barrel. */
const DATA_MODEL = {
  name: "@commonfabric/data-model",
  exports: {
    ".": "./src/index.ts",
    "./types": "./src/types/index.ts",
  },
  imports: {
    "@": "./src/index.ts",
    "@/": "./src/",
    "@/types": "./src/types/index.ts",
    "@std/path": "jsr:@std/path@^1",
  },
};

/** The distinguishing phrase of each of the rule's two messages. */
const BARREL = "is the entry point of the package this file belongs to";
const SUBPATH = "gives one module two spellings";

describe("lint-self-import", () => {
  afterAll(() => {
    for (const root of fixtureRoots) Deno.removeSync(root, { recursive: true });
  });

  it("reports an import of the package's own entry point", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/runtime.ts",
      `import { RuntimeTelemetry } from "@commonfabric/runner";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("gives general advice for an entry-point import, whose path is the barrel", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/storage/interface.ts",
      `import { Runtime } from "@commonfabric/runner";`,
    );
    expect(messages[0]).toContain(
      "Import the module that defines it by relative path instead.",
    );
    expect(messages[0]).not.toContain("index.ts");
  });

  it("reports an import of the package's own subpath export", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/schema.ts",
      `import { walk } from "@commonfabric/runner/traverse";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(SUBPATH);
    expect(messages[0]).toContain("Import `./traverse.ts` instead.");
  });

  it("gives general advice for a subpath the exports map omits", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/schema.ts",
      `import { walk } from "@commonfabric/runner/nowhere";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(
      "Import the module that defines it by relative path instead.",
    );
  });

  it("reports a re-export of the package's own entry point", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/shared.ts",
      `export * from "@commonfabric/runner";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("reports a named re-export from the package's own name", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/shared.ts",
      `export { Runtime } from "@commonfabric/runner";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("reports a dynamic import of the package's own name", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/lazy.ts",
      `export const load = () => import("@commonfabric/runner");`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("reports a type-only import of the package's own name", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/runtime.ts",
      `import type { Runtime } from "@commonfabric/runner";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("reports an exact alias for the package's own entry point", () => {
    const messages = fixture(DATA_MODEL).diagnose(
      "src/codecs.ts",
      `import { FabricHash } from "@";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("advises no form of specifier for an alias of the entry point", () => {
    const messages = fixture(DATA_MODEL).diagnose(
      "src/codecs.ts",
      `import { FabricHash } from "@";`,
    );
    expect(messages[0]).toContain("Import the module that defines it instead.");
    expect(messages[0]).not.toContain("relative path");
  });

  it("reports a prefix alias that reaches the package's own entry point", () => {
    const messages = fixture(DATA_MODEL).diagnose(
      "src/codecs.ts",
      `import { FabricHash } from "@/index.ts";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("returns nothing for a prefix alias that reaches another module", () => {
    const messages = fixture(DATA_MODEL).diagnose(
      "src/codecs.ts",
      `import { FabricHash } from "@/fabric-hash.ts";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for an exact alias that reaches another module", () => {
    const messages = fixture(DATA_MODEL).diagnose(
      "src/codecs.ts",
      `import type { FabricValue } from "@/types";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for an alias to the entry point in a test file", () => {
    const messages = fixture(DATA_MODEL).diagnose(
      "test/codecs.test.ts",
      `import { FabricHash } from "@";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for an imports entry that names another package", () => {
    const messages = fixture(DATA_MODEL).diagnose(
      "src/codecs.ts",
      `import { resolve } from "@std/path";`,
    );
    expect(messages).toEqual([]);
  });

  it("takes the longest prefix alias, as an import map does", () => {
    // Under `@/` alone, `@/deep/index.ts` would be `src/deep/index.ts`. The
    // longer key sends it to the entry point instead.
    const messages = fixture({
      ...DATA_MODEL,
      imports: { "@/": "./src/", "@/deep/": "./src/" },
    }).diagnose(
      "src/codecs.ts",
      `import { FabricHash } from "@/deep/index.ts";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("returns nothing for an alias in a package with no entry point", () => {
    const messages = fixture({
      name: "@commonfabric/toolshed",
      imports: { "@/": "./" },
    }).diagnose("routes/health.ts", `import { app } from "@/index.ts";`);
    expect(messages).toEqual([]);
  });

  it("returns nothing for an import of another package", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/runtime.ts",
      `import { isRecord } from "@commonfabric/utils/types";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for a package whose name only prefixes this one's", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/runtime.ts",
      `import { x } from "@commonfabric/runner-client";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for a relative import", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/runtime.ts",
      `import { RuntimeTelemetry } from "./telemetry.ts";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for a file under the package's test directory", () => {
    const messages = fixture(RUNNER).diagnose(
      "test/runtime.test.ts",
      `import { Runtime } from "@commonfabric/runner";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for a file under the package's integration directory", () => {
    const messages = fixture(RUNNER).diagnose(
      "integration/boot.ts",
      `import { Runtime } from "@commonfabric/runner";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for a test file beside the source it tests", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/runtime.test.ts",
      `import { Runtime } from "@commonfabric/runner";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for a benchmark file", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/runtime.bench.ts",
      `import { Runtime } from "@commonfabric/runner";`,
    );
    expect(messages).toEqual([]);
  });

  it("returns nothing for a file whose package configuration does not parse", () => {
    const root = Deno.makeTempDirSync({ prefix: "lint-self-import-" });
    fixtureRoots.push(root);
    Deno.writeTextFileSync(resolve(root, "deno.jsonc"), "{ this is not json");
    const messages = Deno.lint.runPlugin(
      plugin,
      resolve(root, "src/main.ts"),
      `import { Runtime } from "@commonfabric/runner";`,
    ).map((diagnostic) => diagnostic.message);
    expect(messages).toEqual([]);
  });

  it("returns nothing for a file whose package declares no name", () => {
    const messages = fixture({ exports: { ".": "./mod.ts" } }).diagnose(
      "src/main.ts",
      `import { Runtime } from "@commonfabric/runner";`,
    );
    expect(messages).toEqual([]);
  });

  it("stops the search for a package at the nearest configuration", () => {
    // A workspace member with no name of its own sits inside a package that has
    // one. Its files belong to the member, so the enclosing name is another
    // package's and free to import.
    const outer = fixture(RUNNER);
    const inner = resolve(outer.root, "nested");
    Deno.mkdirSync(inner);
    Deno.writeTextFileSync(resolve(inner, "deno.jsonc"), "{}\n");
    const messages = Deno.lint.runPlugin(
      plugin,
      resolve(inner, "main.ts"),
      `import { Runtime } from "@commonfabric/runner";`,
    ).map((diagnostic) => diagnostic.message);
    expect(messages).toEqual([]);
  });

  it("reports a type written as an inline `import(...)`", () => {
    const messages = fixture(RUNNER).diagnose(
      "src/runtime.ts",
      `type T = import("@commonfabric/runner").Runtime;`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("reads a second file against the package it already resolved", () => {
    // The owning package is cached per directory, so the second file in a
    // directory takes a different path to the same answer than the first.
    const pkg = fixture(RUNNER);
    const first = pkg.diagnose(
      "src/runtime.ts",
      `import { Runtime } from "@commonfabric/runner";`,
    );
    const second = pkg.diagnose(
      "src/schema.ts",
      `import { walk } from "@commonfabric/runner/traverse";`,
    );
    expect(first.length).toBe(1);
    expect(first[0]).toContain(BARREL);
    expect(second.length).toBe(1);
    expect(second[0]).toContain("Import `./traverse.ts` instead.");
  });

  it("prefers deno.json to deno.jsonc, as Deno itself does", () => {
    // Deno takes deno.json whole and ignores the other file, so a name in the
    // ignored one is not the package's name.
    const pkg = fixture({ name: "@commonfabric/ignored" });
    Deno.writeTextFileSync(
      resolve(pkg.root, "deno.json"),
      JSON.stringify(RUNNER),
    );
    const messages = pkg.diagnose(
      "src/runtime.ts",
      `import { Runtime } from "@commonfabric/runner";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });

  it("throws when a package configuration cannot be read at all", () => {
    // A configuration that is unreadable is not a package without a name: Deno
    // fails on the same file, and swallowing it here would quietly stop the
    // rule from checking anything under that directory.
    const root = Deno.makeTempDirSync({ prefix: "lint-self-import-" });
    fixtureRoots.push(root);
    Deno.mkdirSync(resolve(root, "deno.json"));
    expect(() =>
      Deno.lint.runPlugin(
        plugin,
        resolve(root, "src/main.ts"),
        `import { Runtime } from "@commonfabric/runner";`,
      )
    ).toThrow();
  });

  it("reports a package that names itself in a bare exports string", () => {
    const messages = fixture({
      name: "@commonfabric/leb128",
      exports: "./src/mod.ts",
    }).diagnose(
      "src/encode.ts",
      `import { decode } from "@commonfabric/leb128";`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(BARREL);
  });
});
