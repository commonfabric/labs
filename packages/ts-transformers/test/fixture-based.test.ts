import { join } from "@std/path";

import { StaticCache } from "@commonfabric/static";
import {
  createUnifiedDiff,
  defineFixtureSuite,
} from "@commonfabric/test-support/fixture-runner";
import ts from "typescript";

import type { TransformationDiagnostic } from "../src/mod.ts";
import {
  batchTypeCheckFixtures,
  loadFixture,
  transformFixture,
} from "./utils.ts";

interface FixtureConfig {
  directory: string;
  describe: string;
  groups?: Array<{ pattern: RegExp; name: string }>;
  formatTestName?: (fileName: string) => string;
}

const configs: FixtureConfig[] = [
  {
    directory: "ast-transform",
    describe: "AST Transformation",
    formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
  },
  {
    directory: "handler-schema",
    describe: "Handler Schema Transformation",
    formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
  },
  {
    directory: "jsx-expressions",
    describe: "JSX Expression Transformer",
    formatTestName: (name) => {
      const formatted = name.replace(/-/g, " ");
      if (name.includes("no-transform")) {
        return `does not transform ${formatted.replace("no transform ", "")}`;
      }
      return `transforms ${formatted}`;
    },
  },
  {
    directory: "schema-transform",
    describe: "Schema Transformer",
    formatTestName: (name) => {
      const formatted = name.replace(/-/g, " ");
      if (name === "with-reactive") return "works with Reactive transformer";
      return `transforms ${formatted}`;
    },
    groups: [
      { pattern: /with-reactive/, name: "Reactive integration" },
    ],
  },
  {
    directory: "closures",
    describe: "Closure Transformation",
    formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
    groups: [
      { pattern: /^map-/, name: "Map callbacks" },
      { pattern: /^event-/, name: "Event handlers" },
      { pattern: /^lift-/, name: "Generic closures" },
    ],
  },
  {
    directory: "kitchensink",
    describe: "Nested Kitchensinks",
    formatTestName: (name) => `exercises ${name.replace(/-/g, " ")}`,
  },
  {
    directory: "schema-injection",
    describe: "Schema Injection with Literal Widening",
    formatTestName: (name) => {
      if (name.startsWith("literal-widen-")) {
        return `widens ${
          name.replace(/^literal-widen-/, "").replace(/-/g, " ")
        }`;
      }
      if (name.startsWith("double-inject-")) {
        return `prevents ${
          name.replace(/^double-inject-/, "").replace(/-/g, " ")
        }`;
      }
      if (name.startsWith("context-")) {
        return name.replace(/-/g, " ");
      }
      if (name.startsWith("cell-like-")) {
        return name.replace(/-/g, " ");
      }
      if (name.startsWith("collections-")) {
        return `handles ${
          name.replace(/^collections-/, "").replace(/-/g, " ")
        }`;
      }
      return name.replace(/-/g, " ");
    },
  },
];

const staticCache = StaticCache.fromFileSystem();
const commonfabric = await staticCache.getText("types/commonfabric.d.ts");
const commonfabricSchema = await staticCache.getText(
  "types/commonfabric-schema.d.ts",
);
// Anchored to this file so the suite loads from any cwd: `deno task test`
// runs from the package root, `deno test packages/ts-transformers` does not.
const FIXTURES_ROOT = join(import.meta.dirname!, "fixtures");

// Environment variable filtering for faster iteration
// Usage: FIXTURE=map-array-destructured deno task test
// Or: FIXTURE_PATTERN="array.*destructured" deno task test
const fixtureFilter = Deno.env.get("FIXTURE");
const fixturePattern = Deno.env.get("FIXTURE_PATTERN");

/**
 * Loads all fixture input files from a directory for batch type-checking
 */
