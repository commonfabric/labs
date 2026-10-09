import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, emittedSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource, validateSource } from "./utils.ts";

describe("policySecretHash schema injection", () => {
  it("reports a call without a type argument", async () => {
    const { diagnostics } = await validateSource(
      [
        'import { policySecretHash } from "commonfabric";',
        "",
        'export const x = policySecretHash({ input: "alice" });',
      ].join("\n"),
      { types: COMMONFABRIC_TYPES },
    );

    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.type === "policy-secret-hash:missing-type-argument"
      ),
    ).toHaveLength(1);
  });

  it("injects the schema of its type argument as `schema`", async () => {
    const output = await transformSource(
      [
        'import { policySecretHash } from "commonfabric";',
        "",
        "export default function T() {",
        '  return policySecretHash<string>({ input: "alice" });',
        "}",
      ].join("\n"),
      { types: COMMONFABRIC_TYPES },
    );

    const root = parseModule(output);
    expect(emittedSchemas(root)).toEqual([{ type: "string" }]);
    const call = callsNamed(root, "policySecretHash").at(-1);
    const arg = call?.arguments[0];
    expect(arg !== undefined && ts.isObjectLiteralExpression(arg)).toBe(true);
    const names = (arg as ts.ObjectLiteralExpression).properties.map(
      (property) =>
        property.name && ts.isIdentifier(property.name)
          ? property.name.text
          : undefined,
    );
    expect(names).toEqual(["schema", "input"]);
  });

  it("reports a `policySecretHashes` call without a type argument", async () => {
    const { diagnostics } = await validateSource(
      [
        'import { policySecretHashes } from "commonfabric";',
        "",
        'export const x = policySecretHashes({ input: ["alice"] });',
      ].join("\n"),
      { types: COMMONFABRIC_TYPES },
    );

    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.type === "policy-secret-hash:missing-type-argument"
      ),
    ).toHaveLength(1);
  });

  it("injects the schema of a `policySecretHashes` type argument, the type of each hash, as `schema`", async () => {
    const output = await transformSource(
      [
        'import { policySecretHashes } from "commonfabric";',
        "",
        "export default function T() {",
        '  return policySecretHashes<string>({ input: ["alice", "bob"] });',
        "}",
      ].join("\n"),
      { types: COMMONFABRIC_TYPES },
    );

    const root = parseModule(output);
    expect(emittedSchemas(root)).toEqual([{ type: "string" }]);
    const call = callsNamed(root, "policySecretHashes").at(-1);
    const arg = call?.arguments[0];
    expect(arg !== undefined && ts.isObjectLiteralExpression(arg)).toBe(true);
    const names = (arg as ts.ObjectLiteralExpression).properties.map(
      (property) =>
        property.name && ts.isIdentifier(property.name)
          ? property.name.text
          : undefined,
    );
    expect(names).toEqual(["schema", "input"]);
  });
});
