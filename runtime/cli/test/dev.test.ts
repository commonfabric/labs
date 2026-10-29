import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { argv, bytesToLines, cf, checkStderr, stripAnsi } from "./utils.ts";
import { serializeMainExport } from "../lib/dev.ts";

const cliPackageDir = join(import.meta.dirname!, "..");
const repoRoot = join(cliPackageDir, "..", "..");

describe("cli check", () => {
  it("rejects main exports that do not serialize as JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => serializeMainExport({ default: 1n })).toThrow(
      "Main export not serializable.",
    );
    expect(() => serializeMainExport({ default: circular })).toThrow(
      "Main export not serializable.",
    );
    expect(() =>
      serializeMainExport({
        default: {
          toJSON: () => {
            throw new Error("serialization failed");
          },
          toString: () => "[object Object]",
        },
      })
    ).toThrow("Main export not serializable.");
  });

  it("keeps serialization callbacks off JSON stdout", async () => {
    const output = await runDenoCommandWithTemporaryLock({
      root: repoRoot,
      cwd: cliPackageDir,
      args: (lockPath) => [
        "run",
        `--lock=${lockPath}`,
        "--frozen=true",
        "--allow-env",
        "--allow-ffi",
        "--allow-read",
        join(import.meta.dirname!, "fixtures", "dev-json-output.ts"),
      ],
    });
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);

    expect(output.code).toBe(0);
    expect(stdout).toBe("1\n");
    expect(stderr).toContain("check JSON serialized");
    expect(stderr).toContain("check JSON serialization deferred");
  });

  it("Executes a package", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/pow-5.tsx --pattern-json`,
    );
    checkStderr(stderr);
    expect(stdout[stdout.length - 1]).toBe("25");
    expect(code).toBe(0);
  });

  it("Runs a pattern with commonfabric+3P modules", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/3p-modules.tsx --pattern-json`,
    );
    checkStderr(stderr);
    expect(JSON.parse(stdout.join("\n")).argumentSchema).toBeTruthy();
    expect(code).toBe(0);
  });

  it("Generates output file with the compiled module bodies", async () => {
    const temp = await Deno.makeTempFile();
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/pattern.tsx --no-run --output ${temp}`,
    );
    checkStderr(stderr);
    expect(stdout.length).toBe(0);
    expect(code).toBe(0);
    const rendered = bytesToLines(await Deno.readFile(temp));
    // Concatenated per-module compiled bodies, each headed by its
    // content-addressed specifier.
    expect(rendered[0]).toMatch(/^\/\/ cf:module\//);
    expect(rendered.some((line) => line.includes('"use strict"'))).toBe(true);
  });

  it("Uses default export when no --main-export specified", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/named-export.tsx --pattern-json`,
    );
    checkStderr(stderr);
    const output = JSON.parse(stdout.join("\n"));
    expect(output.result.message).toBe("from default export");
    expect(code).toBe(0);
  });

  it("Uses specified named export with --main-export", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/named-export.tsx --main-export myNamedPattern --pattern-json`,
    );
    checkStderr(stderr);
    const output = JSON.parse(stdout.join("\n"));
    // Named export uses cell reference, so check the argument schema
    expect(output.argumentSchema.default.message).toBe("from named export");
    // Also verify mainExport was set correctly in program
    expect(output.program.mainExport).toBe("myNamedPattern");
    expect(code).toBe(0);
  });

  it("Produces no output on success by default", async () => {
    const { code, stdout, stderr } = await cf(argv`check fixtures/pow-5.tsx`);
    checkStderr(stderr);
    expect(stdout.length).toBe(0);
    expect(code).toBe(0);
  });

  it("Resolves imports with --root flag", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check --root fixtures fixtures/pow-5.tsx --pattern-json`,
    );
    checkStderr(stderr);
    expect(stdout[stdout.length - 1]).toBe("25");
    expect(code).toBe(0);
  });

  it("evaluates a pattern that reads a data file attached with --datafile", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check --root fixtures fixtures/reads-data-file.tsx
        --datafile fixtures/data/cities.json --pattern-json`,
    );
    checkStderr(stderr);
    // The printed value is the file's contents, so this fails if the bytes
    // never reached the pattern rather than merely if the compile broke.
    expect(JSON.parse(stdout.join("\n"))).toEqual(["Oslo", "Lima"]);
    expect(code).toBe(0);
  });

  it("evaluates a pattern that reads a data file it names itself", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check --root fixtures fixtures/reads-data-file.tsx --pattern-json`,
    );
    checkStderr(stderr);
    // No `--datafile`: the `dataFile()` call is the declaration, so the same
    // bytes reach the pattern as when the flag names them.
    expect(JSON.parse(stdout.join("\n"))).toEqual(["Oslo", "Lima"]);
    expect(code).toBe(0);
  });

  it("refuses a data file the pattern names with nothing behind it", async () => {
    const { code, stderr } = await cf(
      argv`check --root fixtures fixtures/reads-absent-data-file.tsx`,
    );
    // The program cannot be assembled as its source describes it, so this
    // fails at the build, naming the module that asked and the path it wanted.
    const text = stripAnsi(stderr.join("\n"));
    expect(text).toContain("/reads-absent-data-file.tsx");
    expect(text).toContain('"/data/absent.json"');
    expect(code).not.toBe(0);
  });

  it("prints compiled module bodies as a structured JSON result", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/check-json-no-evaluate.ts --json`,
    );
    checkStderr(stderr);

    const result = JSON.parse(stdout.join("\n"));
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("fixtures/check-json-no-evaluate.ts");
    expect(result.files[0].output).toContain('"use strict"');
    expect(code).toBe(0);

    const evaluated = await cf(
      argv`check fixtures/check-json-no-evaluate.ts --pattern-json`,
    );
    expect(evaluated.code).toBe(0);
    expect(evaluated.stdout).toEqual(["1"]);
    expect(stripAnsi(evaluated.stderr.join("\n"))).toContain(
      "check JSON evaluated",
    );
    expect(stripAnsi(evaluated.stderr.join("\n"))).toContain(
      "check JSON deferred",
    );
  });

  it("rejects conflicting stdout modes", async () => {
    for (
      const flags of [
        argv`--json --show-transformed`,
        argv`--json --pattern-json`,
        argv`--show-transformed --pattern-json`,
      ]
    ) {
      const { code, stderr } = await cf(
        argv`check fixtures/pow-5.tsx ${flags}`,
      );
      expect(code).not.toBe(0);
      expect(stripAnsi(stderr.join("\n"))).toContain("conflicts with option");
    }
  });

  it("does not print transformed output when any input fails", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/pow-5.tsx fixtures/no-such-pattern.tsx --show-transformed --no-run`,
    );

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain("no-such-pattern.tsx");
  });

  it("does not evaluate input while showing transformed output", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/check-json-no-evaluate.ts --show-transformed`,
    );

    checkStderr(stderr);
    expect(code).toBe(0);
    expect(stdout).not.toContain("check JSON evaluated");
    expect(stdout.join("\n")).toContain('console.log("check JSON evaluated")');
  });

  it("does not print pattern JSON when any input fails", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/check-json-no-evaluate.ts fixtures/no-such-pattern.tsx --pattern-json`,
    );

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain("check JSON evaluated");
    expect(stripAnsi(stderr.join("\n"))).toContain("check JSON deferred");
    expect(stripAnsi(stderr.join("\n"))).toContain("no-such-pattern.tsx");
  });

  it("surfaces fabric imports without a space as a CLI compile error", async () => {
    const { code, stdout, stderr } = await cf(
      argv`check fixtures/fabric-import.tsx --no-run`,
    );
    const renderedStderr = stripAnsi(stderr.join("\n"));

    expect(code).not.toBe(0);
    expect(stdout.length).toBe(0);
    expect(renderedStderr).toContain(
      "fabric imports require a space context (options.fabricImports)",
    );
    expect(renderedStderr).not.toContain("Could not resolve");
  });
});
