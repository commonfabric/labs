import { assert, assertEquals } from "@std/assert";

import ts from "typescript";

import {
  analyzeFunctionCapabilities,
  type MergeablePushMisuse,
} from "../../src/policy/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

function collectMergeablePushMisuses(
  source: string,
): MergeablePushMisuse[] {
  const findings: MergeablePushMisuse[] = [];
  analyzeFunctionCapabilities(parseFirstCallback(source), {
    mergeablePushMisuseSink: (finding) => findings.push(finding),
  });
  return findings;
}

function parseFirstCallback(
  source: string,
): ts.ArrowFunction | ts.FunctionExpression {
  const file = ts.createSourceFile(
    "/test.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (callback) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      callback = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (!callback) {
    throw new Error("Expected a callback expression in test source.");
  }

  return callback;
}

function createProgramWithSource(source: string): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
} {
  return createProgramWithFiles({
    "/test.ts": source,
  });
}

function createProgramWithFiles(
  files: Record<string, string>,
  entryFileName = "/test.ts",
): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
} {
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

  const program = ts.createProgram([entryFileName], options, host);
  const sourceFile = program.getSourceFile(entryFileName);
  if (!sourceFile) {
    throw new Error("Expected source file in program.");
  }
  return { program, sourceFile };
}

function findArrowByVariableName(
  sourceFile: ts.SourceFile,
  variableName: string,
): ts.ArrowFunction {
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (callback) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      callback = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!callback) {
    throw new Error(`Expected arrow function variable '${variableName}'.`);
  }
  return callback;
}

function getPaths(
  summary: ReturnType<typeof analyzeFunctionCapabilities>,
  name: string,
): {
  capability: string;
  readPaths: string[];
  fullShapePaths: string[];
  writePaths: string[];
  wildcard: boolean;
  passthrough: boolean;
  identityOnly: boolean;
  identityPaths: string[];
  identityCellPaths: string[];
  opaquePaths: string[];
} {
  const param = summary.params.find((entry) => entry.name === name);
  if (!param) {
    throw new Error(`Missing parameter summary for '${name}'.`);
  }
  return {
    capability: param.capability,
    readPaths: param.readPaths.map((path) => path.join(".")),
    fullShapePaths: (param.fullShapePaths ?? []).map((path) => path.join(".")),
    writePaths: param.writePaths.map((path) => path.join(".")),
    wildcard: param.wildcard,
    passthrough: param.passthrough,
    identityOnly: !!param.identityOnly,
    identityPaths: (param.identityPaths ?? []).map((path) => path.join(".")),
    identityCellPaths: (param.identityCellPaths ?? []).map((path) =>
      path.join(".")
    ),
    opaquePaths: (param.opaquePaths ?? []).map((path) => path.join(".")),
  };
}

Deno.test("Capability analysis tracks alias assignment chains", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const alias = input;
      const user = alias.user;
      return user.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("user"));
  assert(input.readPaths.includes("user.name"));
});

Deno.test("TypeScript exposes accessor fields as property declarations", () => {
  const file = ts.createSourceFile(
    "/test.ts",
    `
function tracked(
  _value: undefined,
  _context: ClassAccessorDecoratorContext<Example, number>,
) {}

class Example {
  @tracked accessor count = 1;
}
`,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  let property: ts.PropertyDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (property) return;
    if (ts.isPropertyDeclaration(node)) {
      property = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  assert(property);
  assertEquals(property.name.getText(file), "count");
  assert(
    property.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.AccessorKeyword
    ),
  );
  assert(
    property.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.Decorator
    ),
  );
});

Deno.test("Capability analysis tracks object destructure aliases", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const { foo, bar: b, user: { name } } = input;
      return [foo, b, name].join("-");
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("foo"));
  assert(input.readPaths.includes("bar"));
  assert(input.readPaths.includes("user.name"));
});

Deno.test("Capability analysis does not descend into nested callbacks", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const local = () => input.hidden;
      return input.visible;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("visible"));
  assert(!input.readPaths.includes("hidden"));
});

Deno.test(
  "Capability analysis counts outer captures used inside inline array callbacks",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        filter(predicate: (value: T) => boolean): Array<T>;
        map<U>(mapper: (value: T) => U): Array<U>;
      }

      const fn = (input: {
        items: number[];
        threshold: number;
        factor: number;
      }) => input.items
        .filter((value) => value > input.threshold)
        .map((value) => value * input.factor);
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assert(input.readPaths.includes("items"));
    assert(input.readPaths.includes("threshold"));
    assert(input.readPaths.includes("factor"));
  },
);

Deno.test(
  "Capability analysis counts outer captures used inside other eager array callbacks",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        find(
          predicate: (value: T) => boolean,
        ): T | undefined;
        findIndex(
          predicate: (value: T) => boolean,
        ): number;
        reduce<U>(
          reducer: (accumulator: U, value: T) => U,
          initialValue: U,
        ): U;
      }

      const fn = (input: {
        names: string[];
        searchTerm: string;
        prices: number[];
        discount: number;
        items: { id: string }[];
        selectedId: string;
      }) => ({
        match: input.names.find((name) => name.includes(input.searchTerm)),
        total: input.prices.reduce(
          (sum, price) => sum + price * (1 - input.discount),
          0,
        ),
        index: input.items.findIndex((item) => item.id === input.selectedId),
      });
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assert(input.readPaths.includes("names"));
    assert(input.readPaths.includes("searchTerm"));
    assert(input.readPaths.includes("prices"));
    assert(input.readPaths.includes("discount"));
    assert(input.readPaths.includes("items"));
    assert(input.readPaths.includes("selectedId"));
  },
);

Deno.test(
  "Capability analysis keeps opaque helper callbacks out of outer summaries",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare function later(callback: () => void): void;

      const fn = (input: {
        visible: number;
        hidden: number;
      }) => {
        later(() => input.hidden);
        return input.visible;
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assert(input.readPaths.includes("visible"));
    assert(!input.readPaths.includes("hidden"));
  },
);

Deno.test(
  "Capability analysis keeps dotted literal keys distinct from nested member paths",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
      const direct = input["a.b"];
      const nested = input.a.b;
      return direct ?? nested;
    };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = summary.params.find((entry) => entry.name === "input");
    if (!input) {
      throw new Error("Missing parameter summary for 'input'.");
    }

    const readPathKeys = input.readPaths.map((path) => JSON.stringify(path));
    assert(readPathKeys.includes('["a.b"]'));
    assert(readPathKeys.includes('["a","b"]'));
  },
);

Deno.test("Capability analysis tracks reassignment aliases", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      let current = input;
      current = current.user;
      return current.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("user"));
  assert(input.readPaths.includes("user.name"));
});

Deno.test("Capability analysis tracks object assignment pattern aliases", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      let name;
      let alias;
      ({ user: { name }, profile: alias } = input);
      return name + alias.title;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("user.name"));
  assert(input.readPaths.includes("profile"));
  assert(input.readPaths.includes("profile.title"));
});

Deno.test("Capability analysis treats array assignment patterns as wildcard", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      let first;
      [first] = input.items;
      return first.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.wildcard, true);
});

Deno.test("Capability analysis reads the prefix above a dynamic alias key in full", () => {
  const fn = parseFirstCallback(
    `const fn = (input, key) => {
      const alias = input.offers;
      return alias[key];
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.wildcard, false);
  assertEquals(input.readPaths, ["offers"]);
  assertEquals(input.fullShapePaths, ["offers"]);
});

Deno.test(
  "Capability analysis: an unknown access does not erase non-overlapping identity paths",
  () => {
    // Closure captures share one synthetic root state, so an unknown access
    // (here a dynamic element access, a read of the prefix `items`) used to
    // blanket-erase the identity/comparable markings of UNRELATED captures —
    // degrading an equals()-only [SELF] capture to a full-value demand of the
    // piece's own result, which can never satisfy, so the consuming node
    // silently never ran (PR #4714). The unknown access must keep suppressing
    // identityOnly, but identity paths that no tracked value access overlaps
    // survive.
    const fn = parseFirstCallback(
      `const fn = (input, key) => {
        const { list, self } = input;
        const item = input.items[key];
        return equals(list, self) && item;
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.fullShapePaths.includes("items"));
    assertEquals(input.identityOnly, false);
    assert(input.identityPaths.includes("list"));
    assert(input.identityPaths.includes("self"));
    assertEquals(input.readPaths.includes("list"), false);
    assertEquals(input.readPaths.includes("self"), false);
  },
);

Deno.test(
  "Capability analysis: a root-scoped unknown access still erases element identity paths",
  () => {
    // The CT-1639 removal idiom: a dynamic element access through a
    // whole-root alias means the unknown access can value-read any element,
    // so element identity markings must not survive it — surviving markings
    // would degrade the elements' emitted schema to opaque comparable refs
    // and break value round-trips (caught by CI on the first, blanket
    // relaxation of this filter).
    const fn = parseFirstCallback(
      `const fn = (input, key) => {
        const cur = input;
        const target = cur[key];
        const idx = input.findIndex((el) => equals(target, el));
        return idx;
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.fullShapePaths.includes(""));
    assertEquals(input.identityPaths.length, 0);
  },
);

Deno.test(
  "Capability analysis: an unknown access still erases the root-length identity path",
  () => {
    // The whole-root comparison overlaps whatever the unknown access may
    // read, so it stays conservative: value semantics win at the root.
    const fn = parseFirstCallback(
      `const fn = (input, other, key) => {
        const item = input[key];
        const same = equals(input, other);
        return item && same;
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.fullShapePaths.includes(""));
    assertEquals(input.identityPaths.length, 0);
  },
);

Deno.test("Capability analysis tracks template literal and numeric key paths", () => {
  const fn = parseFirstCallback(
    "const fn = (input) => input.key(`profile`).key(0).get();",
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("profile.0"));
  assertEquals(input.wildcard, false);
});

Deno.test("Capability analysis tracks boolean wrapper conditions", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      for (; (input.ready as boolean)!; ) {
        break;
      }
      return input.done ? input.value : input.alt;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("ready"));
  assert(input.readPaths.includes("done"));
  assert(input.readPaths.includes("value"));
  assert(input.readPaths.includes("alt"));
});

