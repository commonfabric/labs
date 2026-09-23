/**
 * Everything that runs a pattern: the integration suites and their
 * server-execution arms, the reload suite, the pattern unit tests, and
 * the generated-pattern integration tests.
 *
 * Three of the four are `deno test` over a directory of files. The
 * fourth, `pattern-unit`, is `cf test` once per pattern file, run through
 * the integration task because that task is what writes the records; it
 * is handed the files it should run rather than a name filter, because a
 * selected set is a list of unrelated paths and no filter expresses one.
 */

import * as path from "@std/path";
import { PATTERN_TREES } from "../pattern-files.ts";
import { SERVER_EXECUTION_ON_SKIPS } from "../server-execution-on-skips.ts";
import { serverExecutionCiLane } from "../server-execution-ci.ts";
import { taskEnvironment } from "./deno-task.ts";
import {
  type CommandContext,
  fileSuite,
  type Invocation,
  type Location,
  type Suite,
  unavailableFrom,
} from "./suite.ts";

/** Test files directly inside a directory, repository-relative and sorted. */
async function filesIn(
  root: string,
  directory: string,
  suffix = ".test.ts",
): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(path.join(root, directory))) {
      if (entry.isFile && entry.name.endsWith(suffix)) {
        found.push(`${directory}/${entry.name}`);
      }
    }
  } catch (error) {
    // A directory the tree does not hold contributes nothing, which is
    // what a package without integration tests looks like. Anything else
    // would silently take tests out of the topology, so it is raised.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found.sort();
}

/** Every `.test.tsx` pattern the unit suite runs, repository-relative. */
async function patternTestFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    // Read before any entry is followed, so a directory that vanishes
    // mid-walk ends its own subtree rather than every level above it.
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(
        Deno.readDir(path.join(root, directory)),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory) await walk(`${directory}/${entry.name}`);
      else if (entry.isFile && entry.name.endsWith(".test.tsx")) {
        found.push(`${directory}/${entry.name}`);
      }
    }
  };
  for (const tree of PATTERN_TREES) await walk(tree.directory);
  return found.sort();
}

/** The integration suites over `packages/patterns/integration/`. */
async function patternIntegrationSuites(
  root: string,
  defaultEnabled: boolean,
): Promise<Suite[]> {
  const packageDir = "packages/patterns";
  const files = await filesIn(root, `${packageDir}/integration`);
  const flags = [
    // `packages/patterns/integration` is one of the paths the type check
    // owns, so checking it again here is the same work a second time.
    "--no-check",
    "-A",
    "--v8-flags=--max-old-space-size=4096",
    "--trace-leaks",
  ];
  const junit = {
    kind: "integration",
    scope: "patterns",
    filePrefix: packageDir,
  };
  // The environment the package's own `integration` task sets, so the
  // suite a lane runs and the suite somebody runs by hand are the same
  // run. `HEADLESS` is not part of it: the task leaves the browser
  // visible and CI hides it.
  const env = {
    ...await taskEnvironment(`${root}/${packageDir}`, "integration"),
    HEADLESS: "1",
  };
  const on = unavailableFrom(SERVER_EXECUTION_ON_SKIPS.patterns, packageDir);
  const defaultLane = serverExecutionCiLane("default", defaultEnabled);
  const oppositeLane = serverExecutionCiLane("opposite", defaultEnabled);
  return [
    fileSuite({
      id: "pattern-integration",
      // The baked server rather than one run from source: these drive a
      // browser at the shell, and the shell is a bundle inside the
      // binary. A source run answers the API and serves no shell.
      needs: ["deno", "toolshed-baked", "browser", "compile-cache"],
      // Authored-pattern instrumentation compiles each pattern a second
      // way, and what the browser worker records is the whole of what ran
      // only where that worker is the sole compiler. Server execution puts
      // another one on the server, so the arm running it leaves the
      // authored-pattern measurement to the arm that does not.
      patternCoverage: !defaultLane.enabled,
      parts: [{
        packageDir,
        flags,
        env,
        junit,
        files: defaultLane.enabled
          ? files.filter((file) => !on.excluded.has(file))
          : files,
        unavailable: defaultLane.enabled ? on.unavailable : [],
      }],
    }),
    fileSuite({
      id: "pattern-integration-opposite",
      variant: oppositeLane.recordVariant,
      patternCoverage: !oppositeLane.enabled,
      needs: [
        "deno",
        "toolshed-baked-opposite",
        "browser",
        "compile-cache",
      ],
      parts: [{
        packageDir,
        flags,
        env: {
          ...env,
          EXPERIMENTAL_SERVER_EXECUTION: String(oppositeLane.enabled),
        },
        junit,
        files: oppositeLane.enabled
          ? files.filter((file) => !on.excluded.has(file))
          : files,
        unavailable: oppositeLane.enabled ? on.unavailable : [],
      }],
    }),
  ];
}

