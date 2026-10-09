import { assert, assertEquals } from "@std/assert";

import ts from "typescript";

import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";

// These tests drive `analyzeFunctionCapabilities` through interprocedural
// propagation and local-collection identity tracking. Those paths run today
// only as a side effect of patterns compiling through the transformer in the
// CI pattern-integration jobs; the cases here bring them under unit coverage.

function createProgram(
  source: string,
): { program: ts.Program; sourceFile: ts.SourceFile } {
  const files: Record<string, string> = { "/test.ts": source };
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
  const program = ts.createProgram(["/test.ts"], options, host);
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

function analyze(source: string, name = "fn") {
  const { program, sourceFile } = createProgram(source);
  const summary = analyzeFunctionCapabilities(
    findArrow(sourceFile, name),
    { checker: program.getTypeChecker(), interprocedural: true },
  );
  return summary;
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
    identityOnly: !!p.identityOnly,
    identityPaths: (p.identityPaths ?? []).map((x) => x.join(".")),
    identityCellPaths: (p.identityCellPaths ?? []).map((x) => x.join(".")),
    comparablePaths: (p.comparablePaths ?? []).map((x) => x.join(".")),
  };
}

const CELL = `declare const CELL_BRAND: unique symbol;
type Cell<T> = {
  readonly [CELL_BRAND]: "cell";
  set(value: T): void;
  equals(other: Cell<T>): boolean;
};`;

Deno.test(
  "interprocedural equals-only helper keeps caller argument identity-preserving",
  () => {
    // The callee compares its two parameters with `.equals()`, so neither
    // parameter's structure is read. Propagating that summary back to the
    // caller must leave `input` opaque and passthrough rather than reading it.
    const input = getPaths(
      analyze(`${CELL}
        const helper = (value: Cell<{ n: string }>, other: Cell<{ n: string }>) =>
          value.equals(other);
        const fn = (input: Cell<{ n: string }>, rhs: Cell<{ n: string }>) =>
          helper(input, rhs);`),
      "input",
    );

    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths.length, 0);
    assertEquals(input.writePaths.length, 0);
  },
);

Deno.test(
  "interprocedural helper that writes to its parameter marks caller writeonly",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        const helper = (v: Cell<number>) => { v.set(1); };
        const fn = (input: Cell<number>) => { helper(input); };`),
      "input",
    );

    assertEquals(input.capability, "writeonly");
    assert(input.writePaths.includes(""));
    assertEquals(input.readPaths.length, 0);
  },
);

Deno.test(
  "interprocedural helper that reads a parameter field propagates the read path",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        const helper = (v: { user: { name: string } }) => v.user.name;
        const fn = (input: { user: { name: string } }) => helper(input);`),
      "input",
    );

    assertEquals(input.capability, "readonly");
    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("user.name"));
  },
);

Deno.test(
  "unknown optional callback use still widens its tracked argument",
  () => {
    // Optionality does not change the call policy. The unresolved callback
    // itself requires conservative whole-root treatment of its argument.
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { thing: number }, cb?: (x: unknown) => void) => {
          cb?.(input);
        };`),
      "input",
    );

    assertEquals(input.wildcard, true);
    assertEquals(input.passthrough, true);
  },
);

Deno.test(
  "optional invocation does not wildcard a supported receiver-method path",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { name?: string }) => {
          return input.name?.trim?.();
        };`),
      "input",
    );

    assertEquals(input.capability, "readonly");
    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("name"));
  },
);

Deno.test(
  "optional get chains retain the nested cell read path",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        type ReadCell<T> = Cell<T> & { get(): T };
        const fn = (
          input: {
            state: string;
            auth?: ReadCell<{ token: string; refreshToken: string }>;
          },
        ) => input.state === "ready" &&
          input.auth?.get?.()?.token === "initial";`),
      "input",
    );

    assertEquals(input.capability, "readonly");
    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("state"));
    assert(input.readPaths.includes("auth"));
  },
);

Deno.test(
  "array literal wrapped in an as-expression still yields an element read",
  () => {
    // The array-local element scan must unwrap the parenthesized/as wrappers
    // around `[piece]` to attribute the read to `input.piece`.
    const input = getPaths(
      analyze(`${CELL}
        declare const state: { items: Cell<Piece[]> };
        type Piece = { title: string };
        const fn = (input: { piece?: Piece }) => {
          const piece = input?.piece;
          if (!piece) return;
          state.items.set(([piece]) as Piece[]);
        };`),
      "input",
    );

    assert(input.readPaths.includes("piece"));
    assertEquals(input.wildcard, false);
  },
);

Deno.test(
  "spread of a tracked local array set payload records identity-cell paths",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        interface Array<T> { push(...items: T[]): number; }
        declare const state: { items: Cell<Piece[]> };
        declare const external: Piece[];
        type Piece = { title: string };
        const fn = (input: { piece?: Piece }) => {
          const piece = input?.piece;
          if (!piece) return;
          const updated = [...external, piece];
          state.items.set(updated);
        };`),
      "input",
    );

    assert(input.identityPaths.includes("piece"));
    assert(input.identityCellPaths.includes("piece"));
  },
);