Deno.test("Capability analysis marks object assignment spreads as wildcard", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      let value;
      ({ ["profile"]: value, ...rest } = input);
      return value.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("profile"));
  assert(input.readPaths.includes("profile.name"));
  assertEquals(input.wildcard, true);
});

Deno.test("Capability analysis treats elementById as a wildcard array read", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => input.elementById("k1").get();`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  // elementById addresses a separately derived entity, so the access is
  // attributed conservatively to the whole array root.
  assertEquals(input.wildcard, true);
});

Deno.test("Capability analysis does not record method names as read paths", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => input.get().foo;`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  // .get() is transparent — input.get().foo resolves to path ["foo"]
  assert(input.readPaths.includes("foo"));
  assert(!input.readPaths.includes("get"));
  assert(!input.readPaths.includes(""));
});

Deno.test("Capability analysis tracks destructured parameter paths", () => {
  const fn = parseFirstCallback(
    `const fn = (_, { input }) => input.key("foo").get();`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const params = getPaths(summary, "__param1");

  assertEquals(params.capability, "readonly");
  assert(params.readPaths.includes("input.foo"));
  assertEquals(params.wildcard, false);
});

Deno.test("Capability analysis classifies write-only usage", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      input.key("count").set(1);
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "writeonly");
  assert(input.writePaths.includes("count"));
  assertEquals(input.readPaths.length, 0);
});

Deno.test("Capability analysis classifies read+write usage as writable", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      input.key("count").set(input.key("count").get() + 1);
      return input.key("count").get();
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "writable");
  assert(input.readPaths.includes("count"));
  assert(input.writePaths.includes("count"));
});

Deno.test("Capability analysis classifies update-only usage as writeonly", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      input.key("profile").update({ name: "Ada" });
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "writeonly");
  assert(input.writePaths.includes("profile"));
  assertEquals(input.readPaths.length, 0);
});

Deno.test("Capability analysis classifies push-only usage as writeonly", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      input.key("items").push({ id: "1" });
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "writeonly");
  assert(input.writePaths.includes("items"));
  assertEquals(input.readPaths.length, 0);
});

Deno.test("Capability analysis reads the whole list passed to pushAll", () => {
  // `xs === input.prev` makes `other` identity-compared, so an element pushed
  // by `push(xs)` stays an identity use; `pushAll(xs)` stores every element of
  // the list, so the list is read in full.
  const analyze = (write: string) =>
    getPaths(
      analyzeFunctionCapabilities(parseFirstCallback(
        `const fn = (input) => {
          const xs = input.other;
          if (xs === input.prev) return;
          input.key("items").${write};
        };`,
      )),
      "input",
    );

  const pushAll = analyze("pushAll(xs)");
  assert(pushAll.writePaths.includes("items"));
  assert(pushAll.fullShapePaths.includes("other"));

  const push = analyze("push(xs)");
  assert(push.writePaths.includes("items"));
  assert(!push.fullShapePaths.includes("other"));
});

Deno.test("Capability analysis classifies removeAll-only usage as writeonly", () => {
  const fn = parseFirstCallback(
    `const fn = (input, item) => {
      input.key("items").removeAll(item);
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "writeonly");
  assert(input.writePaths.includes("items"));
  assertEquals(input.readPaths.length, 0);
});

Deno.test("Capability analysis keeps opaque derivation methods opaque", () => {
  const fn = parseFirstCallback(
    `const fn = (input, mapper) => {
      input.map(mapper);
      input.flatMap(mapper);
      input.filter(mapper);
      input.mapWithPattern(mapper, {});
      input.flatMapWithPattern(mapper, {});
      input.filterWithPattern(mapper, {});
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "opaque");
  assertEquals(input.readPaths.length, 0);
  assertEquals(input.writePaths.length, 0);
  assertEquals(input.wildcard, false);
});

Deno.test(
  "Capability analysis records nested opaque derivation methods without reads",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
        return input.items.map((item) => item.name);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.readPaths.length, 0);
    assertEquals(input.writePaths.length, 0);
    assert(input.opaquePaths.includes("items"));
    assertEquals(input.wildcard, false);
  },
);

Deno.test(
  "Capability analysis treats dynamic opaque derivation receivers as wildcard",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input, key) => {
        return input.collections[key].map((item) => item.name);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.wildcard, true);
    assertEquals(input.opaquePaths.length, 0);
  },
);

Deno.test(
  "Capability analysis keeps root derivation plus equality usage opaque",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input, mapper, other) => {
        input.map(mapper);
        return input.equals(other);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.readPaths.length, 0);
    assertEquals(input.writePaths.length, 0);
    assertEquals(input.wildcard, false);
  },
);

Deno.test("Capability analysis classifies pure passthrough as opaque", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const alias = input;
      return alias;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "opaque");
  assertEquals(input.readPaths.length, 0);
  assertEquals(input.writePaths.length, 0);
  assertEquals(input.passthrough, true);
  assertEquals(input.identityOnly, false);
});

Deno.test("Capability analysis marks root call arguments as wildcard", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      consume(input);
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "opaque");
  assertEquals(input.passthrough, true);
  assertEquals(input.wildcard, true);
  assertEquals(input.readPaths.length, 0);
  assertEquals(input.writePaths.length, 0);
});

Deno.test(
  "Capability analysis treats new-expression root arguments as passthrough",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
        return new Wrapper(input);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths.length, 0);
    assertEquals(input.writePaths.length, 0);
  },
);

Deno.test(
  "Capability analysis interprocedural propagation tracks callee reads in compute mode",
  () => {
    const source = `const helper = (value) => value.foo;
const fn = (input) => helper(input);`;
    const { program, sourceFile } = createProgramWithSource(source);
    const checker = program.getTypeChecker();
    const fn = findArrowByVariableName(sourceFile, "fn");

    const summary = analyzeFunctionCapabilities(fn, {
      checker,
      interprocedural: true,
    });
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("foo"));
  },
);

Deno.test(
  "Capability analysis interprocedural propagation tracks root opaque use",
  () => {
    const source = `import { type Cell } from "commonfabric";
const helper = (value: Cell<string[]>, mapper: (value: string) => string) => value.map(mapper);
const fn = (input: Cell<string[]>, other: Cell<string[]>, mapper: (value: string) => string) => {
  helper(input, mapper);
  return input.equals(other);
};`;
    const { program, sourceFile } = createProgramWithFiles({
      "/test.ts": source,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const checker = program.getTypeChecker();
    const fn = findArrowByVariableName(sourceFile, "fn");

    const summary = analyzeFunctionCapabilities(fn, {
      checker,
      interprocedural: true,
    });
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.readPaths.length, 0);
    assertEquals(input.writePaths.length, 0);
    assertEquals(input.wildcard, false);
    assertEquals(input.identityOnly, false);
  },
);

Deno.test(
  "Capability analysis without interprocedural propagation keeps conservative wildcard",
  () => {
    const source = `const helper = (value) => value.foo;
const fn = (input) => helper(input);`;
    const { sourceFile } = createProgramWithSource(source);
    const fn = findArrowByVariableName(sourceFile, "fn");

    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, true);
    assertEquals(input.readPaths.length, 0);
  },
);