async function loadAllFixturesInDirectory(
  directory: string,
): Promise<Record<string, string>> {
  const fixtures: Record<string, string> = {};

  // Find all .input.* files in the directory
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.includes(".input.")) {
      const fullPath = `${directory}/${entry.name}`;
      // Keyed by the absolute path; `execute` below rebuilds the same key.
      fixtures[fullPath] = await Deno.readTextFile(fullPath);
    }
  }

  return fixtures;
}

// PERFORMANCE OPTIMIZATION: Batch Type-Checking
//
// Input fixture type-checking is ENABLED BY DEFAULT. Set SKIP_INPUT_CHECK=1 to disable.
//
// We batch type-check all fixtures upfront in a single TypeScript program instead of
// creating separate programs per fixture. This provides a significant performance improvement:
//
// - WITHOUT batching: ~16s (166 programs × 100ms each)
// - WITH batching: ~4s (1 program × 600ms + 166 transforms × 20ms)
// - Speedup: 4-6x faster
//
// The batching works by:
// 1. Loading all fixture files upfront
// 2. Creating one ts.Program with all fixtures as separate files
// 3. Running ts.getPreEmitDiagnostics() once for all files
// 4. Storing diagnostics in a Map keyed by file path
// 5. Individual tests retrieve their precomputed diagnostics from the Map
//
// To skip input validation temporarily, run with SKIP_INPUT_CHECK=1.
//
// NOTE: Expected (.expected.tsx) files are NOT type-checked because the transformer
// output intentionally strips type arguments and uses __cfHelpers patterns that
// don't carry full type information. This is by design — the transformer converts
// TypeScript type information into runtime schema objects.
const batchedDiagnosticsByConfig = new Map<
  string,
  Map<string, ts.Diagnostic[]>
>();

if (!Deno.env.get("SKIP_INPUT_CHECK")) {
  const batchStart = performance.now();
  for (const config of configs) {
    const configStart = performance.now();

    let allFixtures = await loadAllFixturesInDirectory(
      `${FIXTURES_ROOT}/${config.directory}`,
    );

    // Apply FIXTURE/FIXTURE_PATTERN filter to batch type-checking for faster iteration
    if (fixtureFilter || fixturePattern) {
      const filteredFixtures: Record<string, string> = {};
      for (const [path, content] of Object.entries(allFixtures)) {
        // Extract base name from path (e.g., ".../fixtures/closures/map-basic.input.tsx" -> "map-basic")
        const fileName = path.split("/").pop() || "";
        const baseName = fileName.replace(/\.input\.(tsx?|ts)$/, "");

        const matchesFilter = fixtureFilter
          ? baseName === fixtureFilter
          : new RegExp(fixturePattern!).test(baseName);

        if (matchesFilter) {
          filteredFixtures[path] = content;
        }
      }
      allFixtures = filteredFixtures;
    }

    // Skip empty fixture sets (when filter doesn't match any in this directory)
    if (Object.keys(allFixtures).length === 0) {
      continue;
    }

    console.log(`Batch type-checking fixtures in ${config.describe}...`);

    const result = await batchTypeCheckFixtures(allFixtures, {
      types: {
        "commonfabric.d.ts": commonfabric,
        "commonfabric-schema.d.ts": commonfabricSchema,
      },
    });

    console.log(
      `  -> ${Object.keys(allFixtures).length} fixtures in ${
        (performance.now() - configStart).toFixed(0)
      }ms`,
    );

    batchedDiagnosticsByConfig.set(config.describe, result.diagnosticsByFile);
  }
  console.log(
    `Total batch type-checking time: ${
      (performance.now() - batchStart).toFixed(0)
    }ms`,
  );
}

