import { assert, assertEquals } from "@std/assert";

import ts from "typescript";

import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";

// These tests drive `analyzeFunctionCapabilities` through parameter-summary
// branches that run today only as a side effect of patterns compiling through
// the transformer in CI's pattern-integration jobs. Each case constructs a
// callback body that reaches a specific branch and pins the observable summary
// (capability, read/write/identity paths, wildcard/passthrough flags).

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

function analyze(
  source: string,
  name = "fn",
  opts: { interprocedural?: boolean } = {},
) {
  const { program, sourceFile } = createProgram(source);
  return analyzeFunctionCapabilities(
    findArrow(sourceFile, name),
    {
      checker: program.getTypeChecker(),
      interprocedural: opts.interprocedural,
    },
  );
}

// Analyze without a type checker (many branches gate on `!checker`).
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
    identityOnly: !!p.identityOnly,
    identityPaths: (p.identityPaths ?? []).map((x) => x.join(".")),
    identityCellPaths: (p.identityCellPaths ?? []).map((x) => x.join(".")),
    comparablePaths: (p.comparablePaths ?? []).map((x) => x.join(".")),
    opaquePaths: (p.opaquePaths ?? []).map((x) => x.join(".")),
  };
}

const CELL = `declare const CELL_BRAND: unique symbol;
type Cell<T> = {
  readonly [CELL_BRAND]: "cell";
  get(): T;
  set(value: T): void;
  update(value: Partial<T>): void;
  push(...items: unknown[]): number;
  removeAll(): void;
  splice(start: number, count: number, ...items: unknown[]): unknown[];
  map<U>(fn: (v: unknown) => U): U[];
  filter(fn: (v: unknown) => boolean): unknown[];
  flatMap<U>(fn: (v: unknown) => U): U[];
  equals(other: unknown): boolean;
  equalLinks(other: unknown): boolean;
  key(...segments: (string | number)[]): Cell<unknown>;
};`;

Deno.test("writer method set() marks the receiver path writeonly", () => {
  const input = getPaths(
    analyze(`${CELL}
      const fn = (input: Cell<{ n: number }>) => { input.set({ n: 1 }); };`),
    "input",
  );
  assertEquals(input.capability, "writeonly");
  assert(input.writePaths.includes(""));
  assertEquals(input.readPaths.length, 0);
});

Deno.test("writer method update() marks the receiver path writeonly", () => {
  const input = getPaths(
    analyze(`${CELL}
      const fn = (input: Cell<{ n: number }>) => { input.update({ n: 2 }); };`),
    "input",
  );
  assertEquals(input.capability, "writeonly");
  assert(input.writePaths.includes(""));
});

Deno.test("reader method get() records a read of the receiver path", () => {
  const input = getPaths(
    analyze(`${CELL}
      const fn = (input: Cell<{ n: number }>) => input.get();`),
    "input",
  );
  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes(""));
});

Deno.test(
  "get() chained into a member access records the narrowed path, not a blanket read",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: Cell<{ meta: { size: number } }>) =>
          input.get().meta.size;`),
      "input",
    );
    assertEquals(input.capability, "readonly");
    assert(input.readPaths.includes("meta.size"));
    assert(!input.readPaths.includes(""));
  },
);

Deno.test(
  "array identity writer push() writes the receiver and reads a tracked argument element",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { row: { id: string } }, list: Cell<unknown[]>) => {
          list.push(input.row);
        };`),
      "input",
    );
    // The pushed argument is read at its path.
    assert(input.readPaths.includes("row"));
  },
);

Deno.test("removeAll() over a tracked cell writes the receiver path", () => {
  const list = getPaths(
    analyze(`${CELL}
      const fn = (list: Cell<unknown[]>) => { list.removeAll(); };`),
    "list",
  );
  assertEquals(list.capability, "writeonly");
  assert(list.writePaths.includes(""));
});

