/**
 * The `AgentRun` record and agent queue have two statements: the JSON schemas
 * the runtime reads and writes through, here in the runner, and the
 * pattern-facing types in `packages/patterns/system`. The runner cannot
 * import from the patterns package, so this holds the two together by
 * reading the pattern sources as text.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { AGENT_RUN_ERROR_CODES } from "../src/agent-error-codes.ts";
import {
  AGENT_RUN_STATES,
  AgentQueueIndexSchema,
  AgentRunRecordSchema,
} from "../src/builtins/agent-schemas.ts";

const read = (path: string): string =>
  Deno.readTextFileSync(new URL(path, import.meta.url));

/** Finds a named exported type alias through TypeScript's TSX parser. */
const typeAlias = (source: string, name: string): ts.TypeAliasDeclaration => {
  const file = ts.createSourceFile(
    "pattern.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declaration = file.statements.find((statement) =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === name &&
    statement.modifiers?.some((modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword
      ) === true
  );
  if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(`Exported type ${name} was not found`);
  }
  return declaration;
};

/** The property names an object type alias declares at its top level. */
const declaredIn = (declaration: ts.TypeAliasDeclaration): string[] => {
  if (!ts.isTypeLiteralNode(declaration.type)) {
    throw new Error(`${declaration.name.text} is not an object type`);
  }
  return declaration.type.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || member.name === undefined) return [];
    if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
      return [member.name.text];
    }
    return [];
  }).toSorted();
};

/** The members of a type alias made only from string literals and unions. */
const stringLiteralsIn = (declaration: ts.TypeAliasDeclaration): string[] => {
  const members = ts.isUnionTypeNode(declaration.type)
    ? declaration.type.types
    : [declaration.type];
  return members.map((member) => {
    if (
      !ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)
    ) {
      throw new Error(`${declaration.name.text} is not a string-literal union`);
    }
    return member.literal.text;
  }).toSorted();
};

const propertiesOf = (schema: unknown): Record<string, unknown> =>
  (schema as { properties: Record<string, unknown> }).properties;

describe("agent schemas parity", () => {
  const agentRun = read("../../patterns/system/agent-run.tsx");
  const agentQueue = read("../../patterns/system/agent-queue.tsx");

  it("names every record property in the pattern-facing `AgentRun` type", () => {
    const body = typeAlias(agentRun, "AgentRun");

    expect(declaredIn(body)).toEqual(
      Object.keys(propertiesOf(AgentRunRecordSchema)).toSorted(),
    );
  });

  it("names every state and error code in the pattern-facing unions", () => {
    expect(stringLiteralsIn(typeAlias(agentRun, "AgentRunState")))
      .toEqual(AGENT_RUN_STATES.toSorted());
    expect(stringLiteralsIn(typeAlias(agentRun, "AgentRunErrorCode")))
      .toEqual(AGENT_RUN_ERROR_CODES.toSorted());
  });

  it("names every queue property in the pattern-facing queue types", () => {
    const queue = propertiesOf(AgentQueueIndexSchema);
    const output = typeAlias(agentQueue, "AgentQueueOutput");
    for (const name of Object.keys(queue)) {
      expect(declaredIn(output)).toContain(name);
    }

    const entry = typeAlias(agentQueue, "AgentQueueEntry");
    const entrySchema = (queue.entries as { items: unknown }).items;
    expect(declaredIn(entry))
      .toEqual(Object.keys(propertiesOf(entrySchema)).toSorted());

    const runner = typeAlias(agentQueue, "AgentRunnerEntry");
    expect(declaredIn(runner))
      .toEqual(Object.keys(propertiesOf(queue.agentRunner)).toSorted());
  });

  it("reads type aliases independently of spacing and line wrapping", () => {
    const source = `
      export   type Example={ alpha ?: string; 'beta-key': {
        nested: number;
      }; };
      export type Choices = "one" |\n"two";
    `;

    expect(declaredIn(typeAlias(source, "Example"))).toEqual([
      "alpha",
      "beta-key",
    ]);
    expect(stringLiteralsIn(typeAlias(source, "Choices"))).toEqual([
      "one",
      "two",
    ]);
  });
});
