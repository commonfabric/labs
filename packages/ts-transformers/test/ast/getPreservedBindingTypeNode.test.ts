import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import {
  cloneTypeNodeDeepForEmission,
  getPreservedBindingTypeNode,
} from "../../src/ast/type-building.ts";

// The wrappers are declared in the module under test, so the checker resolves
// every name without a library. `Writable`, `Default`, and `PerUser` are
// generic aliases here as they are in `commonfabric`.
const PRELUDE = `
type Writable<T> = { get(): T };
type Default<T, V = T> = T & { readonly __default?: V };
type PerUser<T> = T & { readonly __scope?: "user" };
`;

/**
 * Compiles `declarations` and returns what `getPreservedBindingTypeNode()`
 * makes of the type node of `Input`'s property `c`, printed.
 */
function preserved(
  declarations: string,
  files: Record<string, string> = {},
): string | undefined {
  const fileName = "/main.ts";
  const sources: Record<string, string> = {
    ...files,
    [fileName]: PRELUDE + declarations,
  };
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) =>
    name in sources
      ? ts.createSourceFile(name, sources[name]!, compilerOptions.target!, true)
      : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name in sources;
  host.readFile = (name) => sources[name];
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(fileName)!;
  const input = sourceFile.statements.find((statement) =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === "Input"
  ) as ts.InterfaceDeclaration;
  const member = input.members[0] as ts.PropertySignature;

  const node = getPreservedBindingTypeNode(
    member.type!,
    program.getTypeChecker(),
  );
  // Printed as its callers emit it: cloned without source positions, since the
  // node may come from a module other than the one being printed.
  return node && ts.createPrinter({ removeComments: true }).printNode(
    ts.EmitHint.Unspecified,
    cloneTypeNodeDeepForEmission(node),
    sourceFile,
  );
}

describe("getPreservedBindingTypeNode()", () => {
  it("returns the declared node for a wrapper written in place", () => {
    expect(preserved(`interface Input { c: Writable<string | Default<"">>; }`))
      .toBe(`Writable<string | Default<"">>`);
  });

  it("returns `undefined` for a type that carries no wrapper", () => {
    expect(preserved(`interface Input { c: Writable<string>; }`))
      .toBeUndefined();
  });

  it("returns `undefined` for an alias of a type that carries no wrapper", () => {
    expect(preserved(`
      type Plain = Writable<string>;
      interface Input { c: Plain; }
    `)).toBeUndefined();
  });

  it("returns the type an alias names", () => {
    expect(preserved(`
      type Draft = Writable<string | Default<"">>;
      interface Input { c: Draft; }
    `)).toBe(`Writable<string | Default<"">>`);
  });

  it("returns the type at the end of a chain of aliases", () => {
    expect(preserved(`
      type Draft = Writable<string | Default<"">>;
      type Renamed = Draft;
      interface Input { c: Renamed; }
    `)).toBe(`Writable<string | Default<"">>`);
  });

  it("returns a `Writable` of the type its aliased argument names", () => {
    expect(preserved(`
      type Blank = string | Default<"">;
      interface Input { c: Writable<Blank>; }
    `)).toBe(`Writable<string | Default<"">>`);
  });

  it("returns one flat union for a member that names a union", () => {
    expect(preserved(`
      type Blank = string | Default<"">;
      interface Input { c: Blank | number; }
    `)).toBe(`string | Default<""> | number`);
  });

  it("leaves a reference to an alias that carries no wrapper as written", () => {
    expect(preserved(`
      type Status = "idle" | "running";
      interface Input { c: Writable<Status | Default<"idle">>; }
    `)).toBe(`Writable<Status | Default<"idle">>`);
  });

  it("returns an intersection of the types its aliased members name", () => {
    expect(preserved(`
      type Nickname = PerUser<string>;
      interface Input { c: Nickname & { readonly tag?: "nick" }; }
    `)).toBe(`PerUser<string> & {
    readonly tag?: "nick";
}`);
  });

  it("returns a parenthesized type around the type its alias names", () => {
    expect(preserved(`
      type Draft = Writable<string | Default<"">>;
      interface Input { c: (Draft); }
    `)).toBe(`(Writable<string | Default<"">>)`);
  });

  it("returns the type an alias imported from another module names", () => {
    expect(preserved(
      `
      import type { Draft } from "./types.ts";
      interface Input { c: Draft; }
    `,
      {
        "/types.ts": `
          type Writable<T> = { get(): T };
          type Default<T, V = T> = T & { readonly __default?: V };
          export type Draft = Writable<string | Default<"remote">>;
        `,
      },
    )).toBe(`Writable<string | Default<"remote">>`);
  });

  it("leaves a reference to a generic alias as written", () => {
    expect(preserved(`
      type Defaulted<T> = Writable<T | Default<"">>;
      interface Input { c: Defaulted<string>; }
    `)).toBeUndefined();
  });

  it("leaves an alias's reference to itself as written", () => {
    expect(preserved(`
      type Nested = Writable<Nested | Default<"">>;
      interface Input { c: Nested; }
    `)).toBe(`Writable<Nested | Default<"">>`);
  });
});