Deno.test(
  "Capability analysis records write intent from imported Writable parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function createClient(auth: Writable<Auth>): void;
      `,
      "/test.ts": `
        import { createClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          createClient(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "writable");
    assert(state.readPaths.includes("auth"));
    assert(state.writePaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis records write intent for a nullable imported Writable parameter",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function createClient(auth: Writable<Auth> | null): void;
      `,
      "/test.ts": `
        import { createClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          createClient(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "writable");
    assert(state.writePaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis records write intent for a null-and-undefined imported Writable parameter",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function createClient(
          auth: Writable<Auth> | null | undefined,
        ): void;
      `,
      "/test.ts": `
        import { createClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          createClient(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "writable");
    assert(state.writePaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis records write intent from imported WriteonlyCell parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { WriteonlyCell } from "commonfabric";

        export type Auth = { token: string };
        export function createClient(auth: WriteonlyCell<Auth>): void;
      `,
      "/test.ts": `
        import { createClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          createClient(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assert(state.writePaths.includes("auth"));
    // A write-only parameter records only a write; the passing-read is
    // suppressed, so the destructured argument stays write-only.
    assertEquals(state.readPaths.includes("auth"), false);
  },
);

Deno.test(
  "Capability analysis keeps a member-access WriteonlyCell argument write-only",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { WriteonlyCell } from "commonfabric";

        export type Auth = { token: string };
        export function persist(auth: WriteonlyCell<Auth>): void;
      `,
      "/test.ts": `
        import { persist, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          state: { auth: Writable<Auth> },
        ) => {
          persist(state.auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "state");

    // A member-access argument (state.auth) must be treated the same as a
    // destructured one: the write-only parameter records only a write.
    assert(state.writePaths.includes("auth"));
    assertEquals(state.readPaths.includes("auth"), false);
  },
);

Deno.test(
  "Capability analysis does not record write intent from imported Cell parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Cell } from "commonfabric";

        export type Auth = { token: string };
        export function createClient(auth: Cell<Auth>): void;
      `,
      "/test.ts": `
        import { createClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          createClient(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "readonly");
    assert(state.readPaths.includes("auth"));
    assertEquals(state.writePaths.includes("auth"), false);
  },
);

Deno.test(
  "Capability analysis ignores imported Writable type names from other libraries",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        export type Auth = { token: string };
        export type Writable<T> = any;
        export function createClient(auth: Writable<Auth>): void;
      `,
      "/test.ts": `
        import { createClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          createClient(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "readonly");
    assert(state.readPaths.includes("auth"));
    assertEquals(state.writePaths.includes("auth"), false);
  },
);

Deno.test(
  "Capability analysis selects the Writable overload for imported clients",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export interface AuthCell {
          get(): Auth | undefined;
          update(values: { token?: string }): void;
        }
        export interface ClientFactory {
          (auth: Writable<Auth>): void;
          (auth: AuthCell): void;
        }
        export const createClient: ClientFactory;
      `,
      "/test.ts": `
        import { createClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          createClient(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "writable");
    assert(state.writePaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis records write intent from imported Writable constructors",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export class Client {
          constructor(auth: Writable<Auth>);
        }
      `,
      "/test.ts": `
        import { Client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          new Client(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "writable");
    assert(state.writePaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis does not record write intent from imported Cell constructors",
  () => {
    // A constructor whose auth parameter is declared bare `Cell<Auth>` does not
    // grant write authority. Write intent must be spelled `Writable<Auth>`; a
    // client that writes the cell (such as a token refresh) must declare it that
    // way rather than rely on the neutral `Cell<Auth>` alias.
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Cell } from "commonfabric";

        export type Auth = { token: string };
        export class Client {
          constructor(auth: Cell<Auth>);
        }
      `,
      "/test.ts": `
        import { Client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          new Client(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "readonly");
    assertEquals(state.writePaths.includes("auth"), false);
  },
);

Deno.test(
  "Capability analysis does not record write intent for unmatched extra arguments",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function createClient(auth: Writable<Auth>): void;
      `,
      "/test.ts": `
        import { createClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          createClient("ignored", auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.writePaths.includes("auth"), false);
  },
);

Deno.test(
  "Capability analysis reads a generic constraint to classify an imported parameter",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function persist<C extends Writable<Auth>>(auth: C): void;
      `,
      "/test.ts": `
        import { persist, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          persist(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    // A bounded generic parameter carries the capability of its constraint.
    assertEquals(state.capability, "writable");
    assert(state.writePaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis reads a ReadonlyCell generic constraint as readonly",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { ReadonlyCell } from "commonfabric";

        export type Auth = { token: string };
        export function readAll<C extends ReadonlyCell<Auth>>(auth: C): void;
      `,
      "/test.ts": `
        import { readAll, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          readAll(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "readonly");
    assertEquals(state.writePaths.includes("auth"), false);
  },
);

Deno.test(
  "Capability analysis records write intent for imported Writable rest parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function writeAll(...auths: Writable<Auth>[]): void;
      `,
      "/test.ts": `
        import { writeAll, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          writeAll(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "writable");
    assert(state.writePaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis records write intent for imported Array rest parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function writeAll(...auths: Array<Writable<Auth>>): void;
      `,
      "/test.ts": `
        import { writeAll, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          writeAll(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "writable");
    assert(state.writePaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis records write intent for imported readonly-array rest parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function writeAll(...auths: readonly Writable<Auth>[]): void;
      `,
      "/test.ts": `
        import { writeAll, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          writeAll(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.capability, "writable");
    assert(state.writePaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis does not map array spreads to imported fixed parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function createClient(
          first: Writable<Auth>,
          second: Writable<Auth>,
          third: Writable<Auth>,
        ): void;
      `,
      "/test.ts": `
        import { createClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          {
            first,
            rest,
            later,
          }: {
            first: Writable<Auth>;
            rest: Writable<Auth>[];
            later: Writable<Auth>;
          },
        ) => {
          createClient(first, ...rest, later);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assert(state.writePaths.includes("first"));
    assertEquals(state.writePaths.includes("rest.0"), false);
    assertEquals(state.writePaths.includes("later"), false);
  },
);

Deno.test(
  "Capability analysis maps spread calls to imported Writable rest parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function writeAll(
          first: Writable<Auth>,
          ...rest: Writable<Auth>[]
        ): void;
      `,
      "/test.ts": `
        import { writeAll, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          {
            first,
            rest,
            later,
          }: {
            first: Writable<Auth>;
            rest: Writable<Auth>[];
            later: Writable<Auth>;
          },
        ) => {
          writeAll(first, ...rest, later);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assert(state.writePaths.includes("first"));
    assert(state.writePaths.includes("rest.0"));
    assert(state.writePaths.includes("later"));
  },
);

Deno.test(
  "Capability analysis expands a fixed tuple spread into imported fixed parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function client(
          a: Writable<Auth>,
          b: Writable<Auth>,
        ): void;
      `,
      "/test.ts": `
        import { client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { pair }: { pair: [Writable<Auth>, Writable<Auth>] },
        ) => {
          client(...pair);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assert(state.writePaths.includes("pair.0"));
    assert(state.writePaths.includes("pair.1"));
  },
);

Deno.test(
  "Capability analysis maps each fixed tuple spread element to its own parameter capability",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { ReadonlyCell, Writable } from "commonfabric";

        export type Auth = { token: string };
        export function client(
          a: Writable<Auth>,
          b: ReadonlyCell<Auth>,
        ): void;
      `,
      "/test.ts": `
        import { client, type Auth } from "client";
        import type { ReadonlyCell, Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { pair }: { pair: [Writable<Auth>, ReadonlyCell<Auth>] },
        ) => {
          client(...pair);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    // Element 0 flows to a Writable parameter (read and write); element 1 flows
    // to a ReadonlyCell parameter (read only, no write).
    assert(state.writePaths.includes("pair.0"));
    assertEquals(state.writePaths.includes("pair.1"), false);
    assert(state.readPaths.includes("pair.1"));
  },
);

Deno.test(
  "Capability analysis does not expand a variable-length array spread into imported fixed parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function client(
          a: Writable<Auth>,
          b: Writable<Auth>,
        ): void;
      `,
      "/test.ts": `
        import { client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { pair }: { pair: Writable<Auth>[] },
        ) => {
          client(...pair);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assertEquals(state.writePaths.includes("pair.0"), false);
    assertEquals(state.writePaths.includes("pair.1"), false);
  },
);

Deno.test(
  "Capability analysis keeps a tuple spread with a non-cell position conservatively read",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function client(
          a: Writable<Auth>,
          b: number,
        ): void;
      `,
      "/test.ts": `
        import { client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { pair }: { pair: [Writable<Auth>, number] },
        ) => {
          client(...pair);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    // Element 0 maps to a Writable parameter, so its write is recorded. Element
    // 1 is a plain value with no cell contract, so the spread source is not
    // suppressed and its ordinary read is tracked conservatively.
    assert(state.writePaths.includes("pair.0"));
    assert(state.readPaths.includes("pair"));
  },
);

Deno.test(
  "Capability analysis maps a leading fixed argument before a fixed tuple spread",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function client(
          first: Writable<Auth>,
          a: Writable<Auth>,
          b: Writable<Auth>,
        ): void;
      `,
      "/test.ts": `
        import { client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          {
            first,
            pair,
          }: {
            first: Writable<Auth>;
            pair: [Writable<Auth>, Writable<Auth>];
          },
        ) => {
          client(first, ...pair);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    assert(state.writePaths.includes("first"));
    assert(state.writePaths.includes("pair.0"));
    assert(state.writePaths.includes("pair.1"));
  },
);

Deno.test(
  "Capability analysis advances past a single-element tuple spread to a trailing argument",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function client(
          a: Writable<Auth>,
          b: Writable<Auth>,
        ): void;
      `,
      "/test.ts": `
        import { client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          {
            single,
            tail,
          }: {
            single: [Writable<Auth>];
            tail: Writable<Auth>;
          },
        ) => {
          client(...single, tail);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    // The single tuple element fills parameter 0, so the trailing argument must
    // map to parameter 1 rather than colliding on parameter 0.
    assert(state.writePaths.includes("single.0"));
    assert(state.writePaths.includes("tail"));
  },
);

Deno.test(
  "Capability analysis stays conservative for a variadic tuple spread into fixed parameters",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function client(
          a: Writable<Auth>,
          b: Writable<Auth>,
        ): void;
      `,
      "/test.ts": `
        import { client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { variadic }: { variadic: [Writable<Auth>, ...Writable<Auth>[]] },
        ) => {
          client(...variadic);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    // A tuple with a rest element has no statically fixed length, so signature
    // mapping stops and the positions are not written.
    assertEquals(state.writePaths.includes("variadic.0"), false);
    assertEquals(state.writePaths.includes("variadic.1"), false);
  },
);

Deno.test(
  "Capability analysis wildcards a dynamically indexed fixed tuple spread",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export function client(
          a: Writable<Auth>,
          b: Writable<Auth>,
        ): void;
      `,
      "/test.ts": `
        import { client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          {
            bag,
            k,
          }: {
            bag: { [key: string]: [Writable<Auth>, Writable<Auth>] };
            k: string;
          },
        ) => {
          const local = bag;
          client(...local[k]);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    // The tuple is fixed-length, but the spread source is reached through a
    // dynamic index, so the whole root is wildcarded rather than mapped to
    // specific positions.
    assert(state.wildcard);
  },
);

Deno.test(
  "Capability analysis maps writeonly, comparable, and opaque fixed tuple positions",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type {
          ComparableCell,
          OpaqueCell,
          WriteonlyCell,
        } from "commonfabric";

        export type Auth = { token: string };
        export function client(
          a: WriteonlyCell<Auth>,
          b: ComparableCell<Auth>,
          c: OpaqueCell<Auth>,
        ): void;
      `,
      "/test.ts": `
        import { client, type Auth } from "client";
        import type {
          ComparableCell,
          OpaqueCell,
          WriteonlyCell,
        } from "commonfabric";

        const fn = (
          _event: unknown,
          {
            triple,
          }: {
            triple: [
              WriteonlyCell<Auth>,
              ComparableCell<Auth>,
              OpaqueCell<Auth>,
            ];
          },
        ) => {
          client(...triple);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    // Element 0 is write-only (write, no passing read), element 1 is a
    // comparable cell (identity-cell path), element 2 is opaque.
    assert(state.writePaths.includes("triple.0"));
    assertEquals(state.readPaths.includes("triple.0"), false);
    assert(state.identityCellPaths.includes("triple.1"));
    assert(state.opaquePaths.includes("triple.2"));
  },
);

Deno.test(
  "Capability analysis records nothing for a parenthesis-free imported construction",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { Writable } from "commonfabric";

        export type Auth = { token: string };
        export declare class Client {
          constructor(auth: Writable<Auth>);
        }
      `,
      "/test.ts": `
        import { Client, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (
          _event: unknown,
          { auth }: { auth: Writable<Auth> },
        ) => {
          new Client;
          return auth;
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "__param1");

    // A construction written without an argument list has no arguments to map,
    // so the constructor's declared cell contract records no write for the
    // separately-read cell.
    assertEquals(state.writePaths.includes("auth"), false);
    assert(state.readPaths.includes("auth"));
  },
);

Deno.test(
  "Capability analysis shrinks a root cell to readonly for a ReadonlyCell parameter",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/client.d.ts": `
        import type { ReadonlyCell } from "commonfabric";

        export type Auth = { token: string };
        export function readClient(auth: ReadonlyCell<Auth>): void;
      `,
      "/test.ts": `
        import { readClient, type Auth } from "client";
        import type { Writable } from "commonfabric";

        const fn = (auth: Writable<Auth>) => {
          readClient(auth);
        };
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "auth");

    // The declared read-only contract accounts for this argument, so the
    // whole-cell root fallback does not also grant write. Passing a cell to a
    // declared reader demonstrates only read need, and the handler is not given
    // write authority it never uses. In well-typed code a `Writable<Auth>` value
    // cannot be passed to a `ReadonlyCell<Auth>` parameter (distinct brands,
    // TS2345), so this shape is reached through a `ReadonlyCell`-typed input or
    // an explicit cast; the snippet exercises the parameter-type mapping the
    // analysis applies at that call.
    assertEquals(state.capability, "readonly");
    assertEquals(state.writePaths.includes(""), false);
    assertEquals(state.wildcard, false);
  },
);

Deno.test("Capability analysis marks for...in over tracked source as wildcard", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      for (const key in input) {
        console.log(key);
      }
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.wildcard, true);
});

Deno.test(
  "Capability analysis keeps bare for...of element uses path-specific",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
      for (const item of input) {
        console.log(item);
      }
    };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("0"));
  },
);

Deno.test(
  "Capability analysis keeps ?? fallback aliases path-specific through for...of item reads",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
        const items = input.items ?? [];
        for (const item of items) {
          item.notes?.length;
        }
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("items"));
    assert(input.readPaths.includes("items.0.notes.length"));
  },
);

Deno.test(
  "Capability analysis follows right-hand ?? fallback aliases through for...of item reads",
  () => {
    const fn = parseFirstCallback(
      `const cached = undefined;
      const fn = (input) => {
        const items = cached ?? input.notes;
        for (const item of items) {
          item.title;
        }
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("notes"));
    assert(input.readPaths.includes("notes.0.title"));
  },
);

Deno.test(
  "Capability analysis binds plain array callback items back to source element paths",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        map<U>(mapper: (value: T) => U): Array<U>;
      }

      type Route = { id: string; label: string; capacity: number; unused: string };

      const fn = (input: { routes: Route[] }) =>
        input.routes.map((route) => ({
          route: route.id,
          label: route.label,
          capacity: route.capacity,
        }));
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("routes"));
    assert(input.readPaths.includes("routes.0.id"));
    assert(input.readPaths.includes("routes.0.label"));
    assert(input.readPaths.includes("routes.0.capacity"));
    assertEquals(input.readPaths.includes("routes.0.unused"), false);
  },
);

Deno.test(
  "Capability analysis follows tracked values through local Map set/get",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        forEach(callback: (value: T) => void): void;
      }

      type Component = { id: string; name: string; props: string[]; unused: string };

      const fn = (input: { components: Component[]; ids: string[] }) => {
        const componentMap = new Map<string, Component>();
        input.components.forEach((component) => componentMap.set(component.id, component));
        return input.ids.map((id) => componentMap.get(id)?.name ?? id);
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("components"));
    assert(input.readPaths.includes("components.0.id"));
    assert(input.readPaths.includes("components.0.name"));
    assert(input.readPaths.includes("ids"));
    assert(input.readPaths.includes("ids.0"));
    assertEquals(input.readPaths.includes("components.0.unused"), false);
  },
);

Deno.test(
  "Capability analysis follows tracked values stored in local arrays through sort callbacks",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        push(...items: T[]): number;
        sort(compareFn?: (a: T, b: T) => number): T[];
      }

      type Candidate = { id: string; age: number; site: string; unused: string };
      type Result = { candidate: Candidate; eligible: boolean };

      const fn = (input: { candidates: Candidate[] }) => {
        const results: Result[] = [];
        for (const candidate of input.candidates) {
          results.push({ candidate, eligible: candidate.age >= 18 });
        }
        results.sort((left, right) =>
          left.candidate.id.localeCompare(right.candidate.id)
        );
        return results.length;
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("candidates"));
    assert(input.readPaths.includes("candidates.0.age"));
    assert(input.readPaths.includes("candidates.0.id"));
    assertEquals(input.readPaths.includes("candidates.0.unused"), false);
  },
);

Deno.test(
  "Capability analysis does not treat non-cell set calls as identity array sinks",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      class Map<K, V> {
        set(key: K, value: V): this;
      }

      type Piece = { title: string; unused: string };

      const fn = (input: { piece: Piece }) => {
        const piece = input.piece;
        const updated = [piece];
        const cache = new Map<string, Piece[]>();
        cache.set("items", updated);
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.identityPaths.includes("piece"), false);
    assert(input.readPaths.includes("piece"));
  },
);

Deno.test(
  "Capability analysis keeps array locals structural when methods inspect items before set",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const state: {
        items: {
          set(value: unknown): void;
        };
      };

      type Piece = { title: string; unused: string };

      const fn = (input: { piece: Piece }) => {
        const updated = [input.piece];
        if (updated.length > 0) {
          state.items.set(updated);
        }
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.identityPaths.includes("piece"), false);
    assert(input.readPaths.includes("piece"));
    assertEquals(input.readPaths.includes("piece.unused"), false);
  },
);

Deno.test(
  "Capability analysis keeps array-literal map chains structural before set",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const CELL_BRAND: unique symbol;

      type Cell<T> = {
        readonly [CELL_BRAND]: "cell";
        set(value: T): void;
      };

      interface Array<T> {
        map<U>(mapper: (value: T) => U): U[];
      }

      declare const state: { items: Cell<{ title: string }[]> };

      type Piece = { title: string; unused: string };

      const fn = (input: { piece?: Piece }) => {
        const piece = input?.piece;
        if (!piece) return;
        const updated = [piece].map((p) => ({ title: p.title }));
        state.items.set(updated);
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.identityPaths.includes("piece"), false);
    assert(
      input.readPaths.includes("piece") ||
        input.readPaths.includes("piece.title"),
    );
  },
);

Deno.test(
  "Capability analysis treats direct local array set payloads as identity-only",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const CELL_BRAND: unique symbol;

      type Cell<T> = {
        readonly [CELL_BRAND]: "cell";
        set(value: T): void;
      };

      declare const state: { items: Cell<Piece[]> };

      type Piece = { title: string; unused: string };

      const fn = (input: { piece?: Piece }) => {
        const piece = input?.piece;
        if (!piece) return;
        const updated = [piece];
        state.items.set(updated);
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assert(input.identityPaths.includes("piece"));
    assert(input.identityCellPaths.includes("piece"));
    assertEquals(input.readPaths.includes("piece"), false);
  },
);

Deno.test(
  "Capability analysis treats local array push, unshift, and splice payloads as identity-only",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const CELL_BRAND: unique symbol;

      type Cell<T> = {
        readonly [CELL_BRAND]: "cell";
        set(value: T): void;
      };

      interface Array<T> {
        push(...items: T[]): number;
        unshift(...items: T[]): number;
        splice(start: number, deleteCount: number, ...items: T[]): T[];
      }

      declare const state: { items: Cell<Piece[]> };

      type Piece = { title: string; unused: string };

      const fn = (input: { first?: Piece; second?: Piece; third?: Piece }) => {
        const first = input?.first;
        const second = input?.second;
        const third = input?.third;
        if (!first) return;
        if (!second) return;
        if (!third) return;
        const updated: Piece[] = [];
        updated.push(first);
        updated.unshift(second);
        updated.splice(1, 0, third);
        state.items.set(updated);
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assert(input.identityPaths.includes("first"));
    assert(input.identityPaths.includes("second"));
    assert(input.identityPaths.includes("third"));
    assert(input.identityCellPaths.includes("first"));
    assert(input.identityCellPaths.includes("second"));
    assert(input.identityCellPaths.includes("third"));
    assertEquals(input.readPaths.includes("first"), false);
    assertEquals(input.readPaths.includes("second"), false);
    assertEquals(input.readPaths.includes("third"), false);
  },
);

Deno.test(
  "Capability analysis keeps splice control arguments structural",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const CELL_BRAND: unique symbol;

      type Cell<T> = {
        readonly [CELL_BRAND]: "cell";
        set(value: T): void;
      };

      interface Array<T> {
        splice(start: number, deleteCount: number, ...items: T[]): T[];
      }

      declare const state: { items: Cell<Piece[]> };

      type Piece = { title: string; unused: string };

      const fn = (
        input: { piece?: Piece; index: number; deleteCount: number },
      ) => {
        const piece = input?.piece;
        if (!piece) return;
        const updated: Piece[] = [];
        updated.splice(input.index, input.deleteCount, piece);
        state.items.set(updated);
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assert(input.identityPaths.includes("piece"));
    assert(input.identityCellPaths.includes("piece"));
    assert(input.readPaths.includes("index"));
    assert(input.readPaths.includes("deleteCount"));
    assertEquals(input.readPaths.includes("piece"), false);
  },
);

Deno.test(
  "Capability analysis keeps primitive local array writer payloads structural",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const CELL_BRAND: unique symbol;

      type Cell<T> = {
        readonly [CELL_BRAND]: "cell";
        set(value: T): void;
      };

      interface Array<T> {
        push(...items: T[]): number;
      }

      declare const state: { items: Cell<string[]> };

      type Piece = { title: string; unused: string };

      const fn = (input: { piece: Piece }) => {
        const updated: string[] = [];
        updated.push(input.piece.title);
        state.items.set(updated);
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.identityPaths.includes("piece.title"), false);
    assert(input.readPaths.includes("piece.title"));
    assertEquals(input.readPaths.includes("piece.unused"), false);
  },
);

Deno.test(
  "Capability analysis restores local array bindings after nested callbacks",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        push(...items: T[]): number;
        sort(compareFn?: (a: T, b: T) => number): T[];
        map<U>(mapper: (value: T) => U): U[];
      }

      type Candidate = { id: string; name: string; unused: string };

      const fn = (input: { candidates: Candidate[]; other: Candidate[] }) => {
        const results: Candidate[] = [];
        for (const candidate of input.candidates) {
          results.push(candidate);
        }
        input.other.map((candidate) => {
          const results: Candidate[] = [];
          results.push(candidate);
          return candidate.id;
        });
        results.sort((left, right) => left.name.localeCompare(right.name));
        return results.length;
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("candidates"));
    assert(input.readPaths.includes("candidates.0"));
    assert(input.readPaths.includes("candidates.0.name"));
    assert(input.readPaths.includes("other"));
    assert(input.readPaths.includes("other.0.id"));
    assertEquals(input.readPaths.includes("other.0.name"), false);
  },
);

Deno.test(
  "Capability analysis restores local array bindings after block shadowing",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        push(...items: T[]): number;
        sort(compareFn?: (a: T, b: T) => number): T[];
      }

      type Candidate = { id: string; name: string; unused: string };

      const fn = (input: { candidates: Candidate[]; other: Candidate[] }) => {
        const results: Candidate[] = [];
        for (const candidate of input.candidates) {
          results.push(candidate);
        }
        if (input.other.length > 0) {
          const results: Candidate[] = [];
          for (const candidate of input.other) {
            results.push(candidate);
          }
        }
        results.sort((left, right) => left.name.localeCompare(right.name));
        return results.length;
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("candidates"));
    assert(input.readPaths.includes("candidates.0"));
    assert(input.readPaths.includes("candidates.0.name"));
    assert(input.readPaths.includes("other"));
    assert(input.readPaths.includes("other.length"));
    assert(input.readPaths.includes("other.0"));
    assertEquals(input.readPaths.includes("other.0.name"), false);
  },
);

Deno.test(
  "Capability analysis restores local map bindings after block shadowing",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      type Candidate = { id: string; name: string; unused: string };

      const fn = (input: { candidates: Candidate[]; other: Candidate[] }) => {
        const lookup = new Map<string, Candidate>();
        for (const candidate of input.candidates) {
          lookup.set("outer", candidate);
        }
        if (input.other.length > 0) {
          const lookup = new Map<string, Candidate>();
          for (const candidate of input.other) {
            lookup.set("inner", candidate);
          }
        }
        return lookup.get("outer")?.name;
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("candidates"));
    assert(input.readPaths.includes("candidates.0"));
    assert(input.readPaths.includes("candidates.0.name"));
    assert(input.readPaths.includes("other"));
    assert(input.readPaths.includes("other.length"));
    assert(input.readPaths.includes("other.0"));
    assertEquals(input.readPaths.includes("other.0.name"), false);
  },
);

Deno.test(
  "Capability analysis keeps element bindings through filter-to-map chains",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        filter(predicate: (value: T) => boolean): Array<T>;
        map<U>(mapper: (value: T) => U): Array<U>;
      }

      type ScreeningResult = {
        candidate: { id: string; site: string; unused: string };
        eligible: boolean;
      };

      const fn = (input: { report: ScreeningResult[] }) =>
        input.report
          .filter((entry) => entry.eligible)
          .map((entry) => entry.candidate.id);
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("report"));
    assert(input.readPaths.includes("report.0.eligible"));
    assert(input.readPaths.includes("report.0.candidate.id"));
    assertEquals(input.readPaths.includes("report.0.candidate.unused"), false);
  },
);

Deno.test(
  "Capability analysis tracks properties read from find() result aliases",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        find(predicate: (value: T) => boolean): T | undefined;
      }

      type IncidentStep = {
        id: string;
        title: string;
        owner: string;
        status: "pending" | "in_progress";
        expectedMinutes: number;
        elapsedMinutes: number;
      };

      const fn = (input: { list: IncidentStep[]; active: string | null }) => {
        const target = input.list.find((step) => step.id === input.active);
        return target ? target.title : "idle";
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("list"));
    assert(input.readPaths.includes("list.0.id"));
    assert(input.readPaths.includes("list.0.title"));
    assert(input.readPaths.includes("active"));
  },
);

Deno.test(
  "Capability analysis tracks direct properties read from find() results",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        find(predicate: (value: T) => boolean): T | undefined;
      }

      type ParkingPerson = {
        name: string;
        priorityRank: number;
        defaultSpot: string;
      };

      const fn = (input: { people: ParkingPerson[] }) =>
        input.people.find((person) => person.name === "Alice")?.priorityRank === 1;
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("people"));
    assert(input.readPaths.includes("people.0.name"));
    assert(input.readPaths.includes("people.0.priorityRank"));
    assertEquals(input.readPaths.includes("people.0.defaultSpot"), false);
  },
);

Deno.test(
  "Capability analysis conservatively widens chained unknown array methods",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        filter(predicate: (value: T) => boolean): T[];
        slice(start?: number): T[];
        find(predicate: (value: T) => boolean): T | undefined;
      }

      type ParkingPerson = {
        name: string;
        priorityRank: number;
        defaultSpot: string;
        active: boolean;
      };

      const fn = (input: { people: ParkingPerson[] }) =>
        input.people.filter((person) => person.active).slice(0).find((person) => person.name === "Alice")?.priorityRank === 1;
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("people"));
    assert(input.readPaths.includes("people.0.active"));
  },
);

Deno.test(
  "Capability analysis tracks chained || fallback reads on both branches",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      const fn = (state: { name: string; firstItem: string | undefined }) =>
        state.name || state.firstItem || "default";
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const state = getPaths(summary, "state");

    assertEquals(state.wildcard, false);
    assert(state.readPaths.includes("name"));
    assert(state.readPaths.includes("firstItem"));
  },
);

Deno.test(
  "Capability analysis keeps array item properties named key",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        filter(predicate: (value: T) => boolean): Array<T>;
        map<U>(mapper: (value: T) => U): Array<U>;
      }

      type ColumnSummary = {
        key: "backlog" | "inProgress" | "review" | "done";
        overloaded: boolean;
        title: string;
      };

      const fn = (summaries: ColumnSummary[]) =>
        summaries
          .filter((summary) => summary.overloaded)
          .map((summary) => summary.key);
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const summaries = getPaths(summary, "summaries");

    assertEquals(summaries.wildcard, false);
    assert(summaries.readPaths.includes("0.overloaded"));
    assert(summaries.readPaths.includes("0.key"));
  },
);

Deno.test(
  "Capability analysis treats equals() arguments as identity-only",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input, other) => {
        return equals(input, other);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");
    const other = getPaths(summary, "other");

    assertEquals(input.capability, "comparable");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, false);
    assertEquals(input.identityOnly, true);
    assertEquals(input.readPaths.length, 0);

    assertEquals(other.capability, "comparable");
    assertEquals(other.passthrough, true);
    assertEquals(other.wildcard, false);
    assertEquals(other.identityOnly, true);
    assertEquals(other.readPaths.length, 0);
  },
);

Deno.test(
  "Capability analysis treats .equals() receiver and argument as identity-only",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input, other) => {
        return input.equals(other);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");
    const other = getPaths(summary, "other");

    assertEquals(input.capability, "comparable");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, false);
    assertEquals(input.identityOnly, true);
    assertEquals(input.readPaths.length, 0);

    assertEquals(other.capability, "comparable");
    assertEquals(other.passthrough, true);
    assertEquals(other.wildcard, false);
    assertEquals(other.identityOnly, true);
    assertEquals(other.readPaths.length, 0);
  },
);

Deno.test(
  "Capability analysis treats .equalLinks() receiver and argument as comparable",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input, other) => {
        return input.equalLinks(other);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");
    const other = getPaths(summary, "other");

    assertEquals(input.capability, "comparable");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, false);
    assertEquals(input.identityOnly, true);
    assertEquals(input.readPaths.length, 0);

    assertEquals(other.capability, "comparable");
    assertEquals(other.passthrough, true);
    assertEquals(other.wildcard, false);
    assertEquals(other.identityOnly, true);
    assertEquals(other.readPaths.length, 0);
  },
);

Deno.test(
  "Capability analysis marks destructured cell equals paths as identity-cell paths",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const CELL_BRAND: unique symbol;

      type Writable<T> = {
        readonly [CELL_BRAND]: "cell";
        equals(other: Writable<T>): boolean;
      };

      const fn = ({ left, right }: {
        left: Writable<{ name: string }>;
        right: Writable<{ name: string }>;
      }) => left.equals(right);
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "__param0");

    assertEquals(input.identityOnly, false);
    assert(input.identityPaths.includes("left"));
    assert(input.identityPaths.includes("right"));
    assert(input.identityCellPaths.includes("left"));
    assert(input.identityCellPaths.includes("right"));
  },
);

Deno.test(
  "Capability analysis marks inferred lift cell equals paths as identity-cell paths",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/test.ts": `
        import { lift, type Writable } from "commonfabric";

        type Piece = Writable<{ name: string }>;
        const left = {} as Piece;
        const right = {} as Piece;
        const same = lift(({ left, right }: { left: Piece; right: Piece }) =>
          left.equals(right)
        )({ left, right });
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const checker = program.getTypeChecker();
    const callback = (() => {
      let found: ts.ArrowFunction | undefined;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isArrowFunction(node) && node.parameters.length === 1) {
          found = node;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      if (!found) {
        throw new Error("Expected lift callback.");
      }
      return found;
    })();
    const summary = analyzeFunctionCapabilities(callback, { checker });
    const input = getPaths(summary, "__param0");

    assert(input.identityPaths.includes("left"));
    assert(input.identityPaths.includes("right"));
    assert(input.identityCellPaths.includes("left"));
    assert(input.identityCellPaths.includes("right"));
  },
);

Deno.test(
  "Capability analysis drops identity-only paths that overlap full-shape reads",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/test.ts": `
        import { equals } from "commonfabric";

        type ParkingPerson = {
          active: boolean;
          name: string;
          priorityRank: number;
          defaultSpot: string;
        };

        const fn = (input: { people: ParkingPerson[] }) =>
          equals(
            input.people,
            input.people.filter((person) => person.active).slice(0),
          );
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assert(input.fullShapePaths.includes("people"));
    assertEquals(input.identityPaths.includes("people"), false);
  },
);

Deno.test(
  "Capability analysis tracks known fixed-symbol element access without wildcard",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const NAME: unique symbol;
      declare const UI: unique symbol;
      declare const SELF: unique symbol;

      const fn = (input: {
        [NAME]?: string;
        [UI]?: { node: string };
        [SELF]?: { id: string };
        extra: number;
      }) => [input[NAME], input[UI], input[SELF]];
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("$NAME"));
    assert(input.readPaths.includes("$UI"));
    assert(input.readPaths.includes("$SELF"));
    assertEquals(input.readPaths.includes("extra"), false);
  },
);

Deno.test(
  "Capability analysis resolves shadowed fixed-key identifiers to local const strings",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      const UI = "title" as const;

      const fn = (input: {
        title: string;
        extra: number;
      }) => input[UI];
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("title"));
    assertEquals(input.readPaths.includes("$UI"), false);
    assertEquals(input.readPaths.includes("extra"), false);
  },
);

Deno.test(
  "Capability analysis tracks known fixed-symbol destructuring without wildcard",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const SELF: unique symbol;

      const fn = (
        { [SELF]: self, value }: { [SELF]?: { id: string }; value: string },
      ) => self?.id ?? value;
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "__param0");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("$SELF.id"));
    assert(input.readPaths.includes("value"));
  },
);

