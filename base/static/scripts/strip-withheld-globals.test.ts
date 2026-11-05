import { assertEquals, assertThrows } from "@std/assert";

import {
  cliMain,
  runCli,
  stillDeclared,
  stripWithheldGlobals,
} from "./strip-withheld-globals.ts";

/**
 * Tests for the type-library global stripper.
 *
 * The stripper edits `assets/types/es2023.d.ts` and `assets/types/dom.d.ts` in
 * place, so it has to leave every byte it is not removing alone — including the
 * line endings, which are CRLF in the first file and LF in the second.
 *
 * They live beside the script under `scripts/`, where the recursive deno-test
 * task finds them but the browser-bundled `test/*.test.ts` pass does not.
 */

const names = new Set(["Withheld", "AlsoWithheld"]);

Deno.test("removes a one-line declaration and keeps its interface", () => {
  const { text, removed } = stripWithheldGlobals(
    [
      "interface Withheld {",
      "    length: number;",
      "}",
      "",
      "declare var Withheld: WithheldConstructor;",
      "",
      "interface Kept {",
      "}",
      "",
    ].join("\n"),
    names,
  );

  assertEquals(removed, ["Withheld"]);
  assertEquals(
    text,
    [
      "interface Withheld {",
      "    length: number;",
      "}",
      "",
      "interface Kept {",
      "}",
      "",
    ]
      .join("\n"),
  );
});

Deno.test("removes a braced declaration block", () => {
  const { text, removed } = stripWithheldGlobals(
    [
      "declare var Withheld: {",
      "    prototype: Withheld;",
      "    new(parts?: unknown[]): Withheld;",
      "};",
      "",
      "interface Body {",
      "}",
      "",
    ].join("\n"),
    names,
  );

  assertEquals(removed, ["Withheld"]);
  assertEquals(text, ["interface Body {", "}", ""].join("\n"));
});

Deno.test("leaves declarations that are not withheld alone", () => {
  const source = [
    "declare var Kept: KeptConstructor;",
    "declare var AlsoWithheld: AlsoWithheldConstructor;",
    "declare var KeptToo: {",
    "    prototype: KeptToo;",
    "};",
    "",
  ].join("\n");
  const { text, removed } = stripWithheldGlobals(source, names);

  assertEquals(removed, ["AlsoWithheld"]);
  assertEquals(
    text,
    [
      "declare var Kept: KeptConstructor;",
      "declare var KeptToo: {",
      "    prototype: KeptToo;",
      "};",
      "",
    ].join("\n"),
  );
});

Deno.test("removes a declare function global", () => {
  const { text, removed } = stripWithheldGlobals(
    [
      "declare function Withheld(handler: TimerHandler, timeout?: number): number;",
      "declare function Kept(data: string): string;",
      "",
    ].join("\n"),
    names,
  );

  assertEquals(removed, ["Withheld"]);
  assertEquals(
    text,
    ["declare function Kept(data: string): string;", ""].join("\n"),
  );
});

Deno.test("preserves CRLF line endings", () => {
  const { text } = stripWithheldGlobals(
    "interface Kept {\r\n}\r\ndeclare var Withheld: W;\r\ndeclare var Kept: K;\r\n",
    names,
  );

  assertEquals(text, "interface Kept {\r\n}\r\ndeclare var Kept: K;\r\n");
});

Deno.test("does not match a name that merely starts the same", () => {
  const { text, removed } = stripWithheldGlobals(
    "declare var WithheldExtra: X;\n",
    names,
  );

  assertEquals(removed, []);
  assertEquals(text, "declare var WithheldExtra: X;\n");
});

Deno.test("is idempotent", () => {
  const source = "declare var Withheld: W;\n\ninterface Kept {\n}\n";
  const once = stripWithheldGlobals(source, names).text;
  const twice = stripWithheldGlobals(once, names);

  assertEquals(twice.removed, []);
  assertEquals(twice.text, once);
});

Deno.test("throws when a declaration never closes", () => {
  assertThrows(
    () => stripWithheldGlobals("declare var Withheld: {\n    a: 1;\n", names),
    Error,
    "Unbalanced declaration",
  );
});

Deno.test("throws when a declaration closes more braces than it opens", () => {
  assertThrows(
    () => stripWithheldGlobals("declare var Withheld: };\n", names),
    Error,
    "Unbalanced declaration",
  );
});