Deno.test(
  "splice() only reads inserted items (index >= 2), not the start/count args",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { item: { id: string } }, list: Cell<unknown[]>) => {
          list.splice(0, 1, input.item);
        };`),
      "input",
    );
    assert(input.readPaths.includes("item"));
  },
);

Deno.test(
  "opaque derivation map() over a tracked field records an opaque path, not a read",
  () => {
    // Without a checker the OPAQUE_DERIVATION branch fires unconditionally, so
    // the field is recorded as an opaque path rather than a structural read.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => input.items.map((x) => x + 1);`,
      ),
      "input",
    );
    assert(input.opaquePaths.includes("items"));
    assertEquals(input.readPaths.includes("items"), false);
  },
);

Deno.test(
  "opaque derivation filter() over the whole root marks the root opaque",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => input.filter((x) => x > 0);`,
      ),
      "input",
    );
    // Whole-root opaque use: no reads/writes recorded, capability opaque.
    assertEquals(input.capability, "opaque");
    assertEquals(input.readPaths.length, 0);
  },
);

Deno.test("equals() over a tracked field records a comparable identity path", () => {
  // Without a checker the equals-callee recognition treats any `.equals`
  // property access as the known identity comparison.
  const input = getPaths(
    analyzeNoChecker(
      `const fn = (input, other) => input.a.equals(other);`,
    ),
    "input",
  );
  assert(input.comparablePaths.includes("a"));
  assert(input.identityPaths.includes("a"));
});

Deno.test(
  "equalLinks() over a tracked field records a comparable identity path",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, other) => input.a.equalLinks(other);`,
      ),
      "input",
    );
    assert(input.comparablePaths.includes("a"));
  },
);

Deno.test("key() with static string segment reads the composed path", () => {
  const input = getPaths(
    analyze(`${CELL}
      const fn = (input: Cell<{ sub: number }>) => input.key("sub");`),
    "input",
  );
  assert(input.readPaths.includes("sub"));
});

Deno.test("key() with a dynamic segment widens the receiver to wildcard", () => {
  const input = getPaths(
    analyze(`${CELL}
      const fn = (input: Cell<Record<string, number>>, k: string) =>
        input.key(k);`),
    "input",
  );
  assertEquals(input.wildcard, true);
});

Deno.test(
  "key() chained into a member access defers the read to the member handler",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: Cell<{ sub: { n: number } }>) =>
          input.key("sub").get();`),
      "input",
    );
    // The key() itself is chained, so it records the composed path via the
    // member/get handler rather than a blanket key read.
    assert(input.readPaths.some((p) => p.includes("sub")));
  },
);

Deno.test("numeric element access records a numeric path segment", () => {
  const input = getPaths(
    analyzeNoChecker(`const fn = (input) => input.items[0].name;`),
    "input",
  );
  assert(input.readPaths.includes("items.0.name"));
});

Deno.test(
  "template-literal element access records the literal path segment",
  () => {
    const input = getPaths(
      analyzeNoChecker("const fn = (input) => input[`field`];"),
      "input",
    );
    assert(input.readPaths.includes("field"));
  },
);

Deno.test(
  "dynamic element access reads the static prefix above the key",
  () => {
    const input = getPaths(
      analyzeNoChecker(`const fn = (input, k) => input.offers[k].space;`),
      "input",
    );
    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths, ["offers"]);
  },
);

Deno.test(
  "object destructure with a computed key name marks the root wildcard",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k) => { const { [k]: v } = input; return v; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "object destructure rest element widens the root to wildcard",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { const { a, ...rest } = input; return rest; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "array binding pattern destructure widens the source root to wildcard",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { const [first] = input.items; return first; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "assignment-pattern object destructure tracks per-property reads",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { let a, b; ({ a, b } = input); return a + b; };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("a"));
    assert(input.readPaths.includes("b"));
  },
);

Deno.test(
  "assignment-pattern object spread widens the source root to wildcard",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { let a, r; ({ a, ...r } = input); return r; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "assignment-pattern array destructure widens the source root to wildcard",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { let a; ([a] = input.list); return a; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test("alias chain across reassignments follows the latest source", () => {
  const input = getPaths(
    analyzeNoChecker(
      `const fn = (input) => {
        let cur = input.a;
        cur = input.b;
        return cur.name;
      };`,
    ),
    "input",
  );
  assert(input.readPaths.includes("b.name"));
});

Deno.test("for-in over a tracked expression widens the root to wildcard", () => {
  const input = getPaths(
    analyzeNoChecker(
      `const fn = (input) => { for (const k in input.map) { k; } };`,
    ),
    "input",
  );
  assertEquals(input.wildcard, true);
});

Deno.test(
  "for-of over a tracked array reads the element path via the iterator binding",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          for (const item of input.list) { item.id; }
        };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("list.0.id"));
  },
);

Deno.test(
  "for-of over the whole root marks the root passthrough",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { for (const item of input) { item; } };`,
      ),
      "input",
    );
    assertEquals(input.passthrough, true);
  },
);

