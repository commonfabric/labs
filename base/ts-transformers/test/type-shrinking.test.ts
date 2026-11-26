import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  type CapabilityParamSummary,
  CrossStageState,
  TransformationContext,
} from "../src/core/mod.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import {
  applyCapabilityDefaultsToTypeNode,
  applyShrinkAndWrap,
  containsAnyOrUnknownTypeNode,
  isCellLikeTypeNode,
  isSqliteTypeNode,
  isStreamTypeNode,
  preservedWrapperFor,
  printTypeNode,
  wrapTypeNodeWithCapability,
} from "../src/transformers/type-shrinking.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, collect, parseModule } from "./transformed-ast.ts";
import {
  createInMemoryProgram,
  transformFiles,
  validateSource,
} from "./utils.ts";
import { describe, it, test } from "@commonfabric/test-support/test";

//
// Structural inspection of printed type nodes.
//
// `printTypeNode` renders a `ts.TypeNode` to text. Asserting on that text with
// `assertStringIncludes` is weak: it matches on formatting and cannot tell a
// property named `title` apart from the word `title` appearing anywhere. These
// helpers reparse the printed type node and expose its members as real AST
// nodes so tests can assert on property names, optional flags, exact member
// types, and the shape of the root node.
//

/** Reparse a printed type node into a `ts.TypeNode`. */
function parseType(printed: string): ts.TypeNode {
  const decl = collect(
    parseModule(`type __T = ${printed};`),
    ts.isTypeAliasDeclaration,
  )[0];
  if (!decl) throw new Error(`Could not parse type node: ${printed}`);
  return decl.type;
}

interface PropInfo {
  optional: boolean;
  type: string;
}

/**
 * Every property signature reachable under `node`, keyed by name, carrying its
 * optional flag and the printed text of its declared type. Nested literals
 * contribute their own members, so `unused` being absent from the map means it
 * appears nowhere in the shape.
 */
function props(node: ts.Node): Map<string, PropInfo> {
  const sf = node.getSourceFile();
  const out = new Map<string, PropInfo>();
  for (const signature of collect(node, ts.isPropertySignature)) {
    const name = ts.isIdentifier(signature.name)
      ? signature.name.text
      : signature.name.getText(sf);
    out.set(name, {
      optional: !!signature.questionToken,
      type: signature.type ? signature.type.getText(sf) : "",
    });
  }
  return out;
}

/** Reparse the printed shrink result and return its member map. */
function shrunkProps(result: ts.TypeNode, sourceFile: ts.SourceFile): {
  node: ts.TypeNode;
  props: Map<string, PropInfo>;
} {
  const node = parseType(printTypeNode(result, sourceFile));
  return { node, props: props(node) };
}

/** True when `node` contains a reference to the qualified name `left.right`. */
function hasQualifiedRef(node: ts.Node, left: string, right: string): boolean {
  return collect(node, ts.isTypeReferenceNode).some((ref) => {
    const name = ref.typeName;
    return ts.isQualifiedName(name) &&
      ts.isIdentifier(name.left) && name.left.text === left &&
      name.right.text === right;
  });
}

function createProgram(source: string): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { program, sourceFile, checker: program.getTypeChecker() };
}

function createProgramWithFiles(
  files: Record<string, string>,
  entryFileName = "/test.ts",
): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
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
      files[name] !== undefined
        ? ts.createSourceFile(
          name,
          files[name]!,
          languageVersion,
          true,
          name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
        : undefined,
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) => {
        const directMatch = Object.keys(files).find((fileName) =>
          fileName === `/${name}.d.ts` ||
          fileName.endsWith(`/${name}.d.ts`)
        );
        if (!directMatch) {
          return undefined;
        }
        return {
          resolvedFileName: directMatch,
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        };
      }),
  };

  const program = ts.createProgram([entryFileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(entryFileName);
  if (!sourceFile) {
    throw new Error("Expected source file in program.");
  }

  return { sourceFile, checker: program.getTypeChecker() };
}

function findTypeAlias(
  sourceFile: ts.SourceFile,
  aliasName: string,
): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === aliasName
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error(`Type alias ${aliasName} not found`);
  }

  return found;
}

function createParamSummary(
  summary: Partial<CapabilityParamSummary>,
): CapabilityParamSummary {
  return {
    name: "input",
    capability: "opaque",
    readPaths: [],
    writePaths: [],
    opaquePaths: [],
    passthrough: false,
    wildcard: false,
    identityOnly: false,
    ...summary,
  };
}

/** What `shrinkInput()` returns. */
interface ShrunkInput {
  /** The shrunk node, printed and parsed again. */
  readonly result: ts.TypeNode;

  /** The node the shrink returned, as it returned it. */
  readonly node: ts.TypeNode;

  /** The type node the alias `Input` declares. */
  readonly authored: ts.TypeNode;

  /** The messages of the diagnostics path validation reported. */
  readonly diagnostics: readonly string[];
}

/**
 * Shrinks the type alias `Input` that `source` declares, in a program that can
 * import `commonfabric`, as `summary` describes a parameter of that type.
 * Paths are validated against the type unless `validate` is `false`. With
 * `synthetic`, the base node is a synthesized `unknown`, which sends the
 * shrink to the type; with `untyped`, no type goes with the node.
 */