Deno.test(
  "Capability analysis tracks aliased fixed-symbol destructuring without wildcard",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/test.ts": `
      import { SELF as CF_SELF } from "commonfabric";

      const fn = (
        { [CF_SELF]: self, value }: { [CF_SELF]?: { id: string }; value: string },
      ) => self?.id ?? value;
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "__param0");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("$SELF.id"));
    assert(input.readPaths.includes("value"));
  },
);

/**
 * The capability summary of `input`, the parameter of the first arrow in
 * `body`, which is compiled after an import of `equals`, `lift`, `pattern` and
 * `SELF` and a declaration of `Input` and of `other`, an `Input`.
 */
function analyzeInputWithSelf(body: string, patternCallback: boolean) {
  const { program, sourceFile } = createProgramWithFiles({
    "/test.ts": `
      import { equals, lift, pattern, SELF } from "commonfabric";

      type Input = { title: string; [SELF]?: { title: string } };
      declare const other: Input;

      ${body}
    `,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
  });
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (callback) return;
    if (ts.isArrowFunction(node)) {
      callback = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!callback) {
    throw new Error("Expected a callback in test source.");
  }
  return getPaths(
    analyzeFunctionCapabilities(callback, {
      checker: program.getTypeChecker(),
      patternCallback,
    }),
    "input",
  );
}

