import { beforeAll, describe, it } from "@std/testing/bdd";
import { walkSync } from "@std/fs/walk";
import { basename, isAbsolute, relative, resolve, SEPARATOR } from "@std/path";

export interface Fixture {
  readonly rootDir: string;
  readonly inputPath: string;
  readonly expectedPath: string;
  readonly relativeInputPath: string;
  readonly relativeExpectedPath: string;
  readonly stem: string;
  readonly extension: string;
  readonly id: string;
  readonly baseName: string;
}

export interface FixtureContext<Warmup> {
  readonly warmup: Warmup;
  readonly shouldUpdateGolden: boolean;
  readonly rootDir: string;
}

export interface FixtureGroup {
  readonly name: string;
  readonly fixtures: Fixture[];
}

type MaybePromise<T> = T | Promise<T>;

export interface FixtureSuiteConfig<Actual, Expected, Warmup = void> {
  suiteName: string;

  /**
   * Root directory containing fixture files. Resolved relative to the current
   * working directory of the test process.
   */
  rootDir: string;

  /**
   * Pattern for identifying input fixtures. Defaults to `/\.input\.(ts|tsx)$/i`.
   */
  inputPattern?: RegExp;

  /**
   * Computes the path to the expected output relative to the fixture root.
   */
  expectedPath: (details: {
    stem: string;
    extension: string;
    relativeInputPath: string;
  }) => string;

  /**
   * Optional filter to skip fixtures.
   */
  skip?: (fixture: Fixture) => boolean;

  /**
   * Optional grouping for nested describe blocks.
   */
  groupBy?: (fixture: Fixture) => string | undefined;

  /**
   * Custom comparator for fixture ordering.
   */
  sortFixtures?: (a: Fixture, b: Fixture) => number;

  /**
   * Friendly test name formatter. Defaults to the fixture stem.
   */
  formatTestName?: (fixture: Fixture) => string;

  /**
   * Optional warmup hook executed once before tests run.
   */
  warmup?: () => MaybePromise<Warmup>;

  /**
   * Optional hook executed before each fixture test.
   */
  beforeEach?: (
    fixture: Fixture,
    ctx: FixtureContext<Warmup>,
  ) => MaybePromise<void>;

  /**
   * Produce the actual output for a fixture.
   */
  execute: (
    fixture: Fixture,
    ctx: FixtureContext<Warmup>,
  ) => MaybePromise<Actual>;

  /**
   * Load the expected output for a fixture.
   */
  loadExpected: (
    fixture: Fixture,
    ctx: FixtureContext<Warmup>,
  ) => MaybePromise<Expected>;

  /**
   * Compare actual vs expected values.
   */
  compare: (
    actual: Actual,
    expected: Expected,
    fixture: Fixture,
    ctx: FixtureContext<Warmup>,
  ) => MaybePromise<void>;

  /**
   * Optional determinism check for executions that should be stable across
   * multiple invocations (e.g., schema generation).
   */
  determinismCheck?: (
    actual: Actual,
    fixture: Fixture,
    ctx: FixtureContext<Warmup>,
  ) => MaybePromise<void>;

  /**
   * Handle golden updates when `UPDATE_GOLDENS=1`.
   */
  updateGolden?: (
    actual: Actual,
    fixture: Fixture,
    ctx: FixtureContext<Warmup>,
  ) => MaybePromise<void>;
}

export function shouldUpdateGoldens(): boolean {
  return Deno.env.get("UPDATE_GOLDENS") === "1";
}

export function createUnifiedDiff(
  expected: string,
  actual: string,
  context = 3,
): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const maxLines = Math.max(expectedLines.length, actualLines.length);
  const diffRanges: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < maxLines; i++) {
    const e = expectedLines[i] ?? "";
    const a = actualLines[i] ?? "";
    if (e === a) continue;
    const lastRange = diffRanges[diffRanges.length - 1];
    if (lastRange && i <= lastRange.end + context * 2) {
      lastRange.end = i;
    } else {
      diffRanges.push({ start: i, end: i });
    }
  }

  if (diffRanges.length === 0) return "";

  let diff = "";
  for (const range of diffRanges) {
    const blockStart = Math.max(0, range.start - context);
    const blockEnd = Math.min(maxLines - 1, range.end + context);
    const lines: string[] = [];

    for (let i = blockStart; i <= blockEnd; i++) {
      const e = expectedLines[i] ?? "";
      const a = actualLines[i] ?? "";
      if (e === a) {
        lines.push(`  ${e}`);
      } else {
        if (i < expectedLines.length && e !== "") lines.push(`- ${e}`);
        if (i < actualLines.length && a !== "") lines.push(`+ ${a}`);
      }
    }

    const expectedCount = lines.filter((line) => !line.startsWith("+")).length;
    const actualCount = lines.filter((line) => !line.startsWith("-")).length;
    diff += `@@ -${blockStart + 1},${expectedCount} +${
      blockStart + 1
    },${actualCount} @@\n`;
    diff += `${lines.join("\n")}\n\n`;
  }

  return diff.trimEnd();
}

