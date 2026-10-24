import { expect } from "@std/expect";
import { dirname, fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { dispatchArms, loadCliSuites, phaseAnnouncements } from "./cli.ts";

/** The reader `integration.sh`'s arms are read with. */
const stepsForTest = (body: string): string[] =>
  [...body.matchAll(/^ {4}cf_test_step_begin (\S+)$/gm)].map((f) => f[1]!);
import type { Suite } from "./suite.ts";

const root = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
const suites = await loadCliSuites(root);
const byId = (id: string): Suite => suites.find((s) => s.id === id)!;
const context = { root, outputDir: "/out", spoolDir: "/spool" };

describe("the command-line suites", () => {
  it("names a unit for the record its step writes", () => {
    // The store speaks in identities, so a unit is named the way its
    // record will be, and the arm that runs it is what the command
    // reaches for.
    expect(byId("cli-core").units).toContain(
      "integration.sh verbs-walkthrough",
    );
    expect(byId("cli-core").units).toContain("acl.sh");
  });

  it("dispatches the arm that runs one step alone", async () => {
    const [invocation] = await byId("cli-core").command(
      [{ unit: "integration.sh verbs-walkthrough", skip: [] }],
      context,
    );
    expect(invocation!.command).toEqual(["./integration/integration.sh"]);
    expect(invocation!.env?.CF_CLI_INTEGRATION_SECTION).toBe("verbs");
    expect(invocation!.cwd).toBe(`${root}/packages/cli`);
  });

  it("runs a standalone script as itself", async () => {
    const [invocation] = await byId("cli-core").command(
      [{ unit: "acl.sh", skip: [] }],
      context,
    );
    expect(invocation!.command).toEqual(["./integration/acl.sh"]);
    expect(invocation!.env?.CF_CLI_INTEGRATION_SECTION).toBeUndefined();
  });

  it("holds the script's whole-invocation record to the suite", () => {
    // It measures the invocation rather than any one step, and the same
    // identity appears whichever arm dispatched it, so summing it with
    // its own steps would count them twice.
    expect(
      byId("cli-core").locate({
        test: { k: "integration", s: "cli", n: "integration.sh" },
      }),
    ).toEqual({ level: "suite" });
  });

  it("keeps the three suites' records apart by name", () => {
    const [core, fuse, deno] = ["cli-core", "cli-fuse", "cli-deno"].map(byId);
    const step = {
      k: "integration",
      s: "cli",
      n: "fuse-exec.sh Legacy handler write-through still works",
    };
    expect(fuse.locate({ test: step })).toEqual({
      level: "unit",
      unit: "fuse-exec.sh writes",
    });
    expect(core.locate({ test: step })).toBeUndefined();
    expect(deno.locate({ test: step })).toBeUndefined();
  });

  it("claims no record its script's arms do not run", () => {
    // Claiming one by the name it starts with would put every
    // unaccounted record beyond the drift guard's reach, since a claim
    // is what stops the guard failing on it.
    for (const id of ["cli-core", "cli-fuse"]) {
      const suite = byId(id);
      const script = suite.units[0]!.split(" ")[0];
      expect(
        suite.locate({
          test: { k: "integration", s: "cli", n: `${script} no such step` },
        }),
      ).toBeUndefined();
    }
  });

  it("makes each FUSE section a unit and leaves `all` to hand runs", () => {
    expect(byId("cli-fuse").units).toEqual([
      "fuse-exec.sh callables",
      "fuse-exec.sh exec",
      "fuse-exec.sh status",
      "fuse-exec.sh writes",
    ]);
  });

  it("dispatches the section a unit names", async () => {
    const invocations = await byId("cli-fuse").command(
      [{ unit: "fuse-exec.sh status", skip: [] }],
      context,
    );
    expect(invocations.length).toBe(1);
    expect(invocations[0]!.command).toEqual(["./integration/fuse-exec.sh"]);
    expect(invocations[0]!.env?.CF_FUSE_INTEGRATION_SECTION).toBe("status");
    expect(await byId("cli-fuse").command([], context)).toEqual([]);
  });

  it("gives a phase to the one section that runs it", () => {
    // The whole point of the sections: a phase only `writes` runs is
    // scored and scheduled as part of `writes` and nothing else.
    expect(
      byId("cli-fuse").locate({
        test: {
          k: "integration",
          s: "cli",
          n: "fuse-exec.sh Legacy handler write-through still works",
        },
      }),
    ).toEqual({ level: "unit", unit: "fuse-exec.sh writes" });
  });

  it("holds a phase several sections run to the suite", () => {
    // It runs whenever any section does, which is what makes the
    // sections independent, so it belongs to none of them.
    expect(
      byId("cli-fuse").locate({
        test: {
          k: "integration",
          s: "cli",
          n: "fuse-exec.sh Mounted callable entries exist",
        },
      }),
    ).toEqual({ level: "suite" });
  });

  it("accounts for the scripts its steps call", () => {
    const sources = byId("cli-core").sources ?? [];
    expect(sources).toContain("packages/cli/integration/integration.sh");
    expect(sources).toContain("packages/cli/integration/verbs-over-the-cli.sh");
    // The FUSE script is its own suite's to account for.
    expect(sources).not.toContain("packages/cli/integration/fuse-exec.sh");
    expect(byId("cli-fuse").sources).toEqual([
      "packages/cli/integration/fuse-exec.sh",
    ]);
  });

  it("builds nothing for a unit it does not hold", async () => {
    expect(
      await byId("cli-core").command([{ unit: "nope", skip: [] }], context),
    )
      .toEqual([]);
  });
});

describe("reading a script's dispatch table", () => {
  /** A table in the shape both scripts write one in. */
  const table = [
    'case "$SECTION" in',
    "  all)",
    "    cf_test_step_begin one",
    "    cf_test_step_begin two",
    "    ;;",
    "  just-one)",
    "    cf_test_step_begin one",
    "    ;;",
    "  quiet)",
    "    echo nothing to record",
    "    ;;",
    "  *)",
    '    error "Unknown section: $SECTION"',
    "    ;;",
    "esac",
    "",
  ].join("\n");

  it("reads each arm against what the reader finds in it", () => {
    expect([...dispatchArms(table, stepsForTest)]).toEqual([
      ["all", ["one", "two"]],
      ["just-one", ["one"]],
    ]);
  });

  it("passes over the unknown-section arm and one naming no work", () => {
    // Either would become a unit that then runs whatever the script does
    // with it.
    const arms = dispatchArms(table, stepsForTest);
    expect(arms.has("*")).toBe(false);
    expect(arms.has("quiet")).toBe(false);
  });

  it("finds no arms in a script that has no table", () => {
    // A script that lost its table has no arms to enumerate, and
    // inventing some would schedule work nothing can run.
    expect([...dispatchArms("#!/usr/bin/env bash\necho hello\n", stepsForTest)])
      .toEqual([]);
  });
});

describe("reading what a FUSE phase announces", () => {
  const script = [
    "run_mount() {",
    '  phase "the mount"',
    "}",
    "run_probe() {",
    '  if [ "$DEEP" = "1" ]; then',
    '    phase "the deep probe"',
    "  else",
    '    phase "the probe, skipped"',
    "  fi",
    "}",
    "",
  ].join("\n");

  it("names each phase by the sentence its function announces", () => {
    // The table names a phase by identifier and the record carries the
    // sentence, so this is what joins the two.
    expect(phaseAnnouncements(script).get("mount")).toEqual(["the mount"]);
  });

  it("takes every name a phase announces conditionally", () => {
    // A phase that announces one of two sentences records under either,
    // and both are that phase, so both reach the section running it.
    expect(phaseAnnouncements(script).get("probe")).toEqual([
      "the deep probe",
      "the probe, skipped",
    ]);
  });

  it("finds nothing in a script with no phase functions", () => {
    expect([...phaseAnnouncements("#!/usr/bin/env bash\necho hello\n").keys()])
      .toEqual([]);
  });
});

describe("deciding which scripts a suite is built from", () => {
  /**
   * A root holding one dispatch script, with the text given, beside an
   * empty FUSE script. Both are read when the suites are built, and the
   * FUSE script being present is what makes passing over it a decision
   * rather than the same silence a missing script would get.
   */
  async function rooted(script: string): Promise<string> {
    const at = await Deno.makeTempDir({ prefix: "cli-sources-" });
    await Deno.mkdir(`${at}/packages/cli/integration`, { recursive: true });
    await Deno.writeTextFile(
      `${at}/packages/cli/integration/integration.sh`,
      script,
    );
    await Deno.writeTextFile(`${at}/packages/cli/integration/fuse-exec.sh`, "");
    return at;
  }

  it("leaves the fuse script to the suite that runs it", async () => {
    // The dispatch script calls it, but a suite claiming it here would
    // claim a surface `cli-fuse` already holds, and the drift guard
    // reports a surface claimed twice.
    const at = await rooted("#!/usr/bin/env bash\n./fuse-exec.sh run\n");
    try {
      const sources = (await loadCliSuites(at))
        .find((suite) => suite.id === "cli-core")!.sources;
      expect(sources).not.toContain("packages/cli/integration/fuse-exec.sh");
      expect(sources).toContain("packages/cli/integration/integration.sh");
    } finally {
      await Deno.remove(at, { recursive: true });
    }
  });

  it("passes over a name that is not a script beside it", async () => {
    // A script writes paths ending in `.sh` that it never calls. Only a
    // name the tree holds is a source, so a written path claims nothing.
    const at = await rooted("#!/usr/bin/env bash\necho x > /tmp/report.sh\n");
    try {
      const sources = (await loadCliSuites(at))
        .find((suite) => suite.id === "cli-core")!.sources;
      expect(sources).not.toContain("packages/cli/integration/report.sh");
    } finally {
      await Deno.remove(at, { recursive: true });
    }
  });
});
