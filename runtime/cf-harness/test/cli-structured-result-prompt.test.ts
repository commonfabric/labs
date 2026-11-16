import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { JSONSchema } from "@commonfabric/api";

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

  it("puts the caller's instructions before the result contract, so runs that differ only in schema share the prompt through the instructions", () => {
    const instructions = "Write the brief.\n\nRead before you write.";
    const other = {
      type: "object",
      properties: { subject: { enum: ["person-1", "person-2"] } },
    } as const;
    const resultAt = (schema: JSONSchema) => ({
      path: "/tmp/project/result.json",
      sandboxPath: "/workspace/result.json",
      schema,
    });
    const pairs = [
      [schema, other].map((each) =>
        buildCfHarnessBatchSystemPrompt({
          systemPrompt: instructions,
          structuredResult: resultAt(each),
        })
      ),
      [schema, other].map((each) =>
        buildCfHarnessOperatorSystemPrompt({
          workspace: "/tmp/project",
          focusRoot: "/tmp/project",
          systemPrompt: instructions,
          structuredResult: resultAt(each),
        })
      ),
    ];
    for (const [first, second] of pairs) {
      const end = first.indexOf(instructions) + instructions.length;
      expect(first.indexOf(instructions)).toBeGreaterThan(0);
      expect(second.slice(0, end)).toBe(first.slice(0, end));
      expect(first.indexOf("Structured result contract:")).toBeGreaterThan(
        end,
      );
      expect(first.endsWith(JSON.stringify(schema))).toBe(true);
      expect(second.endsWith(JSON.stringify(other))).toBe(true);
    }
  });

  it("advertises only submission when available and files otherwise", () => {
    const structuredResult = {
      path: "/tmp/result.json",
      sandboxPath: "/workspace/result.json",
      schema,
    };
    for (
      const allowedToolIds of [
        undefined,
        ["submit_result"] as const,
        ["write_file"] as const,
      ]
    ) {
      for (
        const prompt of [
          buildCfHarnessBatchSystemPrompt({ structuredResult, allowedToolIds }),
          buildCfHarnessOperatorSystemPrompt({
            workspace: "/tmp",
            focusRoot: "/tmp",
            structuredResult,
            allowedToolIds,
          }),
        ]
      ) {
        const submits = allowedToolIds === undefined ||
          allowedToolIds[0] === "submit_result";
        expect(prompt.includes("Finish by calling submit_result")).toBe(
          submits,
        );
        expect(
          prompt.includes(
            "Write a JSON file at /workspace/result.json when an available tool can write it",
          ),
        ).toBe(!submits);
        expect(prompt.includes("The harness validates that file")).toBe(
          !submits,
        );
        expect(prompt.includes("If the file is missing")).toBe(!submits);
        expect(prompt).not.toContain("the other way to the same place");
      }
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
    for (
      const prompt of [
        buildCfHarnessBatchSystemPrompt({}),
        buildCfHarnessOperatorSystemPrompt({
          workspace: "/tmp",
          focusRoot: "/tmp",
        }),
      ]
    ) {
      expect(prompt).not.toContain("Result schema (JSON):");
      expect(prompt).not.toContain("Write a JSON file");
      expect(prompt).not.toContain("Structured result contract:");
    }
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