//
// The command over the checked-in libraries
//
// The checked-in type libraries are kept stripped, so the CLI run over them is
// the up-to-date path: --check reports clean and returns 0, and a plain run
// finds nothing to remove and rewrites nothing.
//

Deno.test("runCli --check passes on the stripped libraries", async () => {
  assertEquals(await runCli(["--check"]), 0);
});

Deno.test("runCli without --check leaves up-to-date libraries unchanged", async () => {
  const path = new URL("../assets/types/es2023.d.ts", import.meta.url);
  const before = await Deno.readTextFile(path);
  assertEquals(await runCli([]), 0);
  assertEquals(await Deno.readTextFile(path), before);
});

//
// The entry-point gate
//

Deno.test("cliMain does nothing unless this module is the entry point", async () => {
  let called: number | undefined;
  await cliMain(["--check"], false, (code) => called = code);
  assertEquals(called, undefined);
});

Deno.test("cliMain exits with the CLI status when it is the entry point", async () => {
  let code: number | undefined;
  await cliMain(["--check"], true, (c) => code = c);
  assertEquals(code, 0);
});

//
// The error and write paths
//
// Driven with injected files rather than the checked-in libraries, which are
// kept clean.
//

Deno.test("runCli --check fails when a library still declares a withheld global", async () => {
  const status = await runCli(["--check"], {
    files: ["injected.d.ts"],
    readFile: () =>
      Promise.resolve("declare var Float32Array: Float32ArrayConstructor;\n"),
  });
  assertEquals(status, 1);
});

Deno.test("runCli fails when a withheld global is declared in an unstrippable form", async () => {
  const status = await runCli(["--check"], {
    files: ["injected.d.ts"],
    readFile: () =>
      Promise.resolve("declare const Float32Array: Float32ArrayConstructor;\n"),
  });
  assertEquals(status, 1);
});

Deno.test("runCli without --check writes the stripped text back", async () => {
  const writes: Array<[string, string]> = [];
  const status = await runCli([], {
    files: ["injected.d.ts"],
    readFile: () =>
      Promise.resolve("declare var Float32Array: Float32ArrayConstructor;\n"),
    writeFile: (path, text) => {
      writes.push([path, text]);
      return Promise.resolve();
    },
  });
  assertEquals(status, 0);
  assertEquals(writes.length, 1);
  assertEquals(writes[0][1], "");
});

//
// Stripping a namespace
//
// The members a withheld namespace declares, and the shapes that make finding
// their bounds hard: braces in prose, a signature wrapped across lines, a
// declaration split across blocks.
//

Deno.test("strips a namespace's value members and keeps its types", () => {
  const { text, removed } = stripWithheldGlobals(
    [
      "declare namespace Withheld {",
      "    var Collator: CollatorConstructor;",
      "    function getCanonicalLocales(locale?: string): string[];",
      "    interface CollatorOptions {",
      "        usage?: string;",
      "    }",
      '    type Fallback = "code" | "none";',
      "}",
      "",
    ].join("\n"),
    names,
  );

  assertEquals(removed, ["Withheld"]);
  assertEquals(
    text,
    [
      "declare namespace Withheld {",
      "    interface CollatorOptions {",
      "        usage?: string;",
      "    }",
      '    type Fallback = "code" | "none";',
      "}",
      "",
    ].join("\n"),
  );
});