function shrinkInput(
  source: string,
  summary: CapabilityParamSummary,
  options: {
    readonly synthetic?: boolean;
    readonly untyped?: boolean;
    readonly validate?: boolean;
    readonly mode?: "full" | "defaults_only";
  } = {},
): ShrunkInput {
  const program = createInMemoryProgram({
    "/test.ts": source,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
  }, {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  });
  const sourceFile = program.getSourceFile("/test.ts")!;
  const checker = program.getTypeChecker();
  let tsContext: ts.TransformationContext | undefined;
  ts.transform(sourceFile, [(transformation) => {
    tsContext = transformation;
    return (node) => node;
  }]);
  const context = new TransformationContext({
    program,
    sourceFile,
    tsContext: tsContext!,
    options: { state: new CrossStageState() },
  });
  const alias = findTypeAlias(sourceFile, "Input");
  const node = applyShrinkAndWrap(
    summary,
    options.synthetic
      ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
      : alias.type,
    options.untyped ? undefined : checker.getTypeAtLocation(alias.type),
    false,
    checker,
    sourceFile,
    ts.factory,
    options.mode,
    summary.capability,
    options.validate === false ? undefined : context,
    alias,
  );
  return {
    result: parseType(printTypeNode(node, sourceFile)),
    node,
    authored: alias.type,
    diagnostics: context.diagnostics.map(({ message }) => message),
  };
}

/** The names of the members of `node`, a type literal, in order. */
function memberNames(node: ts.TypeNode): string[] {
  if (!ts.isTypeLiteralNode(node)) {
    throw new Error(`Expected a type literal, not ${ts.SyntaxKind[node.kind]}`);
  }
  return node.members.map((member) =>
    member.name ? member.name.getText(node.getSourceFile()) : "(unnamed)"
  );
}