export function defineFixtureSuite<Actual, Expected, Warmup = void>(
  config: FixtureSuiteConfig<Actual, Expected, Warmup>,
): void {
  const {
    suiteName,
    rootDir,
    expectedPath,
    inputPattern = /\.input\.(ts|tsx)$/i,
    skip,
    groupBy,
    sortFixtures,
    formatTestName,
    warmup,
    beforeEach,
    execute,
    loadExpected,
    compare,
    determinismCheck,
    updateGolden,
  } = config;

  const absoluteRoot = resolve(rootDir);
  const fixtures = collectFixtures(absoluteRoot, inputPattern, expectedPath)
    .filter((fixture) => !skip || !skip(fixture));

  const sorter = sortFixtures ?? defaultSort;
  fixtures.sort(sorter);

  const shouldUpdate = shouldUpdateGoldens();

  describe(suiteName, () => {
    let warmupValue: Warmup;

    beforeAll(async () => {
      warmupValue = (warmup ? await warmup() : undefined) as Warmup;
    });

    const registerTest = (fixture: Fixture) => {
      const testName = formatTestName ? formatTestName(fixture) : fixture.id;
      it(testName, async () => {
        const ctx: FixtureContext<Warmup> = {
          warmup: warmupValue,
          shouldUpdateGolden: shouldUpdate,
          rootDir: absoluteRoot,
        };

        if (beforeEach) {
          await beforeEach(fixture, ctx);
        }

        const actual = await execute(fixture, ctx);

        if (determinismCheck) {
          await determinismCheck(actual, fixture, ctx);
        }

        if (ctx.shouldUpdateGolden) {
          if (!updateGolden) {
            throw new Error(
              `UPDATE_GOLDENS=1, but no updateGolden handler provided for fixture suite "${suiteName}".`,
            );
          }
          await updateGolden(actual, fixture, ctx);
          return;
        }

        const expected = await loadExpected(fixture, ctx);
        await compare(actual, expected, fixture, ctx);
      });
    };

    if (groupBy) {
      const groups = new Map<string, Fixture[]>();
      const ungrouped: Fixture[] = [];

      for (const fixture of fixtures) {
        const groupName = groupBy(fixture);
        if (groupName) {
          const bucket = groups.get(groupName) ?? [];
          bucket.push(fixture);
          groups.set(groupName, bucket);
        } else {
          ungrouped.push(fixture);
        }
      }

      for (const [name, groupFixtures] of groups) {
        describe(name, () => {
          groupFixtures.sort(sorter);
          for (const fixture of groupFixtures) {
            registerTest(fixture);
          }
        });
      }

      for (const fixture of ungrouped) {
        registerTest(fixture);
      }
    } else {
      for (const fixture of fixtures) {
        registerTest(fixture);
      }
    }
  });
}

function defaultSort(a: Fixture, b: Fixture): number {
  return a.id.localeCompare(b.id);
}

function collectFixtures(
  absoluteRoot: string,
  inputPattern: RegExp,
  expectedPath: FixtureSuiteConfig<unknown, unknown>["expectedPath"],
): Fixture[] {
  const fixtures: Fixture[] = [];
  const normalizedRoot = absoluteRoot.endsWith(SEPARATOR)
    ? absoluteRoot.slice(0, -1)
    : absoluteRoot;

  try {
    for (const entry of walkSync(absoluteRoot, { includeDirs: false })) {
      const relativeInputPath = relative(normalizedRoot, entry.path);
      if (!matchesPattern(inputPattern, normalizeId(relativeInputPath))) {
        continue;
      }

      const stem = stripInputSuffix(relativeInputPath);
      const extension = extractExtension(relativeInputPath);
      const expectedRelative = expectedPath({
        stem,
        extension,
        relativeInputPath,
      });
      const absoluteExpected = isAbsolute(expectedRelative)
        ? expectedRelative
        : resolve(absoluteRoot, expectedRelative);
      const relativeExpectedPath = relative(normalizedRoot, absoluteExpected);

      fixtures.push({
        rootDir: absoluteRoot,
        inputPath: entry.path,
        expectedPath: absoluteExpected,
        relativeInputPath,
        relativeExpectedPath,
        stem,
        extension,
        id: normalizeId(stem),
        baseName: basename(stem),
      });
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return fixtures;
    }
    throw error;
  }

  return fixtures;
}

function matchesPattern(pattern: RegExp, value: string): boolean {
  if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
  return pattern.test(value);
}

function stripInputSuffix(relativePath: string): string {
  const marker = ".input.";
  const index = relativePath.lastIndexOf(marker);
  if (index === -1) return normalizeId(relativePath);
  return normalizeId(relativePath.slice(0, index));
}

function extractExtension(relativePath: string): string {
  const marker = ".input.";
  const index = relativePath.lastIndexOf(marker);
  if (index === -1) return "";
  const suffix = relativePath.slice(index + marker.length);
  return suffix ? `.${suffix}` : "";
}

function normalizeId(value: string): string {
  return value.split(SEPARATOR).join("/");
}
