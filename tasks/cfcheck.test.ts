import { join } from "@std/path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  parseRecordLine,
  RECORDS_DIR_VARIABLE,
} from "@commonfabric/test-support/records";
import { createRuntime } from "../runtime/cli/lib/dev.ts";
import {
  cfcheck,
  type CfcheckContext,
  checkoutContext,
  diagnosticFile,
} from "./cfcheck.ts";

/** A pattern that type-checks. */
const SOUND = `import { pattern } from "commonfabric";

export default pattern<{ count: number }>(({ count }) => ({ count }));
`;

/** A pattern whose body assigns a string where a number is declared. */
const MISTYPED = `import { pattern } from "commonfabric";

const count: number = "three";

export default pattern<{ label: string }>(({ label }) => ({ label, count }));
`;

/** A pattern importing a module that is not there. */
const UNRESOLVED = `import { pattern } from "commonfabric";
import { helper } from "./missing.ts";

export default pattern<{ label: string }>(({ label }) => ({
  label: helper(label),
}));
`;

describe("cfcheck", () => {
  let root: string;
  let said: string[];

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "cfcheck-test-" });
    said = [];
    await Deno.mkdir(join(root, "patterns"));
    await Deno.writeTextFile(join(root, "patterns/sound.tsx"), SOUND);
    await Deno.writeTextFile(join(root, "patterns/mistyped.tsx"), MISTYPED);
    await Deno.writeTextFile(join(root, "patterns/unresolved.tsx"), UNRESOLVED);
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  /** A context over the fixture corpus in `root`, saying into `said`. */
  function fixtureContext(env: Record<string, string> = {}): CfcheckContext {
    return {
      corpus: () =>
        Promise.resolve([
          "patterns/mistyped.tsx",
          "patterns/sound.tsx",
          "patterns/unresolved.tsx",
        ]),
      root,
      runtime: createRuntime,
      env: (name) => env[name],
      say: (line) => said.push(line),
    };
  }

  describe("checkoutContext()", () => {
    it("returns the repository's own corpus, relative to its root", async () => {
      const context = checkoutContext();
      const corpus = await context.corpus();
      expect(corpus).toContain("patterns/examples/counter/counter.tsx");
      expect(corpus).not.toContain(
        "patterns/examples/counter/counter.test.tsx",
      );
      expect(
        (await Deno.stat(join(context.root, "deno.jsonc"))).isFile,
      ).toBe(true);
    });
  });

  describe("diagnosticFile()", () => {
    it("returns the path the engine names below its program prefix", () => {
      expect(diagnosticFile("/fid1:abc_DEF-1/patterns/a.tsx", "/repo"))
        .toBe("patterns/a.tsx");
    });

    it("returns a path below the root relative to it", () => {
      expect(diagnosticFile("/repo/patterns/a.tsx", "/repo"))
        .toBe("patterns/a.tsx");
    });

    it("returns a path outside the root as the engine names it", () => {
      expect(diagnosticFile("/elsewhere/a.tsx", "/repo"))
        .toBe("/elsewhere/a.tsx");
    });

    it("returns `(batch)` for a diagnostic that names no file", () => {
      expect(diagnosticFile(undefined, "/repo")).toBe("(batch)");
      expect(diagnosticFile("", "/repo")).toBe("(batch)");
    });
  });

  describe("cfcheck()", () => {
    it("returns 0, says nothing more and writes no record for an unrecorded selection that type-checks", async () => {
      const output = await cfcheck(["--only", "sound.tsx"], fixtureContext());
      expect(output).toEqual({ code: 0 });
      expect(said).toEqual(["Common Fabric checking 1 pattern files."]);
      expect([...Deno.readDirSync(root)].map((entry) => entry.name))
        .toEqual(["patterns"]);
    });

    it("returns 1 and names each failing pattern with what is wrong with it", async () => {
      const output = await cfcheck([], fixtureContext());
      expect(said).toEqual(["Common Fabric checking 3 pattern files."]);
      expect(output.code).toBe(1);
      expect(output.out).toBeUndefined();
      const [heading, ...blocks] = (output.err ?? "").split("\n\n");
      expect(heading).toBe("Common Fabric pattern checks failed:");
      // One block per failure, sorted by file, each opening with the
      // repository path of the pattern rather than the engine's own name.
      const failures = blocks.map((block) => {
        const [file, ...error] = block.split("\n");
        return { file, error: error.join("\n") };
      });
      const files = failures.map((failure) => failure.file);
      expect(files).toEqual(files.toSorted());
      expect(new Set(files)).toEqual(
        new Set(["patterns/mistyped.tsx", "patterns/unresolved.tsx"]),
      );
      for (const { file, error } of failures) {
        expect(error).toContain(
          file === "patterns/mistyped.tsx"
            ? "Type 'string' is not assignable to type 'number'."
            : "patterns/missing.ts",
        );
      }
    });

    it("returns 2 with the usage for a command line it cannot read, and checks nothing", async () => {
      const output = await cfcheck(["--update"], {
        ...fixtureContext(),
        runtime: () => {
          throw new Error("A run refused at its command line built a runtime.");
        },
      });
      expect(output).toEqual({
        err: "Unknown argument: --update\n" +
          "usage: deno task cfcheck [--only <pattern>]...",
        code: 2,
      });
      expect(said).toEqual([]);
    });

    it("returns 2 with the failure and the usage for a corpus it cannot read, and checks nothing", async () => {
      const output = await cfcheck([], {
        ...fixtureContext(),
        corpus: () => Promise.reject(new Error("The patterns are unreadable.")),
        runtime: () => {
          throw new Error("A run refused at its corpus built a runtime.");
        },
      });
      expect(output).toEqual({
        err: "The patterns are unreadable.\n" +
          "usage: deno task cfcheck [--only <pattern>]...",
        code: 2,
      });
      expect(said).toEqual([]);
    });

    it("records one outcome per checked pattern when the run is recorded", async () => {
      const records = join(root, "records");
      await Deno.mkdir(records);
      await cfcheck(
        [],
        fixtureContext({ [RECORDS_DIR_VARIABLE]: records }),
      );
      const outcomes = [];
      for await (const entry of Deno.readDir(records)) {
        const text = await Deno.readTextFile(join(records, entry.name));
        for (const line of text.split("\n").filter((line) => line !== "")) {
          const record = parseRecordLine(line);
          outcomes.push([record?.test.k, record?.test.n, record?.outcome]);
        }
      }
      expect(outcomes.sort()).toEqual([
        ["typecheck", "cfcheck patterns/mistyped.tsx", "fail"],
        ["typecheck", "cfcheck patterns/sound.tsx", "pass"],
        ["typecheck", "cfcheck patterns/unresolved.tsx", "fail"],
      ]);
    });
  });
});