const SELF_READS = `(input: Input) => [
  input.title,
  input[SELF],
  input[SELF]?.title,
]`;

Deno.test(
  "Capability analysis leaves SELF paths out of a pattern callback's input",
  () => {
    const input = analyzeInputWithSelf(`pattern(${SELF_READS});`, true);

    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths, ["title"]);
  },
);

Deno.test(
  "Capability analysis keeps SELF paths on the input of any other callback",
  () => {
    const input = analyzeInputWithSelf(`lift(${SELF_READS});`, false);

    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths.toSorted(), ["$SELF", "$SELF.title", "title"]);
  },
);

Deno.test(
  "Capability analysis keeps a pattern callback's input identity-only beside a SELF read",
  () => {
    const input = analyzeInputWithSelf(
      `pattern((input: Input) => [equals(input, other), input[SELF]?.title]);`,
      true,
    );

    assertEquals(input.capability, "comparable");
    assertEquals(input.identityOnly, true);
    assertEquals(input.readPaths, []);
  },
);

Deno.test(
  "Capability analysis keeps a pattern callback's input identity-only beside a dynamic-key read under SELF",
  () => {
    const input = analyzeInputWithSelf(
      `declare const at: number;
      pattern((input: Input) => [equals(input, other), input[SELF]?.title[at]]);`,
      true,
    );

    assertEquals(input.capability, "comparable");
    assertEquals(input.identityOnly, true);
    assertEquals(input.readPaths, []);
  },
);

