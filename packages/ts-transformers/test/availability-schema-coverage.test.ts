import { StaticCache } from "@commonfabric/static";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformSource, validateSource } from "./utils.ts";

const types = {
  "commonfabric.d.ts": await StaticCache.fromFileSystem().getText(
    "types/commonfabric.d.ts",
  ),
};

describe("Availability schema injection", () => {
  it("preserves an authored dialog result schema without replacing its constraints", async () => {
    const output = await transformSource(
      `
      import { llmDialog } from "commonfabric";
      export const dialog = llmDialog<{ name: string }>({
        messages: [],
        resultSchema: {
          type: "object",
          properties: { name: { type: "string", minLength: 5 } },
          required: ["name"],
        },
      });
    `,
      { types, typeCheck: true },
    );
    const calls = callsNamed(parseModule(output), "llmDialog");
    expect(calls).toHaveLength(1);
    const options = calls[0]!.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) {
      throw new Error("Expected authored dialog options");
    }
    expect(options.properties).toHaveLength(2);
    expect(
      options.properties.filter((property) =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) &&
        property.name.text === "resultSchema"
      ),
    ).toHaveLength(1);
    expect(literalToValue(options)).toEqual({
      messages: [],
      resultSchema: {
        type: "object",
        properties: { name: { type: "string", minLength: 5 } },
        required: ["name"],
      },
    });
  });

  it("preserves nonliteral stream options alongside the typed event schema", async () => {
    const output = await transformSource(
      `
      import { streamData } from "commonfabric";
      type Event = { score: number };
      export function subscribe(options: Parameters<typeof streamData<Event>>[0]) {
        return streamData<Event>(options);
      }
    `,
      { types, typeCheck: true },
    );
    const calls = callsNamed(parseModule(output), "streamData");
    expect(calls).toHaveLength(1);
    const options = calls[0]!.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) {
      throw new Error("Expected injected stream options");
    }
    expect(options.properties).toHaveLength(2);
    const [schema, spread] = options.properties;
    if (!schema || !ts.isPropertyAssignment(schema)) {
      throw new Error("Expected the event schema assignment");
    }
    expect(ts.isIdentifier(schema.name) && schema.name.text).toBe("schema");
    expect(literalToValue(schema.initializer)).toEqual({
      type: "object",
      properties: { score: { type: "number" } },
      required: ["score"],
    });
    if (!spread || !ts.isSpreadAssignment(spread)) {
      throw new Error("Expected original stream options to be preserved");
    }
    expect(ts.isIdentifier(spread.expression) && spread.expression.text).toBe(
      "options",
    );
  });

  it("preserves nonliteral dialog options alongside the typed result schema", async () => {
    const output = await transformSource(
      `
      import { type Cell, llmDialog } from "commonfabric";
      type Result = { name: string; selected: Cell<string> };
      export function start(options: Parameters<typeof llmDialog<Result>>[0]) {
        return llmDialog<Result>(options);
      }
    `,
      { types, typeCheck: true },
    );
    const root = parseModule(output);
    const calls = callsNamed(root, "llmDialog");
    expect(calls).toHaveLength(1);
    const options = calls[0]!.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) {
      throw new Error("Expected injected dialog options");
    }
    expect(options.properties).toHaveLength(2);
    const [schema, spread] = options.properties;
    if (!schema || !ts.isPropertyAssignment(schema)) {
      throw new Error("Expected the result schema assignment");
    }
    expect(ts.isIdentifier(schema.name) && schema.name.text).toBe(
      "resultSchema",
    );
    expect(literalToValue(schema.initializer)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        selected: { type: "string", asCell: ["cell"] },
      },
      required: ["name", "selected"],
    });
    if (!spread || !ts.isSpreadAssignment(spread)) {
      throw new Error("Expected original options to be preserved");
    }
    expect(ts.isIdentifier(spread.expression) && spread.expression.text).toBe(
      "options",
    );
  });

  it("rejects a stream without an explicit event type instead of injecting an unconstrained schema", async () => {
    const { diagnostics, output } = await validateSource(
      `
      import { streamData } from "commonfabric";
      export const events = streamData({ url: "/events" });
    `,
      { types },
    );
    expect(diagnostics.map(({ type }) => type)).toEqual([
      "stream-data:missing-type-argument",
    ]);
    const calls = callsNamed(parseModule(output), "streamData");
    expect(calls).toHaveLength(1);
    expect(literalToValue(calls[0]!.arguments[0]!)).toEqual({ url: "/events" });
  });
});
