import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

const PRELUDE = `
  type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
  type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
  type TrustedActionWriteWithIntegrity<
    T,
    Binding,
    Action extends string,
    Pattern extends string,
    Integrity extends readonly [string, ...string[]],
  > = Cfc<
    WriteAuthorizedBy<T, Binding>,
    {
      uiContract: {
        helper: "UiAction";
        action: Action;
        trustedPattern: Pattern;
        requiredEventIntegrity: Integrity;
      };
    }
  >;
  type TrustedActionWrite<
    T,
    Binding,
    Action extends string,
    Pattern extends string,
  > = TrustedActionWriteWithIntegrity<T, Binding, Action, Pattern, [Pattern]>;
  type WritePolicyAnyOf<
    T,
    Policies extends readonly [unknown, ...unknown[]],
  > = Cfc<T, { readonly writePolicyAnyOf: Policies }>;

  declare function handler<A, B>(
    fn: (argument: A, state: B) => void,
  ): { readonly __handler: [A, B] };
  const send = handler<void, { body: string }>(() => {});
  const edit = handler<void, { body: string }>(() => {});
  const tidy = handler<void, { body: string }>(() => {});
`;

/** The schema `SchemaRoot` lowers to, after `PRELUDE` and `code`. */
async function schemaOf(code: string) {
  const { type, checker } = await getTypeFromCode(
    `${PRELUDE}\n${code}`,
    "SchemaRoot",
  );
  return asObjectSchema(new SchemaGenerator().generateSchema(type, checker));
}

/** The lowered writer claim naming `binding` in the test file. */
const writer = (binding: string) => ({
  __ctWriterIdentityOf: { file: "test.ts", path: [binding] },
});

/** The lowered contract of a `TrustedActionWrite` with `action` and `surface`. */
const contract = (action: string, surface: string) => ({
  helper: "UiAction",
  action,
  trustedPattern: surface,
  requiredEventIntegrity: [surface],
});

describe("write-policy-any-of", () => {
  it("lowers each writer together with its own action and surface", async () => {
    const schema = await schemaOf(`
      type SchemaRoot = WritePolicyAnyOf<string, [
        TrustedActionWrite<unknown, typeof send, "Send", "SendSurface">,
        TrustedActionWrite<unknown, typeof edit, "Edit", "EditSurface">,
      ]>;
    `);
    expect(schema.type).toBe("string");
    expect(schema.ifc).toEqual({
      writePolicyAnyOf: [
        {
          writeAuthorizedBy: writer("send"),
          uiContract: contract("Send", "SendSurface"),
        },
        {
          writeAuthorizedBy: writer("edit"),
          uiContract: contract("Edit", "EditSurface"),
        },
      ],
    });
  });

  it("lowers a member with no gesture as a writer alone", async () => {
    const schema = await schemaOf(`
      type SchemaRoot = WritePolicyAnyOf<string, [
        TrustedActionWrite<unknown, typeof send, "Send", "SendSurface">,
        WriteAuthorizedBy<unknown, typeof tidy>,
      ]>;
    `);
    expect(schema.ifc?.writePolicyAnyOf).toEqual([
      {
        writeAuthorizedBy: writer("send"),
        uiContract: contract("Send", "SendSurface"),
      },
      { writeAuthorizedBy: writer("tidy") },
    ]);
  });

  it("lowers a member written through an alias of its own", async () => {
    const schema = await schemaOf(`
      type SendPolicy = TrustedActionWrite<unknown, typeof send, "Send", "SendSurface">;
      type SchemaRoot = WritePolicyAnyOf<string, [
        SendPolicy,
        WriteAuthorizedBy<unknown, typeof tidy>,
      ]>;
    `);
    expect(schema.ifc?.writePolicyAnyOf).toEqual([
      {
        writeAuthorizedBy: writer("send"),
        uiContract: contract("Send", "SendSurface"),
      },
      { writeAuthorizedBy: writer("tidy") },
    ]);
  });

  it("lowers a member whose binding arrives through a generic alias", async () => {
    const schema = await schemaOf(`
      type Reviewed<Binding, Action extends string> = TrustedActionWrite<
        unknown,
        Binding,
        Action,
        "ChatSurface"
      >;
      type SchemaRoot = WritePolicyAnyOf<string, [
        Reviewed<typeof send, "Send">,
        Reviewed<typeof edit, "Edit">,
      ]>;
    `);
    expect(schema.ifc?.writePolicyAnyOf).toEqual([
      {
        writeAuthorizedBy: writer("send"),
        uiContract: contract("Send", "ChatSurface"),
      },
      {
        writeAuthorizedBy: writer("edit"),
        uiContract: contract("Edit", "ChatSurface"),
      },
    ]);
  });

  it("lowers the policy on a property, leaving its siblings alone", async () => {
    const schema = await schemaOf(`
      interface SchemaRoot {
        body: WritePolicyAnyOf<string, [
          WriteAuthorizedBy<unknown, typeof send>,
          WriteAuthorizedBy<unknown, typeof edit>,
        ]>;
        note: string;
      }
    `);
    expect((schema.properties?.body as { ifc?: unknown }).ifc).toEqual({
      writePolicyAnyOf: [
        { writeAuthorizedBy: writer("send") },
        { writeAuthorizedBy: writer("edit") },
      ],
    });
    expect((schema.properties?.note as { ifc?: unknown }).ifc).toBeUndefined();
  });

  it("lowers labeled members, and a tuple written in parentheses", async () => {
    const schema = await schemaOf(`
      type SchemaRoot = WritePolicyAnyOf<string, ([
        sender: WriteAuthorizedBy<unknown, typeof send>,
        editor: WriteAuthorizedBy<unknown, typeof edit>,
      ])>;
    `);
    expect(schema.ifc?.writePolicyAnyOf).toEqual([
      { writeAuthorizedBy: writer("send") },
      { writeAuthorizedBy: writer("edit") },
    ]);
  });

  for (
    const [name, members] of [
      ["an optional member", "WriteAuthorizedBy<unknown, typeof edit>?"],
      [
        "a labeled optional member",
        "editor?: WriteAuthorizedBy<unknown, typeof edit>",
      ],
      ["a rest member", "...WriteAuthorizedBy<unknown, typeof edit>[]"],
    ] as const
  ) {
    it(`throws given ${name}`, async () => {
      await expect(schemaOf(`
        type SchemaRoot = WritePolicyAnyOf<string, [
          WriteAuthorizedBy<unknown, typeof send>,
          ${members},
        ]>;
      `)).rejects.toThrow("cannot be optional or rest");
    });
  }

  it("throws given an empty tuple", async () => {
    await expect(schemaOf(`
      type SchemaRoot = WritePolicyAnyOf<string, []>;
    `)).rejects.toThrow("nonempty tuple");
  });

  it("throws given a tuple named rather than written in place", async () => {
    await expect(schemaOf(`
      type Policies = [WriteAuthorizedBy<unknown, typeof send>];
      type SchemaRoot = WritePolicyAnyOf<string, Policies>;
    `)).rejects.toThrow("nonempty tuple");
  });

  it("throws given a member that is not a writer policy", async () => {
    await expect(schemaOf(`
      type SchemaRoot = WritePolicyAnyOf<string, [
        WriteAuthorizedBy<unknown, typeof send>,
        string,
      ]>;
    `)).rejects.toThrow("must be a `WriteAuthorizedBy`");
  });
});