Deno.test(
  "object-shape and optional-presence aliases survive a for-of scope",
  () => {
    // A shape alias (`shape`) and an optional-presence alias (`opt`) are both
    // live when a for-of loop opens a nested collection scope. The loop must
    // restore them on exit so later reads keep their specific paths.
    const input = getPaths(
      analyze(`${CELL}
        type Item = { id: string };
        const fn = (input: {
          user: { name: string };
          maybe?: number;
          list: Item[];
        }) => {
          const shape = { u: input.user };
          const opt = input?.maybe;
          if (!opt) return;
          for (const item of input.list) {
            item.id;
          }
          return shape.u.name + opt;
        };`),
      "input",
    );

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("user.name"));
    assert(input.readPaths.includes("maybe"));
    assert(input.readPaths.includes("list.0.id"));
  },
);

Deno.test(
  "equal object shapes pushed on both branches keep a stable local binding",
  () => {
    // Both branches push the identical shape `{ u: input.a }`, so the
    // per-iteration binding compares equal and the read stays path-specific.
    const input = getPaths(
      analyze(`${CELL}
        interface Array<T> { push(...items: T[]): number; }
        declare const state: { items: Cell<Row[]> };
        type Row = { u: X };
        type X = { name: string };
        const fn = (input: { a: X; list: { flag: boolean }[] }) => {
          const collected: Row[] = [];
          for (const item of input.list) {
            if (item.flag) {
              collected.push({ u: input.a });
            } else {
              collected.push({ u: input.a });
            }
          }
          state.items.set(collected);
        };`),
      "input",
    );

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("a"));
    assert(input.readPaths.includes("list.0.flag"));
  },
);

Deno.test(
  "differently shaped pushes on each branch still track both source fields",
  () => {
    // The two branches push shapes with different property sets, exercising the
    // size-mismatch path of the alias-shape comparison.
    const input = getPaths(
      analyze(`${CELL}
        interface Array<T> { push(...items: T[]): number; }
        declare const state: { items: Cell<Row[]> };
        type Row = { u: X; v?: X };
        type X = { name: string };
        const fn = (input: { a: X; b: X; list: { flag: boolean }[] }) => {
          const collected: Row[] = [];
          for (const item of input.list) {
            if (item.flag) {
              collected.push({ u: input.a });
            } else {
              collected.push({ u: input.a, v: input.b });
            }
          }
          state.items.set(collected);
        };`),
      "input",
    );

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("a"));
    assert(input.readPaths.includes("b"));
  },
);

//
// hasUnverifiedCellUse propagation through callee summaries
//

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

function createTypedProgram(
  source: string,
): { program: ts.Program; sourceFile: ts.SourceFile } {
  const files: Record<string, string> = {
    "/test.ts": source,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
  };
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
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) =>
        files[`/${name}.d.ts`] !== undefined
          ? {
            resolvedFileName: `/${name}.d.ts`,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          }
          : undefined
      ),
  };
  const program = ts.createProgram(["/test.ts"], options, host);
  return { program, sourceFile: program.getSourceFile("/test.ts")! };
}

Deno.test("Interprocedural analysis propagates hasUnverifiedCellUse from callee summaries", () => {
  const source = `import { type Cell } from "commonfabric";
const helper = (c: Cell<{ n: number }>) => {
  c.frobnicate();
  return null;
};
const fn = (input: Cell<{ n: number }>) => {
  helper(input);
  return null;
};`;
  const { program, sourceFile } = createTypedProgram(source);
  const checker = program.getTypeChecker();
  const fn = findArrow(sourceFile, "fn");
  const summary = analyzeFunctionCapabilities(fn, {
    checker,
    interprocedural: true,
  });
  const input = summary.params.find((entry) => entry.name === "input");
  assert(input);

  // The unknown cell-method call happens entirely inside the helper; the
  // caller sees it only through the callee summary. Wildcard stays false —
  // this is the unverified mark propagating, not the wildcard channel.
  assertEquals(input!.hasUnverifiedCellUse, true);
  assertEquals(input!.wildcard, false);
});

