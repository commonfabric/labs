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

    // `Other` keeps only the `name` the read reaches.
    expect(schema).toEqual({
      anyOf: [{ $ref: "#/$defs/Contact" }, {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      }],
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
      anyOf: [{ type: "undefined" }, { $ref: "#/$defs/Contact" }],
      asCell: ["readonly"],
    });
  });

  describe("a generic type", () => {
    // The value is read by the type the capture instantiates. Read from its
    // declaration instead, a generic would describe its parameters unbound:
    // `Contact<{ label: string; extra: number }>` of `Contact<T extends {
    // label: string }>` would describe `name` by the constraint and drop
    // `extra` from every read.

    /** A value whose `name` has the schema `name`. */
    const named = (name: unknown) => ({
      type: "object",
      properties: { name },
      required: ["name"],
      asCell: ["readonly"],
    });
    const WIDE_NAME = {
      type: "object",
      properties: { label: { type: "string" }, extra: { type: "number" } },
      required: ["label", "extra"],
    };
    const CONSTRAINED = "interface Contact<T extends { label: string }> " +
      "{ name: T }";
    const WIDER = "Contact<{ label: string; extra: number }>";

    it("emits the value schema for an argument wider than the constraint of a type the module declares with `export`", async () => {
      const schema = await capturedContactSchema({
        "/test.tsx":
          `import { computed, pattern, Writable } from "commonfabric";
          export ${CONSTRAINED}
          ${readContact(WIDER)}`,
      });

      expect(schema).toEqual(named(WIDE_NAME));
    });

    it("emits the value schema for an argument wider than the constraint of a type the module imports", async () => {
      const schema = await capturedContactSchema({
        "/types.ts": `export ${CONSTRAINED}`,
        "/test.tsx":
          `import { computed, pattern, Writable } from "commonfabric";
          import type { Contact } from "./types.ts";
          ${readContact(WIDER)}`,
      });

      expect(schema).toEqual(named(WIDE_NAME));
    });

    it("emits the value schema for an argument wider than the constraint of a type the module declares", async () => {
      const schema = await capturedContactSchema({
        "/test.tsx":
          `import { computed, pattern, Writable } from "commonfabric";
          ${CONSTRAINED}
          ${readContact(WIDER)}`,
      });

      expect(schema).toEqual(named(WIDE_NAME));
    });

    it("emits the value schema for a type reading its parameter through `keyof`", async () => {
      const schema = await capturedContactSchema({
        "/test.tsx":
          `import { computed, pattern, Writable } from "commonfabric";
          export interface Contact<T> { name: keyof T }
          ${readContact("Contact<{ foo: string }>")}`,
      });

      expect(schema).toEqual(named({ type: "string", enum: ["foo"] }));
    });

    it("emits the value schema for a type reading its parameter through an indexed access", async () => {
      const schema = await capturedContactSchema({
        "/test.tsx":
          `import { computed, pattern, Writable } from "commonfabric";
          export interface Contact<T extends { name: string }> {
            name: T["name"];
          }
          ${readContact('Contact<{ name: "Ada" }>')}`,
      });

      expect(schema).toEqual(named({ type: "string", enum: ["Ada"] }));
    });

    it("emits the value schema for an argument replacing the default of a type the module declares with `export`", async () => {
      const schema = await capturedContactSchema({
        "/test.tsx":
          `import { computed, pattern, Writable } from "commonfabric";
          export interface Contact<T = number> { name: T }
          ${readContact("Contact<string>")}`,
      });

      expect(schema).toEqual(named({ type: "string" }));
    });

    it("emits the payload of an alias the CFC lowering fills from the argument", async () => {
      // Read from the declaration, `name` would be the default's number.
      const schema = await capturedContactSchema({
        "/test.tsx":
          `import { computed, Confidential, pattern, Writable } from "commonfabric";
          export type Secret<T = number> =
            Confidential<{ name: T }, readonly ["owner"]>;
          ${readContact("Secret<string>")}`,
      });

      expect(schema).toEqual({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        ifc: { confidentiality: ["owner"] },
        asCell: ["readonly"],
      });
    });

    it("emits a payload union holding the parameter from the argument", async () => {
      const schema = await capturedContactSchema({
        "/test.tsx":
          `import { computed, Confidential, pattern, Writable } from "commonfabric";
          export type Secret<T = number> =
            Confidential<{ name: T | null }, readonly ["owner"]>;
          ${readContact("Secret<string>")}`,
      });

      expect(schema).toEqual({
        type: "object",
        properties: { name: { anyOf: [{ type: "string" }, { type: "null" }] } },
        required: ["name"],
        ifc: { confidentiality: ["owner"] },
        asCell: ["readonly"],
      });
    });

    it("emits only the labels of a nongeneric alias whose payload substitution does not reach", async () => {
      // `Contact` names no parameter, but the lowering's expansion reaches
      // `Secret`'s `T` through an indexed access it does not substitute.
      const output = await transformFiles({
        "/test.tsx":
          `import { computed, Confidential, pattern, Writable } from "commonfabric";
          type Secret<T extends { name: string }> =
            Confidential<{ name: T["name"] }, readonly ["owner"]>;
          export type Contact = Secret<{ name: "Ada" }>;
          ${READ_CONTACT}`,
      }, { types: COMMONFABRIC_TYPES });
      const input = callSchemas(parseModule(output["/test.tsx"]!), "lift")[0]!;

      expect((input.properties as Record<string, unknown>).contact).toEqual(
        stored,
      );
      expect(input.$defs).toEqual({
        Contact: { ifc: { confidentiality: ["owner"] } },
      });
    });

    it("emits the payload of a default naming an earlier parameter from that parameter's argument", async () => {
      // `Contact`'s body leaves `U` out, so `U` is its default `T`, which is
      // `string`, not `T`'s own default.
      const output = await transformFiles({
        "/test.tsx":
          `import { computed, Confidential, pattern, Writable } from "commonfabric";
          type Secret<T = number, U = T> =
            Confidential<{ name: U }, readonly ["owner"]>;
          export type Contact = Secret<string>;
          ${READ_CONTACT}`,
      }, { types: COMMONFABRIC_TYPES });
      const input = callSchemas(parseModule(output["/test.tsx"]!), "lift")[0]!;

      expect((input.properties as Record<string, unknown>).contact).toEqual(
        stored,
      );
      expect(input.$defs).toEqual({
        Contact: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          ifc: { confidentiality: ["owner"] },
        },
      });
    });

    it("emits the labels of an alias the CFC lowering fills from the argument", async () => {
      const schema = await capturedContactSchema({
        "/test.tsx":
          `import { computed, Confidential, pattern, Writable } from "commonfabric";
          ${CONTACT}
          export type Secret<T> = Confidential<T, readonly ["owner"]>;
          ${readContact("Secret<Contact>")}`,
      });

      expect(schema).toEqual({
        ...stored,
        ifc: { confidentiality: ["owner"] },
      });
    });
  });
});
