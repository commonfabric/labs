import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { stub } from "@std/testing/mock";

import { compileMain, runCompileTypeLib, USAGE } from "./compile-type-lib.ts";

Deno.test("compileMain resolves references and strips withheld globals", async () => {
  // The compiler resolves `/// <reference lib="...">` directives and emits one
  // file, dropping the withheld-global declarations on the way out. This
  // exercises that end to end against a temporary library rather than the real
  // TypeScript tree: a target that references a second file, and a withheld
  // `declare var` that must not survive into the output while its interface
  // does.

  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "es2023.d.ts"),
      '/// <reference lib="extra" />\r\ndeclare var Keep: number;\r\n',
    );
    await Deno.writeTextFile(
      join(dir, "extra.d.ts"),
      "declare var Float32Array: Float32ArrayConstructor;\r\n" +
        "interface Float32ArrayConstructor {\r\n}\r\n",
    );
    const outFile = join(dir, "out.d.ts");

    await compileMain({ target: "es2023", libDir: dir, outFile });

    const out = await Deno.readTextFile(outFile);
    assertStringIncludes(out, "declare var Keep: number;");
    assertStringIncludes(out, "interface Float32ArrayConstructor");
    assertEquals(out.includes("declare var Float32Array"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("compileMain includes a library two others reference once", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "es2023.d.ts"),
      '/// <reference lib="a" />\r\n/// <reference lib="b" />\r\n',
    );
    for (const name of ["a", "b"]) {
      await Deno.writeTextFile(
        join(dir, `${name}.d.ts`),
        `/// <reference lib="common" />\r\ndeclare var ${name}: number;\r\n`,
      );
    }
    await Deno.writeTextFile(
      join(dir, "common.d.ts"),
      "declare var common: number;\r\n",
    );
    const outFile = join(dir, "out.d.ts");

    await compileMain({ target: "es2023", libDir: dir, outFile });

    const out = await Deno.readTextFile(outFile);
    assertEquals(out.split("declare var common").length - 1, 1);
    assertStringIncludes(out, "declare var a: number;");
    assertStringIncludes(out, "declare var b: number;");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runCompileTypeLib writes the es2023 library given both paths", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "es2023.d.ts"),
      "declare var Keep: number;\r\n",
    );
    const outFile = join(dir, "out.d.ts");

    assertEquals(await runCompileTypeLib([dir, outFile]), 0);
    assertStringIncludes(
      await Deno.readTextFile(outFile),
      "declare var Keep: number;",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runCompileTypeLib prints its usage and fails without both paths", async () => {
  using log = stub(console, "log");

  assertEquals(await runCompileTypeLib([]), 1);
  assertEquals(await runCompileTypeLib(["/lib"]), 1);
  assertEquals(await runCompileTypeLib(["", "/out.d.ts"]), 1);

  assertEquals(log.calls.map((call) => call.args), [
    [USAGE],
    [USAGE],
    [USAGE],
  ]);
});