Deno.test("strips a braced namespace value member, keeping the interface", () => {
  const { text, removed } = stripWithheldGlobals(
    [
      "declare namespace Withheld {",
      "    const RelativeTimeFormat: {",
      "        new (): RelativeTimeFormat;",
      "    };",
      "    interface RelativeTimeFormat {",
      "        format(): string;",
      "    }",
      "}",
      "",
    ].join("\n"),
    names,
  );

  assertEquals(removed, ["Withheld"]);
  assertEquals(
    text,
    [
      "declare namespace Withheld {",
      "    interface RelativeTimeFormat {",
      "        format(): string;",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
});

Deno.test("ignores braces inside a namespace member's JSDoc", () => {
  const { text, removed } = stripWithheldGlobals(
    [
      "declare namespace Withheld {",
      "    /** Returns {@link Foo}; @throws {TypeError} on bad input. */",
      "    function supportedValuesOf(key: string): string[];",
      "    interface Kept {",
      "        value: string;",
      "    }",
      "}",
      "",
    ].join("\n"),
    names,
  );

  assertEquals(removed, ["Withheld"]);
  assertEquals(
    text,
    [
      "declare namespace Withheld {",
      "    /** Returns {@link Foo}; @throws {TypeError} on bad input. */",
      "    interface Kept {",
      "        value: string;",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
});

Deno.test("leaves a non-withheld namespace's members alone", () => {
  const source = [
    "declare namespace Kept {",
    "    var Value: ValueConstructor;",
    "}",
    "",
  ].join("\n");
  const { text, removed } = stripWithheldGlobals(source, names);

  assertEquals(removed, []);
  assertEquals(text, source);
});

Deno.test("re-stripping an emptied namespace removes nothing", () => {
  const source = [
    "declare namespace Withheld {",
    "    var Collator: CollatorConstructor;",
    "}",
    "",
  ].join("\n");
  const once = stripWithheldGlobals(source, names).text;
  const twice = stripWithheldGlobals(once, names);

  assertEquals(twice.removed, []);
  assertEquals(twice.text, once);
});

Deno.test("reports a namespace split across blocks once", () => {
  const { removed } = stripWithheldGlobals(
    [
      "declare namespace Withheld {",
      "    var Collator: C;",
      "}",
      "declare namespace Withheld {",
      "    var NumberFormat: N;",
      "}",
      "",
    ].join("\n"),
    names,
  );

  assertEquals(removed, ["Withheld"]);
});

Deno.test("throws when a namespace member's braces never close", () => {
  assertThrows(
    () =>
      stripWithheldGlobals(
        [
          "declare namespace Withheld {",
          "    const RelativeTimeFormat: {",
          "        new (): RelativeTimeFormat;",
          "",
        ].join("\n"),
        names,
      ),
    Error,
    "Unbalanced namespace member",
  );
});

Deno.test("strips a namespace member whose signature wraps across lines", () => {
  const { text, removed } = stripWithheldGlobals(
    [
      "declare namespace Withheld {",
      "    function foo(",
      "        a: number,",
      "    ): void;",
      "    interface Kept {",
      "    }",
      "}",
      "",
    ].join("\n"),
    names,
  );

  assertEquals(removed, ["Withheld"]);
  assertEquals(
    text,
    [
      "declare namespace Withheld {",
      "    interface Kept {",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
});

Deno.test("throws when a wrapped namespace member never terminates", () => {
  assertThrows(
    () =>
      stripWithheldGlobals(
        [
          "declare namespace Withheld {",
          "    function foo(",
          "        a: number,",
          "",
        ].join("\n"),
        names,
      ),
    Error,
    "Unbalanced namespace member",
  );
});

Deno.test("drops a namespace value member's trailing blank line", () => {
  const { text, removed } = stripWithheldGlobals(
    [
      "declare namespace Withheld {",
      "    var Collator: C;",
      "",
      "    interface Kept {",
      "    }",
      "}",
      "",
    ].join("\n"),
    names,
  );

  assertEquals(removed, ["Withheld"]);
  assertEquals(
    text,
    [
      "declare namespace Withheld {",
      "    interface Kept {",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
});

//
// `stillDeclared` on a namespace
//
// `stillDeclared` is the post-strip safety net. `runCli` only ever hands it
// already-stripped text, where a withheld namespace has no value members left,
// so its namespace branch is exercised directly here.
//

Deno.test("stillDeclared flags a withheld namespace that still declares a value", () => {
  const text = [
    "declare namespace Withheld {",
    "    var Collator: C;",
    "    interface Kept {",
    "    }",
    "}",
    "",
  ].join("\n");

  assertEquals(stillDeclared(text, names), ["Withheld"]);
});

Deno.test("stillDeclared ignores an emptied or types-only withheld namespace", () => {
  assertEquals(stillDeclared("declare namespace Withheld {\n}\n", names), []);
  assertEquals(
    stillDeclared(
      [
        "declare namespace Withheld {",
        "    interface Kept {",
        "    }",
        "}",
        "",
      ].join("\n"),
      names,
    ),
    [],
  );
});
