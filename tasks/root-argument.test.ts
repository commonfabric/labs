import { expect } from "@std/expect";
import { join } from "@std/path";
import { runOnRoot } from "./root-argument.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

describe("runOnRoot()", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "root-argument-test-" });
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  /** What a run on `args` returned, printed, and handed the check. */
  async function run(args: readonly string[]) {
    const roots: (string | undefined)[] = [];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...line: unknown[]) => errors.push(line.join(" "));
    try {
      const code = await runOnRoot(
        args,
        "check.ts [root]",
        (root) => {
          roots.push(root);
          return Promise.resolve(7);
        },
      );
      return { code, roots, errors };
    } finally {
      console.error = originalError;
    }
  }

  it("runs the check on its default when the command line is empty", async () => {
    expect(await run([])).toEqual({ code: 7, roots: [undefined], errors: [] });
  });

  it("runs the check on the directory the command line names", async () => {
    expect(await run([dir])).toEqual({ code: 7, roots: [dir], errors: [] });
  });

  it("prints the usage and returns 2, running nothing, for anything but one directory", async () => {
    const file = join(dir, "file.txt");
    await Deno.writeTextFile(file, "");
    const refused = {
      code: 2,
      roots: [],
      errors: ["usage: check.ts [root]"],
    };
    expect(await run(["--help"])).toEqual(refused);
    expect(await run([join(dir, "missing")])).toEqual(refused);
    expect(await run([file])).toEqual(refused);
    expect(await run([dir, dir])).toEqual(refused);
  });
});