Deno.test(
  "fallback with ?? between equal aliases keeps the shared path",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          const v = input.a ?? input.a;
          return v.name;
        };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("a.name"));
  },
);

Deno.test(
  "fallback with || between differing aliases drops to the left source",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          const v = input.a || input.b;
          return v;
        };`,
      ),
      "input",
    );
    // Both operands are read as passthrough sources.
    assert(input.readPaths.includes("a") || input.readPaths.includes("b"));
  },
);

Deno.test(
  "navigateTo() over a whole tracked root records an identity-only passthrough",
  () => {
    // Without a checker the navigateTo callee is recognized by name. Passing
    // the whole root avoids a member read, so the root is identity-preserving
    // and passthrough rather than structurally read.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { navigateTo(input); };`,
      ),
      "input",
    );
    assertEquals(input.passthrough, true);
    assertEquals(input.identityOnly, true);
    assert(input.identityPaths.includes(""));
  },
);

Deno.test(
  "prefix increment over a tracked member both reads and writes it",
  () => {
    const input = getPaths(
      analyzeNoChecker(`const fn = (input) => { ++input.count; };`),
      "input",
    );
    assert(input.readPaths.includes("count"));
    assert(input.writePaths.includes("count"));
  },
);

Deno.test(
  "spread of a tracked member into an array literal reads the member",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { const merged = [...input.items]; return merged; };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("items"));
  },
);

Deno.test(
  "object spread assignment of a tracked member widens the root to wildcard",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { const merged = { ...input }; return merged; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "interprocedural helper reading a param field propagates the read path",
  () => {
    const input = getPaths(
      analyze(
        `const helper = (v: { user: { name: string } }) => v.user.name;
         const fn = (input: { user: { name: string } }) => helper(input);`,
        "fn",
        { interprocedural: true },
      ),
      "input",
    );
    assert(input.readPaths.includes("user.name"));
  },
);

Deno.test(
  "interprocedural helper that writes a param field propagates the write path",
  () => {
    const input = getPaths(
      analyze(
        `${CELL}
        const helper = (v: { a: Cell<number> }) => { v.a.set(1); };
        const fn = (input: { a: Cell<number> }) => helper(input);`,
        "fn",
        {
          interprocedural: true,
        },
      ),
      "input",
    );
    assert(input.writePaths.includes("a"));
  },
);

Deno.test(
  "unknown method call over a tracked field reads that field",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => input.helper.doThing();`,
      ),
      "input",
    );
    assert(input.readPaths.some((p) => p.startsWith("helper")));
  },
);

Deno.test(
  "passing a tracked root as a plain call argument widens it to wildcard",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { doThing(input); };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

//
// Batch 2: checker-gated and shape-specific branches
//

Deno.test(
  "numeric destructure key records a numeric path segment",
  () => {
    // getStaticPropertyKeyText resolves a NumericLiteral property name.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { const { 0: first } = input; return first; };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("0"));
  },
);

Deno.test(
  "template-literal destructure key records the literal path segment",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        "const fn = (input) => { const { [`sub`]: v } = input; return v; };",
      ),
      "input",
    );
    assert(input.readPaths.includes("sub"));
  },
);

Deno.test(
  "element-access with a bracketed string method reads the composed path",
  () => {
    // getCallReceiverFromExpression / getCallMethodName over an
    // ElementAccessExpression callee (input.a["get"]()).
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { a: Cell<{ n: number }> }) => input.a["get"]();`),
      "input",
    );
    assert(input.readPaths.includes("a"));
  },
);