Deno.test(
  "Capability analysis does not treat arbitrary .equals() methods as identity-only",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      type Person = {
        name: string;
        active: boolean;
        equals(other: string): boolean;
      };

      const fn = (input: { person: Person }) => input.person.equals("Alice");
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.identityOnly, false);
    assertEquals(input.passthrough, false);
    assertEquals(input.identityPaths.length, 0);
    assert(input.readPaths.includes("person"));
  },
);

Deno.test(
  "Capability analysis keeps dynamic element access after .get() reading both captures",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const CELL_BRAND: unique symbol;

      type Writable<T> = {
        readonly [CELL_BRAND]: "cell";
        get(): T;
      };

      const fn = ({ items, index }: {
        items: Writable<string[]>;
        index: Writable<number>;
      }) => items.get()[index.get()];
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "__param0");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("items"));
    assert(input.readPaths.includes("index"));
  },
);

Deno.test(
  "Capability analysis keeps for...of over tracked sub-path path-specific",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
      for (const item of input.items) {
        item.name;
      }
    };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("items"));
    assert(input.readPaths.includes("items.0.name"));
  },
);

Deno.test(
  "Capability analysis keeps direct array parameters path-specific in for...of loops",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface AssetRecord {
        id: string;
        stage: string;
        owner: string;
        unused: { nested: string };
      }

      const fn = (entries: AssetRecord[]) => {
        const buckets: { id: string; stage: string; owner: string }[] = [];
        for (const entry of entries) {
          buckets.push({
            id: entry.id,
            stage: entry.stage,
            owner: entry.owner,
          });
        }
        return buckets;
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "entries");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("0.id"));
    assert(input.readPaths.includes("0.stage"));
    assert(input.readPaths.includes("0.owner"));
    assertEquals(input.readPaths.includes("0.unused"), false);
  },
);

