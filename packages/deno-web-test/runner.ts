import { ConsoleEvent } from "@astral/astral";
import { basename } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  FragmentWriter,
  markWholeRun,
  repositoryRelativePath,
} from "@commonfabric/test-support/records";
import {
  shuffled,
  shuffledPaths,
  shuffleNotice,
  shuffleSeed,
} from "@commonfabric/test-support/shuffle";

import { Manifest } from "./manifest.ts";
import { summarize } from "./utils.ts";
import { BrowserController } from "./browser.ts";
import { Reporter } from "./reporter.ts";
import { TestFileResults, TestResultError } from "./interface.ts";

// The record scope of the harnessed package: the last segment of its
// manifest's name, or the directory's own name when no manifest names it.
// deno.json is read first because Deno resolves it first when both exist.
async function packageScope(): Promise<string> {
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    try {
      const parsed = parseJsonc(await Deno.readTextFile(manifest)) as {
        name?: string;
      };
      if (typeof parsed.name === "string" && parsed.name.length > 0) {
        return parsed.name.split("/").at(-1) ?? parsed.name;
      }
    } catch {
      // The next candidate or the fallback answers instead.
    }
  }
  return basename(Deno.cwd());
}

export class Runner {
  manifest: Manifest;
  reporter: Reporter;
  browser: BrowserController;
  results: TestFileResults[];

  constructor(manifest: Manifest, serverPort: number) {
    this.manifest = manifest;
    this.reporter = new Reporter();
    this.results = [];
    this.browser = new BrowserController(manifest, serverPort);
    this.browser.addEventListener(
      "console",
      (e: Event) => this.onConsole(e as ConsoleEvent),
    );
  }

  /** Runs all tests in the browser, returning whether all of them passed. */
  async run(): Promise<boolean> {
    this.reporter.onRunStart();

    // One browser-kind record per completed test, spooled as results
    // arrive so a killed run keeps everything that finished. The scope is
    // the harnessed package, read from the manifest of the working
    // directory the consuming task runs in; the directory's own name is
    // the fallback for a package without one. A file that fails to import
    // produces no per-test results and so records nothing; the run's
    // failure stays visible in CI. A file inside no repository is no test
    // of one and records nothing either.
    const recordsFragment = FragmentWriter.openForRun();
    const scope = await packageScope();

    // Files and the tests inside them both run in the order the seed
    // puts them in, which is finer than `deno test --shuffle` reaches:
    // that flag reorders a file's top-level registrations, and a file
    // whose tests are steps of one registration keeps them in place.
    const seed = shuffleSeed();
    console.log(shuffleNotice(seed));

    // How many tests the files registered. A run that loaded every file
    // and has a result for every test each registered names those tests
    // in the spool, and a run that does not says nothing.
    let registered = 0;

    try {
      for (const tsTestPath of shuffledPaths(this.manifest.tests, seed)) {
        const results: TestFileResults = {
          fileName: tsTestPath,
          tests: [],
        };
        this.results.push(results);

        try {
          await this.browser.load(tsTestPath);
        } catch (e: unknown) {
          this.reporter.onLoadError(tsTestPath, e as TestResultError);
          return false;
        }

        const testCount = await this.browser.getTestCount();
        this.reporter.onFileStart(tsTestPath, testCount);
        const file = repositoryRelativePath(tsTestPath);

        const order = shuffled(
          Array.from({ length: testCount }, (_, index) => index),
          seed,
        );
        for (const index of order) {
          const testResult = await this.browser.runTest(index);
          if (!testResult) {
            break;
          }
          results.tests.push(testResult);
          this.reporter.onTestCompleted(testResult);
          if (file === undefined) continue;
          recordsFragment?.append({
            line: "record",
            test: { k: "browser", s: scope, n: testResult.name },
            outcome: testResult.error === null ? "pass" : "fail",
            durationMs: Math.round(testResult.duration),
            file,
          });
        }
        this.reporter.onFileEnd(tsTestPath);
        // Counted again once the file's tests have run, so that a test the
        // page registered after the first count counts too.
        registered += await this.browser.getTestCount();
      }
      const ran = this.results.reduce(
        (total, file) => total + file.tests.length,
        0,
      );
      // A file inside no repository is no test of one, so it has no place
      // in the mark either, and a run of only such files leaves none.
      const tests = Object.fromEntries(
        this.results.flatMap((file) => {
          const path = repositoryRelativePath(file.fileName);
          return path === undefined
            ? []
            : [[path, file.tests.map((test) => test.name)]];
        }),
      );
      if (ran === registered && Object.keys(tests).length > 0) {
        markWholeRun({ kind: "browser", scope, tests });
      }

      const summary = summarize(this.results);
      this.reporter.onRunEnd(summary);
      return summary.failed.length === 0;
    } finally {
      recordsFragment?.close();
      // The manifest's directories are removed once this returns, so the
      // browser closes first, whichever way the run ended.
      await this.browser.close();
    }
  }

  onConsole(e: ConsoleEvent) {
    if (this.manifest.config.pipeConsole) {
      switch (e.detail.type) {
        case "warning":
          console.warn(`browser: ${e.detail.text}`);
          break;
        case "log":
        case "info":
        case "debug":
        case "error":
          console[e.detail.type](`browser: ${e.detail.text}`);
          break;
      }
    }
  }
}
