import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  readWholeRuns,
  RECORDS_DIR_VARIABLE,
  type WholeRun,
} from "@commonfabric/test-support/records";
import { runDenoWebTest } from "./utils.ts";

/**
 * What a run leaves in a spool of its own, read once the run has settled.
 * The project is copied inside a repository unless `inRepository` is false.
 */
async function marksOf(
  projectDir: string,
  { inRepository = true }: { inRepository?: boolean } = {},
): Promise<WholeRun[]> {
  const spool = await Deno.makeTempDir();
  try {
    await runDenoWebTest(projectDir, { [RECORDS_DIR_VARIABLE]: spool }, {
      inRepository,
    });
    return await readWholeRuns(spool);
  } finally {
    await Deno.remove(spool, { recursive: true });
  }
}

describe("whole-run", () => {
  it("names every test of a run that ran them all", async () => {
    // A run shuffles its order, so the names are compared as sets.
    const marks = await marksOf("success-project");
    expect(marks.map((mark) => ({
      ...mark,
      tests: Object.fromEntries(
        Object.entries(mark.tests).map(([file, names]) => [
          file,
          new Set(names),
        ]),
      ),
    }))).toEqual([{
      kind: "browser",
      scope: "deno-web-test-success-project",
      tests: {
        "success-project/add.test.ts": new Set(["add-sync", "add-async"]),
      },
    }]);
  });

  it("names nothing for a run of files inside no repository", async () => {
    // Such a file is no test of a repository, so it has no
    // repository-relative path to be named by.
    expect(await marksOf("success-project", { inRepository: false }))
      .toEqual([]);
  });

  it("names nothing for a run that never reached its tests", async () => {
    expect(await marksOf("broken-config-project")).toEqual([]);
  });

  it("names nothing for a run that has a test it never ran", async () => {
    // The page registered that test after the run had counted the file's
    // tests, so nothing ran it.
    expect(await marksOf("late-registration-project")).toEqual([]);
  });

  it("names nothing for a run one of whose files failed to load", async () => {
    // The other file may load and run, but the run cannot say what the
    // file that failed would have registered.
    expect(await marksOf("load-error-project")).toEqual([]);
  });
});
