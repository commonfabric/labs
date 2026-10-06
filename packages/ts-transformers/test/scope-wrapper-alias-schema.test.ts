import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

describe("scope-wrapper-alias-schema", () => {
  for (const form of ["local", "exported", "imported"]) {
    it(`keeps the scope of a ${form} alias of a scope wrapper`, async () => {
      const prefix = form === "local" ? "" : "export ";
      const declarations = `import type { PerUser } from "commonfabric";
${prefix}type Inner = { a: string };
${prefix}type Rec = PerUser<Inner>;
`;
      const consumer =
        `import { computed, handler, pattern, Writable } from "commonfabric";
const cancel = handler<void, { run: Writable<Rec> }>((_, { run }) => {
  run.set({ a: "" });
});
export default pattern<{ run: Writable<Rec> }>(({ run }) => ({
  x: computed(() => run.get().a),
  cancel: cancel({ run }),
}));`;
      const files: Record<string, string> = form === "imported"
        ? {
          "/records.ts": declarations,
          "/main.tsx": 'import type { Rec } from "./records.ts";\n' + consumer,
        }
        : { "/main.tsx": declarations + consumer };
      const output = await transformFiles(files, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      });
      const module = parseModule(output["/main.tsx"]!);
      const scopedCell = {
        $ref: "#/$defs/Inner",
        scope: "user",
        asCell: ["cell"],
      };

      const { input } = patternSchemas(module);
      expect(input.properties).toEqual({ run: scopedCell });
      expect(Object.keys(input.$defs as object)).toEqual(["Inner"]);

      const [, state] = callSchemas(module, "handler");
      // The handler only writes, so its capability narrows to `writeonly`.
      expect((state as { properties: unknown }).properties).toEqual({
        run: { ...scopedCell, asCell: ["writeonly"] },
      });

      const [liftInput] = callSchemas(module, "lift");
      expect(
        (liftInput as { properties: { run: Record<string, unknown> } })
          .properties.run,
      ).toMatchObject({ $ref: "#/$defs/Inner", scope: "user" });
    });
  }
});