// Now run the tests
for (const config of configs) {
  const suiteConfig = {
    suiteName: config.describe,
    rootDir: `${FIXTURES_ROOT}/${config.directory}`,
    expectedPath: (
      { stem, extension }: { stem: string; extension: string },
    ) => {
      // Expected files use JS extensions since they are post-transform output
      // (type arguments stripped, __cfHelpers patterns) — not valid TypeScript.
      const jsExtension = extension === ".tsx" ? ".jsx" : ".js";
      return `${stem}.expected${jsExtension}`;
    },
    skip: (fixture: { baseName: string }) => {
      if (fixtureFilter && fixture.baseName !== fixtureFilter) {
        return true;
      }
      if (
        fixturePattern && !new RegExp(fixturePattern).test(fixture.baseName)
      ) {
        return true;
      }
      return false;
    },
    async execute(fixture: { relativeInputPath: string }) {
      // Construct full path matching the keys in batchedDiagnostics
      const fullPath =
        `${FIXTURES_ROOT}/${config.directory}/${fixture.relativeInputPath}`;

      // Get precomputed diagnostics if available
      const diagnosticsMap = batchedDiagnosticsByConfig.get(config.describe);
      const precomputedDiagnostics = diagnosticsMap?.get(fullPath);

      const pipelineDiagnostics: TransformationDiagnostic[] = [];
      const result = await transformFixture(
        `${config.directory}/${fixture.relativeInputPath}`,
        {
          types: {
            "commonfabric.d.ts": commonfabric,
            "commonfabric-schema.d.ts": commonfabricSchema,
          },
          typeCheck: !Deno.env.get("SKIP_INPUT_CHECK"),
          precomputedDiagnostics,
          pipelineDiagnostics,
        },
      );

      // Fail on pipeline diagnostics (validation errors from the transformer)
      if (!Deno.env.get("SKIP_INPUT_CHECK")) {
        const errors = pipelineDiagnostics.filter((d) =>
          d.severity === "error"
        );
        if (errors.length > 0) {
          const messages = errors.map((d) =>
            `${d.fileName}:${d.line}:${d.column} - ${d.type}: ${d.message}`
          );
          throw new Error(
            `Transformer pipeline produced ${errors.length} error(s):\n${
              messages.join("\n")
            }`,
          );
        }
      }

      return result;
    },
    async loadExpected(fixture: { relativeExpectedPath: string }) {
      return await loadFixture(
        `${config.directory}/${fixture.relativeExpectedPath}`,
      );
    },
    compare(actual: string, expected: string, fixture: {
      baseName: string;
      relativeInputPath: string;
      relativeExpectedPath: string;
    }) {
      if (actual === expected) return;
      const diff = createUnifiedDiff(expected, actual);
      let message =
        `\n\nTransformation output does not match expected for: ${fixture.baseName}\n`;
      message += `\nFiles:\n`;
      message +=
        `  Input:    ${FIXTURES_ROOT}/${config.directory}/${fixture.relativeInputPath}\n`;
      message +=
        `  Expected: ${FIXTURES_ROOT}/${config.directory}/${fixture.relativeExpectedPath}\n`;
      message += `\n${"=".repeat(80)}\n`;
      message += `UNIFIED DIFF (expected vs actual):\n`;
      message += `${"=".repeat(80)}\n`;
      message += diff;
      message += `\n${"=".repeat(80)}\n`;
      throw new Error(message);
    },
    updateGolden(actual: string, fixture: { relativeExpectedPath: string }) {
      const normalized = `${actual}\n`;
      return Deno.writeTextFile(
        `${FIXTURES_ROOT}/${config.directory}/${fixture.relativeExpectedPath}`,
        normalized,
      );
    },
  };

  if (config.formatTestName) {
    Object.assign(suiteConfig, {
      formatTestName: (fixture: { baseName: string }) =>
        config.formatTestName!(fixture.baseName),
    });
  }

  if (config.groups) {
    Object.assign(suiteConfig, {
      groupBy: (fixture: { baseName: string }) => {
        for (const group of config.groups!) {
          if (group.pattern.test(fixture.baseName)) {
            return group.name;
          }
        }
        return undefined;
      },
    });
  }

  defineFixtureSuite<string, string>(suiteConfig);
}
