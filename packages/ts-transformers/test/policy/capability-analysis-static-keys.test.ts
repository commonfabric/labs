/**
 * An element access, a `.key()` argument or a computed property name keyed by
 * an expression the code fixes is a static path segment: the capability
 * analysis records the read at the member the key names, and a builder's
 * input schema shrinks to it. A key is fixed by a literal, a Common Fabric
 * key, or a declared type that is a single literal, when every step from the
 * key to that type is a declaration that writes it or takes it from an
 * initializer that counts the same way. It is not fixed by a type assertion
 * anywhere on the way, at the key, in the initializer of the variable it names
 * or further back, nor by a step that is not a declaration, such as an element
 * access, an operator, a parameter typed by its context or a property of a
 * value cast to a type that declares it, nor by a narrowing
 * at the use, which a call between the test and the use can make stale. Such
 * a key reads as one that can name any member, so the read keeps every member
 * it could reach.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { callSchemas, parseModule } from "../transformed-ast.ts";
import { transformSource } from "../utils.ts";

const PRELUDE = `import { type Cell } from "commonfabric";
type Entry = { space: string; size: number };
type Catalog = { offers: { a: Entry; b: Entry }; meta: { x: number } };
declare const anyKey: string;
`;

/**
 * `source`, after `PRELUDE`, compiled as `/test.ts` beside the commonfabric
 * types, with the program's checker.
 */
function compile(source: string): {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
} {
  const files: Record<string, string> = {
    "/test.ts": PRELUDE + source,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, languageVersion) =>
      files[name] === undefined
        ? undefined
        : ts.createSourceFile(name, files[name]!, languageVersion, true),
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) =>
        files[`/${name}.d.ts`] === undefined ? undefined : {
          resolvedFileName: `/${name}.d.ts`,
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        }
      ),
  };
  const program = ts.createProgram(
    ["/test.ts"],
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noLib: true,
    },
    host,
  );
  return {
    checker: program.getTypeChecker(),
    sourceFile: program.getSourceFile("/test.ts")!,
  };
}

/** The arrow function `const read = …` declares in `sourceFile`. */
function findRead(sourceFile: ts.SourceFile): ts.ArrowFunction {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "read" && declaration.initializer &&
        ts.isArrowFunction(declaration.initializer)
      ) {
        return declaration.initializer;
      }
    }
  }
  throw new Error("Expected `const read = (catalog, …) => …`.");
}

/**
 * How the function `read` declared in `source` uses its parameter `catalog`:
 * the paths it reads, dot-joined, and whether the use is a wildcard.
 */
function catalogUsage(
  source: string,
): { readPaths: string[]; wildcard: boolean } {
  const { checker, sourceFile } = compile(source);
  const summary = analyzeFunctionCapabilities(findRead(sourceFile), {
    checker,
  });
  const catalog = summary.params.find((param) => param.name === "catalog");
  if (!catalog) throw new Error("Expected a summary for `catalog`.");
  return {
    readPaths: catalog.readPaths.map((path) => path.join(".")),
    wildcard: catalog.wildcard,
  };
}

/** Whether `usage` reads `offers.a` alone among the offers. */
function readsOnlyOfferA(usage: { readPaths: string[] }): boolean {
  return usage.readPaths.includes("offers.a.space") &&
    !usage.readPaths.some((path) => path === "" || path === "offers");
}