/**
 * Where a suite that builds its own invocation puts what it measures.
 *
 * Two streams, and they are not the same shape. Deno writes V8 profiles
 * into `DENO_COVERAGE_DIR`, which the lane converts afterwards; the
 * authored-pattern instrumentation writes LCOV straight into
 * `CF_PATTERN_COVERAGE_DIR`, which the lane only has to carry. A suite
 * whose runner is `deno test` over a file list gets both from
 * `fileSuite`; these two build their own command lines, so they say it
 * here.
 */
function coverageEnv(
  context: CommandContext,
  slug: string,
): Record<string, string> {
  return {
    ...(context.coverageDir === undefined
      ? {}
      : { DENO_COVERAGE_DIR: path.join(context.coverageDir, slug) }),
    ...(context.patternCoverageDir === undefined
      ? {}
      : { CF_PATTERN_COVERAGE_DIR: context.patternCoverageDir }),
  };
}

/**
 * The reload suite, which is one unit rather than one per file. Its own
 * task brings up the whole local development stack around the run and
 * hard-codes the directory it runs, so a lane can ask for the suite or
 * not ask for it, and nothing finer.
 */
function patternReloadSuite(): Suite {
  const unit = "packages/patterns/integration/reload";
  return {
    id: "pattern-reload",
    recordSurfaces: [{ kind: "integration", scope: "patterns" }],
    needs: ["deno", "local-dev-servers", "browser"],
    units: [unit],
    unavailable: [],
    // The task hard-codes the directory it runs and brings the local
    // development stack up around it, so a lane asks for the suite or
    // does not.
    whole: [unit],
    locate(record): Location | undefined {
      if (record.test.v !== undefined) return undefined;
      if (record.test.k !== "integration" || record.test.s !== "patterns") {
        return undefined;
      }
      if (record.file?.startsWith(`${unit}/`) !== true) return undefined;
      return { level: "unit", unit };
    },
    command(requests, context): Promise<Invocation[]> {
      if (requests.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "integration",
          `--junit-dir=${context.outputDir}`,
          "patterns-reload",
        ],
        cwd: context.root,
        env: {
          HEADLESS: "1",
          ...coverageEnv(context, "pattern-reload"),
        },
        junit: [{
          path: path.join(context.outputDir, "patterns-reload.xml"),
          kind: "integration",
          scope: "patterns",
          filePrefix: "packages/patterns",
        }],
      }]);
    },
  };
}

/**
 * The pattern unit tests. Each file is one identity, named for its own
 * path, so the file and the identity coincide and there is nothing
 * finer to reach.
 */
async function patternUnitSuite(root: string): Promise<Suite> {
  const units = await patternTestFiles(root);
  const known = new Set(units);
  return {
    id: "pattern-unit",
    recordSurfaces: [{ kind: "pattern", scope: "patterns" }],
    needs: ["deno", "cf", "compile-cache"],
    units,
    unavailable: [],
    // The file is the identity, so running one unit runs the one thing
    // in it.
    whole: units,
    locate(record): Location | undefined {
      if (record.test.v !== undefined) return undefined;
      if (record.test.k !== "pattern" || record.test.s !== "patterns") {
        return undefined;
      }
      return known.has(record.test.n)
        ? { level: "unit", unit: record.test.n }
        : undefined;
    },
    async command(requests, context): Promise<Invocation[]> {
      const files = requests
        .map((request) => request.unit)
        .filter((unit) => known.has(unit));
      if (files.length === 0) return [];
      const listPath = path.join(context.outputDir, "pattern-unit.files");
      await Deno.mkdir(context.outputDir, { recursive: true });
      await Deno.writeTextFile(listPath, `${files.join("\n")}\n`);
      return [{
        command: [
          Deno.execPath(),
          "task",
          "integration",
          `--junit-dir=${context.outputDir}`,
          `--files=${listPath}`,
          "pattern-tests",
        ],
        cwd: context.root,
        env: coverageEnv(context, "pattern-unit"),
      }];
    },
  };
}

/** The generated-pattern integration tests. */
async function generatedPatternSuite(root: string): Promise<Suite> {
  const packageDir = "packages/generated-patterns";
  return fileSuite({
    id: "generated-patterns",
    needs: ["deno", "compile-cache"],
    parts: [{
      packageDir,
      flags: ["--trace-leaks", "-A", "--parallel"],
      env: { LOG_LEVEL: "warn" },
      junit: {
        kind: "integration",
        scope: "generated-patterns",
        filePrefix: packageDir,
      },
      files: await filesIn(root, `${packageDir}/integration/patterns`),
    }],
  });
}

/** Every pattern suite, read from the working tree. */
export async function loadPatternSuites(
  root: string,
  defaultEnabled = serverExecutionCiLane("default").enabled,
): Promise<Suite[]> {
  return [
    ...await patternIntegrationSuites(root, defaultEnabled),
    patternReloadSuite(),
    await patternUnitSuite(root),
    await generatedPatternSuite(root),
  ];
}
