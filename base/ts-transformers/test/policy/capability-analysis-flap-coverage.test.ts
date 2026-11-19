import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";
import type { CapabilityAnalysisOptions } from "../../src/policy/capability-analysis.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

// These cases drive `analyzeFunctionCapabilities` through branches that
// otherwise run only when a pattern happens to compile cold through the
// transformer in CI. With a warm compile cache that compilation is skipped, so
// the branches flip between covered and uncovered across identical CI runs. Each
// test constructs the smallest callback body that reaches its branch and pins
// the observable parameter summary the branch produces.

/**
 * A program of `files`, with the Common Fabric type definitions at
 * `/commonfabric.d.ts`, resolving `commonfabric` and `./name.ts` imports.
 */
function createProgram(files: Record<string, string>): ts.Program {
  const all: Record<string, string> = {
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    ...files,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => all[name] !== undefined,
    readFile: (name) => all[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, lv) =>
      all[name] !== undefined
        ? ts.createSourceFile(name, all[name]!, lv, true, ts.ScriptKind.TS)
        : undefined,
    resolveModuleNames: (names) =>
      names.map((name) => {
        const fileName = name.startsWith("./")
          ? `/${name.slice(2)}`
          : `/${name}.d.ts`;
        if (all[fileName] === undefined) return undefined;
        return {
          resolvedFileName: fileName,
          extension: fileName.endsWith(".d.ts")
            ? ts.Extension.Dts
            : ts.Extension.Ts,
        };
      }),
  };
  return ts.createProgram(
    Object.keys(files),
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noLib: true,
    },
    host,
  );
}

function findArrow(
  sourceFile: ts.SourceFile,
  variableName: string,
): ts.ArrowFunction {
  let cb: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (cb) return;
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === variableName && node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      cb = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!cb) throw new Error(`Expected arrow function '${variableName}'.`);
  return cb;
}

function analyze(
  source: string,
  name = "fn",
  extraFiles: Record<string, string> = {},
) {
  const program = createProgram({ "/test.ts": source, ...extraFiles });
  return analyzeFunctionCapabilities(
    findArrow(program.getSourceFile("/test.ts")!, name),
    { checker: program.getTypeChecker() },
  );
}

// Analyze without a type checker (identity-argument callees are then recognized
// by name, and computed element access widens to a dynamic source).
function analyzeNoChecker(source: string, name = "fn") {
  const program = createProgram({ "/test.ts": source });
  return analyzeFunctionCapabilities(
    findArrow(program.getSourceFile("/test.ts")!, name),
  );
}

function getPaths(
  summary: ReturnType<typeof analyzeFunctionCapabilities>,
  name: string,
) {
  const p = summary.params.find((entry) => entry.name === name);
  if (!p) throw new Error(`Missing parameter summary for '${name}'.`);
  return {
    capability: p.capability,
    readPaths: p.readPaths.map((x) => x.join(".")),
    writePaths: p.writePaths.map((x) => x.join(".")),
    wildcard: p.wildcard,
    passthrough: p.passthrough,
    identityPaths: (p.identityPaths ?? []).map((x) => x.join(".")),
  };
}

const CELL = `declare const CELL_BRAND: unique symbol;
type Cell<T> = {
  readonly [CELL_BRAND]: "cell";
  get(): T;
  set(value: T): void;
  push(...items: unknown[]): number;
};`;

Deno.test(
  "identity call on a dynamic alias reads the static prefix above the key",
  () => {
    // Branch: the final `trackReadRef(resolvedSource)` of a call argument.
    // Reached when an alias used as the argument of a known identity call is
    // itself a dynamic source: each guard that records an identity path
    // requires a static ref, so the dynamic ref is tracked as a plain read,
    // which reads the static prefix above the key.

    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k) => {
           const v = input.items[k];
           navigateTo(v);
         };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths, ["items"]);
    assertEquals(input.writePaths.length, 0);
  },
);

Deno.test(
  "equals() on a dynamic alias also reads the static prefix above the key",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k, other) => {
           const v = input[k];
           v.equals(other);
         };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths, [""]);
  },
);

