import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { argv, cf } from "./utils.ts";

// A value holding everything a shell or a whitespace split would act on.
const AWKWARD = ` it's "quoted" 🐱 $HOME\\n`;

describe("argv()", () => {
  it("returns the template's own words, split on runs of whitespace", () => {
    expect(argv`  space   clone
      --json `).toEqual(["space", "clone", "--json"]);
  });

  it("returns no arguments for a template holding only whitespace", () => {
    expect(argv``).toEqual([]);
    expect(argv`
    `).toEqual([]);
  });

  it("returns an interpolated string as one argument", () => {
    expect(argv`view ${AWKWARD} --json`).toEqual(["view", AWKWARD, "--json"]);
  });

  it("returns an empty interpolated string standing alone as an argument", () => {
    expect(argv`follow ${""}`).toEqual(["follow", ""]);
  });

  it("returns an interpolation joined with the text written against it", () => {
    const path = "/tmp/a b";
    expect(argv`--to=${path} x${path}y`).toEqual([
      "--to=/tmp/a b",
      "x/tmp/a by",
    ]);
    expect(argv`${"a "}${" b"}`).toEqual(["a  b"]);
    expect(argv`--to=${""}`).toEqual(["--to="]);
  });

  it("returns an interpolated number as one argument", () => {
    expect(argv`--port ${8000}`).toEqual(["--port", "8000"]);
  });

  it("returns each element of an interpolated array as an argument", () => {
    const flags = ["--space", "a b"];
    expect(argv`get ${flags} value`).toEqual([
      "get",
      "--space",
      "a b",
      "value",
    ]);
    expect(argv`get ${[]} value`).toEqual(["get", "value"]);
    expect(argv`${["a"]} ${["b"]}`).toEqual(["a", "b"]);
  });

  it("throws for an interpolated array written against anything", () => {
    expect(() => argv`--x=${["a"]}`).toThrow("must stand apart: `--x=${…}`");
    expect(() => argv`${["a"]}=x`).toThrow("must stand apart");
    expect(() => argv`${"a"}${["b"]}`).toThrow("must stand apart");
    expect(() => argv`${["a"]}${"b"}`).toThrow("must stand apart");
    expect(() => argv`${["a"]}${["b"]}`).toThrow("must stand apart");
  });

  it("throws for a quote or a backslash in the template's own text", () => {
    expect(() => argv`id derive "a b"`).toThrow("Interpolate an argument");
    expect(() => argv`id derive 'a b'`).toThrow("Interpolate an argument");
    expect(() => argv`id derive a\ b`).toThrow("Interpolate an argument");
    expect(() => argv`id derive \x`).toThrow("Interpolate an argument");
  });

  it("lets cf read a file at a path holding awkward characters", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(dir, AWKWARD));
      const file = join(dir, AWKWARD, `${AWKWARD}.ts`);
      await Deno.writeTextFile(file, "const answer = 42;\n");
      const { code, stdout } = await cf(
        argv`view --plain --color never ${file}`,
      );
      expect(code).toBe(0);
      expect(stdout.join("\n")).toContain("const answer = 42;");

      const missing = await cf(argv`view --plain --color never ${`${file}x`}`);
      expect(missing.code).not.toBe(0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
