import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  candidateSurfaces,
  check,
  checkStore,
  checkTree,
  checkWorkflows,
  main,
  parseCheckArgs,
  readRecords,
  report,
  USAGE,
  UsageError,
  workflowRecords,
} from "./check-test-topology.ts";
import { AliasResolver } from "@commonfabric/test-support/records";
import type { Suite } from "./test-topology/suite.ts";

/** A suite holding exactly what a case describes. */
function suite(partial: Partial<Suite> & { id: string }): Suite {
  return {
    recordSurfaces: [{ kind: "unit", scope: "bakery" }],
    needs: ["deno"],
    units: [],
    unavailable: [],
    whole: [],
    locate: () => undefined,
    command: () => Promise.resolve([]),
    ...partial,
  };
}

describe("the tree half of the drift guard", () => {
  it("passes a file some suite enumerates", () => {
    const suites = [
      suite({ id: "workspace-unit", units: ["packages/bakery/glaze.test.ts"] }),
    ];
    expect(checkTree(suites, ["packages/bakery/glaze.test.ts"])).toEqual([]);
  });

  it("fails a file no suite accounts for", () => {
    const findings = checkTree([suite({ id: "workspace-unit" })], [
      "packages/bakery/glaze.test.ts",
    ]);
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("claimed by no suite");
  });

  it("accepts a file inside a unit coarser than a file", () => {
    // A workspace member that runs whole, or a directory one task owns,
    // accounts for what it contains.
    const suites = [
      suite({ id: "workspace-unit", units: ["packages/bakery"] }),
    ];
    expect(checkTree(suites, ["packages/bakery/glaze.test.ts"])).toEqual([]);
  });

  it("lets a default suite and a variant suite claim one file", () => {
    const suites = [
      suite({ id: "package-integration", units: ["packages/oven/a.test.ts"] }),
      suite({
        id: "package-integration-on",
        variant: "server-execution",
        units: ["packages/oven/a.test.ts"],
      }),
    ];
    expect(checkTree(suites, ["packages/oven/a.test.ts"])).toEqual([]);
  });

  it("fails two suites claiming one file under the same variant", () => {
    const suites = [
      suite({ id: "one", units: ["packages/oven/a.test.ts"] }),
      suite({ id: "other", units: ["packages/oven/a.test.ts"] }),
    ];
    const findings = checkTree(suites, ["packages/oven/a.test.ts"]);
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("one and other");
  });

  it("accepts a file a configuration declares unavailable", () => {
    const suites = [
      suite({
        id: "package-integration-on",
        variant: "server-execution",
        unavailable: [{
          unit: "packages/oven/a.test.ts",
          phase: "phase-3",
          reason: "the surface it exercises has not landed",
        }],
      }),
    ];
    expect(checkTree(suites, ["packages/oven/a.test.ts"])).toEqual([]);
  });

  it("accepts a script a suite names as a source of its own", () => {
    // A suite whose units are dispatch arms names the scripts those arms
    // run, because no arm is a path.
    const suites = [
      suite({
        id: "cli-core",
        units: ["integration.sh verbs"],
        sources: ["packages/cli/integration/integration.sh"],
      }),
    ];
    expect(checkTree(suites, ["packages/cli/integration/integration.sh"]))
      .toEqual([]);
  });
});

