import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  preloadArgument,
  SKIP_LIST_VARIABLE,
} from "@commonfabric/test-support/records";
import {
  coverageMemberDirectory,
  fileSuite,
  unavailableFrom,
  unavailableLeaves,
  unavailableUnits,
  writeSkipList,
} from "./suite.ts";

/** A suite over two packages, one of which skips a leaf. */
function twoParts() {
  return fileSuite({
    id: "package-integration-on",
    variant: "server-execution",
    needs: ["deno"],
    parts: [
      {
        packageDir: "packages/oven",
        flags: ["-A"],
        env: { HEADLESS: "1" },
        junit: {
          kind: "integration",
          scope: "oven",
          filePrefix: "packages/oven",
        },
        files: ["packages/oven/integration/bake.test.ts"],
        unavailable: [{
          unit: "packages/oven/integration/bake.test.ts",
          leafName: "bakes > slowly",
          reason: "the surface that step exercises has not landed",
        }],
      },
      {
        packageDir: "packages/mill",
        flags: ["-A"],
        junit: {
          kind: "integration",
          scope: "mill",
          filePrefix: "packages/mill",
        },
        files: ["packages/mill/integration/grind.test.ts"],
      },
    ],
  });
}

describe("reading a configuration's skip registry", () => {
  it("takes a whole-file entry out and leaves a step entry's file in", () => {
    const { excluded, unavailable } = unavailableFrom([
      { file: "a.test.ts", phase: "phase-3", reason: "not landed" },
      {
        file: "b.test.ts",
        step: "bakes > slowly",
        phase: "phase-4",
        reason: "that step is not landed",
      },
    ], "packages/oven");
    expect([...excluded]).toEqual(["packages/oven/a.test.ts"]);
    expect(unavailable.map((entry) => entry.leafName)).toEqual([
      undefined,
      "bakes > slowly",
    ]);
    expect(unavailable[0]!.phase).toBe("phase-3");
  });

  it("tells a unit that does not run from a leaf that does not", () => {
    const suite = twoParts();
    // Every other identity in that file still runs, so the file is a
    // unit and only the leaf is unavailable.
    expect([...unavailableUnits(suite)]).toEqual([]);
    expect([...unavailableLeaves(suite)]).toEqual([
      ["packages/oven/integration/bake.test.ts", ["bakes > slowly"]],
    ]);
  });
});

describe("a suite of deno test files over several packages", () => {
  const context = { root: "/repo", outputDir: "/out", spoolDir: "/spool" };

  it("runs one invocation per package, each with its own report", async () => {
    // A real directory, because the leaf this configuration skips means
    // there is a skip list to write.
    const outputDir = await Deno.makeTempDir({ prefix: "file-suite-" });
    const made = await twoParts().command([
      { unit: "packages/oven/integration/bake.test.ts", skip: [] },
      { unit: "packages/mill/integration/grind.test.ts", skip: [] },
    ], { ...context, outputDir });
    expect(made.map((i) => i.cwd)).toEqual([
      "/repo/packages/oven",
      "/repo/packages/mill",
    ]);
    expect(made.map((i) => i.junit?.[0]?.scope)).toEqual(["oven", "mill"]);
    expect(made[0]!.env?.HEADLESS).toBe("1");
    await Deno.remove(outputDir, { recursive: true });
  });

  it("skips a leaf its configuration declares unavailable", async () => {
    // The declaration is what stops the leaf running, rather than the
    // test file remembering to guard itself.
    const outputDir = await Deno.makeTempDir({ prefix: "file-suite-" });
    const [invocation] = await twoParts().command(
      [{ unit: "packages/oven/integration/bake.test.ts", skip: [] }],
      { ...context, outputDir },
    );
    const listed = invocation!.env?.[SKIP_LIST_VARIABLE];
    expect(listed).toBeDefined();
    expect(JSON.parse(await Deno.readTextFile(listed!))).toEqual({
      "packages/oven/integration/bake.test.ts": ["bakes > slowly"],
    });
    await Deno.remove(outputDir, { recursive: true });
  });

  it("recognizes a record only under its own scope and variant", () => {
    const suite = twoParts();
    const file = "packages/oven/integration/bake.test.ts";
    expect(
      suite.locate({
        test: {
          k: "integration",
          s: "oven",
          n: "bakes",
          v: "server-execution",
        },
        file,
      }),
    ).toEqual({ level: "unit", unit: file });
    // The right variant but the wrong scope for the part holding it.
    expect(
      suite.locate({
        test: {
          k: "integration",
          s: "mill",
          n: "bakes",
          v: "server-execution",
        },
        file,
      }),
    ).toBeUndefined();
    // The right scope but no variant, which belongs to the default suite.
    expect(
      suite.locate({ test: { k: "integration", s: "oven", n: "bakes" }, file }),
    ).toBeUndefined();
  });

  it("grants the batch's spool to a part that cannot already write it", async () => {
    // The preload leaves its name map there, and that map is what gives
    // each identity its file once the preload has taken the class names.
    const narrow = fileSuite({
      id: "narrow",
      needs: ["deno"],
      parts: [{
        packageDir: "packages/oven",
        flags: ["--allow-read", "--allow-write=/tmp"],
        junit: { kind: "unit", scope: "oven" },
        files: ["packages/oven/a.test.ts"],
      }],
    });
    const [invocation] = await narrow.command(
      [{ unit: "packages/oven/a.test.ts", skip: [] }],
      context,
    );
    expect(invocation!.command).toContain("--allow-write=/spool");
  });

  it("grants nothing to a part that already writes anywhere", async () => {
    // This one runs under `-A`, which Deno refuses to take beside an
    // `--allow-write` path list at all, ending the run before it starts.
    const [blanket] = await twoParts().command(
      [{ unit: "packages/mill/integration/grind.test.ts", skip: [] }],
      context,
    );
    expect(blanket!.command).not.toContain("--allow-write=/spool");
    expect(blanket!.command).toContain(preloadArgument());
  });

  it("grants nothing to a part that cannot read the tree", async () => {
    // Writing the spool is what makes the preload take the class names,
    // and reading is what finds the files that replace them, so a part
    // holding one permission without the other records no file at all.
    const unreadable = fileSuite({
      id: "unreadable",
      needs: ["deno"],
      parts: [{
        packageDir: "packages/oven",
        flags: ["--no-check", "--allow-env", "--allow-run", "--allow-net"],
        junit: { kind: "integration", scope: "oven" },
        files: ["packages/oven/a.test.ts"],
      }],
    });
    const [invocation] = await unreadable.command(
      [{ unit: "packages/oven/a.test.ts", skip: [] }],
      context,
    );
    expect(invocation!.command).not.toContain("--allow-write=/spool");
    expect(invocation!.command).toContain(preloadArgument());
  });

  it("builds nothing for a unit it does not hold", async () => {
    expect(await twoParts().command([{ unit: "elsewhere", skip: [] }], context))
      .toEqual([]);
  });
});

