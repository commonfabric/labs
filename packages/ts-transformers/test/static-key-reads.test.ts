import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callsNamed,
  collect,
  extractedCallbackBody,
  literalToValue,
  parseModule,
} from "./transformed-ast.ts";
import { validateSource } from "./utils.ts";

const PRELUDE = `
  import {
    computed,
    NAME,
    pattern,
    UI,
    VIEWS,
    type VNode,
  } from "commonfabric";

  interface RowInput {
    piece: string;
  }

  interface RowView {
    rendered: string;
  }

  interface RowOutput extends RowView {
    [UI]: VNode;
    [NAME]: string;
    [VIEWS]: { row: RowView };
  }

  interface CoreOutput extends RowOutput {
    extra: string;
  }

  const Row = pattern<RowInput, CoreOutput>((input) => {
    const view = { rendered: input.piece };
    return {
      [UI]: <div />,
      [NAME]: input.piece,
      [VIEWS]: { row: view },
      ...view,
      extra: input.piece,
    };
  });
`;

/**
 * Compiles `source` after the shared prelude, returning the parsed output.
 * Throws when the compile reports an error.
 */
async function compile(source: string): Promise<ts.SourceFile> {
  const { diagnostics, output } = await validateSource(
    `${PRELUDE}\n${source}`,
    { types: COMMONFABRIC_TYPES },
  );
  const errors = diagnostics.filter((diagnostic) =>
    diagnostic.severity === "error"
  );
  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.message).join("\n"));
  }
  return parseModule(output);
}

/**
 * Compiles `source` after the shared prelude, returning the type of each
 * error it reports, in report order, and the parsed output.
 */
async function compileWithErrors(
  source: string,
): Promise<{ errors: string[]; root: ts.SourceFile }> {
  const { diagnostics, output } = await validateSource(
    `${PRELUDE}\n${source}`,
    { types: COMMONFABRIC_TYPES },
  );
  return {
    errors: diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.type),
    root: parseModule(output),
  };
}

/**
 * The arguments of every `<receiver>.key(...)` call under `root`, each
 * argument as its source text, in source order.
 */