Deno.test(
  "equals() addressed via bracket notation records a comparable path",
  () => {
    // isKnownIdentityEqualsCallee over an ElementAccessExpression callee.
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { a: Cell<number> }, other: Cell<number>) =>
          input.a["equals"](other);`),
      "input",
    );
    assert(input.comparablePaths.includes("a"));
  },
);

Deno.test(
  "?? fallback between two equal object-shape aliases keeps the shared read",
  () => {
    // aliasBindingEquals recurses over AliasShape properties, and both operands
    // build the identical shape { u: input.a }.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          const left = { u: input.a };
          const right = { u: input.a };
          const v = left ?? right;
          return v.u.name;
        };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("a.name"));
  },
);

Deno.test(
  "object literal alias with a computed non-static key drops that property",
  () => {
    // buildAliasBindingFromExpression skips the non-static computed key, so the
    // shape alias only carries the statically-keyed property.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k) => {
          const shape = { [k]: input.a, b: input.b };
          return shape.b;
        };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("b"));
    assertEquals(input.wildcard, false);
  },
);

Deno.test(
  "renamed object destructure records the source property, not the alias name",
  () => {
    // assignParameterBindingAlias resolves element.propertyName via
    // getStaticPropertyKeyText and extends the source ref by that key.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { const { user: u } = input; return u.name; };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("user.name"));
  },
);

Deno.test(
  "nested destructure with a default initializer widens the root to wildcard",
  () => {
    // The binding element carries an initializer, taking the
    // dotDotDotToken/initializer branch that marks the source root wildcard.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { const { a = 1 } = input; return a; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "find() truthiness check on the element result records no payload read",
  () => {
    // The element-result alias in a boolean condition (isBooleanConditionUsage)
    // is presence-only, so no structural read of the element is recorded.
    const input = getPaths(
      analyze(`${CELL}
        interface Array<T> { find(p: (v: T) => boolean): T | undefined; }
        const fn = (input: { list: { flag: boolean }[] }) => {
          const found = input.list.find((x) => x.flag);
          if (found) { return 1; }
          return 0;
        };`),
      "input",
    );
    // The list is read structurally (find scans it) but the found element's
    // payload is not required by the presence check alone.
    assert(input.readPaths.some((p) => p.startsWith("list")));
    assertEquals(input.wildcard, false);
  },
);

Deno.test(
  "optional-presence alias truthiness check keeps the property presence-only",
  () => {
    // A non-primitive optional member used only in a truthiness check records
    // presence, not the payload shape (the isBooleanConditionUsage skip).
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { maybe?: { n: number } }) => {
          const opt = input?.maybe;
          if (!opt) { return 0; }
          return 1;
        };`),
      "input",
    );
    assertEquals(input.wildcard, false);
  },
);

Deno.test(
  "increment through a nested member both reads and writes the deep path",
  () => {
    const input = getPaths(
      analyzeNoChecker(`const fn = (input) => { input.a.count++; };`),
      "input",
    );
    assert(input.readPaths.includes("a.count"));
    assert(input.writePaths.includes("a.count"));
  },
);

