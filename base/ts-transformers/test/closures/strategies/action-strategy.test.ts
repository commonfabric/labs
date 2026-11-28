import { expect } from "@std/expect";
import ts from "typescript";

import type { TransformationDiagnostic } from "../../../src/mod.ts";
import { COMMONFABRIC_TYPES } from "../../commonfabric-test-types.ts";
import {
  transformSource,
  validateSource,
  withSourceText,
} from "../../utils.ts";
import {
  callsMatching,
  callsNamed,
  parseModule,
} from "../../transformed-ast.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The module head that imports `action()` from `commonfabric`. */
const IMPORTED_ACTION =
  `import { action, pattern, Writable } from "commonfabric";`;

/**
 * Transforms a pattern whose body binds each of `actions` by name, under the
 * module head `head`.
 */
async function transformActions(
  actions: Record<string, string>,
  head = IMPORTED_ACTION,
): Promise<ts.SourceFile> {
  const bindings = Object.entries(actions)
    .map(([name, call]) => `  const ${name} = ${call};`)
    .join("\n");
  const diagnostics: TransformationDiagnostic[] = [];
  const output = await transformSource(
    `/// <cts-enable />
${head}
export default pattern<{ count: Writable<number> }>(({ count }) => {
${bindings}
  return { ${Object.keys(actions).join(", ")} };
});`,
    { types: COMMONFABRIC_TYPES, pipelineDiagnostics: diagnostics },
  );
  expect(diagnostics).toEqual([]);
  return parseModule(output);
}

/** The syntax kind of each remaining `action(...)` call's first argument. */
function remainingActionCallbacks(root: ts.SourceFile): ts.SyntaxKind[] {
  return callsNamed(root, "action").map((call) => call.arguments[0]!.kind);
}

/**
 * Transforms a module that binds `logAction` to `call` at module scope, next
 * to a module-scope arrow `onLog`, and returns the diagnostics the pipeline
 * reported, each with the source text it points at.
 */
async function moduleScopeActionDiagnostics(
  call: string,
): Promise<{ type: string; text: string }[]> {
  const source = `/// <cts-enable />
import { action } from "commonfabric";
const onLog = (e: string) => console.log(e);
export const logAction = ${call};
`;
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return withSourceText(source, diagnostics).map(({ type, text }) => ({
    type,
    text,
  }));
}

describe("action-strategy", () => {
  describe("transformActionCall()", () => {
    it("lowers an arrow-function action to an applied handler", async () => {
      const root = await transformActions({
        inc: "action(() => count.set(count.get() + 1))",
      });

      expect(remainingActionCallbacks(root)).toEqual([]);
      expect(callsMatching(root, /^__cfHandler_/)).toHaveLength(1);
    });

    it("leaves a call of a local function named `action` calling that function", async () => {
      // Inside `computed()`, where the pattern may create the callback.

      const root = await transformActions(
        { total: "computed(() => action(() => count.get() + 1))" },
        `import { computed, pattern, Writable } from "commonfabric";
function action(callback: () => number): number { return callback(); }`,
      );
      const [call, ...others] = callsNamed(root, "action");

      expect(others).toEqual([]);
      expect(call && call.arguments.map((argument) => argument.kind)).toEqual([
        ts.SyntaxKind.ArrowFunction,
      ]);
      expect(callsMatching(root, /^__cfHandler_/)).toEqual([]);
    });

    it("reports a callback that is not an arrow function written at the call", async () => {
      const cases = [
        { call: "action(onLog)", text: "onLog" },
        { call: "action()", text: "action()" },
        {
          call: "action(function (e: string) { console.log(e); })",
          text: "function (e: string) { console.log(e); }",
        },
        {
          call: "action((e: string) => console.log(e), 2 as never)",
          text: "(e: string) => console.log(e)",
        },
      ];
      for (const { call, text } of cases) {
        expect(await moduleScopeActionDiagnostics(call)).toEqual([
          { type: "action:unsupported-callback", text },
        ]);
      }
    });

    it("reports a callback parameter after the event, which the runtime never passes", async () => {
      expect(
        await moduleScopeActionDiagnostics(
          "action((e: string, ...rest: string[]) => onLog(e + rest.join()))",
        ),
      ).toEqual([
        {
          type: "handler-callback:extra-parameter",
          text: "...rest: string[]",
        },
      ]);
    });

    it("accepts an inline arrow callback at module scope", async () => {
      expect(
        await moduleScopeActionDiagnostics(
          "action((e: string) => onLog(e))",
        ),
      ).toEqual([]);
    });
  });
});