Deno.test(
  "a single map .set() lets a later .get().member resolve through the value binding",
  () => {
    // Branch: with a single `.set()`, the tracked map-value binding survives,
    // so a later `.get(k).name` resolves through it. The contrast is the
    // conflicting-sources case below.

    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
           const m = new Map();
           m.set("k", input.a);
           const v = m.get("k");
           return v.name;
         };`,
      ),
      "input",
    );
    // The stored binding survives, so the member read resolves to input.a.name.
    assert(input.readPaths.includes("a.name"));
  },
);

Deno.test(
  "map .set() values from different sources each reach a .get().member read",
  () => {
    // Branch: `mergeAliasBinding` merges two `.set()` calls that store
    // different sources into alternatives, so the value `.get()` returns may
    // be either and a member read through it is charged to both.

    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
           const m = new Map();
           m.set("k", input.a);
           m.set("k", input.b);
           const v = m.get("k");
           return v.name;
         };`,
      ),
      "input",
    );
    // Both set arguments are read at set time, and the later
    // `.get("k").name` is read through each.
    assert(input.readPaths.includes("a"));
    assert(input.readPaths.includes("b"));
    assert(input.readPaths.includes("a.name"));
    assert(input.readPaths.includes("b.name"));
  },
);

Deno.test(
  "push() of an array-element alias reads the element path",
  () => {
    // Branch: an array-identity writer (`push`) whose argument aliases an array
    // element reads that element's path (capability-analysis.ts ~3128-3130).
    // The `.find()` result carries an array-element binding, so pushing it
    // records a read of the element path rather than treating the pushed value
    // as opaque.

    const input = getPaths(
      analyze(
        `${CELL}
         const fn = (
           input: { rows: { id: string }[] },
           list: Cell<unknown[]>,
         ) => {
           const found = input.rows.find((r) => r.id === "x");
           list.push(found);
         };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("rows.0"));
  },
);

// A callee whose parameters declare each Common Fabric cell wrapper. The
// declarations live in their own file because the analysis only reads a
// signature declared outside the file under analysis, and the wrappers live in
// a file named `commonfabric.d.ts` because that is how the analysis recognizes
// a wrapper as the framework's rather than a local type of the same name.
const CAPABILITY_CALLEE_FILES = {
  "/commonfabric.d.ts": `declare module "commonfabric" {
  export type Writable<T> = { set(value: T): void };
  export type Stream<T> = { send(value: T): void };
}`,
  "/callee.ts": `import type { Stream, Writable } from "commonfabric";
export declare function notify(target: Stream<string>): void;
export declare function assign(target: Writable<string>): void;`,
};

Deno.test(
  "a stream argument is recorded opaque while a writable argument is read and written",
  () => {
    // Branch: `Stream<T>` is the wrapper whose capability is neither read nor
    // write, so a parameter passed to one is recorded as an opaque path
    // (capability-analysis.ts ~377-378 and ~2540-2543). Which pattern in the
    // corpus passes a stream to a declared `Stream<T>` parameter decides
    // whether the branch runs at all, so it is covered on some CI runs and not
    // others.

    const input = getPaths(
      analyze(
        `import type { Stream, Writable } from "commonfabric";
         import { assign, notify } from "./callee.ts";
         const fn = (
           input: { channel: Stream<string>; slot: Writable<string> },
         ) => {
           notify(input.channel);
           assign(input.slot);
         };`,
        "fn",
        CAPABILITY_CALLEE_FILES,
      ),
      "input",
    );
    // Passing a stream says nothing about its value in either direction.
    assertEquals(input.readPaths, ["slot"]);
    assertEquals(input.writePaths, ["slot"]);
  },
);

Deno.test(
  "map values of different binding shapes drop the value binding",
  () => {
    // Branch: `aliasBindingEquals` falls through to `false` when the two
    // bindings are of different shapes -- one a reference to a parameter path,
    // the other a record of properties (capability-analysis.ts ~1237). The two
    // branches above it, which compare two references or two records, are
    // reached far more often.

    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
           const m = new Map();
           m.set("k", input.a);
           m.set("k", { name: input.b });
           const v = m.get("k");
           return v.name;
         };`,
      ),
      "input",
    );
    // Both set arguments are read where they are stored.
    assert(input.readPaths.includes("a"));
    assert(input.readPaths.includes("b"));
    // The two shapes cannot be merged, so the later `.get("k").name` resolves
    // through neither of them.
    assert(!input.readPaths.includes("a.name"));
  },
);

