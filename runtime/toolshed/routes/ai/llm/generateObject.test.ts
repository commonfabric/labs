import { assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { MockLanguageModelV4 } from "ai/test";
import env from "@/env.ts";
import { generateObject } from "./generateObject.ts";
import { findModel, MODELS } from "./models.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("generateObject server-side", () => {
  describe("findModel", () => {
    it("returns undefined for unknown model names", () => {
      const result = findModel("nonexistent:model-xyz");
      assertEquals(result, undefined);
    });

    it("returns undefined for empty string", () => {
      const result = findModel("");
      assertEquals(result, undefined);
    });

    it("returns undefined for the name of an Object.prototype member", () => {
      assertEquals(findModel("constructor"), undefined);
      assertEquals(findModel("toString"), undefined);
    });
  });

  describe("model registration", () => {
    it("MODELS is empty in test environment (no API keys)", () => {
      // In test env (.env.test has no API keys), no models should be registered
      assertEquals(Object.keys(MODELS).length, 0);
    });
  });

  describe("generateObject function", () => {
    it("throws when model is not found", async () => {
      await assertRejects(
        () =>
          generateObject({
            schema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            messages: [{ role: "user", content: "test" }],
            model: "nonexistent:model",
          }),
        Error,
      );
    });

    it("throws when no model specified and default model not registered", async () => {
      await assertRejects(
        () =>
          generateObject({
            schema: {
              type: "object",
              properties: { value: { type: "number" } },
            },
            messages: [{ role: "user", content: "give me a number" }],
            // No model specified — falls back to DEFAULT_GENERATE_OBJECT_MODEL
          }),
        Error,
      );
    });

    it("hands the model no type for a position the schema marks `unknown`", async () => {
      // `unknown` is a type the runtime adds to JSON Schema, and a schema the
      // provider receives has to compile as plain JSON Schema.

      const modelName = "mock:generate-object-unknown";
      const answer = { title: "A title", data: { any: [1, 2] } };
      const schemasSent: unknown[] = [];
      MODELS[modelName] = {
        model: new MockLanguageModelV4({
          doGenerate: (options) => {
            if (options.responseFormat?.type === "json") {
              schemasSent.push(options.responseFormat.schema);
            }
            return Promise.resolve({
              content: [{ type: "text", text: JSON.stringify(answer) }],
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              warnings: [],
            });
          },
        }),
        name: modelName,
        capabilities: {
          contextWindow: 1000,
          maxOutputTokens: 100,
          streaming: false,
          systemPrompt: true,
          stopSequences: true,
          prefill: false,
          images: false,
          reasoning: false,
        },
        aliases: [],
      };
      try {
        const response = await generateObject({
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              data: { type: "unknown" },
            },
            required: ["title", "data"],
          },
          messages: [{ role: "user", content: "Return a title and some data" }],
          model: modelName,
        });

        expect(schemasSent).toEqual([{
          type: "object",
          properties: { title: { type: "string" }, data: {} },
          required: ["title", "data"],
        }]);
        expect(response.object).toEqual(answer);
      } finally {
        delete MODELS[modelName];
      }
    });
  });
});