describe("applyShrinkAndWrap()", () => {
  describe("a member named by the empty string", () => {
    // A path through the member `""` narrows the shape and the cell it reaches
    // as a path through any other name does, and is held to the type as any
    // other path is.

    /**
     * The input schema of the one `lift()` in a module holding `source`, and
     * the types of the diagnostics compiling it reports.
     */
    async function liftInput(
      source: string,
    ): Promise<{ schema: unknown; reported: string[] }> {
      const diagnostics: TransformationDiagnostic[] = [];
      const files = await transformFiles({
        "/main.tsx": `/// <cts-enable />
import { Default, equals, lift, pattern, Writable } from "commonfabric";
${source}
export default pattern<{ v: any }>(({ v }) => ({ m: l(v) }));`,
      }, { types: COMMONFABRIC_TYPES, pipelineDiagnostics: diagnostics });
      return {
        schema: callSchemas(parseModule(files["/main.tsx"]!), "lift")[0],
        reported: diagnostics.map(({ type }) => type),
      };
    }

    const onlyEmpty = (value: Record<string, unknown>) => ({
      type: "object",
      properties: { "": value },
      required: [""],
    });
    for (
      const [shape, source, expected] of [
        [
          "an object",
          'const l = lift((r: { "": string; other: number }) => r[""].length);',
          onlyEmpty({ type: "string" }),
        ],
        [
          "a nested object",
          'const l = lift((r: { inner: { "": string; other: number } }) => r.inner[""].length);',
          {
            type: "object",
            properties: { inner: onlyEmpty({ type: "string" }) },
            required: ["inner"],
          },
        ],
        [
          "an array's element",
          'const l = lift((r: { "": string; other: number }[]) => r[0]![""].length);',
          { type: "array", items: onlyEmpty({ type: "string" }) },
        ],
        [
          "an object, keeping its default",
          'const l = lift((r: { "": Default<string, "x">; other: number }) => r[""].length);',
          onlyEmpty({ type: "string", default: "x" }),
        ],
      ] as const
    ) {
      it(`keeps only the member a read through it names in ${shape}`, async () => {
        const { schema, reported } = await liftInput(source);

        expect(schema).toEqual(expected);
        expect(reported).toEqual([]);
      });
    }

    it("gives the cell under it the capability its read earns", async () => {
      const { schema } = await liftInput(
        'const l = lift((r: { "": Writable<number>; other: Writable<number> }) => r[""].get());',
      );

      expect(schema).toEqual(
        onlyEmpty({ type: "number", asCell: ["readonly"] }),
      );
    });

    it("gives the cell under it the comparable capability where it is only compared", async () => {
      const { schema } = await liftInput(
        'const l = lift((r: { "": Writable<number>; other: Writable<number> }) => equals(r[""], r[""]));',
      );

      expect(schema).toEqual(
        onlyEmpty({ type: "unknown", asCell: ["comparable"] }),
      );
    });

    for (
      const [shape, parameter] of [
        ["an object", "{ other: number }"],
        ["an array", "number[]"],
      ] as const
    ) {
      it(`reports a read through it that ${shape} does not hold`, async () => {
        const { reported } = await liftInput(
          `const l = lift((r: ${parameter}) => (r as any)[""].length);`,
        );

        expect(reported).toContain("schema:path-not-in-type");
      });
    }
  });

  it("records a node printed for a value read whole as printed from its type", () => {
    // A synthetic base node sends the shrink to the value's type, and a value
    // read whole is that type's print.

    const { program, sourceFile, checker } = createProgram(`
      type Item = { title: string; extra: any };
    `);
    const type = checker.getTypeAtLocation(
      findTypeAlias(sourceFile, "Item").type,
    );
    const state = new CrossStageState();
    const context = new TransformationContext({
      program,
      sourceFile,
      tsContext: { factory: ts.factory } as ts.TransformationContext,
      options: { state },
    });

    const result = applyShrinkAndWrap(
      createParamSummary({ readPaths: [[]] }),
      ts.factory.createTypeReferenceNode("Item"),
      type,
      false,
      checker,
      sourceFile,
      ts.factory,
      "full",
      "opaque",
      context,
    );

    expect(state.printedFrom(result)).toBe(type);
  });

  describe("choosing a shrink", () => {
    it("returns the authored node for a value read whole whose type holds an index signature", () => {
      // The candidate built from the type holds the index signature as a
      // member with no name, which counting the members that name a read
      // head passes over.

      const shrunk = shrinkInput(
        `type Input = { a: string; [key: string]: string };`,
        createParamSummary({ readPaths: [[]] }),
      );

      expect(shrunk.node).toBe(shrunk.authored);
    });

    it("keeps an authored `Array<T>` reference, shrinking its element", () => {
      const shrunk = shrinkInput(
        `interface Array<T> { length: number; [n: number]: T }
         type Input = Array<{ a: string; b: string }>;`,
        createParamSummary({ readPaths: [["0", "a"]] }),
      );

      const { result } = shrunk;
      if (
        !ts.isTypeReferenceNode(result) || !ts.isIdentifier(result.typeName)
      ) {
        throw new Error("Expected a type reference");
      }
      expect(result.typeName.text).toBe("Array");
      expect(memberNames(result.typeArguments![0]!)).toEqual(["a"]);
    });

    it("shrinks to the read paths for a summary that holds no opaque paths", () => {
      const shrunk = shrinkInput(
        `type Input = { a: string; b: number };`,
        {
          name: "input",
          capability: "opaque",
          readPaths: [["a"]],
          writePaths: [],
          passthrough: false,
          wildcard: false,
        },
      );

      expect(memberNames(shrunk.result)).toEqual(["a"]);
    });
  });

  describe("shrinking by type", () => {
    it("returns the reference to a self-referential array as its own element", () => {
      // `R` is an array of `R`, so a path that names no member of an array
      // reaches the element with the same paths it reached the array with.

      const shrunk = shrinkInput(
        `interface Array<T> { length: number; [n: number]: T }
         type R = R[];
         type Input = R;`,
        createParamSummary({ readPaths: [["x"]] }),
        { synthetic: true, validate: false },
      );

      const { result } = shrunk;
      if (!ts.isArrayTypeNode(result)) {
        throw new Error("Expected an array type");
      }
      const element = result.elementType;
      expect(
        ts.isTypeReferenceNode(element) && ts.isIdentifier(element.typeName)
          ? element.typeName.text
          : undefined,
      ).toBe("R");
    });
  });

  describe("shrinking a declared reference", () => {
    it("shrinks interfaces that extend each other to the members read", () => {
      const shrunk = shrinkInput(
        `interface A extends B { a: string; c: string }
         interface B extends A { b: string }
         type Input = A;`,
        createParamSummary({ readPaths: [["a"]] }),
        { validate: false },
      );

      expect(memberNames(shrunk.result)).toEqual(["a"]);
    });

    it("reads no member from an `implements` clause on an interface", () => {
      const shrunk = shrinkInput(
        `interface B { b: string }
         interface A implements B { a: string; z: string }
         type Input = A;`,
        createParamSummary({ readPaths: [["a"], ["b"]] }),
      );

      expect(shrunk.diagnostics).toHaveLength(1);
      expect(shrunk.diagnostics[0]).toContain("accesses '.b'");
    });

    it("leaves out a member keyed by a symbol", () => {
      const shrunk = shrinkInput(
        `declare const key: unique symbol;
         type Input = { a: string; [key]: string };`,
        createParamSummary({ readPaths: [["a"]] }),
      );

      expect(memberNames(shrunk.result)).toEqual(["a"]);
    });
  });

  describe("validating the paths read", () => {
    it("reports a head no member of a union holds, and not one a single member holds", () => {
      // The union is named, so no node spells its members, and they are read
      // from its type.

      const shrunk = shrinkInput(
        `type Either = { a: string } | { b: string };
         type Input = Either;`,
        createParamSummary({ readPaths: [["a"], ["c"]] }),
      );

      expect(shrunk.diagnostics).toHaveLength(1);
      expect(shrunk.diagnostics[0]).toContain("accesses '.c' but");
    });

    it("names the element type an `Array<T>` writes in a missing-path diagnostic", () => {
      const shrunk = shrinkInput(
        `interface Array<T> { length: number; [n: number]: T }
         type Input = Array<{ id: string }> | undefined;`,
        createParamSummary({ readPaths: [["0", "id"], ["0", "missing"]] }),
      );

      expect(shrunk.diagnostics).toEqual([
        "Parameter 'input' accesses '.missing' but type '{\n    id: string;\n}' " +
        "does not include it. Add the missing property to the type.",
      ]);
    });

    it("validates an element an array-like literal holds in an index signature against its type", () => {
      const shrunk = shrinkInput(
        `type Input = { length: number; [i: number]: { id: string } } | undefined;`,
        createParamSummary({ readPaths: [["0", "id"], ["0", "missing"]] }),
      );

      expect(shrunk.diagnostics).toHaveLength(1);
      expect(shrunk.diagnostics[0]).toContain("accesses '.missing' but");
    });

    it("names the element a numeric member of an array-like literal writes in a missing-path diagnostic", () => {
      // The read of `other`, which no array holds, keeps the shrink from
      // being an array, so the element is read from the authored literal.

      const shrunk = shrinkInput(
        `type Input = {
           length: number;
           0: { id: string };
           [i: number]: { id: string; extra: number };
         };`,
        createParamSummary({
          readPaths: [["0", "id"], ["0", "missing"], ["other"]],
        }),
      );

      expect(shrunk.diagnostics).toEqual([
        "Parameter 'input' accesses '.missing', '.other' but type " +
        "'{\n    id: string;\n}' does not include them. Add the missing " +
        "properties to the type.",
      ]);
    });

    describe("a member declared on an array intersected with an object", () => {
      /** The diagnostic messages for a lift of `fn` in a pattern. */
      const liftDiagnostics = async (declarations: string, fn: string) => {
        const { diagnostics } = await validateSource(
          `/// <cts-enable />
import { lift, pattern } from "commonfabric";
${declarations}
const l = lift(${fn});
export default pattern<{ v: any }>(({ v }) => ({ m: l(v) }));`,
          { types: COMMONFABRIC_TYPES },
        );
        return diagnostics.map(({ message }) => message);
      };

      it("reports nothing for the member on a self-referential array", async () => {
        expect(
          await liftDiagnostics(
            "type R = R[];",
            "(r: R & { x: string }) => r.x",
          ),
        ).toEqual([]);
      });

      it("reports a head neither the array nor its element holds on a self-referential array", async () => {
        expect(
          await liftDiagnostics(
            "type R = R[];",
            "(r: R & { x: string }) => r.missing",
          ),
        ).toEqual([
          "Parameter 'r' accesses '.missing' but type 'R' does not include " +
          "it. Add the missing property to the type.",
        ]);
      });

      it("reports nothing for the member on an array of objects", async () => {
        expect(
          await liftDiagnostics(
            "",
            "(r: { id: string }[] & { total: number }) => r.total",
          ),
        ).toEqual([]);
      });

      it("reports nothing for the member on an array of strings", async () => {
        expect(
          await liftDiagnostics("", "(r: string[] & { x: string }) => r.x"),
        ).toEqual([]);
      });

      it("reports nothing for a read of the array's own method", async () => {
        expect(
          await liftDiagnostics(
            "",
            "(r: { id: string }[] & { total: number }) => r.values",
          ),
        ).toEqual([]);
      });

      it("reports an element member the element does not declare, named like an array method", async () => {
        expect(
          await liftDiagnostics(
            "",
            "(r: { id: string }[] & { total: number }) => r.map((x) => x.values)",
          ),
        ).toEqual([
          "Parameter 'r' accesses '.values' but type '{ id: string; }' does " +
          "not include it. Add the missing property to the type.",
        ]);
      });
    });
  });

  describe("applying defaults", () => {
    /** A default of the string literal `value` at `path`. */
    const stringDefault = (path: readonly string[], value: string) => ({
      path,
      defaultType: ts.factory.createLiteralTypeNode(
        ts.factory.createStringLiteral(value),
      ),
    });

    it("applies a default to a member named by the empty string", () => {
      const shrunk = shrinkInput(
        `type Input = { "": string; other: number };`,
        createParamSummary({
          readPaths: [[""]],
          defaults: [stringDefault([""], "x")],
        }),
      );

      const [member] = collect(shrunk.result, ts.isPropertySignature);
      expect(member && hasQualifiedRef(member, "__cfHelpers", "Default"))
        .toBe(true);
    });

    it("applies no default it cannot place when the node comes with no type", () => {
      const shrunk = shrinkInput(
        `type Input = { a: string; b: string };`,
        createParamSummary({
          readPaths: [["a"]],
          defaults: [stringDefault(["missing"], "x")],
        }),
        { untyped: true, validate: false },
      );

      expect(memberNames(shrunk.result)).toEqual(["a"]);
      expect(hasQualifiedRef(shrunk.result, "__cfHelpers", "Default"))
        .toBe(false);
    });

    it("keeps an array beside a nested default whole when only defaults apply", () => {
      const shrunk = shrinkInput(
        `interface Array<T> { length: number; [n: number]: T }
         type Input = { a: { list: string[]; n: string }; b: string };`,
        createParamSummary({ defaults: [stringDefault(["a", "n"], "x")] }),
        { mode: "defaults_only", synthetic: true, validate: false },
      );

      const a = collect(shrunk.result, ts.isPropertySignature).find((member) =>
        ts.isIdentifier(member.name) && member.name.text === "a"
      );
      expect(a?.type && memberNames(a.type)).toEqual(["list", "n"]);
    });

    it("leaves the node as it is when a default's path reaches no member", () => {
      const shrunk = shrinkInput(
        `type Input = { a: { id: string }; b: string };`,
        createParamSummary({
          wildcard: true,
          readPaths: [["a", "id"]],
          defaults: [stringDefault(["a", "missing"], "x")],
        }),
        { validate: false },
      );

      expect(shrunk.node).toBe(shrunk.authored);
    });

    it("keeps a method beside the member a default is applied to", () => {
      const shrunk = shrinkInput(
        `type Input = { a: { id: string }; m(): void };`,
        createParamSummary({
          wildcard: true,
          readPaths: [["a", "id"]],
          defaults: [stringDefault(["a", "id"], "x")],
        }),
        { validate: false },
      );

      expect(memberNames(shrunk.result)).toEqual(["a", "m"]);
      expect(hasQualifiedRef(shrunk.result, "__cfHelpers", "Default"))
        .toBe(true);
    });
  });

  describe("narrowing identity paths", () => {
    // Under an identity-only root nothing is shrunk, so each member the
    // identity paths pass over stays as it is.

    it("narrows the member an identity path names, keeping methods and symbol keys", () => {
      const shrunk = shrinkInput(
        `declare const key: unique symbol;
         type Input = { [key]: string; a: { id: string }; m(): void };`,
        createParamSummary({ identityOnly: true, identityPaths: [["a"]] }),
        { validate: false },
      );

      expect(memberNames(shrunk.result)).toEqual(["[key]", "a", "m"]);
      const a = collect(shrunk.result, ts.isPropertySignature).find((member) =>
        ts.isIdentifier(member.name) && member.name.text === "a"
      );
      expect(a?.type?.kind).toBe(ts.SyntaxKind.UnknownKeyword);
    });

    it("keeps a declared reference whose identity path reaches no member", () => {
      const shrunk = shrinkInput(
        `interface Item { a: { id: string }; b: string }
         type Input = Item;`,
        createParamSummary({
          identityOnly: true,
          identityPaths: [["a", "missing"]],
        }),
        { validate: false },
      );

      expect(shrunk.node).toBe(shrunk.authored);
    });

    it("keeps the methods and symbol keys of a declared reference it narrows a member of", () => {
      const shrunk = shrinkInput(
        `declare const key: unique symbol;
         interface Item { [key]: string; a: { id: string }; m(): void }
         type Input = Item;`,
        createParamSummary({ identityOnly: true, identityPaths: [["a"]] }),
        { validate: false },
      );

      expect(memberNames(shrunk.result)).toEqual(["[key]", "a", "m"]);
    });

    it("keeps a union whose identity path reaches no member", () => {
      const shrunk = shrinkInput(
        `type Input = { a: string } | { b: string };`,
        createParamSummary({ identityPaths: [["missing", "id"]] }),
        { validate: false },
      );

      expect(shrunk.node).toBe(shrunk.authored);
    });
  });

  describe("narrowing cells", () => {
    it("keeps a member keyed by a symbol beside a cell it narrows", () => {
      const shrunk = shrinkInput(
        `import type { Writable } from "commonfabric";
         declare const key: unique symbol;
         type Input = { [key]: string; c: Writable<{ v: string }> };`,
        createParamSummary({ wildcard: true, readPaths: [["c", "v"]] }),
      );

      expect(memberNames(shrunk.result)).toEqual(["[key]", "c"]);
      const c = collect(shrunk.result, ts.isPropertySignature).find((member) =>
        ts.isIdentifier(member.name) && member.name.text === "c"
      );
      expect(
        c?.type && hasQualifiedRef(c.type, "__cfHelpers", "ReadonlyCell"),
      ).toBe(true);
    });

    it("leaves a member that can hold only `null` or `undefined` uncelled", () => {
      const shrunk = shrinkInput(
        `type Input = { a: null | undefined; b: string };`,
        createParamSummary({ readPaths: [["a"], ["a", "x"], ["b"]] }),
        { synthetic: true },
      );

      const [a] = collect(shrunk.result, ts.isPropertySignature);
      expect(a?.type && ts.isUnionTypeNode(a.type)).toBe(true);
    });
  });
});