/** The first function `/test.ts` declares or binds to the name `fn`. */
function findFn(sourceFile: ts.SourceFile) {
  let found: ts.ArrowFunction | ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === "fn") {
      found = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === "fn" && node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error("Expected a function named `fn`.");
  return found;
}

/**
 * The summary of `fn` in `source`, compiled as `/test.ts` beside `files` and
 * the Common Fabric type definitions.
 */
function analyzeTyped(
  source: string,
  options: Omit<CapabilityAnalysisOptions, "checker"> = {},
  files: Record<string, string> = {},
) {
  const program = createProgram({ "/test.ts": source, ...files });
  return analyzeFunctionCapabilities(
    findFn(program.getSourceFile("/test.ts")!),
    { checker: program.getTypeChecker(), ...options },
  );
}

/** The parameter summary of `name`, with the empty and false fields dropped. */
function paramOf(
  summary: ReturnType<typeof analyzeFunctionCapabilities>,
  name = "input",
) {
  const param = summary.params.find((entry) => entry.name === name);
  if (!param) throw new Error(`Missing parameter summary for '${name}'.`);
  return Object.fromEntries(
    Object.entries(param)
      .filter(([, value]) =>
        value !== false && !(Array.isArray(value) && value.length === 0)
      )
      .map((
        [key, value],
      ) => [
        key,
        Array.isArray(value)
          ? value.map((path: string[]) => path.join("."))
          : value,
      ]),
  );
}

