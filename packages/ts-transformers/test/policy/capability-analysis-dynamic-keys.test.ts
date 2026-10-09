/**
 * A read through a key that can name any member — `offers[key]` with a
 * `string` key — reads some member under the static prefix above the key,
 * and which one is known only at run time. The capability analysis records
 * it as a read of that whole prefix, which a builder's input then keeps
 * whole, whichever way the read is spelled. It is not a wildcard: the rest of
 * the input still shrinks to what the body reads. Like a wildcard, it erases
 * the identity markings under the prefix, since the unknown member can be a
 * compared one. A key that reads a capture is a read of its own, wherever the
 * access sits. A use the analysis cannot bound, such as `.key()` with a key
 * that can name any member, stays a wildcard, and a write through such a key
 * is a wildcard that also records a write of the prefix, so the prefix's
 * capability says it is written.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { callSchemas, parseModule } from "../transformed-ast.ts";
import { transformSource } from "../utils.ts";

const PRELUDE = `import { type Cell, equals } from "commonfabric";
type Entry = { space: string; tags: Record<string, string> };
type Catalog = { offers: Record<string, Entry>; meta: { x: number } };
type Other = { a: number; unread: string };
type State = {
  items: { price: number }[];
  lists: number[][];
  selected: Cell<number>;
};
declare const anyKey: string;
declare const otherKey: string;
type Row = { topic: string; groups: Record<string, number[]> };
`;

/**
 * How the function `read` declared in `source`, after `PRELUDE` and compiled
 * beside the commonfabric types, uses its single parameter: the paths it
 * reads, reads in full and writes, the identity paths it keeps, all
 * dot-joined, and whether the use is a wildcard.
 */
function usage(source: string): {
  readPaths: string[];
  fullShapePaths: string[];
  writePaths: string[];
  identityPaths: string[];
  wildcard: boolean;
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
  const sourceFile = program.getSourceFile("/test.ts")!;
  let read: ts.ArrowFunction | undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "read" && declaration.initializer &&
        ts.isArrowFunction(declaration.initializer)
      ) {
        read = declaration.initializer;
      }
    }
  }
  if (!read) throw new Error("Expected `const read = (…) => …`.");
  const summary = analyzeFunctionCapabilities(read, {
    checker: program.getTypeChecker(),
  });
  const [param] = summary.params;
  if (!param || summary.params.length !== 1) {
    throw new Error("Expected a summary for exactly one parameter.");
  }
  const join = (paths: readonly (readonly string[])[] | undefined) =>
    (paths ?? []).map((path) => path.join("."));
  return {
    readPaths: join(param.readPaths),
    fullShapePaths: join(param.fullShapePaths),
    writePaths: join(param.writePaths),
    identityPaths: join(param.identityPaths),
    wildcard: param.wildcard,
  };
}

