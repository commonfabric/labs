import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  buildCfHarnessBatchSystemPrompt,
  buildCfHarnessOperatorSystemPrompt,
} from "../src/cli.ts";
import { validateStructuredResultValue } from "../src/structured-result.ts";

describe("cli structured result prompt", () => {
  const schema = {
    type: "object",
    properties: {
      answer: { type: "string" },
      details: { $ref: "#/$defs/details" },
    },
    required: ["answer"],
    $defs: {
      details: {
        type: "object",
        properties: { count: { type: "integer" } },
      },
    },
  } as const;

  it("includes the complete schema and closed-object guidance in batch and operator prompts", () => {
    const structuredResult = {
      path: "/tmp/project/result.json",
      sandboxPath: "/workspace/result.json",
      schema,
    };
    const prompts = [
      buildCfHarnessBatchSystemPrompt({ structuredResult }),
      buildCfHarnessOperatorSystemPrompt({
        workspace: "/tmp/project",
        focusRoot: "/tmp/project",
        structuredResult,
      }),
      buildCfHarnessBatchSystemPrompt({
        structuredResult,
        allowedToolIds: ["write_file"],
      }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(JSON.stringify(schema));
      expect(prompt).toContain(
        "Object schemas are closed by default: include only properties the schema declares unless it explicitly allows additional properties.",
      );
    }
  });

  it("includes a boolean schema and omits the contract when no schema is configured", () => {
    expect(buildCfHarnessBatchSystemPrompt({
      structuredResult: {
        path: "/tmp/result.json",
        sandboxPath: "/workspace/result.json",
        schema: true,
      },
    })).toContain("Result schema (JSON):\ntrue");
    expect(buildCfHarnessBatchSystemPrompt({})).not.toContain(
      "Result schema (JSON):",
    );
  });

  it("validates object schemas as closed unless additional properties are allowed", () => {
    expect(() =>
      validateStructuredResultValue({
        schema,
        value: { answer: "Four", ids: [] },
      })
    ).toThrow("additional property ids");
    expect(() =>
      validateStructuredResultValue({
        schema,
        value: { answer: "Four", details: { count: 4, extra: true } },
      })
    ).toThrow("additional property extra");
    expect(() =>
      validateStructuredResultValue({
        schema: { ...schema, additionalProperties: true },
        value: { answer: "Four", ids: [] },
      })
    ).not.toThrow();
  });
});