describe("the store half of the drift guard", () => {
  /** The commit the tree under test is checked out at. */
  const HERE = "0f1e2d3c";

  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/test/glaze.test.ts"],
    locate: (record) =>
      record.file === "packages/bakery/test/glaze.test.ts"
        ? { level: "unit", unit: record.file }
        : undefined,
  });

  it("passes a recorded identity exactly one suite claims", () => {
    const findings = checkStore([bakery], [{
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      file: "packages/bakery/test/glaze.test.ts",
      commit: HERE,
    }], HERE);
    expect(findings.filter((finding) => finding.fails)).toEqual([]);
  });

  it("fails an identity no suite recognizes", () => {
    const findings = checkStore([bakery], [{
      test: { k: "unit", s: "bakery", n: "icing > sets" },
      file: "packages/bakery/icing.test.ts",
      commit: HERE,
    }], HERE);
    expect(
      findings.some((finding) =>
        finding.fails && finding.message.includes("no suite claims")
      ),
    ).toBe(true);
  });

  it("fails an identity two suites claim", () => {
    const twin = suite({ ...bakery, id: "runner-unit" });
    const findings = checkStore([bakery, twin], [{
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      file: "packages/bakery/test/glaze.test.ts",
      commit: HERE,
    }], HERE);
    expect(
      findings.some((finding) =>
        finding.fails && finding.message.includes("both claim")
      ),
    ).toBe(true);
  });

  it("says nothing about the lane measuring its own setup and batches", () => {
    // The lane writes these through the same record machinery every test
    // uses, and no suite claims them: nothing enumerates them and no lane
    // can be asked to run one. Failing on them would fail every `main`
    // run the moment lanes exist.
    const findings = checkStore([bakery], [
      {
        test: { k: "gate", s: "ci", n: "ci-lane setup toolshed-baked-on" },
        commit: HERE,
      },
      {
        test: { k: "gate", s: "ci", n: "ci-lane batch workspace-unit" },
        commit: HERE,
      },
      {
        test: { k: "unit", s: "bakery", n: "glaze > sets" },
        file: "packages/bakery/test/glaze.test.ts",
        commit: HERE,
      },
    ], HERE);
    expect(findings.filter((finding) => finding.fails)).toEqual([]);
  });

  it("still fails a gate-kind record that is not the lane's own", () => {
    const findings = checkStore([bakery], [
      {
        test: { k: "gate", s: "ci", n: "something nobody declared" },
        commit: HERE,
      },
    ], HERE);
    expect(
      findings.some((finding) =>
        finding.fails && finding.message.includes("no suite claims")
      ),
    ).toBe(true);
  });

  it("reports a unit the run never recorded rather than failing", () => {
    const findings = checkStore([bakery], [], HERE);
    expect(findings.map((finding) => finding.fails)).toEqual([false]);
    expect(findings[0]!.message).toContain("never recorded");
  });

  it("names the job and the file a failing identity came from", () => {
    // The identity says what disagreed. Acting on it means finding the
    // thing that wrote it, and a reader has neither the artifact nor the
    // source unless the finding carries them.
    const findings = checkStore([bakery], [{
      test: { k: "unit", s: "bakery", n: "icing > sets" },
      file: "packages/bakery/icing.test.ts",
      commit: HERE,
      from: "test-records-test-3-a1",
    }], HERE);
    expect(
      findings.filter((finding) => finding.fails).map((finding) =>
        finding.message
      ),
    ).toEqual([
      'no suite claims the recorded identity ["unit","bakery","icing > ' +
      'sets"], recorded by test-records-test-3-a1 from ' +
      "packages/bakery/icing.test.ts",
    ]);
  });

  it("says what it knows when a failing identity names less", () => {
    // A record read from a path given directly carries no artifact, and
    // one a suite locates by name carries no file. The finding says
    // whichever it has and reads as a sentence either way.
    const gates = suite({
      id: "repo-gates",
      recordSurfaces: [{ kind: "gate", scope: "repo" }],
      units: ["deno-fmt"],
    });
    const findings = checkStore([gates], [{
      test: { k: "gate", s: "repo", n: "a gate nobody declares" },
      commit: HERE,
      from: "test-records-check-a1",
    }], HERE);
    expect(
      findings.filter((finding) => finding.fails).map((finding) =>
        finding.message
      ),
    ).toEqual([
      'no suite claims the recorded identity ["gate","repo","a gate nobody ' +
      'declares"], recorded by test-records-check-a1',
    ]);
  });

  it("names which artifact carried a commit that is not this tree's", () => {
    // Two artifacts of one download are two jobs. Which of them is from
    // another build is what somebody has to go and look at.
    const findings = checkStore([bakery], [
      {
        test: { k: "unit", s: "bakery", n: "glaze > sets" },
        file: "packages/bakery/test/glaze.test.ts",
        commit: HERE,
        from: "test-records-test-1-a1",
      },
      {
        test: { k: "unit", s: "bakery", n: "glaze > clears" },
        commit: "9a8b7c6d",
        from: "test-records-test-2-a1",
      },
      { test: { k: "unit", s: "bakery", n: "glaze > melts" }, from: "stray" },
    ], HERE);
    expect(findings.map((finding) => finding.message)).toEqual([
      "the records name 9a8b7c6d (test-records-test-2-a1), no commit at " +
      `all from stray and this tree is ${HERE}: the store half judges a ` +
      "tree by the records that tree produced",
    ]);
  });

  it("refuses records from another commit rather than judging them", () => {
    // The change between the two commits deleted the test, so this tree
    // has no unit for an identity that run recorded. Reading the two as
    // a disagreement would fail the default branch for deleting a test.
    const findings = checkStore([bakery], [{
      test: { k: "unit", s: "bakery", n: "icing > sets" },
      file: "packages/bakery/icing.test.ts",
      commit: "9a8b7c6d",
    }], HERE);
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("9a8b7c6d");
    expect(findings[0]!.message).not.toContain("no suite claims");
  });

  it("refuses a record that names no commit at all", () => {
    // A group with no context is a group nothing can hold to this tree,
    // so the guard cannot say whether it agrees with it.
    const findings = checkStore([bakery], [{
      test: { k: "unit", s: "bakery", n: "icing > sets" },
      file: "packages/bakery/icing.test.ts",
    }], HERE);
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("no commit");
  });

  it("judges records from this commit", () => {
    const findings = checkStore([bakery], [{
      test: { k: "unit", s: "bakery", n: "icing > sets" },
      file: "packages/bakery/icing.test.ts",
      commit: HERE,
    }], HERE);
    expect(
      findings.some((finding) =>
        finding.fails && finding.message.includes("no suite claims")
      ),
    ).toBe(true);
  });

  it("says nothing about a unit a configuration declares unavailable", () => {
    const withSkip = suite({
      ...bakery,
      unavailable: [{
        unit: "packages/bakery/test/glaze.test.ts",
        reason: "the surface it exercises has not landed",
      }],
    });
    expect(checkStore([withSkip], [], HERE)).toEqual([]);
  });
});

