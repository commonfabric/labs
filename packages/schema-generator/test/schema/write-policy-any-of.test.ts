import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

const prelude = `
  type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
  type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
  type TrustedActionWrite<T, Binding, Action, Pattern> = Cfc<T, { writeAuthorizedBy: Binding; uiContract: { action: Action; trustedPattern: Pattern } }>;
  type WritePolicyAnyOf<T, Policies> = Cfc<T, { writePolicyAnyOf: Policies }>;
  type AuthenticatedActionWrite<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding; authenticatedAction: true }>;
  function send() {}
  function edit() {}
`;

describe("write-policy-any-of", () => {
  it("lowers each writer together with its own action and surface", async () => {
    const { type, checker } = await getTypeFromCode(
      `${prelude}
      type SchemaRoot = WritePolicyAnyOf<string, [
        TrustedActionWrite<unknown, typeof send, "Send", "SendSurface">,
        TrustedActionWrite<unknown, typeof edit, "Edit", "EditSurface">
      ]>;
    `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(schema.type).toBe("string");
    expect(schema.ifc?.writePolicyAnyOf).toEqual([
      {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: "test.ts", path: ["send"] },
        },
        uiContract: {
          helper: "UiAction",
          action: "Send",
          trustedPattern: "SendSurface",
          requiredEventIntegrity: ["SendSurface"],
        },
      },
      {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: "test.ts", path: ["edit"] },
        },
        uiContract: {
          helper: "UiAction",
          action: "Edit",
          trustedPattern: "EditSurface",
          requiredEventIntegrity: ["EditSurface"],
        },
      },
    ]);
  });

  it("preserves authenticated writers without inventing a reviewed gesture", async () => {
    const { type, checker } = await getTypeFromCode(
      `${prelude}
      type SchemaRoot = WritePolicyAnyOf<string, [AuthenticatedActionWrite<unknown, typeof send>]>;
    `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(schema.ifc?.writePolicyAnyOf).toEqual([{
      writeAuthorizedBy: {
        __ctWriterIdentityOf: { file: "test.ts", path: ["send"] },
      },
      authenticatedAction: true,
    }]);
  });

  it("rejects an empty alternative tuple", async () => {
    const { type, checker } = await getTypeFromCode(
      `${prelude}
      type SchemaRoot = WritePolicyAnyOf<string, []>;
    `,
      "SchemaRoot",
    );
    expect(() => new SchemaGenerator().generateSchema(type, checker)).toThrow(
      "nonempty tuple",
    );
  });
});