test("applyShrinkAndWrap preserves tuple roots for length-only synthetic shrinking", () => {
  const { sourceFile, checker } = createProgram(`
    type Pair = [number, string];
  `);
  const alias = findTypeAlias(sourceFile, "Pair");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "Pair");
});

test("applyShrinkAndWrap does not treat numeric index signatures as arrays", () => {
  const { sourceFile, checker } = createProgram(`
    type Indexed = { [index: number]: string };
  `);
  const alias = findTypeAlias(sourceFile, "Indexed");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "unknown");
});

test("applyShrinkAndWrap treats numeric index plus length as array-like", () => {
  const { sourceFile, checker } = createProgram(`
    type Option = {
      id: string;
      title: string;
      addedByName: string;
    };
    type Input = {
      length: number;
      [index: number]: Option;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: string;
}[]`,
  );
});

test("applyShrinkAndWrap preserves full array item shapes for direct array reads", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      people: {
        active: boolean;
        name: string;
        priorityRank: number;
      }[];
      other: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["people"], ["people", "0", "active"]],
      fullShapePaths: [["people"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assert(members.has("people"));
  assertEquals(members.get("active")?.type, "boolean");
  assertEquals(members.get("name")?.type, "string");
  assertEquals(members.get("priorityRank")?.type, "number");
  assertEquals(members.has("other"), false);
});

