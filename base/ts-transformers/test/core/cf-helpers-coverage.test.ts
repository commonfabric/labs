/**
 * Unit coverage for `src/core/cf-helpers.ts`.
 *
 * These tests exercise the CFHelpers class's import-scanning constructor and its
 * expression/qualified-name factory methods, plus the module-level import-shape
 * recognizer `getCFHelpersIdentifier` (reached indirectly through the
 * constructor and `sourceHasHelpers`).
 *
 * The recognizer accepts only a named import of `__cfHelpers` from the
 * "commonfabric" module specifier. Each test pins one gate of that shape by
 * feeding a source whose import differs in exactly one respect and asserting
 * whether the helper is detected.
 */

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";

import ts from "typescript";

import {
  CF_HELPERS_IDENTIFIER,
  CFHelpers,
  injectCfHelpers,
  transformCfDirective,
} from "../../src/core/cf-helpers.ts";

function sourceFileFor(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "/test.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
}

function helpersFor(source: string): CFHelpers {
  return new CFHelpers({
    sourceFile: sourceFileFor(source),
    factory: ts.factory,
  });
}

function printExpr(node: ts.Node, sourceFile: ts.SourceFile): string {
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printNode(
    ts.EmitHint.Unspecified,
    node,
    sourceFile,
  );
}

//
// Constructor scanning: getCFHelpersIdentifier
//