Deno.test("Interprocedural analysis does not propagate hasUnverifiedCellUse from read-only callees", () => {
  const source = `import { type Cell } from "commonfabric";
const helper = (c: Cell<{ n: number }>) => c.get();
const fn = (input: Cell<{ n: number }>) => {
  helper(input);
  return null;
};`;
  const { program, sourceFile } = createTypedProgram(source);
  const checker = program.getTypeChecker();
  const fn = findArrow(sourceFile, "fn");
  const summary = analyzeFunctionCapabilities(fn, {
    checker,
    interprocedural: true,
  });
  const input = summary.params.find((entry) => entry.name === "input");
  assert(input);

  assertEquals(input!.hasUnverifiedCellUse, false);
});

Deno.test("Interprocedural analysis lets wildcard subsume the unverified mark for dynamic arguments", () => {
  const source = `import { type Cell } from "commonfabric";
const helper = (c: Cell<{ n: number }>) => {
  c.frobnicate();
  return null;
};
const fn = (input: Cell<{ items: Record<string, { n: number }> }>, k: string) => {
  helper(input.key("items").key(k));
  return null;
};`;
  const { program, sourceFile } = createTypedProgram(source);
  const checker = program.getTypeChecker();
  const fn = findArrow(sourceFile, "fn");
  const summary = analyzeFunctionCapabilities(fn, {
    checker,
    interprocedural: true,
  });
  const input = summary.params.find((entry) => entry.name === "input");
  assert(input);

  // A dynamic argument path takes the wildcard `continue` before the
  // unverified-mark propagation. That precedence is fine for consumers,
  // which must fail closed on either flag.
  assertEquals(input!.wildcard, true);
});

Deno.test(
  "a value leaving for a callee with no summary ends identity use beneath it",
  () => {
    // `record` has no body to summarize, so it may read the whole list it is
    // handed, elements included. The elements compared with `equals()` are
    // then not compared alone; `flag`, compared and never handed on, still is.
    const input = getPaths(
      analyze(`${CELL}
        interface ReadonlyArray<T> { some(p: (v: T) => boolean): boolean; }
        declare function record(value: unknown): void;
        const fn = (
          input: { list: readonly Cell<number>[]; flag: Cell<number> },
          other: Cell<number>,
        ) => {
          if (input.flag.equals(other)) return;
          if (input.list.some((item) => item.equals(other))) return;
          record(input.list);
        };`),
      "input",
    );

    assertEquals(input.identityPaths, ["flag"]);
  },
);

Deno.test(
  "a callee's escape ends the caller's identity use beneath it",
  () => {
    // `pass` hands `holder.list` to a callee with no summary. Its summary says
    // so, and the caller, which compares the list's elements and passes the
    // holder to `pass`, no longer uses those elements for identity alone.
    const input = getPaths(
      analyze(`${CELL}
        interface ReadonlyArray<T> { some(p: (v: T) => boolean): boolean; }
        declare function record(value: unknown): void;
        const pass = (holder: { list: readonly Cell<number>[] }) => {
          record(holder.list);
        };
        const fn = (
          input: { list: readonly Cell<number>[] },
          other: Cell<number>,
        ) => {
          if (input.list.some((item) => item.equals(other))) return;
          pass(input);
        };`),
      "input",
    );

    assertEquals(input.identityPaths, []);
  },
);

for (
  const [form, call] of [
    ["the fallback of a member", "record(input.list ?? []);"],
    ["the fallback of the root", "record(input ?? spare);"],
  ]
) {
  Deno.test(
    `${form} leaving for a callee with no summary ends identity use beneath it`,
    () => {
      // Each form hands `record` a value it may read the whole of, the
      // compared elements included, without naming `input.list` directly.
      const input = getPaths(
        analyze(`${CELL}
          interface ReadonlyArray<T> { some(p: (v: T) => boolean): boolean; }
          declare function record(value: unknown): void;
          const fn = (
            input: { list: readonly Cell<number>[] },
            other: Cell<number>,
            spare: { list: readonly Cell<number>[] },
          ) => {
            if (input.list.some((item) => item.equals(other))) return;
            ${call}
          };`),
        "input",
      );

      assertEquals(input.identityPaths, []);
    },
  );
}
