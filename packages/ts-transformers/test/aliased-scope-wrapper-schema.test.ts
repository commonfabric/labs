/**
 * Pins that a scope wrapper reached through a type alias emits the schema the
 * same wrapper emits written in place, in every schema a builder call carries.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformFiles, transformSource } from "./utils.ts";

type Schema = Record<string, unknown>;

/** The property schemas of an emitted object schema. */
const propertiesOf = (schema: Schema | undefined): Record<string, Schema> =>
  (schema?.properties ?? {}) as Record<string, Schema>;

/**
 * The scope a slot declares where the write path reads it: the outermost
 * `asCell` entry, otherwise the top-level `scope`.
 */
const declaredScope = (schema: Schema | undefined): unknown => {
  const entry = (schema?.asCell as unknown[] | undefined)?.[0];
  const entryScope = typeof entry === "object" && entry !== null
    ? (entry as Schema).scope
    : undefined;
  return entryScope ?? schema?.scope;
};

const OPTIONS = { types: COMMONFABRIC_TYPES, typeCheck: true };

describe("aliased-scope-wrapper-schema", () => {
  it("emits the inline input schema for each aliased scope wrapper", async () => {
    const output = await transformSource(
      `/// <cts-enable />
      import {
        type Default, pattern, type PerAny, type PerSession, type PerSpace,
        type PerUser, type Writable,
      } from "commonfabric";
      interface Named { nickname: string }
      type SpaceAlias = PerSpace<string>;
      type UserAlias = PerUser<string>;
      type SessionAlias = PerSession<string>;
      type AnyAlias = PerAny<string>;
      type FlagAlias = PerUser<boolean>;
      type ObjectAlias = PerUser<{ nickname: string }>;
      type NamedAlias = PerUser<Named>;
      type CellAlias = PerUser<Writable<string>>;
      type OptionalAlias = PerUser<string | undefined>;
      type DefaultAlias = PerUser<string | Default<"">>;
      type Mine<T> = PerSession<T>;
      export default pattern<{
        spaceAlias: SpaceAlias; spaceInline: PerSpace<string>;
        userAlias: UserAlias; userInline: PerUser<string>;
        sessionAlias: SessionAlias; sessionInline: PerSession<string>;
        anyAlias: AnyAlias; anyInline: PerAny<string>;
        flagAlias: FlagAlias; flagInline: PerUser<boolean>;
        objectAlias: ObjectAlias; objectInline: PerUser<{ nickname: string }>;
        namedAlias: NamedAlias; namedInline: PerUser<Named>;
        cellAlias: CellAlias; cellInline: PerUser<Writable<string>>;
        optionalAlias: OptionalAlias; optionalInline: PerUser<string | undefined>;
        defaultAlias: DefaultAlias; defaultInline: PerUser<string | Default<"">>;
        genericAlias: Mine<number>; genericInline: PerSession<number>;
      }>((input) => ({ echoed: input.userAlias }));
      `,
      OPTIONS,
    );
    const { input } = patternSchemas(parseModule(output));
    const properties = propertiesOf(input);
    const scopes = {
      space: "space",
      user: "user",
      session: "session",
      any: "any",
      flag: "user",
      object: "user",
      named: "user",
      cell: "user",
      optional: "user",
      default: "user",
      generic: "session",
    };

    for (const [name, scope] of Object.entries(scopes)) {
      expect(declaredScope(properties[`${name}Inline`])).toBe(scope);
      expect(properties[`${name}Alias`]).toEqual(properties[`${name}Inline`]);
    }
    expect(properties.defaultAlias).toHaveProperty("default", "");
    // The scope belongs to the slot, which a definition shared by every use of
    // the alias is not.
    expect(Object.keys((input.$defs ?? {}) as Schema)).toEqual(["Named"]);
  });

  it("emits the scope in the result schema of a pattern returning an aliased input", async () => {
    const output = await transformSource(
      `/// <cts-enable />
      import { pattern, type PerUser } from "commonfabric";
      type Nickname = PerUser<string>;
      export default pattern<{ alias: Nickname; inline: PerUser<string> }>(
        (input) => ({ alias: input.alias, inline: input.inline }),
      );
      `,
      OPTIONS,
    );
    const properties = propertiesOf(patternSchemas(parseModule(output)).output);

    expect(properties.inline).toEqual({ type: "string", scope: "user" });
    expect(properties.alias).toEqual(properties.inline);
  });

  it("emits the inline schemas for a handler and a lift typed through aliases", async () => {
    const output = await transformSource(
      `/// <cts-enable />
      import {
        handler, lift, type PerSession, type PerUser, type Writable,
      } from "commonfabric";
      type Draft = PerSession<string>;
      type Counter = PerUser<Writable<number>>;
      export const onEvent = handler<
        { alias: Draft; inline: PerSession<string> },
        { alias: Counter; inline: PerUser<Writable<number>> }
      >((_event, _state) => {});
      export const lifted = lift<
        { alias: Draft; inline: PerSession<string> },
        { alias: Draft; inline: PerSession<string> }
      >((_args) => ({ alias: "a", inline: "b" }));
      `,
      OPTIONS,
    );
    const root = parseModule(output);
    const schemas = [
      ...callSchemas(root, "handler"),
      ...callSchemas(root, "lift"),
    ];

    expect(schemas).toHaveLength(4);
    for (const schema of schemas) {
      const properties = propertiesOf(schema);
      expect(declaredScope(properties.inline)).toBeDefined();
      expect(properties.alias).toEqual(properties.inline);
    }
  });

  it("emits the inline capture schema for a computed reading aliased inputs", async () => {
    const output = await transformSource(
      `/// <cts-enable />
      import {
        computed, pattern, type PerUser, type Writable,
      } from "commonfabric";
      type Nickname = PerUser<string>;
      type Counter = PerUser<Writable<number>>;
      export default pattern<{
        text: Nickname;
        count: Counter;
      }>((input) => ({
        viaAlias: computed(() => input.text + input.count.get()),
      }));
      `,
      OPTIONS,
    );
    const root = parseModule(output);
    const { input } = patternSchemas(root);
    const [captures] = callSchemas(root, "lift");
    const captured = propertiesOf(propertiesOf(captures).input);

    expect(declaredScope(captured.text)).toBe("user");
    expect(declaredScope(captured.count)).toBe("user");
    expect(declaredScope(propertiesOf(input).text)).toBe("user");
    expect(captures).not.toHaveProperty("$defs");
  });

  it("emits the inline schema for an alias imported from another module", async () => {
    const output = await transformFiles({
      "/types.ts": `
        import type { PerUser, Writable } from "commonfabric";
        export type Nickname = PerUser<string>;
        export type Counter = PerUser<Writable<number>>;
      `,
      "/test.tsx": `/// <cts-enable />
        import { pattern, type PerUser, type Writable } from "commonfabric";
        import type { Counter, Nickname } from "./types.ts";
        export default pattern<{
          textAlias: Nickname; textInline: PerUser<string>;
          cellAlias: Counter; cellInline: PerUser<Writable<number>>;
        }>((input) => ({ echoed: input.textAlias }));
      `,
    }, OPTIONS);
    const properties = propertiesOf(
      patternSchemas(parseModule(output["/test.tsx"]!)).input,
    );

    for (const name of ["text", "cell"]) {
      expect(declaredScope(properties[`${name}Inline`])).toBe("user");
      expect(properties[`${name}Alias`]).toEqual(properties[`${name}Inline`]);
    }
  });

  it("reports no diagnostic for a default inside an aliased scope wrapper", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    await transformSource(
      `/// <cts-enable />
      import { type Default, pattern, type PerUser } from "commonfabric";
      type Nickname = PerUser<string | Default<"">>;
      export default pattern<{ nickname: Nickname }>(
        (input) => ({ echoed: input.nickname }),
      );
      `,
      { ...OPTIONS, pipelineDiagnostics: diagnostics },
    );

    expect(diagnostics).toEqual([]);
  });
});