Deno.test(
  "compound assignment to a tracked member both reads and writes it",
  () => {
    const input = getPaths(
      analyzeNoChecker(`const fn = (input) => { input.count += 1; };`),
      "input",
    );
    assert(input.readPaths.includes("count"));
    assert(input.writePaths.includes("count"));
  },
);

Deno.test(
  "for-of over a dynamic member reads the static prefix above the key",
  () => {
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k) => { for (const x of input.lists[k]) { x; } };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths, ["lists"]);
  },
);

Deno.test(
  "for-of with an object destructure binding reads the destructured field",
  () => {
    // The for-of initializer is a variable declaration list whose binding is a
    // destructure, driving assignBindingAlias against the element binding.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          for (const { id } of input.list) { id; }
        };`,
      ),
      "input",
    );
    assert(input.readPaths.some((p) => p.startsWith("list")));
  },
);

Deno.test(
  "for-of with an assignment-target initializer aliases the element binding",
  () => {
    // The for-of initializer is an expression (not a declaration list), taking
    // the assignExpressionPatternAlias branch inside the loop scope.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          let item;
          for (item of input.list) { item.id; }
        };`,
      ),
      "input",
    );
    assert(input.readPaths.some((p) => p.startsWith("list")));
  },
);

Deno.test(
  "aliases resolved through a for-of scope are restored after the loop",
  () => {
    // aliasesWithSpecificPaths and the alias maps are saved before the loop and
    // restored after, so a post-loop read keeps its specific path.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          const shape = { u: input.user };
          for (const item of input.list) { item.id; }
          return shape.u.name;
        };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("user.name"));
    assert(input.readPaths.some((p) => p.startsWith("list")));
  },
);

Deno.test(
  "interprocedural helper opaque field propagates an opaque path to caller",
  () => {
    // The callee derives from a cell field via map(); its opaquePaths summary
    // is replayed onto the caller argument's path.
    const input = getPaths(
      analyze(
        `${CELL}
        const helper = (v: { items: Cell<number[]> }) => v.items.map(() => 1);
        const fn = (input: { items: Cell<number[]> }) => helper(input);`,
        "fn",
        {
          interprocedural: true,
        },
      ),
      "input",
    );
    assert(input.opaquePaths.includes("items"));
  },
);

Deno.test(
  "interprocedural helper comparable field propagates a comparable path",
  () => {
    // The callee compares a cell field with equals(); the comparable path is
    // replayed onto the caller argument.
    const input = getPaths(
      analyze(
        `${CELL}
        const helper = (v: { a: Cell<number> }, o: Cell<number>) =>
          v.a.equals(o);
        const fn = (input: { a: Cell<number> }, rhs: Cell<number>) =>
          helper(input, rhs);`,
        "fn",
        { interprocedural: true },
      ),
      "input",
    );
    assert(input.comparablePaths.includes("a"));
  },
);

