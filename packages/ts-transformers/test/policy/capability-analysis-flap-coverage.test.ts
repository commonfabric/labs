import { assert, assertEquals } from "@std/assert";

import ts from "typescript";

import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";

// These cases drive `analyzeFunctionCapabilities` through branches that
// otherwise run only when a pattern happens to compile cold through the
// transformer in CI. With a warm compile cache that compilation is skipped, so
// the branches flip between covered and uncovered across identical CI runs. Each
// test constructs the smallest callback body that reaches its branch and pins
// the observable parameter summary the branch produces.

function createProgram(
  source: string,
  extraFiles: Record<string, string> = {},
): { program: ts.Program; sourceFile: ts.SourceFile } {
  const files: Record<string, string> = { "/test.ts": source, ...extraFiles };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
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
    getSourceFile: (name, lv) =>
      files[name] !== undefined
        ? ts.createSourceFile(name, files[name]!, lv, true, ts.ScriptKind.TS)
        : undefined,
  };
  const program = ts.createProgram(
    ["/test.ts", ...Object.keys(extraFiles)],
    options,
    host,
  );
  return { program, sourceFile: program.getSourceFile("/test.ts")! };
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
  const { program, sourceFile } = createProgram(source, extraFiles);
  return analyzeFunctionCapabilities(findArrow(sourceFile, name), {
    checker: program.getTypeChecker(),
  });
}

// Analyze without a type checker (identity-argument callees are then recognized
// by name, and computed element access widens to a dynamic source).
function analyzeNoChecker(source: string, name = "fn") {
  const { sourceFile } = createProgram(source);
  return analyzeFunctionCapabilities(findArrow(sourceFile, name));
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
    // Branch: the fallthrough `trackReadRef(resolvedSource, { identityOnly:
    // true })`. Reached when an alias used as the argument of a known identity
    // call is itself a dynamic source: the three earlier `!dynamic` guards all
    // fall through, and because the ref is dynamic the read is a value read of
    // the whole static prefix above the key rather than an identity-only one.

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
  "conflicting map .set() values drop the value binding so .get().member no longer resolves",
  () => {
    // Branch: `updateLocalCollectionBinding` deletes the tracked map-value
    // binding when two `.set()` calls store non-equal sources, so their merge
    // is undefined (capability-analysis.ts ~1977-1979).

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
    // Both set arguments are still read at set time.
    assert(input.readPaths.includes("a"));
    assert(input.readPaths.includes("b"));
    // But the merged binding was deleted, so the later `.get("k").name` resolves
    // to no source: neither a.name nor b.name is recorded.
    assert(!input.readPaths.includes("a.name"));
    assert(!input.readPaths.includes("b.name"));
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
