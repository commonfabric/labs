import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { LLMClient } from "@commonfabric/llm";

import { installLlmMocks, readLlmMocks } from "../lib/llm-mock.ts";

const client = new LLMClient();

const ask = (content: string | { type: "text"; text: string }[]) =>
  client.generateObject({
    messages: [{ role: "user", content }],
    schema: { type: "object" },
  });

const say = (content: string) =>
  client.sendRequest({
    messages: [{ role: "user", content }],
    model: "mock",
    cache: false,
  });

describe("llm-mock", () => {
  describe("readLlmMocks", () => {
    it("returns `undefined` for a module that exports no `llmMocks`", () => {
      expect(readLlmMocks({ fetchMocks: [] })).toBeUndefined();
      expect(readLlmMocks(undefined)).toBeUndefined();
    });

    it("returns the entries of an `llmMocks` export, an empty one included", () => {
      expect(readLlmMocks({ llmMocks: [] })).toEqual([]);
      expect(
        readLlmMocks({
          llmMocks: [
            { promptIncludes: "pot", object: { name: "AquaPot" } },
            { promptIncludes: "hello", text: "Hi there" },
          ],
        }),
      ).toEqual([
        { promptIncludes: "pot", object: { name: "AquaPot" } },
        { promptIncludes: "hello", text: "Hi there" },
      ]);
    });

    it("throws for an `llmMocks` export that is not an array", () => {
      expect(() => readLlmMocks({ llmMocks: {} })).toThrow(
        "The test's `llmMocks` export is not an array",
      );
    });

    it("throws naming the first malformed entry", () => {
      expect(() =>
        readLlmMocks({
          llmMocks: [
            { promptIncludes: "pot", object: {} },
            { promptIncludes: "lamp" },
          ],
        })
      ).toThrow(
        "`llmMocks[1]` needs a string `promptIncludes` and either an " +
          "`object` or a string `text`",
      );
      for (
        const entry of [
          { promptIncludes: "lamp", object: {}, text: "both" },
          { promptIncludes: "lamp", text: 3 },
          { promptIncludes: 3, text: "reply" },
          "lamp",
        ]
      ) {
        expect(() => readLlmMocks({ llmMocks: [entry] })).toThrow(
          "`llmMocks[0]` needs a string `promptIncludes`",
        );
      }
    });
  });

  describe("installLlmMocks", () => {
    it("answers the first request whose prompt contains an entry's text, once", async () => {
      using _mocks = installLlmMocks([
        { promptIncludes: "pot", object: { name: "AquaPot" } },
        { promptIncludes: "lamp", object: { name: "ReadLamp" } },
      ]);

      expect((await ask("a lamp that reads")).object).toEqual({
        name: "ReadLamp",
      });
      expect(
        (await ask([{ type: "text", text: "a self-watering pot" }])).object,
      ).toEqual({ name: "AquaPot" });
      await expect(ask("another pot")).rejects.toThrow(
        "no matching mock response found",
      );
    });

    it("answers text requests from `text` entries and object requests from `object` entries", async () => {
      using _mocks = installLlmMocks([
        { promptIncludes: "hello", object: { name: "Wrong" } },
        { promptIncludes: "hello", text: "Hi there" },
      ]);

      const reply = await say("hello, model");
      expect(reply.role).toBe("assistant");
      expect(reply.content).toBe("Hi there");
      await expect(say("hello again")).rejects.toThrow(
        "no matching mock response found",
      );
      expect((await ask("hello, object")).object).toEqual({ name: "Wrong" });
    });

    it("leaves no entry behind once disposed", async () => {
      {
        using _first = installLlmMocks([
          { promptIncludes: "pot", object: { name: "AquaPot" } },
        ]);
      }
      using _second = installLlmMocks([]);

      await expect(ask("a pot")).rejects.toThrow(
        "no matching mock response found",
      );
    });
  });
});