Deno.test(
  "interprocedural helper reading a param field via dynamic arg widens caller",
  () => {
    // The caller passes a dynamic member as the argument, so the propagation
    // loop widens the whole root to wildcard.
    const input = getPaths(
      analyze(
        `${CELL}
        const helper = (v: { user: { name: string } }) => v.user.name;
        const fn = (input: { items: { user: { name: string } }[] }, k: number) =>
          helper(input.items[k]);`,
        "fn",
        { interprocedural: true },
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "destructured parameter uses a synthetic positional summary name",
  () => {
    // A non-identifier parameter name yields a `${PARAMETER_SUMMARY_PREFIX}i`
    // summary name in the final param loop.
    const summary = analyze(`${CELL}
      const fn = ({ a }: { a: { n: number } }) => a.n;`);
    assert(summary.params.length >= 1);
    assert(summary.params.some((p) => p.readPaths.length > 0));
  },
);

//
// Batch 3: assignment patterns, opaque roots, method dispatch edges
//

Deno.test(
  "parenthesized assignment destructure target treats the source as passthrough",
  () => {
    // assignExpressionPatternAlias unwraps a ParenthesizedExpression pattern;
    // the whole tracked root flows through as a passthrough assignment source.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { let a; (({ a }) = input); return a; };`,
      ),
      "input",
    );
    assertEquals(input.passthrough, true);
  },
);

Deno.test(
  "renamed property in an assignment destructure records the source key",
  () => {
    // The property-assignment branch resolves the static key and reads it.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { let x; ({ a: x } = input); return x; };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("a"));
  },
);

Deno.test(
  "computed key in an assignment destructure widens the source root",
  () => {
    // A non-static computed key in the assignment target has no resolvable key,
    // so the source root is widened to wildcard.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k) => { let x; ({ [k]: x } = input); return x; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "nested array destructure inside an assignment target ignores its elements",
  () => {
    // The array-literal assignment pattern marks the source-ref root wildcard
    // and then descends into elements with an undefined source.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { let a; ([a] = input.list); return a; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "assignment destructure from an untracked source records no reads",
  () => {
    // With an undefined source binding, the object-assignment branch clears
    // aliases without recording reads against the tracked parameter.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          input.touch;
          let a;
          ({ a } = external);
          return a;
        };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("touch"));
  },
);

Deno.test(
  "splice inserts only track arguments at or after the third position",
  () => {
    // isArrayIdentityWriterValueArgument requires index >= 2 for splice, so the
    // start/count arguments are not treated as inserted identity items.
    const input = getPaths(
      analyze(`${CELL}
        const fn = (
          input: { start: number; item: { id: string } },
          list: Cell<unknown[]>,
        ) => {
          list.splice(input.start, 1, input.item);
        };`),
      "input",
    );
    assert(input.readPaths.includes("start"));
    assert(input.readPaths.includes("item"));
  },
);

Deno.test(
  "constructing with a tracked root argument treats it as passthrough",
  () => {
    // isCallOrNewArgumentUsage recognizes NewExpression arguments, so the whole
    // root flows through as a passthrough rather than a structural read.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { const w = new Wrapper(input); return w; };`,
      ),
      "input",
    );
    assertEquals(input.passthrough, true);
  },
);

Deno.test(
  "method-less call over a tracked field reads its full shape",
  () => {
    // A call whose callee resolves conservatively (no method name) tracks a
    // full-shape read of the receiver.
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { fns: (() => number)[] }) => input.fns[0]();`),
      "input",
    );
    assert(input.readPaths.some((p) => p.startsWith("fns")));
  },
);

Deno.test(
  "elementById() over a tracked collection widens the collection root",
  () => {
    const input = getPaths(
      analyze(`${CELL}
        interface Array<T> { elementById(id: string): T; }
        const fn = (input: { rows: { id: string }[] }) =>
          input.rows.elementById("x");`),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "interprocedural identity propagation through a dynamic arg widens the root",
  () => {
    // The callee records an identity path on its parameter; the caller passes a
    // dynamic member, so identity propagation widens the whole root.
    const input = getPaths(
      analyze(
        `${CELL}
        const helper = (v: Cell<number>, o: Cell<number>) => v.equals(o);
        const fn = (
          input: { cells: Cell<number>[] },
          rhs: Cell<number>,
          k: number,
        ) => helper(input.cells[k], rhs);`,
        "fn",
        { interprocedural: true },
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "interprocedural whole-root equals helper leaves the caller opaque passthrough",
  () => {
    // The callee's parameter is comparable-and-passthrough (equals over the
    // whole cell). Propagating that whole-root identity summary back leaves the
    // caller argument opaque and passthrough rather than structurally read.
    const input = getPaths(
      analyze(
        `${CELL}
        const helper = (v: Cell<number>, o: Cell<number>) => v.equals(o);
        const fn = (input: Cell<number>, rhs: Cell<number>) =>
          helper(input, rhs);`,
        "fn",
        { interprocedural: true },
      ),
      "input",
    );
    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.readPaths.length, 0);
  },
);

//
// Batch 4: aliased identity-writer args, nested patterns, dynamic calls
//

Deno.test(
  "aliased local pushed into a cell writer is read at its aliased path",
  () => {
    // An identifier argument to push() routes through the identity-writer
    // argument recognition (isArrayIdentityWriterValueArgument).
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { row: { id: string } }, list: Cell<unknown[]>) => {
          const it = input.row;
          list.push(it);
        };`),
      "input",
    );
    assert(input.readPaths.includes("row"));
  },
);

