import { expandGlob } from "@std/fs";
import { resolve } from "@std/path";

import { Command, EnumType } from "@cliffy/command";

import { CFC_ENFORCEMENT_MODES } from "@commonfabric/runner/cfc";

import { cliText } from "../lib/cli-name.ts";
import {
  compileTestPatterns,
  discoverTestFiles,
  runTests,
} from "../lib/test-runner.ts";

export interface TestCommandOptions {
  recordResults?: boolean;
}

export function createTestCommand(
  { recordResults = false }: TestCommandOptions = {},
) {
  return new Command()
    .name("test")
    .type("cfc-enforcement", new EnumType(CFC_ENFORCEMENT_MODES))
    .type("cfc-flow", new EnumType(["off", "derive", "observe", "persist"]))
    .description("Run pattern tests (.test.tsx files).")
    .example(
      cliText("cf test ./counter.test.tsx"),
      "Run a single test pattern file.",
    )
    .example(
      cliText("cf test ./patterns/"),
      "Run all .test.tsx files in a directory (recursive).",
    )
    .example(
      cliText("cf test './*.test.tsx'"),
      "Run all test files matching a glob pattern.",
    )
    .example(
      cliText(
        "cf test ./battleship/pass-and-play/main.test.tsx --root ./battleship",
      ),
      "Run with custom root for resolving imports from sibling directories.",
    )
    .option(
      "--cfc-enforcement-mode <mode:cfc-enforcement>",
      "Override the test runtime CFC enforcement mode.",
    )
    .option(
      "--cfc-flow-labels <mode:cfc-flow>",
      "Flow labels: off, derive (runtime observe), or persist.",
    )
    .option(
      "--cfc-shell-posture",
      "Use enforce-explicit enforcement and persist flow labels.",
      { conflicts: ["cfc-enforcement-mode", "cfc-flow-labels"] },
    )
    .option(
      "--cfc-denials",
      "Print each CFC denial, with the reasons and inputs behind it, as it happens.",
    )
    .option(
      "--verbose",
      "Show detailed execution logs.",
    )
    .option(
      "--no-idempotency-check",
      "Disable verification replay for performance measurements.",
    )
    .option(
      "--compile-only",
      "Compile each file's program into the compile byte cache and run nothing. With CF_COMPILE_CACHE_FILE set, a later run of the same files compiles none of it.",
    )
    .option(
      "--root <dir:string>",
      "Root directory for resolving imports. Defaults to the nearest ancestor whose deno.json(c) declares a package name, else the test file's directory.",
    )
    .option(
      "--datafile <path:string>",
      "Attach a data file the pattern under test cannot name. Repeatable.",
      { collect: true },
    )
    .option(
      "--stats-threshold <ms:number>",
      "Print logger stats for steps slower than this (ms). 0 = every step. Requires --verbose.",
      { default: 5000 },
    )
    .option(
      "--stats-include <prefixes:string>",
      "Comma-separated timing categories to always print in verbose stats output (exact or prefix match).",
    )
    .option(
      "--stats-action-limit <count:number>",
      "Number of per-step scheduler action deltas to print in verbose mode.",
      { default: 10 },
    )
    .option(
      "--storage-stats",
      "Print storage-related logger timings and counts after each test file.",
    )
    .option(
      "--storage-stats-limit <count:number>",
      "Maximum number of storage timing/count entries to print with --storage-stats.",
      { default: 16 },
    )
    .option(
      "--pattern-coverage-dir <dir:string>",
      "Write pattern runtime coverage LCOV artifacts to this directory.",
    )
    .option(
      "--timing-measures-out <file:string>",
      "Emit a performance.measure per logger time span and write them here as " +
        "JSON. Aggregate with skills/perf-investigation/scripts/" +
        "aggregate-measures.ts.",
    )
    .arguments("<paths...:string>")
    .action(async (options, ...paths) => {
      const testFiles: string[] = [];

      for (const path of paths) {
        const fullPath = resolve(Deno.cwd(), path);

        // Check if it's a glob pattern
        if (path.includes("*")) {
          // Expand glob pattern
          for await (const entry of expandGlob(fullPath)) {
            if (entry.isFile && entry.name.endsWith(".test.tsx")) {
              testFiles.push(entry.path);
            }
          }
        } else {
          // Check if path exists
          let stat: Deno.FileInfo;
          try {
            stat = await Deno.stat(fullPath);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
              console.error(`Error: Path not found: ${fullPath}`);
            } else {
              console.error(`Error accessing path ${fullPath}:`, error);
            }
            Deno.exit(1);
          }

          if (stat.isDirectory) {
            // Discover test files in directory
            const discovered = await discoverTestFiles(fullPath);
            for (const file of discovered) testFiles.push(file);
          } else if (stat.isFile) {
            // Single file - warn but allow non-.test.tsx for flexibility
            if (!path.endsWith(".test.tsx")) {
              console.warn(`Warning: ${path} does not end with .test.tsx`);
            }
            testFiles.push(fullPath);
          } else {
            console.error(`Error: ${fullPath} is not a file or directory`);
            Deno.exit(1);
          }
        }
      }

      // Deduplicate test files (in case of overlapping paths like ./patterns/ and ./patterns/counter.test.tsx)
      const uniqueTestFiles = [...new Set(testFiles)];

      if (uniqueTestFiles.length === 0) {
        console.error(`Error: No test files found`);
        Deno.exit(1);
      }

      console.log(`Found ${uniqueTestFiles.length} test file(s)`);

      // Resolve root path if provided
      const root = options.root ? resolve(Deno.cwd(), options.root) : undefined;
      const patternCoverageDir = options.patternCoverageDir
        ? resolve(Deno.cwd(), options.patternCoverageDir)
        : Deno.env.get("CF_PATTERN_COVERAGE_DIR")
        ? resolve(Deno.cwd(), Deno.env.get("CF_PATTERN_COVERAGE_DIR")!)
        : undefined;
      if (options.compileOnly) {
        const { failed } = await compileTestPatterns(uniqueTestFiles, {
          root,
          dataFilePaths: options.datafile?.map((path: string) =>
            resolve(Deno.cwd(), path)
          ),
          patternCoverageDir,
        });
        if (failed.length > 0) {
          Deno.exit(1);
        }
        return;
      }

      const statsInclude = options.statsInclude
        ? String(options.statsInclude)
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
        : undefined;

      // Run tests
      const { failed } = await runTests(uniqueTestFiles, {
        verbose: options.verbose,
        cfcEnforcementMode: options.cfcShellPosture
          ? "enforce-explicit"
          : options.cfcEnforcementMode,
        cfcFlowLabels: options.cfcShellPosture
          ? "persist"
          : options.cfcFlowLabels === "derive"
          ? "observe"
          : options.cfcFlowLabels,
        cfcDenials: options.cfcDenials,
        noIdempotencyCheck: options.idempotencyCheck === false,
        root,
        dataFilePaths: options.datafile?.map((path: string) =>
          resolve(Deno.cwd(), path)
        ),
        statsThreshold: options.statsThreshold,
        statsInclude,
        statsActionLimit: options.statsActionLimit,
        storageStats: options.storageStats,
        storageStatsLimit: options.storageStatsLimit,
        timingMeasuresOut: options.timingMeasuresOut
          ? resolve(Deno.cwd(), options.timingMeasuresOut)
          : undefined,
        patternCoverageDir,
        continuousUI: Deno.env.get("CF_TEST_CONTINUOUS_UI") === "1",
        recordResults,
      });

      // Exit with error code if any tests failed
      if (failed > 0) {
        Deno.exit(1);
      }
    });
}

export const test = createTestCommand();