Deno.test("CFHelpers detects the __cfHelpers named import from commonfabric", () => {
  const helpers = helpersFor(
    `import { __cfHelpers } from "commonfabric";`,
  );
  assert(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers detects a renamed __cfHelpers import via its property name", () => {
  // `element.propertyName` is `__cfHelpers`; the local binding is `h`. The
  // scanner keys on the imported (property) name, so it still resolves the
  // helper and stores the local alias identifier.
  const helpers = helpersFor(
    `import { __cfHelpers as h } from "commonfabric";`,
  );
  assert(helpers.sourceHasHelpers());

  const sf = sourceFileFor(`import { __cfHelpers as h } from "commonfabric";`);
  const expr = new CFHelpers({ sourceFile: sf, factory: ts.factory })
    .getHelperExpr("lift");
  // The stored identifier is the local alias `h`, not the imported name.
  assertEquals(printExpr(expr, sf), "h.lift");
});

Deno.test("CFHelpers ignores __cfHelpers imported from a non-commonfabric module", () => {
  const helpers = helpersFor(
    `import { __cfHelpers } from "other-module";`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores an import whose specifier is not a string literal", () => {
  // A bare `import mod = require(...)` has no StringLiteral module specifier, so
  // the `ts.isStringLiteral(moduleSpecifier)` guard rejects it.
  const helpers = helpersFor(
    `import __cfHelpers = require("commonfabric");`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores a default (non-named) import from commonfabric", () => {
  // `import __cfHelpers from "commonfabric"` has an import clause but no
  // NamedImports binding, so the `ts.isNamedImports(namedBindings)` guard fails.
  const helpers = helpersFor(
    `import __cfHelpers from "commonfabric";`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores a namespace import from commonfabric", () => {
  // `import * as __cfHelpers` produces a NamespaceImport binding, not
  // NamedImports.
  const helpers = helpersFor(
    `import * as __cfHelpers from "commonfabric";`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores commonfabric named imports that are not __cfHelpers", () => {
  const helpers = helpersFor(
    `import { pattern, Cell } from "commonfabric";`,
  );
  assertFalse(helpers.sourceHasHelpers());
});

Deno.test("CFHelpers ignores a bare import declaration with no import clause", () => {
  // `import "commonfabric"` has `importClause === undefined`.
  const helpers = helpersFor(`import "commonfabric";`);
  assertFalse(helpers.sourceHasHelpers());
});

//
// getHelperExpr / getHelperQualified
//

Deno.test("getHelperExpr throws when the source has no helpers import", () => {
  const helpers = helpersFor(`const x = 1;`);
  assertThrows(
    () => helpers.getHelperExpr("lift"),
    Error,
    "Source file does not contain helpers.",
  );
});

Deno.test("getHelperExpr without an original node builds a plain property access", () => {
  const source = `import { __cfHelpers } from "commonfabric";`;
  const sf = sourceFileFor(source);
  const helpers = new CFHelpers({ sourceFile: sf, factory: ts.factory });
  const expr = helpers.getHelperExpr("lift");
  assert(ts.isPropertyAccessExpression(expr));
  assertEquals(printExpr(expr, sf), "__cfHelpers.lift");
});

Deno.test("getHelperExpr with an original node preserves source map ranges and identity", () => {
  const source =
    `import { __cfHelpers } from "commonfabric";\nconst marker = 1;`;
  const sf = sourceFileFor(source);
  const helpers = new CFHelpers({ sourceFile: sf, factory: ts.factory });

  // Any node from the source works as the original-node anchor.
  let original: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (!original && ts.isNumericLiteral(node)) original = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert(original);

  const expr = helpers.getHelperExpr("lift", original);
  assert(ts.isPropertyAccessExpression(expr));
  const helperImport = sf.statements[0];
  assert(ts.isImportDeclaration(helperImport));
  const namedBindings = helperImport.importClause?.namedBindings;
  assert(namedBindings && ts.isNamedImports(namedBindings));
  const helperIdentity = namedBindings.elements[0]?.name;
  assert(helperIdentity);
  // The whole property-access is anchored to the original node's source map
  // range (its position), distinguishing this branch from the no-original one.
  assertEquals(ts.getSourceMapRange(expr).pos, original.pos);
  assert(ts.isIdentifier(expr.expression));
  assert(ts.getOriginalNode(expr.expression) === helperIdentity);
  assert(ts.getOriginalNode(expr.name) === expr.name);
  assert(ts.getOriginalNode(expr) === expr);
  assertEquals(printExpr(expr, sf), "__cfHelpers.lift");
});

Deno.test("getHelperQualified throws when the source has no helpers import", () => {
  const helpers = helpersFor(`const x = 1;`);
  assertThrows(
    () => helpers.getHelperQualified("JSONSchema"),
    Error,
    "Source file does not contain helpers.",
  );
});

Deno.test("getHelperQualified builds a qualified name against the helper identifier", () => {
  const source = `import { __cfHelpers } from "commonfabric";`;
  const sf = sourceFileFor(source);
  const helpers = new CFHelpers({ sourceFile: sf, factory: ts.factory });
  const qualified = helpers.getHelperQualified("JSONSchema");
  assert(ts.isQualifiedName(qualified));
  assertEquals(qualified.right.text, "JSONSchema");
  assertEquals((qualified.left as ts.Identifier).text, CF_HELPERS_IDENTIFIER);
});

//
// transformCfDirective / injectCfHelpers (string passes)
//

Deno.test("transformCfDirective returns an all-blank source unchanged", () => {
  // With no content line, `findFirstContentLineIndex` returns null and the
  // source is returned verbatim before any injection.
  const source = "\n   \n\t\n";
  assertEquals(transformCfDirective(source), source);
});

Deno.test("transformCfDirective injects the helpers import for an ordinary source", () => {
  const source = `const answer = 42;`;
  const out = transformCfDirective(source);
  // Prepends the `__cfHelpers` import prelude and appends the used-helper
  // shim so binding survives tree-shaking.
  assert(out.startsWith(`import { ${CF_HELPERS_IDENTIFIER} } from`));
  assert(out.includes(source));
  assert(out.includes(`${CF_HELPERS_IDENTIFIER}.h.apply`));
});

Deno.test("injectCfHelpers uses TypeScript helper-shim syntax by default", () => {
  const out = injectCfHelpers(`const x = 1;`);
  // The TS variant carries the `: any[]` rest annotation.
  assert(out.includes("function h(...args: any[])"));
});

Deno.test("injectCfHelpers uses JS-only helper-shim syntax for JavaScript file names", () => {
  const out = injectCfHelpers(`const x = 1;`, "authored.jsx");
  // The JS variant drops the type annotation to stay parseable in .jsx.
  assert(out.includes("function h(...args)"));
  assertFalse(out.includes("function h(...args: any[])"));
});

const FALLBACK_TRAILER_TS = "// @ts-ignore: Internals\n" +
  "function __cfHelpersShim(...args: any[]) { return __cfHelpers.h.apply(null, args); }\n";
const FALLBACK_TRAILER_JS = "// @ts-ignore: Internals\n" +
  "function __cfHelpersShim(...args) { return __cfHelpers.h.apply(null, args); }\n";

Deno.test("injectCfHelpers renames the shim to `__cfHelpersShim` when the source binds `h` at top level", () => {
  // A second module-scope `h` would be a duplicate identifier (TS2300, or
  // TS2440 against an import) at the authored declaration. Keeping the helper
  // import live is all the shim contributes once JSX dispatches through
  // `__cfHelpers.h` (js-compiler `jsxFactory`), so only its name changes; the
  // shape stays a direct function, which the runner's module-body verifier
  // admits at module scope.
  const declarations: Record<string, string> = {
    "const": "export const h = [1, 2];",
    "let": "let h = 1;",
    "var": "var h = 1;",
    "function": "export function h(x: number) { return x; }",
    "ambient function": "declare function h(): void;",
    "class": "class h {}",
    "enum": "enum h { A }",
    "namespace": "namespace h { export const a = 1; }",
    "object destructuring": "const { a: { h } } = { a: { h: 1 } };",
    "array destructuring": "const [, [h]] = [0, [1]];",
    "default import": 'import h from "./h.ts";',
    "named import alias": 'import { hyperscript as h } from "./h.ts";',
    "namespace import": 'import * as h from "./h.ts";',
    "import equals": 'import h = require("./h.ts");',
    // A type-only import still occupies the binding (TS2440 against a local
    // declaration), so it counts too.
    "type-only import": 'import type { h } from "./h.ts";',
    // `var` hoists out of nested blocks and loops to the module scope.
    "var in a block": "{ var h = 1; }",
    "var in an if": "if (Math.random()) { var h = 1; } else { const x = 1; }",
    "var in a classic for": "for (var h = 0; h < 1; h++) {}",
    "var in a for-of": "for (var h of [1]) {}",
    "var in a for-in": "for (var h in { a: 1 }) {}",
    "var in a try": "try { var h = 1; } catch { }",
    "var in a catch": "try { } catch (e) { var h = e; }",
    "var in a switch case": "switch (1) { case 1: var h = 1; break; default: }",
    "var in a labeled block": "outer: { var h = 1; }",
    "var in a while": "while (false) { var h = 1; }",
    "var in a do-while": "do { var h = 1; } while (false);",
    "var destructured in a block": "{ var { h } = { h: 1 }; }",
  };
  for (const [label, declaration] of Object.entries(declarations)) {
    for (const fileName of ["/main.tsx", "/main.jsx"]) {
      const out = injectCfHelpers(
        `${declaration}\nexport const ui = <div />;`,
        fileName,
      );
      assert(out.startsWith(`import { ${CF_HELPERS_IDENTIFIER} } from`), label);
      // The shim's own head, not `function h(` — the authored declaration may
      // be a function itself.
      assertFalse(out.includes("function h(...args"), `${label} (${fileName})`);
      const trailer = fileName.endsWith(".jsx")
        ? FALLBACK_TRAILER_JS
        : FALLBACK_TRAILER_TS;
      assert(out.endsWith(`\n${trailer}`), `${label} (${fileName})`);
    }
  }
});

Deno.test("injectCfHelpers parses `.ts` sources as TypeScript, so a `<T>` assertion cannot hide a later `h`", () => {
  // Parsed as TSX, `<number>1` opens a JSX element that swallows the rest of
  // the file, and the scan would miss `h`.
  const sources = [
    "export const n = <number>1;\nexport const h = [1];",
    "export const id = <T>(x: T) => x;\nexport const h = 1;",
  ];
  for (const source of sources) {
    const out = injectCfHelpers(source, "/main.ts");
    assert(out.endsWith(`\n${FALLBACK_TRAILER_TS}`), source);
  }
});

Deno.test("injectCfHelpers rejects the reserved fallback shim name in authored source", () => {
  assertThrows(
    () => injectCfHelpers("const __cfHelpersShim = 1;\nconst h = 2;"),
    Error,
    "reserved helper symbol '__cfHelpersShim'",
  );
});

Deno.test("injectCfHelpers keeps the `h` shim when `h` is only nested, type-only, or not a local binding", () => {
  const sources: Record<string, string> = {
    "local inside a function":
      "export function render() { const h = [1]; return <div>{h}</div>; }",
    "parameter": "export const f = (h: number) => h + 1;",
    "interface": "interface h { a: number }",
    "type alias": "type h = number;",
    "re-export without a local binding": 'export { h } from "./h.ts";',
    "property named h": "export const o = { h: 1 };",
    "other top-level binding": "export const hh = 1;",
    "anonymous default function": "export default function () {}",
    "anonymous default class": "export default class {}",
    "side-effect import": 'import "./side-effect.ts";',
    "named import of something else": 'import { hyperscript } from "./h.ts";',
    // Block-scoped nested bindings and function-scoped `var` do not hoist.
    "const in a block": "{ const h = 1; }",
    "let in a for-of": "for (let h of [1]) {}",
    "var inside a nested function": "if (true) { function f() { var h = 1; } }",
    "var inside an arrow body": "export const f = () => { var h = 1; };",
    "var inside a class method": "class C { m() { var h = 1; } }",
  };
  for (const [label, source] of Object.entries(sources)) {
    const out = injectCfHelpers(source);
    assert(out.includes("function h(...args: any[])"), label);
    assertFalse(out.includes("__cfHelpersShim"), label);
  }
});

Deno.test("injectCfHelpers throws when the source already uses the reserved helper symbol", () => {
  assertThrows(
    () => injectCfHelpers(`const ${CF_HELPERS_IDENTIFIER} = {};`),
    Error,
    `reserved helper symbol '${CF_HELPERS_IDENTIFIER}'`,
  );
});
