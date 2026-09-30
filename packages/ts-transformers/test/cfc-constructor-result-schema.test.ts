/** Synthesized constructor lifts retain the authored value and writer binding. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callsNamed,
  collect,
  literalToValue,
  parseModule,
} from "./transformed-ast.ts";
import { transformFiles, transformSource } from "./utils.ts";

const source = `
import { Writable, Cfc, RepresentsCurrentUser, CurrentPrincipal, WriteAuthorizedBy, handler, pattern } from "commonfabric";
type Protected<T, Binding> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>;
const setName = handler<{ name: string }, { name: Writable<string> }>(
  ({ name }, { name: target }) => target.set(name),
);
export default pattern<{ initialName: string }, { name: Protected<string, typeof setName> }>(
  ({ initialName }) => {
    const initialProfileName = initialName.trim();
    const name = new Writable<Protected<string, typeof setName>>(initialProfileName).for("name");
    return { name };
  },
);
`;

describe("CFC constructor result schemas", () => {
  it("retains the exact writer binding on a static factory", async () => {
    const output = parseModule(
      await transformSource(
        source
          .replace("import { Writable,", "import { Cell, Writable,")
          .replace(
            'new Writable<Protected<string, typeof setName>>(initialProfileName).for("name")',
            "Cell.for<Protected<string, typeof setName>>(initialProfileName)",
          ),
        { types: COMMONFABRIC_TYPES },
      ),
    );
    const factorySchema = callsNamed(output, "asSchema").find((call) =>
      collect(call.expression, ts.isPropertyAccessExpression)
        .some((access) => access.name.text === "for")
    );
    expect(factorySchema).toBeDefined();
    expect(literalToValue(factorySchema!.arguments[0]!)).toMatchObject({
      type: "string",
      ifc: {
        writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
      },
    });
  });

  it("retains the scalar and exact writer binding on the synthesized reference result", async () => {
    const output = parseModule(
      await transformSource(source, {
        types: COMMONFABRIC_TYPES,
      }),
    );
    const constructorLift = callsNamed(output, "lift").find((call) =>
      call.arguments[0] &&
      collect(call.arguments[0], ts.isNewExpression).length === 1
    );
    expect(constructorLift).toBeDefined();
    const constructor = collect(
      constructorLift!.arguments[0]!,
      ts.isNewExpression,
    )[0]!;
    const cellSchema = literalToValue(constructor.arguments![1]!);
    const resultSchema = literalToValue(constructorLift!.arguments[2]!);
    expect(cellSchema).toMatchObject({
      type: "string",
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { path: ["setName"] },
        },
      },
    });
    expect(resultSchema).toEqual({ ...cellSchema as object, asCell: ["cell"] });
  });

  it("retains the defining imported writer through an alias despite a same-shaped local writer", async () => {
    const outputs = await transformFiles({
      "/policy.ts": `/// <cts-enable />
        import { Writable, Cfc, RepresentsCurrentUser, CurrentPrincipal, WriteAuthorizedBy, handler } from "commonfabric";
        export type Protected<T, Binding> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>;
        export const save = handler<{ name: string }, { name: Writable<string> }>(
          ({ name }, { name: target }) => target.set(name),
        );
      `,
      "/main.tsx": `/// <cts-enable />
        import { Writable, handler, pattern } from "commonfabric";
        import { type Protected as RenamedPolicy, save as importedSave } from "./policy.ts";
        const save = handler<{ name: string }, { name: Writable<string> }>(
          ({ name }, { name: target }) => target.set(name),
        );
        export default pattern<{ initialName: string }>(
          ({ initialName }) => {
            const initialProfileName = initialName.trim();
            const name = new Writable<RenamedPolicy<string, typeof importedSave>>(initialProfileName).for("name");
            return { name, save };
          },
        );
      `,
    }, {
      types: COMMONFABRIC_TYPES,
      moduleIdentities: new Map([
        ["/policy.ts", "defining-policy"],
        ["/main.tsx", "importer"],
      ]),
    });
    const output = parseModule(outputs["/main.tsx"]!);
    const constructorLift = callsNamed(output, "lift").find((call) =>
      call.arguments[0] &&
      collect(call.arguments[0], ts.isNewExpression).length === 1
    );
    expect(constructorLift).toBeDefined();
    expect(literalToValue(constructorLift!.arguments[2]!)).toMatchObject({
      type: "string",
      asCell: ["cell"],
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            file: "/policy.ts",
            path: ["save"],
            moduleIdentity: "defining-policy",
          },
        },
      },
    });
  });

  it("keeps an ordinary constructor's for-method result type", async () => {
    const output = parseModule(
      await transformSource(
        `
      import { pattern } from "commonfabric";
      class Local {
        constructor(_value: string) {}
        for(_key: string): number { return 1; }
      }
      export default pattern<{ input: string }>(({ input }) => {
        const value = new Local(input).for("value");
        return { value };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      ),
    );
    const constructorLift = callsNamed(output, "lift").find((call) =>
      call.arguments[0] &&
      collect(call.arguments[0], ts.isNewExpression).length === 1
    );
    expect(constructorLift).toBeDefined();
    expect(literalToValue(constructorLift!.arguments[2]!)).toEqual({
      type: "number",
    });
  });
});