describe("capability-analysis-dynamic-keys", () => {
  describe("a read through a key that can name any member", () => {
    it("reads the static prefix above the key in full through a `.get()` chain", () => {
      const read = usage(`const read = (catalog: Cell<Catalog>) =>
  catalog.get().offers[anyKey].space;`);

      expect(read.readPaths).toEqual(["offers"]);
      expect(read.fullShapePaths).toEqual(["offers"]);
      expect(read.wildcard).toBe(false);
    });

    it("reads the same prefix through an alias of the member above the key", () => {
      const read = usage(`const read = (catalog: Cell<Catalog>) => {
  const offers = catalog.get().offers;
  return offers[anyKey].space;
};`);

      expect(read.readPaths).toEqual(["offers"]);
      expect(read.fullShapePaths).toEqual(["offers"]);
      expect(read.wildcard).toBe(false);
    });

    it("reads the same prefix through `.key()` and `.get()`", () => {
      const read = usage(`const read = (catalog: Cell<Catalog>) =>
  catalog.key("offers").get()[anyKey].space;`);

      expect(read.readPaths).toEqual(["offers"]);
      expect(read.fullShapePaths).toEqual(["offers"]);
      expect(read.wildcard).toBe(false);
    });

    it("keeps the prefix above the first key that can name any member", () => {
      const read = usage(`const read = (catalog: Cell<Catalog>) =>
  catalog.get().offers[anyKey].tags[otherKey];`);

      expect(read.readPaths).toEqual(["offers"]);
      expect(read.wildcard).toBe(false);
    });

    it("reads the prefix inside a fallback without a wildcard", () => {
      const read = usage(`const read = (catalog: Cell<Catalog>) =>
  catalog.get().offers[anyKey]?.space ?? "";`);

      expect(read.readPaths).toEqual(["offers"]);
      expect(read.wildcard).toBe(false);
    });

    it("leaves a sibling capture shrunk to what the body reads", () => {
      const read = usage(
        `const read = ({ catalog, other }: { catalog: Cell<Catalog>; other: Cell<Other> }) =>
  other.get().a + (catalog.get().offers[anyKey]?.space ?? "");`,
      );

      expect([...read.readPaths].sort()).toEqual(["catalog.offers", "other.a"]);
      expect(read.wildcard).toBe(false);
    });
  });

  describe("a key that reads a capture", () => {
    it("records the key's read inside a fallback", () => {
      const read = usage(`const read = ({ state }: { state: State }) =>
  state.items[state.selected.get()]?.price ?? 0;`);

      expect(read.readPaths).toContain("state.selected");
      expect(read.readPaths).toContain("state.items");
    });

    it("records the key's read in a for..of over the member", () => {
      const read = usage(`const read = ({ state }: { state: State }) => {
  let total = 0;
  for (const value of state.lists[state.selected.get()]) total += value;
  return total;
};`);

      expect(read.readPaths).toContain("state.selected");
      expect(read.readPaths).toContain("state.lists");
    });

    it("records the key's read in a for..of over a fallback", () => {
      const read = usage(`const read = ({ state }: { state: State }) => {
  let total = 0;
  for (const value of state.lists[state.selected.get()] ?? []) total += value;
  return total;
};`);

      expect(read.readPaths).toContain("state.selected");
      expect(read.readPaths).toContain("state.lists");
    });

    it("records the reads inside a call on the spine of a for..of iterable", () => {
      const read = usage(
        `const read = ({ table, self, key }: { table: Row[]; self: string; key: string }) => {
  let total = 0;
  for (
    const value of table.filter((row) => row.topic === self)[0]?.groups[key] ?? []
  ) total += value;
  return total;
};`,
      );

      expect(read.readPaths).toContain("self");
      expect(read.readPaths).toContain("table.0.topic");
      expect(read.readPaths).toContain("key");
    });

    it("records the key reads of a fallback below an element access on a for..of iterable's spine", () => {
      const read = usage(
        `const read = ({ state }: {
  state: {
    lists: number[][][];
    first: Cell<number>;
    second: Cell<number>;
    third: Cell<number>;
  };
}) => {
  let total = 0;
  for (
    const value of (state.lists[state.first.get()] ??
      state.lists[state.second.get()])?.[state.third.get()] ?? []
  ) total += value;
  return total;
};`,
      );

      expect(read.readPaths).toContain("state.first");
      expect(read.readPaths).toContain("state.second");
      expect(read.readPaths).toContain("state.third");
    });

    it("records the reads inside a call at the top of a for..of iterable", () => {
      const read = usage(
        `const read = ({ table, self }: { table: Row[]; self: string }) => {
  let total = 0;
  for (const row of table.filter((row) => row.topic === self)) {
    total += row.groups.x.length;
  }
  return total;
};`,
      );

      expect(read.readPaths).toContain("self");
      expect(read.readPaths).toContain("table.0.topic");
    });

    it("records a captured key cell read inside a fallback", () => {
      const read = usage(
        `const read = ({ catalog, key }: { catalog: Cell<Catalog>; key: Cell<string> }) =>
  catalog.get().offers[key.get()]?.space ?? "";`,
      );

      expect(read.readPaths).toContain("key");
      expect(read.readPaths).toContain("catalog.offers");
    });
  });

  describe("a lift iterating through a key that can name any member", () => {
    /** The input schema of the one lift `source` compiles to. */
    async function liftInput(source: string): Promise<Record<string, unknown>> {
      const output = await transformSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const [input] = callSchemas(parseModule(output), "lift");
      if (!input) throw new Error("Expected a lift with an input schema.");
      return input;
    }

    it("keeps the key's cell in the input for a for..of over a fallback", async () => {
      const input = await liftInput(
        `import { computed, pattern, Writable } from "commonfabric";

export default pattern<{ lists: number[][] }>(({ lists }) => {
  const selected = new Writable(0);
  const total = computed(() => {
    let sum = 0;
    for (const value of lists[selected.get()] ?? []) sum += value;
    return sum;
  });
  return { total };
});
`,
      );

      expect(input.required).toEqual(["lists", "selected"]);
    });

    it("keeps the key cells of a fallback below an element access on the iterable's spine", async () => {
      const input = await liftInput(
        `import { computed, pattern, Writable } from "commonfabric";

export default pattern<{ lists: number[][][] }>(({ lists }) => {
  const first = new Writable(0);
  const second = new Writable(0);
  const third = new Writable(0);
  const total = computed(() => {
    let sum = 0;
    for (
      const value of (lists[first.get()] ?? lists[second.get()])?.[third.get()] ?? []
    ) sum += value;
    return sum;
  });
  return { total };
});
`,
      );

      expect((input.required as string[]).toSorted()).toEqual([
        "first",
        "lists",
        "second",
        "third",
      ]);
    });

    it("keeps a capture a callback on the iterable's spine reads in the input", async () => {
      const input = await liftInput(
        `import { computed, pattern } from "commonfabric";

type Row = { topic: string; groups: Record<string, number[]> };

export default pattern<{ table: Row[]; self: string; key: string }>(
  ({ table, self, key }) => {
    const total = computed(() => {
      let sum = 0;
      for (
        const value of table.filter((row) => row.topic === self)[0]?.groups[key] ?? []
      ) sum += value;
      return sum;
    });
    return { total };
  },
);
`,
      );

      expect(input.required).toEqual(["table", "self", "key"]);
    });
  });

  describe("identity markings", () => {
    it("erases an identity marking under the prefix", () => {
      const control = usage(
        `const read = ({ input, other }: { input: Catalog; other: Entry }) => {
  const { offers } = input;
  const { a } = offers;
  return equals(a, other);
};`,
      );
      const read = usage(
        `const read = ({ input, other }: { input: Catalog; other: Entry }) => {
  const { offers } = input;
  const { a } = offers;
  return equals(a, other) && input.offers[anyKey].space;
};`,
      );

      expect(control.identityPaths).toContain("input.offers.a");
      expect(read.identityPaths).not.toContain("input.offers.a");
      expect(read.wildcard).toBe(false);
    });

    it("keeps an identity marking outside the prefix", () => {
      const read = usage(
        `const read = ({ input, other }: { input: Catalog; other: { x: number } }) => {
  const { meta } = input;
  return equals(meta, other) && input.offers[anyKey].space;
};`,
      );

      expect(read.identityPaths).toContain("input.meta");
      expect(read.wildcard).toBe(false);
    });
  });

  describe("a use the analysis cannot bound", () => {
    it("leaves `.key()` with a key that can name any member a wildcard", () => {
      const read = usage(`const read = (catalog: Cell<Catalog>) =>
  catalog.key("offers").key(anyKey).get().space;`);

      expect(read.wildcard).toBe(true);
    });
  });

  describe("a write through a key that can name any member", () => {
    it("records a write of the prefix beside a read through `.key()`", () => {
      const write = usage(
        `const read = ({ counts, idx }: { counts: Cell<number[]>; idx: Cell<number> }) => {
  const i = idx.get();
  counts.key(i).set(counts.key(i).get() + 1);
};`,
      );

      expect(write.writePaths).toContain("counts");
      expect(write.wildcard).toBe(true);
    });

    it("records a write of the prefix beside a read through `.get()`", () => {
      const write = usage(
        `const read = ({ counts, idx }: { counts: Cell<number[]>; idx: Cell<number> }) => {
  const i = idx.get();
  counts.key(i).set(counts.get()[i] + 1);
};`,
      );

      expect(write.writePaths).toContain("counts");
      expect(write.wildcard).toBe(true);
    });

    it("keeps a handler's state cell writable when it is written through such a key", async () => {
      const output = await transformSource(
        `import { handler, pattern, Writable } from "commonfabric";

export const bump = handler<
  void,
  { counts: Writable<number[]>; idx: Writable<number> }
>((_, { counts, idx }) => {
  const i = idx.get();
  counts.key(i).set(counts.key(i).get() + 1);
});

export default pattern(() => ({}));
`,
        { types: COMMONFABRIC_TYPES },
      );
      const state = callSchemas(parseModule(output), "handler").find((schema) =>
        (schema.properties as Record<string, unknown> | undefined)?.counts
      );

      expect(
        (state?.properties as Record<string, { asCell?: string[] }>).counts
          .asCell,
      ).toEqual(["cell"]);
    });
  });
});
