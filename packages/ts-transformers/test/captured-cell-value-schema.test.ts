/**
 * Pins the value schema emitted for a cell that a `computed()` captures. The
 * capture leaves the transformer a synthetic reference to the cell's value
 * type, and schema generation reads that name from the module's scope.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule } from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

const CONTACT = "interface Contact { name: string }";

/** A pattern whose `computed()` reads `name` from a captured cell of `value`. */
const readContact = (value: string) =>
  `export default pattern<{ contact: Writable<${value}> }>(({ contact }) => {
     return { label: computed(() => contact.key("name").get()) };
   });`;

const READ_CONTACT = readContact("Contact");

/** The schema of `contact` in the input of the lift the `computed()` lowers to. */
async function capturedContactSchema(
  files: Record<string, string>,
): Promise<unknown> {
  const output = await transformFiles(files, { types: COMMONFABRIC_TYPES });
  const input = callSchemas(parseModule(output["/test.tsx"]!), "lift")[0]!;
  return (input.properties as Record<string, unknown>).contact;
}

describe("captured-cell-value-schema", () => {
  const stored = { $ref: "#/$defs/Contact", asCell: ["readonly"] };

  it("emits the value schema for a type the module declares", async () => {
    const schema = await capturedContactSchema({
      "/test.tsx": `import { computed, pattern, Writable } from "commonfabric";
        ${CONTACT}
        ${READ_CONTACT}`,
    });

    expect(schema).toEqual(stored);
  });

  it("emits the value schema for a type the module declares with `export`", async () => {
    const schema = await capturedContactSchema({
      "/test.tsx": `import { computed, pattern, Writable } from "commonfabric";
        export ${CONTACT}
        ${READ_CONTACT}`,
    });

    expect(schema).toEqual(stored);
  });

  it("emits the value schema for a type the module imports", async () => {
    const schema = await capturedContactSchema({
      "/types.ts": `export ${CONTACT}`,
      "/test.tsx": `import { computed, pattern, Writable } from "commonfabric";
        import type { Contact } from "./types.ts";
        ${READ_CONTACT}`,
    });

    expect(schema).toEqual(stored);
  });

  it("emits every member of a union holding a type the module declares with `export`", async () => {
    const schema = await capturedContactSchema({
      "/test.tsx": `import { computed, pattern, Writable } from "commonfabric";
        export ${CONTACT}
        interface Other { name: string; other: number }
        ${readContact("Contact | Other")}`,
    });

    expect(schema).toEqual({
      anyOf: [{ $ref: "#/$defs/Contact" }, { $ref: "#/$defs/Other" }],
      asCell: ["readonly"],
    });
  });

  it("emits every member of a union holding a type the module imports", async () => {
    const schema = await capturedContactSchema({
      "/types.ts": `export ${CONTACT}`,
      "/test.tsx": `import { computed, pattern, Writable } from "commonfabric";
        import type { Contact } from "./types.ts";
        ${readContact("Contact | undefined")}`,
    });

    expect(schema).toEqual({
      anyOf: [{ $ref: "#/$defs/Contact" }, { type: "undefined" }],
      asCell: ["readonly"],
    });
  });
});