Deno.test(
  "Capability analysis visits chained array callbacks inside for...of iterable expressions",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        filter(predicate: (value: T) => boolean): Array<T>;
      }

      interface Section {
        active: boolean;
        title: string;
        unused: string;
      }

      const fn = (input: { sections: Section[] }) => {
        for (const section of input.sections.filter((entry) => entry.active)) {
          section.title;
        }
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("sections"));
    assert(input.readPaths.includes("sections.0.active"));
    assert(input.readPaths.includes("sections.0.title"));
    assertEquals(input.readPaths.includes("sections.0.unused"), false);
  },
);

Deno.test(
  "Capability analysis handles deeply nested mutual recursion without hanging",
  () => {
    const source = `
const f = (a) => g(a);
const g = (b) => h(b);
const h = (c) => f(c);
const main = (input) => f(input);`;
    const { program, sourceFile } = createProgramWithSource(source);
    const checker = program.getTypeChecker();
    const main = findArrowByVariableName(sourceFile, "main");

    const summary = analyzeFunctionCapabilities(main, {
      checker,
      interprocedural: true,
    });

    // The cycle should be detected — `f` is recursive, so the interprocedural
    // analysis bails out with { recursive: true } for `f`, which means
    // `main`'s argument falls through to the conservative wildcard path.
    const input = getPaths(summary, "input");
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "Capability analysis interprocedural with default parameters does not corrupt paths",
  () => {
    const source = `
const callee = (x, y = 0) => x.foo;
const caller = (input) => callee(input);`;
    const { program, sourceFile } = createProgramWithSource(source);
    const checker = program.getTypeChecker();
    const caller = findArrowByVariableName(sourceFile, "caller");

    const summary = analyzeFunctionCapabilities(caller, {
      checker,
      interprocedural: true,
    });
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assert(input.readPaths.includes("foo"));
    assertEquals(input.wildcard, false);
  },
);

Deno.test(
  "Capability analysis interprocedural propagation stays conservative across source-file boundaries",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/helper.ts": `const helper = (value) => value.foo;`,
      "/test.ts": `const fn = (input) => helper(input);`,
    });
    const checker = program.getTypeChecker();
    const fn = findArrowByVariableName(sourceFile, "fn");

    const summary = analyzeFunctionCapabilities(fn, {
      checker,
      interprocedural: true,
    });
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, true);
    assertEquals(input.readPaths.length, 0);
  },
);

Deno.test("Capability analysis marks an array-destructured parameter as wildcard", () => {
  // Unpacking a parameter positionally (`[first, second]`) loses the
  // field-level precision needed to shrink, so the root is wildcarded.
  const fn = parseFirstCallback(
    `const fn = ([first, second]) => first.id + second.value;`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const param = summary.params[0];

  assert(param, "expected a parameter summary");
  assertEquals(param.wildcard, true);
});

Deno.test("Capability analysis skips omitted elements in array destructuring", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const [, , third] = input.items;
      return third.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assert(input.readPaths.includes("items"));
});

