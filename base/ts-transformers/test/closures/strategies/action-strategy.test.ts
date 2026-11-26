import { expect } from "@std/expect";
import ts from "typescript";

import type { TransformationDiagnostic } from "../../../src/core/mod.ts";
import { COMMONFABRIC_TYPES } from "../../commonfabric-test-types.ts";
import { transformSource } from "../../utils.ts";
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
  });
});
