import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callsNamed,
  collect,
  parseModule,
  patternSchemas,
} from "./transformed-ast.ts";
import { validateSource } from "./utils.ts";

const PRELUDE = `
  import {
    computed,
    handler,
    lift,
    NAME,
    pattern,
    SELF,
    type Stream,
    UI,
    type VNode,
  } from "commonfabric";

  interface Input {
    title: string;
    items: string[];
  }

  interface Output {
    [NAME]: string;
    [UI]: VNode;
    title: string;
    other: unknown;
  }
`;

/** Compiles `source` after the shared prelude, returning its diagnostics. */
async function compile(source: string) {
  return await validateSource(`${PRELUDE}\n${source}`, {
    types: COMMONFABRIC_TYPES,
  });
}

/** The type of each error from compiling `source`, in report order. */
async function errorsOf(source: string) {
  const { diagnostics } = await compile(source);
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.type);
}

/** Whether `node` is `__cfHelpers.SELF`. */
function isHelperSelf(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "__cfHelpers" &&
    node.name.text === "SELF";
}

/** Every `<receiver>[__cfHelpers.SELF]` in `root`, by receiver text. */
function selfReceivers(root: ts.SourceFile): string[] {
  return collect(root, ts.isElementAccessExpression)
    .filter((access) => isHelperSelf(access.argumentExpression))
    .map((access) => access.expression.getText(root));
}

describe("pattern-input-self", () => {
  describe("in the pattern body", () => {
    it("reads `input[SELF]` in place, as `input[__cfHelpers.SELF]`", async () => {
      const { diagnostics, output } = await compile(`
        export default pattern<Input, Output>((input) => {
          const other = input[SELF];
          return {
            [NAME]: "n",
            [UI]: <div />,
            title: input.title,
            other,
          };
        });
      `);
      const root = parseModule(output);

      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(selfReceivers(root)).toEqual(["input"]);
      expect(callsNamed(root, "lift")).toEqual([]);
    });

    it("keys a property of `input[SELF]` off the self reference", async () => {
      const { diagnostics, output } = await compile(`
        export default pattern<Input, Output>((input) => ({
          [NAME]: "n",
          [UI]: <div>{input[SELF].title}</div>,
          title: input.title,
          other: null,
        }));
      `);
      const root = parseModule(output);
      const keyCalls = callsNamed(root, "key");

      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(
        keyCalls
          .filter((call) =>
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isElementAccessExpression(call.expression.expression) &&
            isHelperSelf(call.expression.expression.argumentExpression)
          )
          .map((call) => call.arguments.map((arg) => arg.getText(root))),
      ).toEqual([[`"title"`]]);
      expect(
        keyCalls.filter((call) =>
          call.arguments.some((arg) =>
            isHelperSelf(arg) || (ts.isIdentifier(arg) && arg.text === "SELF")
          )
        ),
      ).toEqual([]);
    });

    it("asks nothing of the input schema for `input[SELF]`", async () => {
      const { diagnostics, output } = await compile(`
        export default pattern<Input, Output>((input) => ({
          [NAME]: "n",
          [UI]: <div>{input[SELF].title}</div>,
          title: input.title,
          other: input[SELF],
        }));
      `);
      const { input } = patternSchemas(parseModule(output));

      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(Object.keys(input.properties as object).sort()).toEqual([
        "items",
        "title",
      ]);
    });

    it("asks nothing of the input schema for `input[SELF]` in a callback held in a `const`", async () => {
      const { diagnostics, output } = await compile(`
        const body = (input: Input & { [SELF]: Output }): Output => ({
          [NAME]: "n",
          [UI]: <div>{input[SELF].title}</div>,
          title: input.title,
          other: input[SELF],
        });

        export default pattern<Input, Output>(body);
      `);
      const { input } = patternSchemas(parseModule(output));

      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(Object.keys(input.properties as object).sort()).toEqual([
        "items",
        "title",
      ]);
    });
  });

  describe("diagnostics", () => {
    it("reports no error for `input[SELF]` read in the pattern body, in JSX, or bound to a handler", async () => {
      expect(
        await errorsOf(`
          const poke = handler<void, { room: unknown }>((_, { room }) => {
            console.log(room);
          });

          export default pattern<Input, Output & { poke: Stream<void> }>(
            (input) => {
              const self = input[SELF];
              return {
                [NAME]: "n",
                [UI]: <div>{input[SELF].title}{self}</div>,
                title: input.title,
                other: input[SELF],
                poke: poke({ room: input[SELF] }),
              };
            },
          );
        `),
      ).toEqual([]);
    });

    it("reports no error for `[SELF]` in a module-scope helper function", async () => {
      expect(
        await errorsOf(`
          const selfOf = (value: { [SELF]?: string }) => value[SELF];

          export default pattern<Input, Output>((input) => ({
            [NAME]: "n",
            [UI]: <div />,
            title: input.title,
            other: selfOf({ [SELF]: "plain" }),
          }));
        `),
      ).toEqual([]);
    });

    it("reports `pattern-context:self-access` for `input[SELF]` inside `computed()`", async () => {
      expect(
        await errorsOf(`
          export default pattern<Input, Output>((input) => ({
            [NAME]: "n",
            [UI]: <div />,
            title: input.title,
            other: computed(() => input[SELF]),
          }));
        `),
      ).toEqual(["pattern-context:self-access"]);
    });

    it("reports `pattern-context:self-access` for `[SELF]` inside a `lift()` body", async () => {
      expect(
        await errorsOf(`
          const pick = lift((value: Input & { [SELF]?: unknown }) =>
            value[SELF]
          );

          export default pattern<Input, Output>((input) => ({
            [NAME]: "n",
            [UI]: <div />,
            title: input.title,
            other: pick(input),
          }));
        `),
      ).toEqual(["pattern-context:self-access"]);
    });

    it("reports `pattern-context:self-access` for `[SELF]` inside a handler body", async () => {
      expect(
        await errorsOf(`
          const poke = handler<void, { input: Input & { [SELF]?: unknown } }>(
            (_, { input }) => {
              console.log(input[SELF]);
            },
          );

          export default pattern<Input, Output & { poke: Stream<void> }>(
            (input) => ({
              [NAME]: "n",
              [UI]: <div />,
              title: input.title,
              other: null,
              poke: poke({ input }),
            }),
          );
        `),
      ).toEqual(["pattern-context:self-access"]);
    });

    it("reports `pattern-context:self-access` for `input[SELF]` inside a reactive `.map()` callback", async () => {
      expect(
        await errorsOf(`
          export default pattern<Input, Output>((input) => ({
            [NAME]: "n",
            [UI]: (
              <div>
                {input.items.map((item) => (
                  <span>{item}{input[SELF].title}</span>
                ))}
              </div>
            ),
            title: input.title,
            other: null,
          }));
        `),
      ).toEqual(["pattern-context:self-access"]);
    });
  });
});