Deno.test(
  "aliased local at splice insert position is read at its aliased path",
  () => {
    // splice only treats arguments at index >= 2 as inserted items.
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: { item: { id: string } }, list: Cell<unknown[]>) => {
          const it = input.item;
          list.splice(0, 1, it);
        };`),
      "input",
    );
    assert(input.readPaths.includes("item"));
  },
);

Deno.test(
  "parenthesized property target inside an assignment destructure is handled",
  () => {
    // The property initializer is itself parenthesized, driving the
    // ParenthesizedExpression branch of assignExpressionPatternAlias.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { let x; ({ a: (x) } = input); return x; };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("a"));
  },
);

Deno.test(
  "array destructure assignment with a rest element skips the spread slot",
  () => {
    // The array-literal assignment pattern marks the source root wildcard and
    // continues past the spread element.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => { let a, r; ([a, ...r] = input.list); return a; };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "assignment destructure from an untracked source clears nested aliases",
  () => {
    // With an undefined source, the object-assignment branch recurses into a
    // property initializer to clear its alias without recording a read.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          input.keep;
          let x;
          ({ a: x } = external);
          return x;
        };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("keep"));
  },
);

Deno.test(
  "call through a dynamically-indexed method reads the receiver conservatively",
  () => {
    // getCallMethodName returns undefined for a dynamic element-access callee,
    // so the method-less call branch reads the conservative receiver path.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k) => { input.handlers[k](); };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("handlers"));
    assertEquals(input.wildcard, false);
  },
);

//
// Batch 5: shape equality, dynamic markers, identity array items
//

Deno.test(
  "?? fallback between differently-shaped aliases keeps both source reads",
  () => {
    // aliasBindingEquals compares the two shapes, finds a size mismatch, and
    // resolveBinding drops the merged shape so both branches read their source.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          const left = { u: input.a };
          const right = { u: input.a, v: input.b };
          const v = left ?? right;
          return v;
        };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("a"));
    assert(input.readPaths.includes("b"));
  },
);

Deno.test(
  "?? fallback between equal-size but differing-value shapes drops the merge",
  () => {
    // Equal property counts but a differing property value exercises the
    // recursive value comparison inside aliasBindingEquals.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input) => {
          const left = { u: input.a };
          const right = { u: input.b };
          const v = left ?? right;
          return v;
        };`,
      ),
      "input",
    );
    assert(input.readPaths.includes("a"));
    assert(input.readPaths.includes("b"));
  },
);

Deno.test(
  "increment through a dynamic member widens the root to wildcard",
  () => {
    // markFromExpression resolves a dynamic ref and widens the whole root.
    const input = getPaths(
      analyzeNoChecker(`const fn = (input, k) => { input.counts[k]++; };`),
      "input",
    );
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "identity-tracked local spread into a set payload records identity item paths",
  () => {
    // A local array built by spreading a tracked element and passed to set()
    // records identity (not structural) paths for that element's source.
    const input = getPaths(
      analyze(
        `${CELL}
        interface Array<T> { push(...items: T[]): number; }
        declare const external: unknown[];
        const fn = (
          input: { piece?: { title: string } },
          state: { items: Cell<unknown[]> },
        ) => {
          const piece = input?.piece;
          if (!piece) return;
          const updated = [...external, piece];
          state.items.set(updated);
        };`,
        "fn",
        { interprocedural: true },
      ),
      "input",
    );
    assert(input.identityPaths.includes("piece"));
    assert(input.identityCellPaths.includes("piece"));
  },
);

//
// Batch 6: whole-root identity, array-item identity, param array binding
//

Deno.test(
  "equals() over the whole tracked root records a root comparable passthrough",
  () => {
    // markIdentityUseRef with a zero-length path records a root comparable path
    // and marks the root passthrough identity-only.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, other) => input.equals(other);`,
      ),
      "input",
    );
    assertEquals(input.capability, "comparable");
    assert(input.comparablePaths.includes(""));
    assertEquals(input.passthrough, true);
  },
);