test("applyShrinkAndWrap keeps numeric array access array-shaped", () => {
  const { sourceFile, checker } = createProgram(`
    type Option = {
      id: string;
      title: string;
      addedByName: string;
    };
    type Input = Option[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: string;
}[]`,
  );
});

test("applyShrinkAndWrap prefers array-shaped semantic shrink over synthetic numeric object", () => {
  const { sourceFile, checker } = createProgram(`
    type Option = {
      id: string;
      title: string;
      addedByName: string;
    };
    type Input = Option[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(
      undefined,
      ts.factory.createNumericLiteral("0"),
      undefined,
      ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          undefined,
          "title",
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ),
      ]),
    ),
    ts.factory.createPropertySignature(
      undefined,
      "length",
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
    ),
  ]);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: string;
}[]`,
  );
});

test("applyShrinkAndWrap materializes item paths for synthetic unknown arrays", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = unknown[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const syntheticBaseNode = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(
      undefined,
      ts.factory.createNumericLiteral("0"),
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    ),
    ts.factory.createPropertySignature(
      undefined,
      "length",
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
    ),
  ]);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["length"], ["0", "title"]],
    }),
    syntheticBaseNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    `{
    title: unknown;
}[]`,
  );
});

test("applyShrinkAndWrap defaults-only fallback expands repeated child leaves independently", () => {
  const { sourceFile, checker } = createProgram(`
    type Shared = { a: string; b: string };
    type Input = { group: { left: Shared; right: Shared } };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const baseTypeNode = ts.factory.createTypeReferenceNode("Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      defaults: [{
        path: ["group", "left", "a"],
        defaultType: ts.factory.createKeywordTypeNode(
          ts.SyntaxKind.StringKeyword,
        ),
      }],
    }),
    baseTypeNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
    "defaults_only",
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // Both `left` and `right` are expanded into inline literals with `a` and `b`
  // leaves rather than left as `Shared` references.
  assertEquals(members.get("a")?.type, "string");
  assertEquals(members.get("b")?.type, "string");
  const right = collect(node, ts.isPropertySignature).find((signature) =>
    ts.isIdentifier(signature.name) && signature.name.text === "right"
  );
  assert(right && right.type && ts.isTypeLiteralNode(right.type));
});

test("applyShrinkAndWrap preserves nested primitive leaves for property-only access", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = { text: string };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);
  const baseTypeNode = ts.factory.createTypeReferenceNode("Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["text", "length"]],
    }),
    baseTypeNode,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("text")?.type, "string");
  assertEquals(members.has("length"), false);
});

test("applyShrinkAndWrap turns identity-only wrapped inputs into OpaqueCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    ts.factory.createTypeReferenceNode("Input"),
    baseType,
    true,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    "__cfHelpers.OpaqueCell<unknown>",
  );
});

test("applyShrinkAndWrap turns comparable wrapped inputs into ComparableCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "comparable",
      identityOnly: true,
      passthrough: true,
    }),
    ts.factory.createTypeReferenceNode("Input"),
    baseType,
    true,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(
    printTypeNode(result, sourceFile),
    "__cfHelpers.ComparableCell<unknown>",
  );
});

test("applyShrinkAndWrap turns identity-only unwrapped inputs into unknown", () => {
  const { sourceFile, checker } = createProgram(`
    type Item = { name: string; nested: { value: number } };
  `);
  const alias = findTypeAlias(sourceFile, "Item");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityOnly: true,
      passthrough: true,
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  assertEquals(printTypeNode(result, sourceFile), "unknown");
});

test("applyShrinkAndWrap turns identity-only cell leaves into OpaqueCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      left: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
      right: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["left"], ["right"]],
      identityCellPaths: [["left"], ["right"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("left")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("right")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.has("name"), false);
  assertEquals(members.has("nested"), false);
});

test("applyShrinkAndWrap turns read-only cell leaves into ReadonlyCell", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type ReadonlyCell<T> = { readonly readonly?: T };
    }
    type Input = {
      value: __cfHelpers.Writable<number>;
      untouched: __cfHelpers.Writable<string>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "readonly",
      readPaths: [["value"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("value")?.type, "__cfHelpers.ReadonlyCell<number>");
  assertEquals(members.has("untouched"), false);
});

test("applyShrinkAndWrap turns opaque derivation cell leaves into OpaqueCell", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      items: __cfHelpers.Writable<{ name: string }[]>;
      untouched: __cfHelpers.Writable<string>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      opaquePaths: [["items"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  const items = members.get("items");
  assert(items && hasQualifiedRef(node, "__cfHelpers", "OpaqueCell"));
  assert(items.type.startsWith("__cfHelpers.OpaqueCell<"));
  assertEquals(members.get("name")?.type, "string");
  assertEquals(members.has("untouched"), false);
});

test("applyShrinkAndWrap turns comparable cell leaves into ComparableCell<unknown>", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type Writable<T> = { readonly value?: T };
      export type ComparableCell<T> = { readonly comparable?: T };
    }
    type Input = {
      left: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
      right: __cfHelpers.Writable<{ name: string; nested: { value: number } }>;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      capability: "comparable",
      identityPaths: [["left"], ["right"]],
      identityCellPaths: [["left"], ["right"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(
    members.get("left")?.type,
    "__cfHelpers.ComparableCell<unknown>",
  );
  assertEquals(
    members.get("right")?.type,
    "__cfHelpers.ComparableCell<unknown>",
  );
  assertEquals(members.has("name"), false);
  assertEquals(members.has("nested"), false);
});

test("applyShrinkAndWrap lets identity containers cover retained child paths", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      item: { active: boolean; name: string };
      untouched: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["item", "active"]],
      identityPaths: [["item"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("item")?.type, "unknown");
  assertEquals(members.has("active"), false);
  assertEquals(members.has("name"), false);
});

test("applyShrinkAndWrap shrinks direct array parameters to used item fields", () => {
  const { sourceFile, checker } = createProgram(`
    type AssetRecord = {
      id: string;
      stage: string;
      owner: string;
      unused: { nested: string };
    };
    type Input = AssetRecord[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["id"], ["stage"], ["owner"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("id")?.type, "string");
  assertEquals(members.get("stage")?.type, "string");
  assertEquals(members.get("owner")?.type, "string");
  assertEquals(members.has("unused"), false);
  assertEquals(members.has("nested"), false);
});

test("applyShrinkAndWrap preserves inherited interface fields in array unions", () => {
  const { sourceFile, checker } = createProgram(`
    interface LeadState {
      id: string;
      name: string;
    }

    interface LeadScoreSummary extends LeadState {
      score: number;
      unused: string;
    }

    type Input = LeadScoreSummary[] | undefined;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["0", "id"], ["0", "score"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("id")?.type, "string");
  assertEquals(members.get("score")?.type, "number");
  assertEquals(members.has("name"), false);
  assertEquals(members.has("unused"), false);
});

test("applyShrinkAndWrap preserves aliased fixed-symbol keys in node-driven shrinking", () => {
  const { sourceFile, checker } = createProgramWithFiles({
    "/test.ts": `
      import { SELF as CF_SELF } from "commonfabric";

      type Input = {
        [CF_SELF]?: { id: string; title: string };
        value: string;
      };
    `,
    "/commonfabric.d.ts": `
      export declare const SELF: unique symbol;
    `,
  });
  const alias = findTypeAlias(sourceFile, "Input");

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["$SELF", "id"]],
    }),
    alias.type,
    undefined,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("[CF_SELF]")?.optional, true);
  assertEquals(members.get("id")?.type, "string");
  assertEquals(members.has("title"), false);
  assertEquals(members.has("value"), false);
});

test("applyCapabilityDefaultsToTypeNode applies defaults through tuples and unions", () => {
  const { sourceFile, checker } = createProgram(`
    type Input =
      | [{ name?: string; unused?: string }]
      | { fallback?: string; unused?: string };
    type NameDefault = "Anonymous";
    type FallbackDefault = "Fallback";
  `);
  const input = findTypeAlias(sourceFile, "Input");
  const nameDefault = findTypeAlias(sourceFile, "NameDefault");
  const fallbackDefault = findTypeAlias(sourceFile, "FallbackDefault");
  const baseType = checker.getTypeAtLocation(input.type);

  const result = applyCapabilityDefaultsToTypeNode(
    input.type,
    [
      { path: ["0", "name"], defaultType: nameDefault.type },
      { path: ["fallback"], defaultType: fallbackDefault.type },
    ],
    baseType,
    [["0", "name"], ["fallback"]],
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("name")?.optional, true);
  assertEquals(
    members.get("name")?.type,
    '__cfHelpers.Default<string, "Anonymous">',
  );
  assertEquals(members.get("fallback")?.optional, true);
  assertEquals(
    members.get("fallback")?.type,
    '__cfHelpers.Default<string, "Fallback">',
  );
});

test("type shrinking helper predicates detect wrapper type nodes", () => {
  const { sourceFile, checker } = createProgram(`
    type CellValue = Cell<string>;
    type StreamValue = Stream<string>;
    type SqliteValue = SqliteDb<{ id: string }>;
    type PlainValue = string;
    type AnyUnion = { value: any } | { fallback: unknown };
  `);
  const cellNode = findTypeAlias(sourceFile, "CellValue").type;
  const streamNode = findTypeAlias(sourceFile, "StreamValue").type;
  const sqliteNode = findTypeAlias(sourceFile, "SqliteValue").type;
  const plainNode = findTypeAlias(sourceFile, "PlainValue").type;
  const anyUnionNode = findTypeAlias(sourceFile, "AnyUnion").type;

  assertEquals(containsAnyOrUnknownTypeNode(anyUnionNode), true);
  assertEquals(containsAnyOrUnknownTypeNode(plainNode), false);
  assertEquals(isCellLikeTypeNode(cellNode), true);
  assertEquals(isCellLikeTypeNode(sqliteNode), false);
  assertEquals(isStreamTypeNode(streamNode), true);
  assertEquals(isStreamTypeNode(cellNode), false);
  assertEquals(isSqliteTypeNode(sqliteNode), true);
  assertEquals(isSqliteTypeNode(cellNode), false);
  assertEquals(preservedWrapperFor(streamNode, undefined, checker), "Stream");
  assertEquals(preservedWrapperFor(sqliteNode, undefined, checker), "SqliteDb");
  assertEquals(preservedWrapperFor(plainNode, undefined, checker), undefined);
});

test("applyShrinkAndWrap descends identity paths through named interface references", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    interface Inner { keep: string; drop: number; }
    interface Outer { inner: Inner; other: string; }
    type Input = Outer;
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["inner", "drop"], ["other"]],
      identityPaths: [["inner", "keep"]],
      identityCellPaths: [["inner", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  // The reference resolves to declared members, recurses into `inner`, and
  // wraps the `keep` leaf. Identity-path application transforms the targeted
  // leaf in place and leaves the members the summary reads intact.
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
  assertEquals(members.get("other")?.type, "string");
});

test("applyShrinkAndWrap rebuilds inline literals when a nested identity leaf changes", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      inner: { keep: string; drop: number };
      other: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["inner", "drop"], ["other"]],
      identityPaths: [["inner", "keep"]],
      identityCellPaths: [["inner", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
  assertEquals(members.get("other")?.type, "string");
});

test("applyShrinkAndWrap returns an inline literal unchanged when a nested identity path does not resolve", () => {
  const { sourceFile, checker } = createProgram(`
    type Input = {
      a: { x: string };
      b: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["a", "x"], ["b"]],
      identityPaths: [["a", "missing"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // No member changes, so the literal (and its `a` member) is returned as-is.
  assertEquals(members.get("x")?.type, "string");
  assertEquals(members.get("b")?.type, "string");
  assertEquals(hasQualifiedRef(node, "__cfHelpers", "OpaqueCell"), false);
});

test("applyShrinkAndWrap prunes members no path reaches when every path is an identity path", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    type Input = {
      inner: { keep: string; drop: number };
      other: string;
    };
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["inner", "keep"]],
      identityCellPaths: [["inner", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { props: members } = shrunkProps(result, sourceFile);
  // Only `inner.keep` is used, and only for its identity: it is narrowed, and
  // the members no path reaches are pruned as any shrink prunes them.
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.has("drop"), false);
  assertEquals(members.has("other"), false);
});

test("applyShrinkAndWrap leaves array elements untouched when an identity item path does not resolve", () => {
  const { sourceFile, checker } = createProgram(`
    interface Item { keep: string; drop: number; }
    type Input = Item[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      identityPaths: [["0", "missing"]],
      identityCellPaths: [["0", "missing"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const printed = printTypeNode(result, sourceFile);
  // The item path names no real member, so the element type (and the whole
  // array node) is returned unchanged.
  assertEquals(printed, "Item[]");
});

test("applyShrinkAndWrap descends identity item paths through readonly arrays", () => {
  const { sourceFile, checker } = createProgram(`
    declare namespace __cfHelpers {
      export type OpaqueCell<T> = { readonly opaque?: T };
    }
    interface Item { keep: string; drop: number; }
    type Input = readonly Item[];
  `);
  const alias = findTypeAlias(sourceFile, "Input");
  const baseType = checker.getTypeAtLocation(alias.type);

  const result = applyShrinkAndWrap(
    createParamSummary({
      readPaths: [["0", "drop"]],
      identityPaths: [["0", "keep"]],
      identityCellPaths: [["0", "keep"]],
    }),
    alias.type,
    baseType,
    false,
    checker,
    sourceFile,
    ts.factory,
  );

  const { node, props: members } = shrunkProps(result, sourceFile);
  // The readonly-array node recurses into its element type, resolves the item
  // interface's members, and wraps the requested leaf in place.
  assert(ts.isTypeOperatorNode(node));
  assertEquals(node.operator, ts.SyntaxKind.ReadonlyKeyword);
  assertEquals(members.get("keep")?.type, "__cfHelpers.OpaqueCell<unknown>");
  assertEquals(members.get("drop")?.type, "number");
});

test("wrapTypeNodeWithCapability emits the expected cell wrappers", () => {
  const { sourceFile } = createProgram(`type Value = string;`);
  const valueNode = findTypeAlias(sourceFile, "Value").type;

  const wrappers = [
    ["readonly", "ReadonlyCell"],
    ["comparable", "ComparableCell"],
    ["writeonly", "WriteonlyCell"],
    ["writable", "Writable"],
    ["opaque", "OpaqueCell"],
  ] as const;

  for (const [capability, wrapperName] of wrappers) {
    const node = parseType(printTypeNode(
      wrapTypeNodeWithCapability(valueNode, capability, ts.factory),
      sourceFile,
    ));
    assert(ts.isTypeReferenceNode(node));
    assert(hasQualifiedRef(node, "__cfHelpers", wrapperName));
    assert(node.typeArguments && node.typeArguments.length === 1);
    assertEquals(
      node.typeArguments[0]!.getText(node.getSourceFile()),
      "string",
    );
  }
});

test("applyShrinkAndWrap preserves a parenthesized capture while narrowing cell capability", () => {
  const { sourceFile, checker } = createProgramWithFiles({
    "/commonfabric.d.ts": "export interface Cell<T> { get(): T; }",
    "/test.ts": `
      import type { Cell } from "commonfabric";
      type Input = ({ value: Cell<{ count: number }>; other: string });
    `,
  });
  const alias = findTypeAlias(sourceFile, "Input");
  const result = applyShrinkAndWrap(
    createParamSummary({ wildcard: true, readPaths: [["value"]] }),
    alias.type,
    checker.getTypeAtLocation(alias.type),
    false,
    checker,
    sourceFile,
    ts.factory,
  );
  const { node } = shrunkProps(result, sourceFile);
  expect(ts.isParenthesizedTypeNode(node)).toBe(true);
  if (!ts.isParenthesizedTypeNode(node) || !ts.isTypeLiteralNode(node.type)) {
    throw new Error("Expected a parenthesized object capture");
  }
  const outer = node.type.members.filter(ts.isPropertySignature);
  expect(
    outer.map((member) =>
      ts.isIdentifier(member.name) ? member.name.text : undefined
    ),
  )
    .toEqual(["value", "other"]);
  const value = outer[0]!;
  const other = outer[1]!;
  expect(other.type?.kind).toBe(ts.SyntaxKind.StringKeyword);
  if (!value.type || !ts.isTypeReferenceNode(value.type)) {
    throw new Error("Expected the value property to carry the Cell wrapper");
  }
  if (
    !ts.isQualifiedName(value.type.typeName) ||
    !ts.isIdentifier(value.type.typeName.left)
  ) {
    throw new Error("Expected a qualified Cell wrapper");
  }
  expect(value.type.typeName.left.text).toBe("__cfHelpers");
  expect(value.type.typeName.right.text).toBe("ReadonlyCell");
  expect(value.type.typeArguments).toHaveLength(1);
  const payload = value.type.typeArguments![0]!;
  if (!ts.isTypeLiteralNode(payload)) {
    throw new Error("Expected a Cell payload object");
  }
  expect(payload.members).toHaveLength(1);
  const count = payload.members[0]!;
  if (!ts.isPropertySignature(count) || !ts.isIdentifier(count.name)) {
    throw new Error("Expected the Cell payload's count property");
  }
  expect(count.name.text).toBe("count");
  expect(count.type?.kind).toBe(ts.SyntaxKind.NumberKeyword);
});