describe("capability-analysis-static-keys", () => {
  describe("a key the code fixes", () => {
    it("reads the member a `const` initialized with a literal names", () => {
      const usage = catalogUsage(`const KEY = "a";
const read = (catalog: Cell<Catalog>) => catalog.get().offers[KEY].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a `const` initialized `as const` names", () => {
      const usage = catalogUsage(`const KEY = "a" as const;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[KEY].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member an enum member names", () => {
      const usage = catalogUsage(`enum Key { A = "a", B = "b" }
const read = (catalog: Cell<Catalog>) =>
  catalog.get().offers[Key.A].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a parameter typed with a literal names", () => {
      const usage = catalogUsage(
        `const read = (catalog: Cell<Catalog>, key: "a") =>
  catalog.get().offers[key].space;`,
      );

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a non-null assertion's operand names", () => {
      const usage = catalogUsage(`declare const maybe: "a" | undefined;
const read = (catalog: Cell<Catalog>) =>
  catalog.get().offers[maybe!].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the element a `const` initialized with a number names", () => {
      const usage = catalogUsage(`const SECOND = 1;
const read = (catalog: Cell<{ slots: [Entry, Entry] }>) =>
  catalog.get().slots[SECOND].space;`);

      expect(usage.readPaths).toContain("slots.1.space");
      expect(usage.readPaths).not.toContain("slots");
    });

    it("reads the member a `const` copied from a `const` initialized with a literal names", () => {
      const usage = catalogUsage(`const KEY = "a";
const key = KEY;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a property of an object initialized `as const` names", () => {
      const usage = catalogUsage(`const KEYS = { first: "a" } as const;
const key = KEYS.first;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a property signature's written type names", () => {
      const usage = catalogUsage(`interface Choice { key: "a" }
declare const choice: Choice;
const key = choice.key;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a class field initialized `as const` names", () => {
      const usage = catalogUsage(`class Choice { readonly key = "a" as const; }
const key = new Choice().key;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a shorthand property names", () => {
      const usage = catalogUsage(`const k = "a";
const holder = { k } as const;
const key = holder.k;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a name destructured from a parameter's written type names", () => {
      const usage = catalogUsage(
        `const read = (catalog: Cell<Catalog>, { key }: { key: "a" }) =>
  catalog.get().offers[key].space;`,
      );

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a call names whose signature writes its return type", () => {
      const usage = catalogUsage(`function pick(): "a" {
  return "a";
}
const key = pick();
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a name destructured by a numeric property name names", () => {
      const usage = catalogUsage(`const { 0: key } = { 0: "a" } as const;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(readsOnlyOfferA(usage)).toBe(true);
    });

    it("reads the member a `.key()` argument's declared type names", () => {
      const usage = catalogUsage(`const KEY = "a";
const read = (catalog: Cell<Catalog>) =>
  catalog.key("offers").key(KEY).get().space;`);

      expect(usage.readPaths).toContain("offers.a.space");
      expect(usage.wildcard).toBe(false);
    });
  });

  describe("a key whose type the code does not fix", () => {
    it("reads past a key cast to a literal type", () => {
      const usage = catalogUsage(
        `const read = (catalog: Cell<Catalog>) =>
  catalog.get().offers[anyKey as "a"].space;`,
      );

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key whose `const` was initialized by a cast", () => {
      const usage = catalogUsage(`const key = anyKey as "a";
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key whose `const` was initialized by a cast under a non-null assertion", () => {
      const usage = catalogUsage(`const key = (anyKey as "a" | undefined)!;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key copied from a `const` initialized by a cast", () => {
      const usage = catalogUsage(`const asserted = anyKey as "a";
const key = asserted;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key read from an object property initialized by a cast", () => {
      const usage = catalogUsage(`const holder = { key: anyKey as "a" };
const key = holder.key;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key read from a shorthand property of a `const` initialized by a cast", () => {
      const usage = catalogUsage(`const k = anyKey as "a";
const holder = { k };
const key = holder.k;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key destructured from an object property initialized by a cast", () => {
      const usage = catalogUsage(`const { key } = { key: anyKey as "a" };
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key a conditional with a cast in one branch initializes", () => {
      const usage = catalogUsage(`declare const flag: boolean;
const key = flag ? (anyKey as "a") : "a";
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key a call returns whose signature writes no return type", () => {
      const usage = catalogUsage(`function pick() {
  return anyKey as "a";
}
const key = pick();
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key a generic call instantiates from a cast", () => {
      const usage = catalogUsage(`function id<T>(value: T): T {
  return value;
}
const key = id(anyKey as "a");
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a parameter typed by its context", () => {
      const usage = catalogUsage(
        `const read: (catalog: Cell<Catalog>, key: "a") => string = (
  catalog,
  key,
) => catalog.get().offers[key].space;`,
      );

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key read from a property no declaration writes", () => {
      const usage = catalogUsage(
        `type Table<K extends string, V> = { [P in K]: V };
declare const choice: Table<"k", "a">;
const key = choice.k;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`,
      );

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key read from a getter", () => {
      const usage = catalogUsage(`const holder = {
  get key(): "a" {
    return "a";
  },
};
const key = holder.key;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key destructured from a nested pattern", () => {
      const usage = catalogUsage(
        `const { inner: { key } } = { inner: { key: "a" } } as const;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`,
      );

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key destructured from an array", () => {
      const usage = catalogUsage(`const [key] = ["a"] as const;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key destructured by a computed name", () => {
      const usage = catalogUsage(`const { ["k"]: key } = { k: "a" } as const;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key read from a value cast to a type that declares the property", () => {
      const usage = catalogUsage(`const source = { key: anyKey };
const holder = source as { key: "a" };
const key = holder.key;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key destructured from a value cast to a type that declares the property", () => {
      const usage = catalogUsage(`const source = { key: anyKey };
const { key } = source as { key: "a" };
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key a generic type's property holds by an instantiation from a cast", () => {
      const usage = catalogUsage(`function wrap<T>(value: T): { key: T } {
  return { key: value };
}
const key = wrap(anyKey as "a").key;
const read = (catalog: Cell<Catalog>) => catalog.get().offers[key].space;`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key cast to a literal type inside parentheses and `satisfies`", () => {
      const usage = catalogUsage(
        `const read = (catalog: Cell<Catalog>) =>
  catalog.get().offers[(anyKey as "a") satisfies string].space;`,
      );

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a non-null assertion on a key cast to a literal type", () => {
      const usage = catalogUsage(
        `const read = (catalog: Cell<Catalog>) =>
  catalog.get().offers[(anyKey as "a" | undefined)!].space;`,
      );

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("reads past a key narrowed to a literal by a test a call can make stale", () => {
      const source =
        `const read = (catalog: Cell<Catalog>, pick: () => "a" | "b") => {
  let key = pick();
  const reset = () => {
    key = "b";
  };
  if (key === "a") {
    reset();
    return catalog.get().offers[key].space;
  }
  return "";
};`;
      const { checker, sourceFile } = compile(source);
      let keyAtUse: ts.Expression | undefined;
      const visit = (node: ts.Node): void => {
        if (
          ts.isElementAccessExpression(node) &&
          ts.isIdentifier(node.argumentExpression) &&
          node.argumentExpression.text === "key"
        ) {
          keyAtUse = node.argumentExpression;
        }
        node.forEachChild(visit);
      };
      visit(sourceFile);
      expect(checker.typeToString(checker.getTypeAtLocation(keyAtUse!)))
        .toBe('"a"');

      const usage = catalogUsage(source);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });

    it("leaves the receiver unshrunk for a `.key()` argument cast to a literal type", () => {
      const usage = catalogUsage(`const read = (catalog: Cell<Catalog>) =>
  catalog.key("offers").key(anyKey as "a").get().space;`);

      expect(usage.wildcard).toBe(true);
      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
    });

    it("leaves the receiver unshrunk for a destructured name keyed by a cast", () => {
      const usage = catalogUsage(`const read = (catalog: Cell<Catalog>) => {
  const { [anyKey as "a"]: entry } = catalog.get().offers;
  return entry.space;
};`);

      expect(usage.readPaths.some((path) => path.startsWith("offers.a")))
        .toBe(false);
      expect(usage.readPaths).not.toEqual([]);
    });
  });

  describe("a lift reading through a key a cast fixes further back", () => {
    /**
     * The members of `offers` a lift's input requires, for a pattern whose
     * computed reads `catalog.offers[key].space` after the statements `setup`
     * give `key` its value from the string `raw`.
     */
    async function offersRequired(setup: string): Promise<unknown> {
      const output = await transformSource(
        `import { computed, pattern } from "commonfabric";

type Entry = { space: string; size: number };
type Catalog = { offers: { a: Entry; b: Entry } };

export default pattern<{ catalog: Catalog; raw: string }>(
  ({ catalog, raw }) => {
    const space = computed(() => {
      ${setup}
      return catalog.offers[key].space;
    });
    return { space };
  },
);
`,
        { types: COMMONFABRIC_TYPES },
      );
      const [input] = callSchemas(parseModule(output), "lift");
      const properties = input?.properties as
        | Record<string, { properties: Record<string, { required?: unknown }> }>
        | undefined;
      return properties?.catalog.properties.offers.required;
    }

    it("keeps every offer for a key read from a value cast to a type that declares it", async () => {
      expect(
        await offersRequired(`const source = { key: raw };
      const holder = source as { key: "a" };
      const key = holder.key;`),
      ).toEqual(["a", "b"]);
    });

    it("keeps every offer for a key destructured from a value cast to a type that declares it", async () => {
      expect(
        await offersRequired(`const source = { key: raw };
      const { key } = source as { key: "a" };`),
      ).toEqual(["a", "b"]);
    });

    it("keeps every offer for a key a generic property holds by an instantiation from a cast", async () => {
      expect(
        await offersRequired(
          `const wrap = <T,>(value: T): { key: T } => ({ key: value });
      const key = wrap(raw as "a").key;`,
        ),
      ).toEqual(["a", "b"]);
    });
  });
});