describe("the parts of a suite that answer no", () => {
  it("holds no leaf for a configuration that skips whole files only", () => {
    const whole = {
      unavailable: [{ unit: "a.test.ts", reason: "not landed yet" }],
    };
    expect([...unavailableLeaves(whole)]).toEqual([]);
    expect([...unavailableUnits(whole)]).toEqual(["a.test.ts"]);
  });

  it("writes no skip list where nothing inside a unit is skipped", async () => {
    // The absence of the file is what tells the invocation to run
    // everything, so writing an empty one would be a different
    // instruction.
    const at = `${await Deno.makeTempDir({ prefix: "skip-" })}/skips.json`;
    await writeSkipList(at, {});
    await expect(Deno.readTextFile(at)).rejects.toThrow();
  });

  it("declines a record whose kind is not the part's own", () => {
    // A part is a kind and a scope together: a `browser` record under a
    // scope some part covers still belongs to whatever suite runs the
    // browser half, not to this one.
    const suite = twoParts();
    expect(
      suite.locate({
        test: { k: "browser", s: "oven", n: "bakes", v: "server-execution" },
        file: "packages/oven/integration/bake.test.ts",
      }),
    ).toBeUndefined();
  });
});

describe("grouping a batch across the packages it spans", () => {
  it("puts two files of one package in one invocation", async () => {
    // The second file of a package joins the invocation the first
    // opened rather than starting another, because the package's
    // startup is what an invocation costs.
    const suite = fileSuite({
      id: "package-integration",
      needs: ["deno"],
      parts: [{
        packageDir: "packages/oven",
        flags: ["-A"],
        junit: { kind: "integration", scope: "oven" },
        files: ["packages/oven/a.test.ts", "packages/oven/b.test.ts"],
      }],
    });
    const made = await suite.command([
      { unit: "packages/oven/a.test.ts", skip: [] },
      { unit: "packages/oven/b.test.ts", skip: [] },
    ], { root: "/repo", outputDir: "/out", spoolDir: "/spool" });
    expect(made.length).toBe(1);
    expect(made[0]!.command.filter((arg) => arg.endsWith(".test.ts")))
      .toEqual(["a.test.ts", "b.test.ts"]);
  });
});

describe("two parts of one suite under one scope", () => {
  it("gives a record to the part whose kind it carries", () => {
    // A package can record under more than one kind — its Deno tests
    // and its browser tests — and the parts are told apart by kind as
    // well as by scope, so a record goes to the one that produced it.
    const suite = fileSuite({
      id: "workspace-unit",
      needs: ["deno"],
      parts: [
        {
          packageDir: "packages/oven",
          flags: [],
          junit: { kind: "unit", scope: "oven" },
          files: ["packages/oven/a.test.ts"],
        },
        {
          packageDir: "packages/oven",
          flags: [],
          junit: { kind: "browser", scope: "oven" },
          files: ["packages/oven/b.test.ts"],
        },
      ],
    });
    expect(
      suite.locate({
        test: { k: "browser", s: "oven", n: "heats" },
        file: "packages/oven/b.test.ts",
      }),
    ).toEqual({ level: "unit", unit: "packages/oven/b.test.ts" });
    // The same file under the other kind belongs to neither: the part
    // that holds it records under `browser`.
    expect(
      suite.locate({
        test: { k: "unit", s: "oven", n: "heats" },
        file: "packages/oven/b.test.ts",
      }),
    ).toBeUndefined();
  });
});

describe("naming a member's coverage directory", () => {
  it("stands a slash up as a separator a directory name can hold", () => {
    expect(coverageMemberDirectory("packages/connectors/github"))
      .toBe("packages__connectors__github");
  });

  it("names the same directory whether or not the member leads with ./", () => {
    expect(coverageMemberDirectory("./packages/memory"))
      .toBe(coverageMemberDirectory("packages/memory"));
  });

  it("refuses a member whose own name holds the separator", () => {
    // Two members would otherwise share one directory, and their
    // coverage would be added together with nothing saying so.
    expect(() => coverageMemberDirectory("packages/one__two")).toThrow(
      "cannot be measured",
    );
  });
});
