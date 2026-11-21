import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { MockLanguageModelV4 } from "ai/test";
import env from "@/env.ts";
import { generateObject } from "./generateObject.ts";
import { registryWith } from "@/test/fixtures/llm-models.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("generateObject server-side", () => {
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
          }, registryWith("mock:other", new MockLanguageModelV4())),
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
          }, registryWith("mock:other", new MockLanguageModelV4())),
        Error,
      );
    });

    it("hands the model no type for a position the schema marks `unknown`", async () => {
      // `unknown` is a type the runtime adds to JSON Schema, and a schema the
      // provider receives has to compile as plain JSON Schema.

      const modelName = "mock:generate-object-unknown";
      const answer = { title: "A title", data: { any: [1, 2] } };
      const schemasSent: unknown[] = [];
      const models = registryWith(
        modelName,
        new MockLanguageModelV4({
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
        { streaming: false },
      );
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
      }, models);

      expect(schemasSent).toEqual([{
        type: "object",
        properties: { title: { type: "string" }, data: {} },
        required: ["title", "data"],
      }]);
      expect(response.object).toEqual(answer);
    });
  });
});
