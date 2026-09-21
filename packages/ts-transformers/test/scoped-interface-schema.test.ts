import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule } from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

describe("scoped-interface-schema", () => {
  for (const form of ["local", "exported", "imported"]) {
    it(`retains fields and scope for a whole read of the ${form} interface`, async () => {
      const prefix = form === "local" ? "" : "export ";
      const declarations = `import type { PerSession } from "commonfabric";
${prefix}interface Flags { messages: boolean; channels: boolean }
${prefix}interface Out { errorFlags: PerSession<Flags> }
`;
      const consumer = `import { computed, pattern } from "commonfabric";
export default pattern<Out>((reader) => ({
  failed: computed(() => Object.values(reader.errorFlags).some(Boolean)),
}));`;
      const files: Record<string, string> = form === "imported"
        ? {
          "/reader.ts": declarations,
          "/main.tsx": 'import type { Out } from "./reader.ts";\n' + consumer,
        }
        : { "/main.tsx": declarations + consumer };
      const output = await transformFiles(files, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      });
      const input = callSchemas(parseModule(output["/main.tsx"]!), "lift")[0];

      expect(input).toMatchObject({
        properties: {
          reader: {
            properties: {
              errorFlags: { $ref: "#/$defs/Flags", scope: "session" },
            },
          },
        },
        $defs: {
          Flags: {
            type: "object",
            properties: {
              messages: { type: "boolean" },
              channels: { type: "boolean" },
            },
            required: ["messages", "channels"],
          },
        },
      });
    });
  }
});
