import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { WrapperSpelling } from "@commonfabric/schema-generator/wrapper-names";
import ts from "typescript";

import {
  cloneTypeNodeDeepForEmission,
  getPreservedBindingTypeNode,
} from "../../src/ast/type-building.ts";

// A wrapper counts only where its name resolves to the declaration
// `commonfabric` exports, so the wrappers are declared in that module and each
// module under test imports them. They are generic aliases here as they are in
// `commonfabric`.
const COMMONFABRIC = `declare module "commonfabric" {
  export interface Cell<T> { get(): T }
  export type Writable<T> = Cell<T>;
  export interface ReadonlyCell<T> { get(): T }
  export interface WriteonlyCell<T> { set(value: T): void }
  export interface ComparableCell<T> { readonly __value?: T }
  export interface OpaqueCell<T> { readonly __value?: T }
  export interface Stream<E, R = void> { send(event: E): R }
  export type Reactive<T> = T;
  export interface SqliteDb<T> { readonly __database?: T }
  export interface CellTypeConstructor<T> { readonly __kind?: T }
  export interface ScopedCellTypeConstructor<T> { readonly __kind?: T }
  export type Default<T, V = T> = T & { readonly __default?: V };
  export type PerUser<T> = T & { readonly __scope?: "user" };
}
`;
const IMPORTS = `import type { Default, PerUser, Writable } from "commonfabric";
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
    "/commonfabric.d.ts": COMMONFABRIC,
    [fileName]: declarations,
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

  const program = ts.createProgram(
    ["/commonfabric.d.ts", fileName],
    compilerOptions,
    host,
  );
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
    expect(
      preserved(
        `${IMPORTS}interface Input { c: Writable<string | Default<"">>; }`,
      ),
    )
      .toBe(`Writable<string | Default<"">>`);
  });

  it("returns `undefined` for a type that carries no wrapper", () => {
    expect(preserved(`${IMPORTS}interface Input { c: Writable<string>; }`))
      .toBeUndefined();
  });

  it("returns `undefined` for an alias of a type that carries no wrapper", () => {
    expect(preserved(`${IMPORTS}
      type Plain = Writable<string>;
      interface Input { c: Plain; }
    `)).toBeUndefined();
  });

  it("returns the type an alias names", () => {
    expect(preserved(`${IMPORTS}
      type Draft = Writable<string | Default<"">>;
      interface Input { c: Draft; }
    `)).toBe(`Writable<string | Default<"">>`);
  });

  it("returns the type at the end of a chain of aliases", () => {
    expect(preserved(`${IMPORTS}
      type Draft = Writable<string | Default<"">>;
      type Renamed = Draft;
      interface Input { c: Renamed; }
    `)).toBe(`Writable<string | Default<"">>`);
  });

  it("returns a `Writable` of the type its aliased argument names", () => {
    expect(preserved(`${IMPORTS}
      type Blank = string | Default<"">;
      interface Input { c: Writable<Blank>; }
    `)).toBe(`Writable<string | Default<"">>`);
  });

  it("returns one flat union for a member that names a union", () => {
    expect(preserved(`${IMPORTS}
      type Blank = string | Default<"">;
      interface Input { c: Blank | number; }
    `)).toBe(`string | Default<""> | number`);
  });

  it("leaves a reference to an alias that carries no wrapper as written", () => {
    expect(preserved(`${IMPORTS}
      type Status = "idle" | "running";
      interface Input { c: Writable<Status | Default<"idle">>; }
    `)).toBe(`Writable<Status | Default<"idle">>`);
  });

  it("returns an intersection of the types its aliased members name", () => {
    expect(preserved(`${IMPORTS}
      type Nickname = PerUser<string>;
      interface Input { c: Nickname & { readonly tag?: "nick" }; }
    `)).toBe(`PerUser<string> & {
    readonly tag?: "nick";
}`);
  });

  it("returns a parenthesized type around the type its alias names", () => {
    expect(preserved(`${IMPORTS}
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
        "/types.ts": `${IMPORTS}
          export type Draft = Writable<string | Default<"remote">>;
        `,
      },
    )).toBe(`Writable<string | Default<"remote">>`);
  });

  it("returns `undefined` for the author's own type that shares a wrapper's name", () => {
    expect(preserved(`
      type Default<T, V = T> = { mine: T; tag?: V };
      interface Input { c: Default<string, "x">; }
    `)).toBeUndefined();
  });

  it("returns `undefined` for an alias of the author's own type that shares a wrapper's name", () => {
    expect(preserved(`
      type Default<T, V = T> = { mine: T; tag?: V };
      type Mine = Default<string, "x">;
      interface Input { c: Mine; }
    `)).toBeUndefined();
  });

  it("returns `undefined` for the author's own `Writable` around a wrapper", () => {
    expect(preserved(`
      import type { Default } from "commonfabric";
      type Writable<T> = { mine: T };
      interface Input { c: Writable<string | Default<"">>; }
    `)).toBeUndefined();
  });

  describe("a wrapper around a value with a default, by spelling", () => {
    // Whether each spelling's argument is kept as written: kept for a cell a
    // binding is captured as, and not for an opaque cell or a `Reactive`, whose
    // value a `computed()` captures, nor for the rest, which hold no value that
    // has a default.

    const KEEPS_ARGUMENT = {
      Cell: true,
      Writable: true,
      ReadonlyCell: true,
      WriteonlyCell: true,
      ComparableCell: true,
      Stream: true,
      OpaqueCell: false,
      Reactive: false,
      SqliteDb: false,
      CellTypeConstructor: false,
      ScopedCellTypeConstructor: false,
    } satisfies Record<WrapperSpelling, boolean>;

    for (const [spelling, keeps] of Object.entries(KEEPS_ARGUMENT)) {
      const declared = `${spelling}<string | Default<"">>`;
      it(
        keeps
          ? `returns the declared node for \`${declared}\``
          : `returns \`undefined\` for \`${declared}\``,
        () => {
          expect(preserved(`
            import type { Default, ${spelling} } from "commonfabric";
            interface Input { c: ${declared}; }
          `)).toBe(keeps ? declared : undefined);
        },
      );
    }
  });

  it("returns a `Cell` of the type its aliased argument names", () => {
    expect(preserved(`
      import type { Cell, Default } from "commonfabric";
      type Blank = string | Default<"">;
      interface Input { c: Cell<Blank>; }
    `)).toBe(`Cell<string | Default<"">>`);
  });

  it("leaves a `Stream`'s aliased result as written", () => {
    expect(preserved(`
      import type { Default, Stream } from "commonfabric";
      type Blank = string | Default<"">;
      interface Input { c: Stream<Blank, Blank>; }
    `)).toBe(`Stream<string | Default<"">, Blank>`);
  });

  it("returns `undefined` for a `Stream` whose result alone carries a wrapper", () => {
    expect(preserved(`
      import type { Default, Stream } from "commonfabric";
      interface Input { c: Stream<string, string | Default<"">>; }
    `)).toBeUndefined();
  });

  it("returns `undefined` for the author's own `Cell` around a wrapper", () => {
    expect(preserved(`
      import type { Default } from "commonfabric";
      interface Cell<T> { mine: T }
      interface Input { c: Cell<string | Default<"">>; }
    `)).toBeUndefined();
  });

  it("leaves a reference to a generic alias as written", () => {
    expect(preserved(`${IMPORTS}
      type Defaulted<T> = Writable<T | Default<"">>;
      interface Input { c: Defaulted<string>; }
    `)).toBeUndefined();
  });

  it("leaves an alias's reference to itself as written", () => {
    expect(preserved(`${IMPORTS}
      type Nested = Writable<Nested | Default<"">>;
      interface Input { c: Nested; }
    `)).toBe(`Writable<Nested | Default<"">>`);
  });
});