describe("capability-analysis", () => {
  describe("a cell wrapper an out-of-file callee declares", () => {
    const CALLEE = {
      "/callee.ts": `import type {
  OpaqueCell,
  SqliteDb,
  Writable,
} from "commonfabric";
export declare function query(db: SqliteDb<any>): void;
export declare function peek(ref: OpaqueCell<string>): void;
export declare function assignAll(...cells: Writable<string>[]): void;
export declare function untypedRest(...cells): void;`,
    };

    it("records a `SqliteDb` argument as an opaque path", () => {
      expect(
        paramOf(analyzeTyped(
          `import { query } from "./callee.ts";
           const fn = (input: { db: any }) => { query(input.db); };`,
          {},
          CALLEE,
        )),
      ).toEqual({ name: "input", capability: "opaque", opaquePaths: ["db"] });
    });

    it("records an `OpaqueCell` argument as an opaque path", () => {
      expect(
        paramOf(analyzeTyped(
          `import { peek } from "./callee.ts";
           const fn = (input: { ref: any }) => { peek(input.ref); };`,
          {},
          CALLEE,
        )),
      ).toEqual({ name: "input", capability: "opaque", opaquePaths: ["ref"] });
    });

    it("reads and writes an argument to a `Writable` rest parameter", () => {
      expect(
        paramOf(analyzeTyped(
          `import { assignAll } from "./callee.ts";
           const fn = (input: { c: any }) => { assignAll(input.c); };`,
          {},
          CALLEE,
        )),
      ).toEqual({
        name: "input",
        capability: "writable",
        readPaths: ["c"],
        writePaths: ["c"],
      });
    });

    it("reads an argument to an unannotated rest parameter in full", () => {
      // An unannotated rest parameter declares no wrapper, so the argument
      // leaves whole to a callee whose use of it is unknown.

      expect(
        paramOf(analyzeTyped(
          `import { untypedRest } from "./callee.ts";
           const fn = (input: { c: any }) => { untypedRest(input.c); };`,
          {},
          CALLEE,
        )),
      ).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["c"],
        fullShapePaths: ["c"],
        escapedPaths: ["c"],
      });
    });
  });

  describe("a use under `SELF` of a pattern callback's input", () => {
    // Each body reaches `input[SELF]` through a different kind of use. On a
    // pattern callback none of them records anything against the input; on
    // any other callback each records the `$SELF` path it touches.

    const PRELUDE = `import {
  equals,
  navigateTo,
  pattern,
  SELF,
  Writable,
} from "commonfabric";
import { query } from "./callee.ts";
type Input = {
  title: string;
  [SELF]: { title: string; c: Writable<string>; items: string[] };
};
declare const other: Input;
declare const k: number;
const Child = pattern<{ v: unknown }>(({ v }) => ({ v }));
`;
    const CALLEE = {
      "/callee.ts": `import type { SqliteDb } from "commonfabric";
export declare function query(db: SqliteDb<any>): void;`,
    };
    const USES: Record<string, { body: string; elsewhere: object }> = {
      "an assignment": {
        body: `input[SELF].title = "x";`,
        elsewhere: {
          capability: "writable",
          readPaths: ["title", "$SELF.title"],
          writePaths: ["$SELF.title"],
        },
      },
      "a dynamic key": {
        body: `input[SELF].items[k];`,
        elsewhere: {
          capability: "readonly",
          readPaths: ["title", "$SELF.items"],
          fullShapePaths: ["$SELF.items"],
          wildcardPaths: ["$SELF.items"],
        },
      },
      "a rest destructuring": {
        body: `const { ...rest } = input[SELF]; rest;`,
        elsewhere: {
          capability: "readonly",
          readPaths: ["title", "$SELF"],
          wildcard: true,
          wildcardPaths: ["$SELF"],
        },
      },
      "an opaque argument": {
        body: `query(input[SELF]);`,
        elsewhere: {
          capability: "readonly",
          readPaths: ["title"],
          opaquePaths: ["$SELF"],
        },
      },
      "an input of a pattern it instantiates": {
        body: `Child({ v: input[SELF] });`,
        elsewhere: {
          capability: "readonly",
          readPaths: ["title"],
          opaquePaths: ["$SELF"],
          forwardedPaths: ["$SELF"],
        },
      },
      "an identity argument": {
        body: `navigateTo(input[SELF]);`,
        elsewhere: {
          capability: "readonly",
          readPaths: ["title"],
          identityPaths: ["$SELF"],
          identityCellPaths: ["$SELF"],
        },
      },
      "an identity comparison": {
        body: `equals(input[SELF].title, other.title);`,
        elsewhere: {
          capability: "readonly",
          readPaths: ["title"],
          identityPaths: ["$SELF.title"],
          comparablePaths: ["$SELF.title"],
        },
      },
    };

    for (const [use, { body, elsewhere }] of Object.entries(USES)) {
      it(`records only the read of \`title\` for ${use}`, () => {
        const source = `${PRELUDE}
const fn = (input: Input) => { input.title; ${body} };`;
        expect(
          paramOf(analyzeTyped(source, { patternCallback: true }, CALLEE)),
        ).toEqual({
          name: "input",
          capability: "readonly",
          readPaths: ["title"],
        });
        expect(paramOf(analyzeTyped(source, {}, CALLEE))).toEqual({
          name: "input",
          ...elsewhere,
        });
      });
    }

    it("leaves the capability opaque where a comparison under `SELF` is the only use", () => {
      const source = `${PRELUDE}
const fn = (input: Input) => equals(input[SELF].title, other.title);`;
      expect(
        paramOf(analyzeTyped(source, { patternCallback: true }, CALLEE)),
      ).toEqual({ name: "input", capability: "opaque" });
      expect(paramOf(analyzeTyped(source, {}, CALLEE)).capability).toBe(
        "comparable",
      );
    });

    it("keeps the input identity-only beside an argument a summarized callee ignores", () => {
      // The callee's summary says it does nothing with its parameter, which
      // makes the argument an opaque use: on any other callback, a use of the
      // input's data.

      const source = `${PRELUDE}
function ignore(v: unknown) {}
const fn = (input: Input) => [equals(input, other), ignore(input[SELF])];`;
      expect(
        paramOf(
          analyzeTyped(
            source,
            { patternCallback: true, interprocedural: true },
            CALLEE,
          ),
        ),
      ).toEqual({
        name: "input",
        capability: "comparable",
        passthrough: true,
        identityOnly: true,
        identityPaths: [""],
        identityCellPaths: [""],
        comparablePaths: [""],
        comparableCellPaths: [""],
      });
      expect(
        paramOf(analyzeTyped(source, { interprocedural: true }, CALLEE)),
      ).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["$SELF"],
        passthrough: true,
      });
    });
  });

  describe("a function with no body", () => {
    it("returns no parameter summaries for a declaration with no body", () => {
      expect(
        analyzeTyped(`declare function fn(input: { a: number }): void;`),
      ).toEqual({ params: [] });
    });
  });

  describe("an `isArray` call", () => {
    it("reads only the shape of an argument to `ArrayConstructor.isArray`", () => {
      expect(
        paramOf(analyzeTyped(
          `interface ArrayConstructor { isArray(arg: any): arg is any[]; }
           declare var Array: ArrayConstructor;
           const fn = (input: { a: { x: number } }) => Array.isArray(input.a);`,
        )),
      ).toEqual({ name: "input", capability: "readonly", readPaths: ["a"] });
    });

    it("hands an argument whole to an `isArray` nested below `ArrayConstructor`", () => {
      // Only a member declared on `ArrayConstructor` itself is the library's
      // `isArray`; one on a type nested inside it is an unknown callee.

      expect(
        paramOf(analyzeTyped(
          `interface ArrayConstructor {
             isArray(arg: any): arg is any[];
             nested: { isArray(v: unknown): boolean };
           }
           declare var Array: ArrayConstructor;
           const fn = (input: { a: { x: number } }) =>
             Array.nested.isArray(input.a);`,
        )),
      ).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["a"],
        fullShapePaths: ["a"],
        escapedPaths: ["a"],
      });
    });
  });

  describe("a spread copy of an array whose name is declared again", () => {
    // A copy whose elements the body never reads leaves the source array
    // read only as a whole. A name that matches the copy's but declares a
    // function or names a method is not a read of the copy.

    const UNREAD = {
      name: "input",
      capability: "readonly",
      readPaths: ["items"],
    };
    const declarations: Record<string, string> = {
      "a function expression": `const g = function copy() {}; g;`,
      "a function declaration": `{ function copy() {} }`,
      "a method": `const o = { copy() {} }; o;`,
    };
    for (const [kind, declaration] of Object.entries(declarations)) {
      it(`leaves the elements unread beside ${kind} named like the copy`, () => {
        expect(
          paramOf(analyzeTyped(
            `const fn = (input: { items: { id: string }[] }) => {
               const copy = [...input.items];
               ${declaration}
               return copy.length;
             };`,
          )),
        ).toEqual(UNREAD);
      });
    }

    it("reads the elements in full where the body reads one of the copy", () => {
      expect(
        paramOf(analyzeTyped(
          `const fn = (input: { items: { id: string }[] }) => {
             const copy = [...input.items];
             const first = copy[0];
             return [copy.length, first];
           };`,
        )).fullShapePaths,
      ).toEqual(["items.0"]);
    });
  });
  describe("an alias of an element a lookup finds", () => {
    const ROWS = `type Row = { id: string; v: number };`;
    const UNREAD = {
      name: "input",
      capability: "readonly",
      readPaths: ["rows"],
    };
    const conditions: Record<string, string> = {
      "a parenthesized negation": `if ((!found)) return 0;`,
      "a `for` condition": `for (; found;) break;`,
    };
    for (const [kind, condition] of Object.entries(conditions)) {
      it(`reads none of the element tested as ${kind}`, () => {
        expect(
          paramOf(analyzeTyped(
            `${ROWS}
             const fn = (input: { rows: Row[] }) => {
               const found = input.rows.find((r) => r.id === "x");
               ${condition}
               return 1;
             };`,
          )),
        ).toEqual(UNREAD);
      });
    }

    it("reads the element in full where the body returns it", () => {
      expect(
        paramOf(analyzeTyped(
          `${ROWS}
           const fn = (input: { rows: Row[] }) => {
             const found = input.rows.find((r) => r.id === "x");
             return [found];
           };`,
        )).fullShapePaths,
      ).toEqual(["rows.0"]);
    });

    it("hands the array on whole where an assignment yields it to the lookup", () => {
      expect(
        paramOf(analyzeTyped(
          `${ROWS}
           let held: Row[] = [];
           const fn = (input: { rows: Row[] }) =>
             (held = input.rows).find((r) => r.id === "x");`,
        )),
      ).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["rows"],
        fullShapePaths: ["rows"],
        escapedPaths: ["rows"],
      });
    });
  });

  describe("an assignment of a member to a local", () => {
    const TYPE = `{ a: { x: number; y: number } }`;

    it("follows the member into a parameter of the function", () => {
      expect(
        paramOf(analyzeTyped(
          `const fn = (input: ${TYPE}, holder: unknown) => {
             holder = input.a;
             return [holder.x];
           };`,
        )).fullShapePaths,
      ).toEqual(["a.x"]);
    });

    it("keeps following the member into a local destructuring target with a default", () => {
      // The default leaves the target's alias unresolved, so the member is
      // kept as read, but it has not left the function.

      expect(
        paramOf(analyzeTyped(
          `const fn = (input: ${TYPE}) => {
             let last: { x: number } | undefined;
             ({ row: last = { x: 0 } } = { row: input.a });
             return [last.x];
           };`,
        )),
      ).toEqual({ name: "input", capability: "readonly", readPaths: ["a"] });
    });

    it("hands the member on whole into a variable of an enclosing scope", () => {
      for (
        const assignment of [
          `outer = input.a;`,
          `({ row: outer = { x: 0 } } = { row: input.a });`,
        ]
      ) {
        expect(
          paramOf(analyzeTyped(
            `let outer: { x: number } | undefined;
             const fn = (input: ${TYPE}) => {
               ${assignment}
               return [outer.x];
             };`,
          )).fullShapePaths,
        ).toEqual(["a"]);
      }
    });
  });

  describe("a value whose key is known only at run time", () => {
    const ROWS = `type Row = { id: string; v: number };
declare const k: number;`;

    it("makes the root a wildcard where a returned local holds the value", () => {
      expect(
        paramOf(analyzeTyped(
          `${ROWS}
           const fn = (input: { rows: Row[] }) => {
             const held = { row: input.rows[k] };
             return held;
           };`,
        )),
      ).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["rows"],
        fullShapePaths: ["rows"],
        wildcard: true,
        wildcardPaths: ["rows"],
      });
    });

    it("reads the prefix above the key in full where the value is pushed", () => {
      // No identity path names the element a key picks, so the receiver
      // records no identity for its elements either.

      const summary = analyzeTyped(
        `import type { Writable } from "commonfabric";
         ${ROWS}
         const fn = (input: { rows: Row[] }, list: Writable<Row[]>) => {
           list.push(input.rows[k]);
         };`,
      );
      expect(paramOf(summary)).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["rows"],
        fullShapePaths: ["rows"],
        wildcardPaths: ["rows"],
      });
      expect(paramOf(summary, "list")).toEqual({
        name: "list",
        capability: "writeonly",
        writePaths: [""],
      });
    });

    it("makes the root a wildcard where its elements are spread into a written array", () => {
      expect(
        paramOf(analyzeTyped(
          `import type { Writable } from "commonfabric";
           ${ROWS}
           const fn = (input: { rows: Row[][] }, out: Writable<Row[]>) => {
             const next = [...input.rows[k]];
             out.set(next);
           };`,
        )),
      ).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["rows"],
        fullShapePaths: ["rows"],
        wildcard: true,
        wildcardPaths: ["rows"],
      });
    });

    it("hands an argument whole to a method a local collection calls by a run-time name", () => {
      expect(
        paramOf(analyzeTyped(
          `declare const name: string;
           const fn = (input: { a: { x: number } }) => {
             const list: any[] = [];
             list[name](input.a);
             return list;
           };`,
        )),
      ).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["a"],
        fullShapePaths: ["a"],
        escapedPaths: ["a"],
      });
    });

    it("reads in full a receiver a call returns and a run-time name calls a method on", () => {
      expect(
        paramOf(analyzeTyped(
          `declare const name: string;
           const fn = (input: { a: any }) => input.a.step()[name]();`,
        )),
      ).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["a"],
        fullShapePaths: ["a"],
      });
    });
  });

  describe("an array spread into an array written by identity", () => {
    // The elements of an array written back to a cell keep their identity,
    // and are recorded as identity paths, unless one may be a primitive. The
    // program declares `Array`, so an array type has an element type.

    const WRITE = `import type { Writable } from "commonfabric";
type Row = { id: string; v: number };`;
    const GLOBALS = {
      "/globals.d.ts": `interface Array<T> { [n: number]: T; length: number; }`,
    };
    const IDENTITY = {
      name: "input",
      capability: "readonly",
      readPaths: ["rows"],
      identityPaths: ["rows.0"],
    };

    it("records identity for elements of a type with no element type", () => {
      expect(
        paramOf(analyzeTyped(
          `${WRITE}
           const fn = (input: { rows: unknown }, out: Writable<Row[]>) => {
             const next = [...(input.rows as any)];
             out.set(next);
           };`,
          {},
          GLOBALS,
        )),
      ).toEqual(IDENTITY);
    });

    it("records identity for elements of a member the parameter does not declare", () => {
      expect(
        paramOf(analyzeTyped(
          `${WRITE}
           const fn = (input: {}, out: Writable<Row[]>) => {
             const next = [...(input as any).page.rows];
             out.set(next);
           };`,
          {},
          GLOBALS,
        )),
      ).toEqual({
        ...IDENTITY,
        readPaths: ["page.rows", ""],
        identityPaths: ["page.rows.0"],
      });
    });

    it("records no identity for elements that may be primitives", () => {
      expect(
        paramOf(analyzeTyped(
          `${WRITE}
           const fn = (input: { rows: (Row | string)[] }, out: Writable<Row[]>) => {
             const next = [...input.rows];
             out.set(next);
           };`,
          {},
          GLOBALS,
        )).identityPaths,
      ).toBeUndefined();
    });

    it("records identity for the elements without a checker", () => {
      const sourceFile = ts.createSourceFile(
        "/test.ts",
        `const fn = (input, out) => {
           const next = [...input.rows];
           out.set(next);
         };`,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );
      expect(paramOf(analyzeFunctionCapabilities(findFn(sourceFile))))
        .toEqual(IDENTITY);
    });
  });

  describe("a callee's declared or summarized use of an argument", () => {
    it("passes the input through to a callee that only navigates to it", () => {
      expect(
        paramOf(analyzeTyped(
          `import { navigateTo } from "commonfabric";
           function go(v: { x: number }) { navigateTo(v); }
           const fn = (input: { x: number }) => go(input);`,
          { interprocedural: true },
        )),
      ).toEqual({ name: "input", capability: "opaque", passthrough: true });
    });

    it("charges an argument past the callee's parameters as a callee with no summary would", () => {
      expect(
        paramOf(analyzeTyped(
          `function helper(v: { x: number }, ...rest: unknown[]) { return v.x; }
           const fn = (input: { a: { x: number }; b: number; c: { y: number } }) =>
             helper(input.a, input.b, input.c);`,
          { interprocedural: true },
        )),
      ).toEqual({
        name: "input",
        capability: "readonly",
        readPaths: ["a.x", "a", "b", "c"],
        fullShapePaths: ["c"],
        escapedPaths: ["c"],
      });
    });
  });

  describe("a handler's arguments forwarded by a summarized callee", () => {
    it("reads the event's member in full and leaves the state's member forwarded", () => {
      // An event is copied into what it is handed to, so a callee that hands
      // its parameter to a pattern reads the event in full. The state is
      // linked, and the member forwarded is read only where the call reads
      // it.

      const program = createProgram({
        "/test.ts": `import { handler, pattern } from "commonfabric";
const Child = pattern<{ v: unknown }>(({ v }) => ({ v }));
function helper(v: { x: number }) { return Child({ v }); }
handler<{ a: { x: number } }, { s: { x: number } }>((event, state) => {
  helper(event.a);
  helper(state.s);
});`,
      });
      let callback: ts.ArrowFunction | undefined;
      const visit = (node: ts.Node): void => {
        if (callback) return;
        if (
          ts.isArrowFunction(node) && ts.isCallExpression(node.parent) &&
          ts.isIdentifier(node.parent.expression) &&
          node.parent.expression.text === "handler"
        ) {
          callback = node;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(program.getSourceFile("/test.ts")!);
      if (!callback) throw new Error("Expected the handler's callback.");
      const summary = analyzeFunctionCapabilities(callback, {
        checker: program.getTypeChecker(),
        interprocedural: true,
      });
      expect(paramOf(summary, "event")).toEqual({
        name: "event",
        capability: "readonly",
        readPaths: ["a"],
        fullShapePaths: ["a"],
        escapedPaths: ["a"],
      });
      expect(paramOf(summary, "state")).toEqual({
        name: "state",
        capability: "readonly",
        readPaths: ["s"],
      });
    });
  });
});