Deno.test("Capability analysis tracks reads through a nullish-fallback alias", () => {
  const fn = parseFirstCallback(
    `const fn = (a, b) => {
      const picked = a.user ?? b.user;
      return picked.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);

  assert(getPaths(summary, "a").readPaths.includes("user"));
  assert(getPaths(summary, "b").readPaths.includes("user"));
});
Deno.test(
  "Mergeable-push misuse: flags a read-then-push to the same collection",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const existing = input.key("users").get();
        if (existing.some((u) => u.name === "a")) return;
        input.key("users").push({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.rootName, "input");
    assertEquals(findings[0]!.path.join("."), "users");
    assertEquals(findings[0]!.kind, "read-dependent-push");
    assert(ts.isCallExpression(findings[0]!.node));
  },
);

Deno.test(
  "Mergeable-push misuse: flags a push a guard on a read below a fallback depends on",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        report(input.key("users").get());
        const first = (input.key("users").get() ?? [])[0]?.name ?? "";
        if (first === "a") return;
        input.key("users").push({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.path.join("."), "users");
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: flags an iterate-dedup-then-push to the same collection",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        for (const u of input.key("users")) {
          if (u.name === "a") return;
        }
        input.key("users").push({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.path.join("."), "users");
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: ignores an iterate-then-push when the iteration serves neither the push nor a write",
  () => {
    // The iteration still keeps the append in the conflict set, but with no
    // dedup guard, no value dependence, and no sibling write there is usually
    // no better expression to point at, so the check stays silent.
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        for (const u of input.key("users")) { u; }
        input.key("users").push({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 0);
  },
);

Deno.test(
  "Mergeable-push misuse: flags a read-then-pushAll to the same collection",
  () => {
    const flagged = collectMergeablePushMisuses(
      `const fn = (input) => {
        const existing = input.key("users").get();
        if (existing.length > 0) return;
        input.key("users").pushAll([{ name: "a" }, { name: "b" }]);
      };`,
    );

    assertEquals(flagged.length, 1);
    assertEquals(flagged[0]!.path.join("."), "users");
    assertEquals(flagged[0]!.kind, "read-dependent-push");

    const unread = collectMergeablePushMisuses(
      `const fn = (input) => {
        input.key("users").pushAll([{ name: "a" }, { name: "b" }]);
      };`,
    );

    assertEquals(unread.length, 0);
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a value-dependent push as read-dependent",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const existing = input.key("users").get();
        input.key("users").push({
          describe() { return "meta"; },
          position: existing.length,
        });
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: classifies an append-then-trim as an independent read-modify-write",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        input.key("messages").push({ text: "a" });
        const current = input.key("messages").get();
        input.key("messages").set(current.slice(-50));
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.path.join("."), "messages");
    assertEquals(findings[0]!.kind, "independent-read-modify-write");
  },
);

Deno.test(
  "Mergeable-push misuse: ignores a push when the read serves neither the push nor another write",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const snapshot = input.key("users").get();
        input.key("log").set(snapshot);
        input.key("users").push({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 0);
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a ternary-guarded push as read-dependent",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const existing = input.key("users").get();
        existing.length < 5
          ? input.key("users").push({ name: "a" })
          : undefined;
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a coalescing-guarded push as read-dependent",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const existing = input.key("users").get();
        existing.find((u) => u.name === "a") ??
          input.key("users").push({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a while-bounded push as read-dependent",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const existing = input.key("users").get();
        while (existing.length < 2) {
          input.key("users").push({ name: "a" });
        }
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a for-condition-bounded push as read-dependent",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const existing = input.key("users").get();
        for (let i = 0; i < existing.length; i++) {
          input.key("users").push({ name: "a" });
        }
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a push inside iteration of the read as read-dependent",
  () => {
    // The pushed value is a constant, so this classifies through the loop's
    // control dependence on the read, not through the pushed value.
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const existing = input.key("users").get();
        for (const u of existing) {
          input.key("users").push({ name: "member" });
        }
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a push keyed by a for-in over the read as read-dependent",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const existing = input.key("users").get();
        for (const k in existing) {
          input.key("users").push({ name: k });
        }
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a push inside a callback over the read as read-dependent",
  () => {
    // Checker-less analysis only descends into nested callbacks when asked;
    // the transformer path gets the same descent from the checker's eager
    // array-callback classification.
    const findings: MergeablePushMisuse[] = [];
    analyzeFunctionCapabilities(
      parseFirstCallback(
        `const fn = (input) => {
          const existing = input.key("users").get();
          existing.forEach(() => {
            input.key("users").push({ name: "a" });
          });
        };`,
      ),
      {
        includeNestedCallbacks: true,
        mergeablePushMisuseSink: (finding) => findings.push(finding),
      },
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: tracks read influence through assignment and destructuring",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        let snapshot;
        snapshot = input.key("users").get();
        const [, first] = snapshot;
        if (first) return;
        input.key("users").push({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a dedup guard inside a switch case as read-dependent",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input, event) => {
        const existing = input.key("users").get();
        switch (event.kind) {
          case "add":
            if (existing.some((u) => u.name === event.name)) return;
            input.key("users").push({ name: event.name });
            break;
          default:
            break;
        }
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: scans past a nested function declaration in a guard statement",
  () => {
    // The first early-exit sibling contains a function declaration; its name
    // must read as a declaration name, not a value reference, and scanning
    // continues to the real dedup guard.
    const findings = collectMergeablePushMisuses(
      `const fn = (input, event) => {
        const existing = input.key("users").get();
        if (event.flag) {
          function helper() { return 0; }
          return;
        }
        if (existing.some((u) => u.name === event.name)) return;
        input.key("users").push({ name: event.name });
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: classifies a destructuring iterate-dedup as read-dependent",
  () => {
    // The loop destructures the tainted element, dedups against it, and the
    // guard statement keeps scanning past an unrelated callback before the
    // early return; the push after the loop is still read-dependent.
    const findings = collectMergeablePushMisuses(
      `const fn = (input, event) => {
        if (["reserved"].some((s) => s === event.name)) return;
        for (const { name } of input.key("users")) {
          if (name === event.name) return;
          void name;
        }
        input.key("users").push({ name: event.name });
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: flags a read-then-push in a destructured handler",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = ({ name }, { users, myName }) => {
        if (myName.get()) return;
        const existing = users.get();
        if (existing.some((u) => u.name === name)) return;
        users.push({ name });
        myName.set(name);
      };`,
    );

    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.path.join("."), "users");
    assertEquals(findings[0]!.kind, "read-dependent-push");
  },
);

Deno.test(
  "Mergeable-push misuse: ignores an unconditional push with no read",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        input.key("users").push({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 0);
  },
);

Deno.test(
  "Mergeable-push misuse: ignores a push when the read is of a different path",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        input.key("log").get();
        input.key("users").push({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 0);
  },
);

Deno.test(
  "Mergeable-push misuse: ignores a read-then-addUnique (the keyed fix)",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        input.key("users").get();
        input.key("users").addUnique({ name: "a" });
      };`,
    );

    assertEquals(findings.length, 0);
  },
);

Deno.test(
  "Mergeable-push misuse: ignores a read-modify-write set",
  () => {
    const findings = collectMergeablePushMisuses(
      `const fn = (input) => {
        const current = input.key("users").get();
        input.key("users").set([...current, { name: "a" }]);
      };`,
    );

    assertEquals(findings.length, 0);
  },
);

Deno.test(
  "Mergeable-push misuse: records no sites when no sink is provided",
  () => {
    // Without a sink the analysis stays a pure capability summary; the
    // read-then-push above is still classified as read+write (writable).
    const summary = analyzeFunctionCapabilities(
      parseFirstCallback(
        `const fn = (input) => {
          input.key("users").get();
          input.key("users").push({ name: "a" });
        };`,
      ),
    );
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);
    assertEquals(input!.capability, "writable");
  },
);

Deno.test("Capability analysis classifies send() as a write", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      input.events.send({ fired: true });
      return null;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  // send() delegates to set() on every receiver: a raw cell takes a
  // transactional write; a stream enqueues an event whose handler writes in
  // its own transaction. Either way a sending callback must never summarize
  // as write-free.
  assert(input.writePaths.includes("events"));
  assertEquals(input.capability, "writeonly");
});

Deno.test(
  "Capability analysis fails closed on unknown methods without a checker",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => input.items.frobnicate();`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);

    // Without a checker the receiver cannot be proven value-like, so the
    // unknown method could be an unrecognized mutator: writePaths must not
    // be treated as exhaustive.
    assertEquals(input!.hasUnverifiedCellUse, true);
  },
);

Deno.test(
  "Capability analysis marks unknown cell-method calls as unverified",
  () => {
    const source = `import { type Cell } from "commonfabric";
const fn = (input: Cell<{ items: string[] }>) => {
  // Not a method the analysis recognizes; the receiver is cell-like, so a
  // mutation cannot be ruled out.
  input.frobnicate();
  return null;
};`;
    const { program, sourceFile } = createProgramWithFiles({
      "/test.ts": source,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const checker = program.getTypeChecker();
    const fn = findArrowByVariableName(sourceFile, "fn");
    const summary = analyzeFunctionCapabilities(fn, { checker });
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);

    assertEquals(input!.hasUnverifiedCellUse, true);
  },
);

Deno.test(
  "Capability analysis keeps value-level unknown methods verified",
  () => {
    const source = `import { type Cell } from "commonfabric";
const fn = (input: Cell<string[]>) => {
  const items = input.get();
  return items.some((item) => item.length > 0);
};`;
    const { program, sourceFile } = createProgramWithFiles({
      "/test.ts": source,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const checker = program.getTypeChecker();
    const fn = findArrowByVariableName(sourceFile, "fn");
    const summary = analyzeFunctionCapabilities(fn, { checker });
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);

    // Array methods on a .get() snapshot cannot write through the cell:
    // only cell-like receivers poison write-exhaustiveness.
    assertEquals(input!.hasUnverifiedCellUse, false);
  },
);

Deno.test(
  "Capability analysis marks set() with an onCommit callback as unverified",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
        input.count.set(1, (tx) => tx.doSomething());
        return null;
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);

    // The write itself is still recorded...
    assert(input!.writePaths.map((path) => path.join(".")).includes("count"));
    // ...but onCommit receives the committed transaction and can write
    // arbitrary cells through it, so writePaths is not exhaustive.
    assertEquals(input!.hasUnverifiedCellUse, true);
  },
);

Deno.test(
  "Capability analysis marks send() with an onCommit callback as unverified",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
        input.events.send({ fired: true }, (tx) => tx.doSomething());
        return null;
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);

    assert(input!.writePaths.map((path) => path.join(".")).includes("events"));
    assertEquals(input!.hasUnverifiedCellUse, true);
  },
);

Deno.test(
  "Capability analysis keeps plain set()/send() calls verified",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
        input.count.set(1);
        input.events.send({ fired: true });
        return null;
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);

    assertEquals(input!.hasUnverifiedCellUse, false);
  },
);

Deno.test(
  "Capability analysis marks dynamic cell-method calls as unverified",
  () => {
    const source = `import { type Cell } from "commonfabric";
const fn = (input: Cell<{ items: string[] }>, m: string) => {
  // Unresolvable method name on a cell-like receiver: could be any mutator.
  input[m]();
  return null;
};`;
    const { program, sourceFile } = createProgramWithFiles({
      "/test.ts": source,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const checker = program.getTypeChecker();
    const fn = findArrowByVariableName(sourceFile, "fn");
    const summary = analyzeFunctionCapabilities(fn, { checker });
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);

    assertEquals(input!.hasUnverifiedCellUse, true);
  },
);

Deno.test(
  "Capability analysis keeps value-level dynamic method calls verified",
  () => {
    const source = `import { type Cell } from "commonfabric";
const fn = (input: Cell<Record<string, () => number>>, m: string) => {
  const value = input.get();
  // Dynamic method on a .get() snapshot: cannot write through the cell.
  return value[m]();
};`;
    const { program, sourceFile } = createProgramWithFiles({
      "/test.ts": source,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const checker = program.getTypeChecker();
    const fn = findArrowByVariableName(sourceFile, "fn");
    const summary = analyzeFunctionCapabilities(fn, { checker });
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);

    assertEquals(input!.hasUnverifiedCellUse, false);
  },
);

Deno.test(
  "Capability analysis fails closed on dynamic methods without a checker",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input, m) => input.items[m]();`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = summary.params.find((entry) => entry.name === "input");
    assert(input);

    assertEquals(input!.hasUnverifiedCellUse, true);
  },
);
