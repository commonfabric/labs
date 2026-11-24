/**
 * The tests every read-budget test file registers for its group of cases, so
 * that each group's file holds its cases to the same checks. Each case runs in
 * the test's own process, through the same phases the probe measures.
 */

import { expect } from "@std/expect";
import { basename, fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { caseNamed, measureCasePhases } from "./topics-cost-cases.ts";
import {
  limitsExceeded,
  type ReadBudgetGroup,
  readBudgetGroups,
  readBudgetRegistration,
  readBudgetTestFile,
  readBudgetTestFiles,
  TOPICS_READ_BUDGET_GROUPS,
} from "./topics-read-budget.ts";
import { TOPICS_READ_BUDGET_LIMITS } from "./topics-read-budget-limits.ts";

/**
 * Registers the read-budget tests of `group` inside the calling `describe()`,
 * for the test file at `testFile`, a `file:` URL:
 *
 * - that `testFile` is the file named for `group`, and sits beside one test
 *   file for each other group, each running the cases of the group it is
 *   named for;
 * - that the limits table holds limits for exactly the cases the groups name;
 * - for each of the group's cases, that every count its phases record stays
 *   within its limit.
 *
 * Each case is measured once, in this process. The regression variant each
 * limit is assigned to is run by `--derive-limits`, which the "Topics read
 * budget" section of `docs/development/BENCHMARKS.md` describes.
 */
export function describeReadBudgetGroup(
  group: ReadBudgetGroup,
  testFile: string,
): void {
  it("runs in the test file named for its group", () => {
    expect(basename(fromFileUrl(testFile))).toBe(
      `topics-read-budget-${group}.test.ts`,
    );
  });

  it("sits beside one test file for each group, each running its group", async () => {
    const directory = new URL(".", import.meta.url);
    const files: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (/^topics-read-budget-.+\.test\.ts$/.test(entry.name)) {
        files.push(entry.name);
      }
    }
    expect(files.toSorted()).toEqual(readBudgetTestFiles());
    const registered = await Promise.all(
      readBudgetGroups().map(async (other) => {
        const file = readBudgetTestFile(other);
        const source = await Deno.readTextFile(new URL(file, directory));
        const registration = readBudgetRegistration(other);
        return source.split("\n").some((line) => line.trim() === registration)
          ? file
          : `${file} (runs no read-budget group)`;
      }),
    );
    expect(registered.toSorted()).toEqual(readBudgetTestFiles());
  });

  it("holds limits for exactly the cases the read-budget groups name", () => {
    expect(Object.keys(TOPICS_READ_BUDGET_LIMITS).toSorted()).toEqual(
      Object.values(TOPICS_READ_BUDGET_GROUPS).flat().toSorted(),
    );
  });

  for (const id of TOPICS_READ_BUDGET_GROUPS[group]) {
    const probeCase = caseNamed(id);
    describe(id, () => {
      it("stays within each of its limits in every phase", async () => {
        const { phases } = await measureCasePhases(probeCase);
        expect(limitsExceeded(probeCase, phases)).toEqual([]);
      });
    });
  }
}