describe("what the tree half looks at", () => {
  /** A tree holding the files a case names. */
  async function tree(files: readonly string[]): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "surfaces-" });
    for (const file of files) {
      const at = `${root}/${file}`;
      await Deno.mkdir(at.slice(0, at.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(at, "");
    }
    return root;
  }

  it("finds every shape Deno takes for a test file", async () => {
    const root = await tree([
      "packages/oven/test/bake.test.ts",
      "packages/oven/test/glaze.test.tsx",
      "packages/oven/test/proof_test.ts",
      "packages/oven/test/test.ts",
      "packages/oven/src/oven.ts",
    ]);
    try {
      expect(await candidateSurfaces(root)).toEqual([
        "packages/oven/test/bake.test.ts",
        "packages/oven/test/glaze.test.tsx",
        "packages/oven/test/proof_test.ts",
        "packages/oven/test/test.ts",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("finds a shell script only where an integration directory holds it", async () => {
    const root = await tree([
      "packages/cli/integration/acl.sh",
      "packages/cli/support/release.sh",
    ]);
    try {
      expect(await candidateSurfaces(root)).toEqual([
        "packages/cli/integration/acl.sh",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("never descends into the directories the walk is told to skip", async () => {
    // These hold test files; what keeps them out is their names.
    const root = await tree([
      "packages/oven/node_modules/dep/a.test.ts",
      "packages/oven/dist/b.test.ts",
      "packages/oven/test/c.test.ts",
    ]);
    try {
      expect(await candidateSurfaces(root)).toEqual([
        "packages/oven/test/c.test.ts",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("holds a listed fixture to still being in the tree", () => {
    // A file that gets registered or deleted takes its line with it,
    // which is what stops the list describing a tree nobody has.
    const findings = checkTree([], [], {
      fixtures: [{ path: "packages/gone.test.ts", reason: "moved away" }],
    });
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("no longer holds it");
  });

  it("holds a listed fixture to still being unclaimed", () => {
    const claimed = suite({ id: "workspace-unit", units: ["a.test.ts"] });
    const findings = checkTree([claimed], ["a.test.ts"], {
      fixtures: [{ path: "a.test.ts", reason: "a fixture a test drives" }],
    });
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("still listed as a fixture");
  });
});

describe("the workflow half of the drift guard", () => {
  const gates = suite({
    id: "repo-checks",
    units: ["check-icing"],
    locate: (record) =>
      record.test.k === "gate" && record.test.s === "repo" &&
        record.test.n === "check-icing"
        ? { level: "unit", unit: record.test.n }
        : undefined,
  });

  /** One step, written the way a workflow writes it. */
  function step(k: string, s: string, n: string) {
    return { test: { k, s, n }, where: ".github/workflows/deno.yml" };
  }

  it("passes a step exactly one suite claims", () => {
    const findings = checkWorkflows([gates], [
      step("gate", "repo", "check-icing"),
    ]);
    expect(findings).toEqual([]);
  });

  it("fails a step no suite claims", () => {
    // A gate wired into a job and into no suite runs while its step
    // stands and stops when a lane takes over the job.
    const findings = checkWorkflows([gates], [
      step("gate", "repo", "check-glaze"),
    ]);
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain(
      'no suite claims ["gate","repo","check-glaze"], which ' +
        ".github/workflows/deno.yml records",
    );
  });

  it("fails a step two suites claim", () => {
    const findings = checkWorkflows(
      [gates, { ...gates, id: "repo-gates" }],
      [step("gate", "repo", "check-icing")],
    );
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toContain("both claim");
  });

  it("counts one identity once, however many steps write it", () => {
    const findings = checkWorkflows([gates], [
      step("gate", "repo", "check-glaze"),
      step("gate", "repo", "check-glaze"),
    ]);
    expect(findings.length).toBe(1);
  });
});

describe("what the workflow half looks at", () => {
  /** A tree holding the step definitions a case names. */
  async function workflows(files: Record<string, string>): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "workflows-" });
    for (const [at, body] of Object.entries(files)) {
      const file = `${root}/.github/${at}`;
      await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(file, body);
    }
    return root;
  }

  it("reads the identity out of a step, however the step is wrapped", async () => {
    const root = await workflows({
      "workflows/deno.yml": [
        "      - run: deno task run-recorded gate repo check-icing -- deno task x",
        "      - run: >-",
        "          deno task run-recorded lint repo deno-lint --",
        "          deno lint",
        "      - run: |",
        "          deno task run-recorded test oven bake -- \\",
        "            deno test",
      ].join("\n"),
    });
    try {
      expect((await workflowRecords(root)).map((found) => found.test)).toEqual([
        { k: "gate", s: "repo", n: "check-icing" },
        { k: "lint", s: "repo", n: "deno-lint" },
        { k: "test", s: "oven", n: "bake" },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads no step out of a comment naming the wrapper", async () => {
    // Both shapes a comment takes: a line of its own, and the tail of a
    // line that carries something else. Each holds a whole invocation,
    // so what keeps them out is that they are comments.
    const root = await workflows({
      "workflows/deno.yml": [
        "      # deno task run-recorded gate repo ghost -- deno task ghost",
        "      - run: deno task check # deno task run-recorded gate repo old --",
      ].join("\n"),
    });
    try {
      expect(await workflowRecords(root)).toEqual([]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads a step a quoted hash sits ahead of on its line", async () => {
    // A `#` the shell is handed as a character does not end the command,
    // so the step after it on that line still records and still counts.
    const root = await workflows({
      "workflows/deno.yml": [
        "      - run: |",
        '          echo "count # of things" && deno task run-recorded gate repo icing -- deno task x',
      ].join("\n"),
    });
    try {
      expect((await workflowRecords(root)).map((found) => found.test)).toEqual([
        { k: "gate", s: "repo", n: "icing" },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads a step a quoted hash with an escape in it sits ahead of", async () => {
    // The backslash takes the quote with it, so the quoted run has not
    // ended and the `#` inside it is still a character of the command.
    const root = await workflows({
      "workflows/deno.yml": [
        "      - run: |",
        '          echo "a \\" # b" && deno task run-recorded gate repo icing -- deno task x',
      ].join("\n"),
    });
    try {
      expect((await workflowRecords(root)).map((found) => found.test)).toEqual([
        { k: "gate", s: "repo", n: "icing" },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads an identity a workflow expression stands in the middle of", async () => {
    // A lane cannot be asked for an identity that is not settled until
    // the run resolves the expression, so the guard reads what is
    // written and lets no suite claim it.
    const root = await workflows({
      "workflows/deno.yml":
        "  run: deno task run-recorded unit ${{ matrix.scope }} test -- deno task test",
    });
    try {
      expect((await workflowRecords(root)).map((found) => found.test)).toEqual([
        { k: "unit", s: "${{ matrix.scope }}", n: "test" },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads a step whose parts are quoted rather than passing over it", async () => {
    const root = await workflows({
      "workflows/deno.yml":
        '  run: deno task run-recorded gate repo "check icing" -- deno task x',
    });
    try {
      expect((await workflowRecords(root)).map((found) => found.test.n))
        .toEqual(
          ['"check'],
        );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("names the workflow each step is written in", async () => {
    const root = await workflows({
      "workflows/nightly.yml":
        "  run: deno task run-recorded gate repo audit -- deno task a",
      "workflows/deno.yml":
        "  run: deno task run-recorded gate repo check -- deno task b",
    });
    try {
      expect((await workflowRecords(root)).map((found) => found.where)).toEqual(
        [
          ".github/workflows/deno.yml",
          ".github/workflows/nightly.yml",
        ],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads a step across the line continuations that break it up", async () => {
    const root = await workflows({
      "workflows/deno.yml": [
        "      - run: |",
        "          deno task run-recorded gate \\",
        "            repo check-icing -- \\",
        "            deno task check-icing",
      ].join("\n"),
    });
    try {
      expect((await workflowRecords(root)).map((found) => found.test)).toEqual([
        { k: "gate", s: "repo", n: "check-icing" },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads a step a composite action runs as well as one a workflow runs", async () => {
    const root = await workflows({
      "actions/ship/action.yml":
        "  run: deno task run-recorded gate repo ship -- deno task ship",
      "workflows/deno.yml":
        "  run: deno task run-recorded gate repo check -- deno task check",
    });
    try {
      expect((await workflowRecords(root)).map((found) => found.where)).toEqual(
        [
          ".github/actions/ship/action.yml",
          ".github/workflows/deno.yml",
        ],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads no step out of a file that is not a step definition", async () => {
    // Only the YAML under `.github` defines steps. A document beside it
    // quoting the wrapper is prose.
    const root = await workflows({
      "workflows/README.md":
        "  run: deno task run-recorded gate repo prose -- deno task prose",
      "workflows/deno.yml":
        "  run: deno task run-recorded gate repo real -- deno task real",
    });
    try {
      expect((await workflowRecords(root)).map((found) => found.test.n))
        .toEqual(["real"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("raises on a file ending in the middle of a recording step", async () => {
    // Three words follow the wrapper or the identity is not there to
    // read, and reading a shorter one would invent an identity.
    const root = await workflows({
      "workflows/deno.yml": "  run: deno task run-recorded gate repo",
    });
    try {
      await expect(workflowRecords(root)).rejects.toThrow(
        "ends in the middle of a recording step",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("raises rather than reading a shorter list of definitions", async () => {
    // A directory that cannot be read is not a directory that holds no
    // steps. Treating the two alike would report success over whatever
    // it managed to reach.
    const root = await Deno.makeTempDir({ prefix: "obstructed-" });
    try {
      await Deno.writeTextFile(`${root}/.github`, "not a directory");
      await expect(workflowRecords(root)).rejects.toThrow();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("finds nothing in a tree that defines no steps", async () => {
    const root = await Deno.makeTempDir({ prefix: "bare-" });
    try {
      expect(await workflowRecords(root)).toEqual([]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("reading a run's records", () => {
  it("takes every record of every report in a file", async () => {
    const at = await Deno.makeTempFile({ suffix: ".ndjson" });
    const context = {
      schema: 1,
      line: "context",
      reportId: "01GATHERTEST000000000000",
      repo: "commonfabric/labs",
      commit: "c".repeat(40),
      dirty: false,
      env: "local",
      os: "linux",
      arch: "x86_64",
      denoVersion: "2.9.4",
      startedAt: "2026-08-17T21:00:00.000Z",
    };
    await Deno.writeTextFile(
      at,
      [
        JSON.stringify(context),
        JSON.stringify({
          line: "record",
          test: { k: "unit", s: "oven", n: "bakes" },
          outcome: "pass",
          durationMs: 1,
          file: "packages/oven/test/bake.test.ts",
        }),
        JSON.stringify({
          line: "record",
          test: { k: "unit", s: "oven", n: "glazes", v: "server-execution" },
          outcome: "fail",
          durationMs: 2,
        }),
      ].join("\n") + "\n",
    );
    try {
      const records = await readRecords([at]);
      expect(records.map((record) => record.test.n)).toEqual([
        "bakes",
        "glazes",
      ]);
      // The file the producer knew travels with the record, because it
      // is what locates a unit identity.
      expect(records[0]!.file).toBe("packages/oven/test/bake.test.ts");
      expect(records[1]!.test.v).toBe("server-execution");
    } finally {
      await Deno.remove(at);
    }
  });

  it("reads a lane measuring itself as the lane wrote it", async () => {
    // A scope-wide alias line renames every identity in a scope, so one
    // covering the scope a lane measures itself on reaches the whole of
    // what a lane has ever written. The claim check asks which suite
    // claims a recorded identity, and no suite claims one of these.
    const at = await Deno.makeTempFile({ suffix: ".ndjson" });
    await Deno.writeTextFile(
      at,
      [
        JSON.stringify({
          schema: 1,
          line: "context",
          reportId: "01ALIASTEST00000000000000",
          repo: "commonfabric/labs",
          commit: "c".repeat(40),
          dirty: false,
          env: "local",
          os: "linux",
          arch: "x86_64",
          denoVersion: "2.9.4",
          startedAt: "2026-08-17T21:00:00.000Z",
        }),
        JSON.stringify({
          line: "record",
          test: { k: "gate", s: "ci", n: "ci-lane batch workspace-unit" },
          outcome: "pass",
          durationMs: 92_000,
        }),
        JSON.stringify({
          line: "record",
          test: { k: "unit", s: "ci", n: "bakes" },
          outcome: "pass",
          durationMs: 1,
        }),
      ].join("\n") + "\n",
    );
    try {
      const records = await readRecords(
        [at],
        new AliasResolver([{
          date: "2026-08-18",
          from: { k: "gate", s: "ci" },
          to: { k: "unit", s: "oven" },
        }, {
          date: "2026-08-18",
          from: { k: "unit", s: "ci" },
          to: { k: "unit", s: "oven" },
        }]),
      );
      // A report whose context does not parse has no day to resolve an
      // alias against, which leaves every identity as written and would
      // pass this case without the reading under test running at all.
      expect(records[0]!.commit).toBe("c".repeat(40));
      expect(records.map((record) => [record.test.k, record.test.s])).toEqual([
        ["gate", "ci"],
        // The test beside it takes its rename, so the resolver was live
        // and the measurement is what went past it.
        ["unit", "oven"],
      ]);
    } finally {
      await Deno.remove(at);
    }
  });
});

describe("what the guard declines to fail on", () => {
  it("accepts a declared fixture and fails on anything else", () => {
    const findings = checkTree([], ["fixture.test.ts", "unrun.test.ts"], {
      fixtures: [{ path: "fixture.test.ts", reason: "a test drives it" }],
    });
    // A fixture is not a test surface and says nothing. Everything else
    // is, so a suite has to account for it — a suite that runs it, or one
    // that holds it and says why this configuration does not.
    expect(findings.map((finding) => finding.fails)).toEqual([true]);
    expect(findings[0]!.message).toBe("unrun.test.ts is claimed by no suite");
  });

  it("counts one recorded identity once, however often it was run", () => {
    // Re-running a commit ten times says nothing new about whether the
    // topology claims what it produced.
    const bakery = suite({
      id: "workspace-unit",
      units: ["packages/bakery/test/glaze.test.ts"],
      locate: () => ({
        level: "unit",
        unit: "packages/bakery/test/glaze.test.ts",
      }),
    });
    const record = {
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      file: "packages/bakery/test/glaze.test.ts",
      commit: "c1",
    };
    expect(checkStore([bakery], [record, record, record], "c1"))
      .toEqual([]);
  });
});

describe("reading a run's gathered artifacts", () => {
  /** One downloaded artifact: what a job gathered, and what it knew. */
  async function artifact(
    root: string,
    name: string,
    facts: unknown,
    names: readonly string[],
  ): Promise<void> {
    const dir = `${root}/${name}`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/records.ndjson`,
      names.map((n) =>
        JSON.stringify({
          line: "record",
          test: { k: "unit", s: "oven", n },
          outcome: "pass",
          durationMs: 1,
        })
      ).join("\n") + "\n",
    );
    if (facts !== undefined) {
      await Deno.writeTextFile(`${dir}/job.json`, JSON.stringify(facts));
    }
  }

  it("holds a gathered artifact's records to the commit its job named", async () => {
    // A gathered artifact carries a run's records without the context a
    // report opens with, and the commit the store half holds a tree to is
    // beside them in the facts the job wrote.
    const root = await Deno.makeTempDir({ prefix: "artifacts-" });
    try {
      await artifact(root, "test-records-test-1", {
        job: "Test (1/8)",
        commit: "c0ffee",
      }, ["bakes"]);
      const records = await readRecords([root], new AliasResolver([]));
      expect(records.map((record) => record.commit)).toEqual(["c0ffee"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("gives each artifact the commit its own facts name", async () => {
    // Two artifacts of one download are two jobs, and nothing says they
    // were the same run. The store half is what refuses a mixture.
    const root = await Deno.makeTempDir({ prefix: "artifacts-" });
    try {
      await artifact(root, "a", { job: "A", commit: "aaa" }, ["one"]);
      await artifact(root, "b", { job: "B", commit: "bbb" }, ["two"]);
      const records = await readRecords([root], new AliasResolver([]));
      expect(
        records.map((record) => [record.test.n, record.commit]).sort(),
      ).toEqual([["one", "aaa"], ["two", "bbb"]]);
      // The artifact each came from travels with it, because a failing
      // identity is one somebody has to go and find.
      expect(records.map((record) => record.from).sort()).toEqual(["a", "b"]);
      // A file named directly is named as itself: there is no artifact
      // around it to point at, and its directory is not one.
      const named = await readRecords(
        [`${root}/a/records.ndjson`],
        new AliasResolver([]),
      );
      expect(named.map((record) => record.from)).toEqual([
        `${root}/a/records.ndjson`,
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("leaves records nameless where the facts beside them name nothing", async () => {
    // Facts without a commit, and no facts at all, are both a file that
    // cannot say which tree produced it. The store half refuses those
    // rather than reading them as this tree's.
    const root = await Deno.makeTempDir({ prefix: "artifacts-" });
    try {
      await artifact(root, "no-commit", { job: "A" }, ["one"]);
      await artifact(root, "no-facts", undefined, ["two"]);
      await artifact(root, "blank", { job: "C", commit: "" }, ["three"]);
      const records = await readRecords([root], new AliasResolver([]));
      expect(records.map((record) => record.commit)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("walks a directory of them, however deep each one sits", async () => {
    // A run that produced a single artifact arrives flattened into the
    // directory above, and one that produced many arrives as a directory
    // apiece. One name covers both.
    const root = await Deno.makeTempDir({ prefix: "artifacts-" });
    try {
      await artifact(root, "nested/deep", { job: "A", commit: "aaa" }, ["one"]);
      await artifact(root, ".", { job: "B", commit: "bbb" }, ["two"]);
      const records = await readRecords([root], new AliasResolver([]));
      expect(records.map((record) => record.test.n).sort()).toEqual([
        "one",
        "two",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("fails a path holding nothing beside one that holds records", async () => {
    // Each named path is a part of the run. One that arrived cannot
    // answer for one that did not, so summing them and asking whether
    // anything came back would validate a corpus only partly read.
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const dir = await Deno.makeTempDir({ prefix: "partial-" });
    try {
      await Deno.mkdir(`${dir}/present`);
      await Deno.writeTextFile(
        `${dir}/present/records.ndjson`,
        JSON.stringify({
          line: "record",
          test: { k: "unit", s: "oven", n: "bakes" },
          outcome: "pass",
          durationMs: 1,
        }) + "\n",
      );
      const missing = `${dir}/never-downloaded`;
      const { findings } = await check({
        root,
        store: { records: [`${dir}/present`, missing], commit: "c0ffee" },
      });
      expect(
        findings.filter((finding) => finding.fails).map((finding) =>
          finding.message
        ),
      ).toEqual([
        `${missing} hold no records, so the store half read nothing of ` +
        "what they were to carry",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("fails when the store half is asked for and finds no records", async () => {
    // A download that matched nothing, or a path misspelled, leaves the
    // guard with nothing to judge. It says so once: reporting every unit
    // the topology holds as never recorded would bury that line in
    // thousands of its own making.
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const empty = await Deno.makeTempDir({ prefix: "no-records-" });
    const missing = `${empty}/never-downloaded`;
    try {
      for (const at of [empty, missing]) {
        const { findings } = await check({
          root,
          store: { records: [at], commit: "c0ffee" },
        });
        expect(
          findings.filter((finding) => finding.fails).map((finding) =>
            finding.message
          ),
        ).toEqual([
          `${at} hold no records, so the store half read nothing of what ` +
          "they were to carry",
        ]);
        expect(
          findings.filter((finding) =>
            finding.message.includes("never recorded")
          ),
        ).toEqual([]);
      }
    } finally {
      await Deno.remove(empty);
    }
  });

  it("finds nothing under a path that holds no records or is not there", async () => {
    const root = await Deno.makeTempDir({ prefix: "empty-artifacts-" });
    try {
      expect(await readRecords([root], new AliasResolver([]))).toEqual([]);
      expect(
        await readRecords([`${root}/never-downloaded`], new AliasResolver([])),
      )
        .toEqual([]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

/** One run's records: a context naming the commit, and one record. */
function recordsAt(commit: string): string {
  return [
    JSON.stringify({
      line: "context",
      schema: 1,
      reportId: "01K3",
      repo: "commonfabric/labs",
      commit,
      dirty: false,
      branch: "main",
      env: "ci",
      ci: {
        workflowRunId: "1",
        runAttempt: 1,
        workflow: "deno.yml",
        job: "Lane 1",
        event: "push",
      },
      os: "linux",
      arch: "x86_64",
      denoVersion: "2.9.4",
      startedAt: "2026-08-20T01:00:00.000Z",
    }),
    JSON.stringify({
      line: "record",
      test: { k: "gate", s: "repo", n: "a gate nobody declares" },
      outcome: "pass",
      durationMs: 1,
    }),
  ].join("\n") + "\n";
}

describe("running the check and saying what it found", () => {
  it("runs the store half only when a run's records are named", () => {
    expect(parseCheckArgs([], "/repo")).toEqual({ root: "/repo" });
    expect(() => parseCheckArgs(["--records", "a.ndjson", "b.ndjson"], "/repo"))
      .toThrow(UsageError);
  });

  it("reads the commit the named records were produced at", () => {
    expect(
      parseCheckArgs(
        ["--commit", "0f1e2d3c", "--records", "a.ndjson"],
        "/repo",
      ),
    ).toEqual({
      root: "/repo",
      store: { records: ["a.ndjson"], commit: "0f1e2d3c" },
    });
  });

  it("refuses records named without the commit they were produced at", () => {
    // Without it nothing says whether the records describe this tree, and
    // a tree read against an earlier run's records disagrees with them
    // over every test deleted since.
    expect(() => parseCheckArgs(["--records", "a.ndjson"], "/repo"))
      .toThrow(UsageError);
    expect(() => parseCheckArgs(["--commit", "c1"], "/repo"))
      .toThrow(UsageError);
  });

  it("refuses an argument it does not understand", () => {
    // A record file passed over leaves the store half judging part of a
    // run and reporting that the topology accounts for everything.
    expect(() => parseCheckArgs(["a.ndjson"], "/repo")).toThrow(UsageError);
    expect(() => parseCheckArgs(["--commit"], "/repo")).toThrow(UsageError);
    expect(() => parseCheckArgs(["--commit", "--records", "a"], "/repo"))
      .toThrow(UsageError);
  });

  it("says a record path may be a directory, wherever it says it", () => {
    // What `--records` takes is the contract a caller reads, and the
    // only place it is written down is this task's own text. Pinning the
    // wording is what stops it describing the argument it used to take.
    // The refusal and the usage text are read one after the other and
    // pinned one at a time, so neither can answer for the other.
    let refusal = "";
    try {
      parseCheckArgs(["--commit", "abc", "--records"], "/repo");
    } catch (error) {
      refusal = (error as UsageError).message;
    }
    expect(refusal).toBe("--records takes a file or a directory of them");
    expect(USAGE).toContain("--records <path>...");
    expect(USAGE).not.toContain("--records <file>...");
    expect(USAGE).toContain("a file of records or a directory of them");
  });

  it("refuses a flag given twice or with nothing after it", () => {
    // Taking the last of two commits, or reading `--records` with no
    // file as no store half at all, is the same silence in a different
    // place: the command line asked for something it did not get.
    expect(() => parseCheckArgs(["--records"], "/repo")).toThrow(UsageError);
    expect(() =>
      parseCheckArgs(
        ["--commit", "c1", "--commit", "c2", "--records", "a"],
        "/repo",
      )
    ).toThrow(UsageError);
    expect(() =>
      parseCheckArgs(
        ["--records", "a", "--records", "b", "--commit", "c1"],
        "/repo",
      )
    ).toThrow(UsageError);
  });

  it("keeps reading record files after the commit is named", () => {
    // The two flags may be written in either order, and a file after the
    // commit is a file the store half has to read.
    expect(
      parseCheckArgs(
        ["--records", "a.ndjson", "--commit", "c1", "b.ndjson"],
        "/repo",
      ),
    ).toEqual({
      root: "/repo",
      store: { records: ["a.ndjson", "b.ndjson"], commit: "c1" },
    });
  });

  it("says a tree it accounts for is accounted for", () => {
    const out: string[] = [];
    const err: string[] = [];
    const passed = report([], 20, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    expect(passed).toBe(true);
    expect(out[0]).toContain("20 suites");
    expect(err).toEqual([]);
  });

  it("separates what fails from what is only reported", () => {
    // A surface nobody registered fails; a test that runs nowhere is
    // reported, because registering one means deciding where it runs.
    const out: string[] = [];
    const err: string[] = [];
    const passed = report(
      [
        { fails: false, message: "a.test.ts runs nowhere" },
        { fails: true, message: "b.test.ts is claimed by no suite" },
      ],
      20,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
    );
    expect(passed).toBe(false);
    expect(out).toEqual(["topology (reported): a.test.ts runs nowhere"]);
    expect(err[0]).toBe("topology: b.test.ts is claimed by no suite");
    expect(err[1]).toContain("1 test surface(s)");
  });

  it("runs the store half against the records it is given", async () => {
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const at = await Deno.makeTempFile({ suffix: ".ndjson" });
    await Deno.writeTextFile(
      at,
      recordsAt("c1"),
    );
    try {
      const { findings } = await check({
        root,
        store: { records: [at], commit: "c1" },
      });
      expect(
        findings.some((finding) =>
          finding.fails && finding.message.includes("no suite claims")
        ),
      ).toBe(true);
    } finally {
      await Deno.remove(at);
    }
  });

  it("exits zero over a tree it accounts for and one over a tree it does not", async () => {
    // A surface nobody registered has to stop a build; a guard that only
    // printed would be a log line nobody reads.
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await main([], root)).toBe(0);
      const at = await Deno.makeTempFile({ suffix: ".ndjson" });
      await Deno.writeTextFile(
        at,
        recordsAt("c1"),
      );
      try {
        expect(await main(["--commit", "c1", "--records", at], root)).toBe(1);
      } finally {
        await Deno.remove(at);
      }
    } finally {
      console.log = log;
      console.error = err;
    }
  });

  it("exits two on a command line it cannot act on, and says how", async () => {
    // A usage mistake is not a topology defect, and reporting it as one
    // sends somebody looking through the tree for a surface nobody
    // registered. The exit status is what tells the two apart.
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const said: string[] = [];
    const err = console.error;
    console.error = (line: string) => said.push(line);
    try {
      expect(await main(["--records", "a.ndjson"], root)).toBe(2);
    } finally {
      console.error = err;
    }
    expect(said.join("\n")).toContain("--commit");
    expect(said.join("\n")).toContain("usage:");
  });

  it("accounts for this repository's own tree", async () => {
    // The check the repository runs on itself, run the way it runs it.
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const { findings, suites } = await check({ root });
    expect(findings.filter((finding) => finding.fails)).toEqual([]);
    expect(suites).toBeGreaterThan(0);
  });
});

describe("walking a tree that cannot be read", () => {
  it("raises rather than checking against a shorter list", async () => {
    // A directory that cannot be read is not a directory that holds
    // nothing. Treating the two alike would let the guard report success
    // over whatever it managed to reach.
    const root = await Deno.makeTempDir({ prefix: "obstructed-" });
    await Deno.writeTextFile(`${root}/packages`, "not a directory");
    await expect(candidateSurfaces(root)).rejects.toThrow();
    await Deno.remove(root, { recursive: true });
  });

  it("finds nothing in a tree that holds none of its roots", async () => {
    const root = await Deno.makeTempDir({ prefix: "bare-" });
    expect(await candidateSurfaces(root)).toEqual([]);
    await Deno.remove(root, { recursive: true });
  });
});