function keyReads(root: ts.Node, receiver: string): string[][] {
  const sourceFile = root.getSourceFile();
  return callsNamed(root, "key")
    .filter((call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === receiver
    )
    .map((call) => call.arguments.map((arg) => arg.getText(sourceFile)));
}

/** The names of the hoisted lifts `root` declares, in source order. */
function hoistedLifts(root: ts.SourceFile): string[] {
  return collect(root, ts.isVariableDeclaration)
    .filter((declaration) =>
      declaration.initializer !== undefined &&
      ts.isCallExpression(declaration.initializer) &&
      callsNamed(declaration.initializer, "lift").includes(
        declaration.initializer,
      )
    )
    .map((declaration) => declaration.name.getText(root));
}

/**
 * The property names the input schema of the hoisted lift `name` declares for
 * its `row` capture, following a `$ref` into `$defs`.
 */
function liftRowProperties(root: ts.SourceFile, name: string): string[] {
  const declaration = collect(root, ts.isVariableDeclaration).find((d) =>
    d.name.getText(root) === name
  );
  const call = declaration?.initializer;
  if (!call || !ts.isCallExpression(call)) {
    throw new Error(`No hoisted lift named \`${name}\``);
  }
  const inputSchema = call.arguments[1];
  if (!inputSchema || !ts.isSatisfiesExpression(inputSchema)) {
    throw new Error(`\`${name}\` has no input schema`);
  }
  const schema = literalToValue(inputSchema.expression) as {
    properties: { row: { $ref?: string; properties?: object } };
    $defs?: Record<string, { properties: object }>;
  };
  const row = schema.properties.row;
  const resolved = row.$ref === undefined
    ? row
    : schema.$defs![row.$ref.slice("#/$defs/".length)]!;
  return Object.keys(resolved.properties ?? {});
}

describe("static-key-reads", () => {
  describe("a well-known key in a pattern body", () => {
    it("reads `row[NAME]`, `row[VIEWS]` and `row[UI]` in place, with no lift", async () => {
      const root = await compile(`
        export default pattern<RowInput, RowOutput>(({ piece }) => {
          const row = Row({ piece });
          return {
            [NAME]: row[NAME],
            [VIEWS]: row[VIEWS],
            rendered: row.rendered,
            [UI]: <div>{row[UI]}</div>,
          };
        });
      `);

      expect(hoistedLifts(root)).toEqual([]);
      expect(keyReads(root, "row")).toEqual([
        ["__cfHelpers.NAME"],
        ["__cfHelpers.VIEWS"],
        ['"rendered"'],
        ["__cfHelpers.UI"],
      ]);
    });

    it("reads them in place under a result key that is not reserved", async () => {
      const root = await compile(`
        interface Out {
          n: string;
          v: { row: RowView };
          u: VNode;
        }

        export default pattern<RowInput, Out>(({ piece }) => {
          const row = Row({ piece });
          return { n: row[NAME], v: row[VIEWS], u: row[UI] };
        });
      `);

      expect(hoistedLifts(root)).toEqual([]);
      expect(keyReads(root, "row")).toEqual([
        ["__cfHelpers.NAME"],
        ["__cfHelpers.VIEWS"],
        ["__cfHelpers.UI"],
      ]);
    });

    it("reads a path below `row[VIEWS]` as one key read", async () => {
      const root = await compile(`
        export default pattern<RowInput, RowView>(({ piece }) => {
          const row = Row({ piece });
          return { rendered: row[VIEWS].row.rendered };
        });
      `);

      expect(hoistedLifts(root)).toEqual([]);
      expect(keyReads(root, "row")).toEqual([
        ["__cfHelpers.VIEWS", '"row"', '"rendered"'],
      ]);
    });

    it("lifts a read whose key is not statically known", async () => {
      const root = await compile(`
        interface Keyed extends RowInput {
          field: "rendered" | "extra";
        }

        export default pattern<Keyed>(({ piece, field }) => {
          const row = Row({ piece });
          return { [UI]: <div>{row[field]}</div> };
        });
      `);

      expect(hoistedLifts(root)).toEqual(["__cfLift_1"]);
    });

    it("keys a destructured `[NAME]` and `[VIEWS]` the same way", async () => {
      const root = await compile(`
        interface Out {
          n: string;
          v: { row: RowView };
        }

        export default pattern<RowInput, Out>(({ piece }) => {
          const { [NAME]: n, [VIEWS]: v } = Row({ piece });
          return { n, v };
        });
      `);

      expect(keyReads(root, "__cf_destructure_1")).toEqual([
        ['"$NAME"'],
        ['"$VIEWS"'],
      ]);
    });
  });

  describe("a well-known key in a reactive collection callback", () => {
    it("reads `row[VIEWS]` in place, as `row[NAME]` and `row[UI]` are read", async () => {
      const root = await compile(`
        interface ListInput {
          entries: RowInput[];
        }

        export default pattern<ListInput>(({ entries }) => ({
          [UI]: (
            <div>
              {entries.map((entry) => {
                const row = Row({ piece: entry.piece });
                return { n: row[NAME], v: row[VIEWS], u: row[UI] };
              })}
            </div>
          ),
        }));
      `);

      expect(hoistedLifts(root)).toEqual([]);
      expect(keyReads(extractedCallbackBody(root, "__cfPattern_1"), "row"))
        .toEqual([
          ["__cfHelpers.NAME"],
          ["__cfHelpers.VIEWS"],
          ["__cfHelpers.UI"],
        ]);
    });
  });

  describe("a well-known key in a lift over the result", () => {
    // A comparison is a computation, so each read below stays inside a lift
    // that captures `row` whole. The `computed()` case and the bare
    // expression reach schema generation by different routes.

    for (const key of ["NAME", "UI", "VIEWS"]) {
      it(`declares only \`$${key}\` for an expression that reads \`row[${key}]\``, async () => {
        const root = await compile(`
          interface Out {
            missing: boolean;
          }

          export default pattern<RowInput, Out>(({ piece }) => {
            const row = Row({ piece });
            return { missing: row[${key}] === undefined };
          });
        `);

        expect(hoistedLifts(root)).toEqual(["__cfLift_1"]);
        expect(liftRowProperties(root, "__cfLift_1")).toEqual([`$${key}`]);
      });

      it(`declares only \`$${key}\` for a \`computed()\` that reads \`row[${key}]\``, async () => {
        const root = await compile(`
          interface Out {
            missing: boolean;
          }

          export default pattern<RowInput, Out>(({ piece }) => {
            const row = Row({ piece });
            const missing = computed(() => row[${key}] === undefined);
            return { missing };
          });
        `);

        expect(hoistedLifts(root)).toEqual(["__cfLift_1"]);
        expect(liftRowProperties(root, "__cfLift_1")).toEqual([`$${key}`]);
      });
    }
  });
  describe("a `const` key of a literal type", () => {
    // `KEY` is written out as the `.key()` argument, so each case below reads
    // the argument's text off the one `row.key(...)` call its site emits.

    const KEYED = `
      const KEY = "rendered";

      interface ListInput extends RowInput {
        entries: RowInput[];
      }
    `;

    it("reads `row[KEY]` in place in a pattern body", async () => {
      const root = await compile(`
        ${KEYED}
        export default pattern<RowInput, RowView>(({ piece }) => {
          const row = Row({ piece });
          return { rendered: row[KEY] };
        });
      `);

      expect(hoistedLifts(root)).toEqual([]);
      expect(keyReads(root, "row")).toEqual([["KEY"]]);
    });

    it("reads `row[KEY]` in place in JSX", async () => {
      const root = await compile(`
        ${KEYED}
        export default pattern<RowInput>(({ piece }) => {
          const row = Row({ piece });
          return { [UI]: <div>{row[KEY]}</div> };
        });
      `);

      expect(hoistedLifts(root)).toEqual([]);
      expect(keyReads(root, "row")).toEqual([["KEY"]]);
    });

    it("reads `row[KEY]` in place in a reactive collection callback", async () => {
      const root = await compile(`
        ${KEYED}
        export default pattern<ListInput>(({ entries }) => ({
          rows: entries.map((entry) => {
            const row = Row({ piece: entry.piece });
            return { rendered: row[KEY] };
          }),
        }));
      `);

      expect(hoistedLifts(root)).toEqual([]);
      expect(keyReads(extractedCallbackBody(root, "__cfPattern_1"), "row"))
        .toEqual([["KEY"]]);
    });

    it("reads `row[KEY]` in place in JSX in a reactive collection callback", async () => {
      const root = await compile(`
        ${KEYED}
        export default pattern<ListInput>(({ entries }) => ({
          [UI]: (
            <div>
              {entries.map((entry) => {
                const row = Row({ piece: entry.piece });
                return <span>{row[KEY]}</span>;
              })}
            </div>
          ),
        }));
      `);

      expect(hoistedLifts(root)).toEqual([]);
      expect(keyReads(extractedCallbackBody(root, "__cfPattern_1"), "row"))
        .toEqual([["KEY"]]);
    });

    it("lifts a read whose key of a literal type is read from a reactive value", async () => {
      const root = await compile(`
        interface Keyed extends RowInput {
          field: "rendered";
        }

        export default pattern<Keyed, RowView>(({ piece, field }) => {
          const row = Row({ piece });
          return { rendered: row[field] };
        });
      `);

      expect(hoistedLifts(root)).toEqual(["__cfLift_1"]);
      expect(keyReads(root, "row")).toEqual([]);
    });
  });
  describe("a key of a literal type read from a reactive value", () => {
    // The key's type names one member, but the key is a cell, so no site may
    // write it out as a `.key()` argument. Where the site can hold a
    // computation the read lifts, and where it cannot it is reported.

    const KEYED = `
      interface Lists {
        primary: RowInput[];
        other: RowInput[];
      }

      interface Keyed {
        field: "primary";
        lists: Lists;
      }
    `;

    it("lifts the receiver of a collection method in JSX", async () => {
      const { errors, root } = await compileWithErrors(`
        ${KEYED}
        export default pattern<Keyed>(({ field, lists }) => ({
          [UI]: <div>{lists[field].map((entry) => <i>{entry.piece}</i>)}</div>,
        }));
      `);

      expect(errors).toEqual([]);
      expect(hoistedLifts(root)).toEqual(["__cfLift_1"]);
      expect(keyReads(root, "lists")).toEqual([]);
    });

    it("reports `pattern-context:computation` for the receiver of a collection method in a plain value", async () => {
      const { errors, root } = await compileWithErrors(`
        ${KEYED}
        export default pattern<Keyed>(({ field, lists }) => ({
          pieces: lists[field].map((entry) => entry.piece),
        }));
      `);

      expect(errors).toEqual(["pattern-context:computation"]);
      expect(keyReads(root, "lists")).toEqual([]);
    });

    it("reports `pattern-context:computation` for a read in a reactive collection callback", async () => {
      const { errors, root } = await compileWithErrors(`
        interface ListInput {
          mode: "rendered";
          entries: RowInput[];
        }

        export default pattern<ListInput>(({ mode, entries }) => ({
          rows: entries.map((entry) => {
            const row = Row({ piece: entry.piece });
            return { rendered: row[mode] };
          }),
        }));
      `);

      expect(errors).toEqual(["pattern-context:computation"]);
      expect(keyReads(extractedCallbackBody(root, "__cfPattern_1"), "row"))
        .toEqual([]);
    });

    it("keys the receiver of a collection method by a `const` key", async () => {
      const { errors, root } = await compileWithErrors(`
        ${KEYED}
        const KEY = "primary";

        export default pattern<Keyed>(({ lists }) => ({
          pieces: lists[KEY].map((entry) => entry.piece),
        }));
      `);

      expect(errors).toEqual([]);
      expect(keyReads(root, "lists")).toEqual([["KEY"]]);
    });
  });
});
