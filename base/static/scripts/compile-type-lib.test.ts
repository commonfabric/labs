import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

import { compileMain } from "./compile-type-lib.ts";

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