Deno.test(
  "equals() over a dynamic member reads the static prefix above the key",
  () => {
    // markIdentityUseRef takes a dynamic ref for a read of its whole prefix,
    // since no identity path names the member the key picks.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, k, other) => input.cells[k].equals(other);`,
      ),
      "input",
    );
    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths, ["cells"]);
  },
);

Deno.test(
  "pushing a previously identity-compared element marks the array item identity",
  () => {
    // A push argument that already has a recorded identity use drives
    // markArrayItemIdentityUseRef, recording an element identity path on the
    // receiver array (its item slot "0").
    const list = getPaths(
      analyze(`${CELL}
        const fn = (
          input: Cell<number>,
          other: Cell<number>,
          list: Cell<unknown[]>,
        ) => {
          input.equals(other);
          list.push(input);
        };`),
      "list",
    );
    assert(list.identityPaths.includes("0"));
  },
);

Deno.test(
  "array-binding parameter destructure widens the parameter root to wildcard",
  () => {
    // assignParameterBindingAlias marks the source root wildcard for an
    // array-binding-pattern parameter.
    const summary = analyzeNoChecker(
      `const fn = ([first, second]) => first + second;`,
    );
    const p = summary.params[0];
    assert(p);
    assertEquals(p.wildcard, true);
  },
);

//
// Batch 7: key() wrapper unwrapping, identity-only aliased arguments
//

Deno.test(
  "key() call wrapped in parentheses then chained still defers to member access",
  () => {
    // unwrapExpressionUsageSite unwraps the parenthesized key() result to see
    // it is chained into a further member access, so no blanket key read fires.
    const input = getPaths(
      analyze(`${CELL}
        const fn = (input: Cell<{ sub: { n: number } }>) =>
          (input.key("sub")).get();`),
      "input",
    );
    assert(input.readPaths.some((p) => p.includes("sub")));
  },
);

Deno.test(
  "equals() over an aliased dynamic path reads the static prefix above the key",
  () => {
    // An aliased dynamic member passed to equals() is an identity-only argument;
    // no identity path names the member the key picks, so the use is a read of
    // the whole prefix above the key.
    const input = getPaths(
      analyzeNoChecker(
        `const fn = (input, other, k) => {
          const a = input.cells[k];
          return a.equals(other);
        };`,
      ),
      "input",
    );
    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths, ["cells"]);
  },
);

//
// Batch 8: get()-chain specific paths restored across a for-of loop
//

Deno.test(
  "get()-chain specific-path aliases survive a for-of scope and stay narrowed",
  () => {
    // A `.get()`-resolved alias with a specific property path is saved before a
    // for-of loop opens a nested scope and restored after it closes, so the
    // post-loop read keeps its narrowed path rather than a blanket read.
    const input = getPaths(
      analyze(`${CELL}
        const fn = (
          input: { notes: Cell<{ list: { length: number } }>; items: number[] },
        ) => {
          const notes = input.notes;
          const before = notes.get().list.length;
          for (const it of input.items) {
            it;
          }
          return notes.get().list.length + before;
        };`),
      "input",
    );
    assert(input.readPaths.includes("notes.list.length"));
    assert(input.readPaths.some((p) => p.startsWith("items")));
    assertEquals(input.wildcard, false);
  },
);
