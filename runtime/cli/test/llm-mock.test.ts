/**
 * Unit coverage for the language-model answers a pattern test states in its
 * `llmMocks` export: reading and checking the export, choosing the entry that
 * answers a request, the replies built from an entry, and the failures the
 * runner reports.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type LLMGenerateObjectRequest,
  type LLMRequest,
  setLLMResponder,
} from "@commonfabric/llm";
import {
  answerForwardedLLMRequest,
  type LLMForwardedRequest,
  LLMForwardingResponder,
  LLMMockResponder,
  readLLMMocks,
} from "../lib/llm-mock.ts";

const textRequest = (
  last: string,
  extra: Partial<LLMRequest> = {},
): LLMRequest => ({
  messages: [{ role: "user", content: last }],
  model: "test-model",
  ...extra,
});

const objectRequest = (last: string): LLMGenerateObjectRequest => ({
  messages: [{ role: "user", content: last }],
  schema: { type: "object" },
});

describe("llm-mock", () => {
  describe("readLLMMocks()", () => {
    it("returns no entries when the module exports none", () => {
      expect(readLLMMocks(undefined)).toEqual([]);
      expect(readLLMMocks({})).toEqual([]);
    });

    it("returns the entries a module exports", () => {
      const entries = [
        { when: { lastMessageContains: "hi" }, text: "hello" },
        { text: "calling", toolCalls: [{ name: "search", input: {} }] },
        { object: { name: "x" } },
        { error: "busy" },
      ];

      expect(readLLMMocks({ llmMocks: entries })).toEqual(entries);
    });

    it("throws for an export that is not an array", () => {
      expect(() => readLLMMocks({ llmMocks: { text: "hi" } })).toThrow(
        "The test's `llmMocks` export is not an array.",
      );
    });

    it("throws naming the entry and what is wrong with it", () => {
      const cases: [unknown, string][] = [
        ["hi", "llmMocks[0] is not an object."],
        [{ txt: "hi" }, 'llmMocks[0] has unknown key "txt".'],
        [{}, "llmMocks[0] states no answer"],
        [{ text: "a", object: {} }, "states more than one kind of answer"],
        [{ text: "a", error: "b" }, "states more than one kind of answer"],
        [{ text: 1 }, "`text` is not a string"],
        [{ error: 1 }, "`error` is not a string"],
        [{ object: [] }, "`object` is not a plain JSON object"],
        [
          { object: { at: new Date(0) } },
          "`object` is not a plain JSON object",
        ],
        [{ toolCalls: {} }, "`toolCalls` is not an array"],
        [{ toolCalls: [{ input: {} }] }, "tool call 0 has no string `name`"],
        [
          { toolCalls: [{ name: "a" }] },
          "tool call 0 has an `input` that is not a plain JSON object",
        ],
        [
          { toolCalls: [{ name: "a", input: { f: () => 1 } }] },
          "tool call 0 has an `input` that is not a plain JSON object",
        ],
        [
          { toolCalls: [{ name: "a", input: {} }], repeat: true },
          "repeats a tool call, which would answer every turn with another",
        ],
        [{ toolCalls: [null] }, "tool call 0 is not an object"],
        [
          { toolCalls: [{ name: "a", input: {}, id: 1 }] },
          "tool call 0 has an `id` that is not a string",
        ],
        [{ text: "a", repeat: "yes" }, "`repeat` is not a boolean"],
        [{ text: "a", when: [] }, "`when` is not an object"],
        [{ text: "a", when: { last: "x" } }, '`when` has unknown key "last"'],
        [
          { text: "a", when: { messageCount: 1.5 } },
          "`when.messageCount` is not an integer",
        ],
        [
          { text: "a", when: { hasTools: "search" } },
          "`when.hasTools` is not an array of strings",
        ],
        [
          { text: "a", when: { systemContains: 1 } },
          "`when.systemContains` is not a string",
        ],
      ];

      for (const [entry, message] of cases) {
        expect(() => readLLMMocks({ llmMocks: [entry] })).toThrow(message);
      }
    });
  });

  describe("LLMMockResponder", () => {
    it("answers a text request with the entry's text", async () => {
      const responder = new LLMMockResponder([{ text: "Paris." }]);

      const reply = await responder.sendRequest(
        textRequest("capital?"),
        undefined,
        undefined,
      );

      expect(reply).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "Paris." }],
        id: "llm-mock-0",
      });
      expect(responder.unanswered).toEqual([]);
    });

    it("gives a streamed request the text as its partial result", async () => {
      const responder = new LLMMockResponder([{ text: "Paris." }]);
      const partials: string[] = [];

      await responder.sendRequest(
        textRequest("capital?", { stream: true }),
        (text) => partials.push(text),
        undefined,
      );

      expect(partials).toEqual(["Paris."]);
    });

    it("answers with tool calls, naming each call", async () => {
      const responder = new LLMMockResponder([
        {
          toolCalls: [
            { name: "search", input: { q: "a" } },
            { name: "send", input: {}, id: "mine" },
          ],
        },
      ]);

      const reply = await responder.sendRequest(
        textRequest("go", {
          tools: {
            search: { description: "", inputSchema: {} },
            send: { description: "", inputSchema: {} },
          },
        }),
        undefined,
        undefined,
      );

      expect(reply.content).toEqual([
        {
          type: "tool-call",
          toolCallId: "llm-mock-0-0",
          toolName: "search",
          input: { q: "a" },
        },
        { type: "tool-call", toolCallId: "mine", toolName: "send", input: {} },
      ]);
    });

    it("answers with the empty text for an entry whose text is blank", async () => {
      const responder = new LLMMockResponder([{ text: " " }]);

      const reply = await responder.sendRequest(
        textRequest("go"),
        undefined,
        undefined,
      );

      expect(reply.content).toBe(" ");
    });

    it("answers a generateObject request with the entry's object", async () => {
      const responder = new LLMMockResponder([
        { text: "not this" },
        { object: { name: "Ada" } },
      ]);

      const reply = await responder.generateObject(
        objectRequest("who?"),
        undefined,
      );

      expect(reply).toEqual({ object: { name: "Ada" }, id: "llm-mock-1" });
    });

    it("answers a generateObject given tools by calling its presentResult tool", async () => {
      const responder = new LLMMockResponder([{ object: { name: "Ada" } }]);
      const offering = (tools: string[]) =>
        textRequest("who?", {
          tools: Object.fromEntries(
            tools.map((name) => [name, { description: "", inputSchema: {} }]),
          ),
        });

      await expect(
        responder.sendRequest(offering(["search"]), undefined, undefined),
      ).rejects.toThrow("No llmMocks entry answers a text request");
      const reply = await responder.sendRequest(
        offering(["search", "presentResult"]),
        undefined,
        undefined,
      );

      expect(reply.content).toEqual([{
        type: "tool-call",
        toolCallId: "llm-mock-0-0",
        toolName: "presentResult",
        input: { name: "Ada" },
      }]);
    });

    it("answers a generateObject given tools with tool calls, but not with text alone", async () => {
      const responder = new LLMMockResponder([
        { text: "for a plain request" },
        { toolCalls: [{ name: "search", input: { q: "a" } }] },
      ]);
      const presenting = textRequest("who?", {
        tools: {
          search: { description: "", inputSchema: {} },
          presentResult: { description: "", inputSchema: {} },
        },
      });

      const first = await responder.sendRequest(
        presenting,
        undefined,
        undefined,
      );
      const plain = await responder.sendRequest(
        textRequest("hi"),
        undefined,
        undefined,
      );

      expect(first.id).toBe("llm-mock-1");
      expect(plain.content).toEqual([
        { type: "text", text: "for a plain request" },
      ]);
    });

    it("fails a request of either kind with an entry's error", async () => {
      const responder = new LLMMockResponder([
        { error: "busy" },
        { error: "down" },
      ]);

      await expect(
        responder.sendRequest(textRequest("a"), undefined, undefined),
      ).rejects.toThrow("busy");
      await expect(responder.generateObject(objectRequest("b"), undefined))
        .rejects.toThrow("down");
      expect(responder.unanswered).toEqual([]);
    });

    it("uses each entry once, in order, skipping those whose conditions fail", async () => {
      const responder = new LLMMockResponder([
        { when: { lastMessageContains: "second" }, text: "two" },
        { text: "one" },
        { text: "three" },
      ]);
      const ask = async (last: string) =>
        (await responder.sendRequest(textRequest(last), undefined, undefined))
          .content;

      expect(await ask("first")).toEqual([{ type: "text", text: "one" }]);
      expect(await ask("second")).toEqual([{ type: "text", text: "two" }]);
      expect(await ask("third")).toEqual([{ type: "text", text: "three" }]);
    });

    it("answers every request it fits with an entry that repeats", async () => {
      const responder = new LLMMockResponder([
        { when: { lastMessageContains: "item" }, error: "busy", repeat: true },
        { text: "after" },
      ]);

      for (const last of ["item one", "item two", "item three"]) {
        await expect(
          responder.sendRequest(textRequest(last), undefined, undefined),
        ).rejects.toThrow("busy");
      }
      const reply = await responder.sendRequest(
        textRequest("other"),
        undefined,
        undefined,
      );
      expect(reply.content).toEqual([{ type: "text", text: "after" }]);
    });

    it("fails a request no entry answers, saying why each entry does not fit", async () => {
      const responder = new LLMMockResponder([
        { when: { lastMessageContains: "weather" }, text: "sunny" },
        { object: { unused: true } },
      ]);

      await expect(
        responder.sendRequest(
          textRequest("capital?", {
            system: "Be brief.",
            tools: { search: { description: "", inputSchema: {} } },
          }),
          undefined,
          undefined,
        ),
      ).rejects.toThrow("No llmMocks entry answers a text request");
      expect(responder.unanswered.length).toBe(1);
      const [unanswered] = responder.unanswered;
      expect(unanswered).toContain('last message: "capital?"');
      expect(unanswered).toContain('system: "Be brief."');
      expect(unanswered).toContain("tools: search");
      expect(unanswered).toContain(
        'llmMocks[0] does not fit: expected last message to contain "weather"',
      );
      expect(unanswered).not.toContain("llmMocks[1] does not fit");
    });

    it("answers with tool calls only a request that offers each tool", async () => {
      const responder = new LLMMockResponder([
        { toolCalls: [{ name: "search", input: {} }] },
      ]);
      const offering = (tools: string[]) =>
        textRequest("go", {
          tools: Object.fromEntries(
            tools.map((name) => [name, { description: "", inputSchema: {} }]),
          ),
        });

      await expect(
        responder.sendRequest(offering(["fetch"]), undefined, undefined),
      ).rejects.toThrow(
        'llmMocks[0] does not fit: expected tool "search" in request, got [fetch]',
      );
      const reply = await responder.sendRequest(
        offering(["fetch", "search"]),
        undefined,
        undefined,
      );
      expect(reply.id).toBe("llm-mock-0");
    });

    it("rejects an aborted request without using an entry", async () => {
      const responder = new LLMMockResponder([{ text: "hi" }]);
      const controller = new AbortController();
      controller.abort(new Error("gone"));

      await expect(
        responder.sendRequest(textRequest("a"), undefined, controller.signal),
      ).rejects.toThrow("gone");
      const reply = await responder.sendRequest(
        textRequest("b"),
        undefined,
        undefined,
      );
      expect(reply.id).toBe("llm-mock-0");
    });
  });

  describe("forwarding", () => {
    afterEach(() => setLLMResponder(undefined));

    /**
     * A worker's responder wired straight to this process, where `responder`
     * is installed.
     */
    const forwardingTo = (responder: LLMMockResponder) => {
      setLLMResponder(responder);
      const forwarded: LLMForwardedRequest[] = [];
      const forwarding: LLMForwardingResponder = new LLMForwardingResponder(
        (message) => {
          forwarded.push(message);
          answerForwardedLLMRequest(message).then((answer) =>
            forwarding.receive(answer)
          );
        },
      );
      return { forwarding, forwarded };
    };

    it("answers a forwarded text request, replaying its partial results", async () => {
      const responder = new LLMMockResponder([{ text: "Paris." }]);
      const { forwarding, forwarded } = forwardingTo(responder);
      const partials: string[] = [];

      const reply = await forwarding.sendRequest(
        textRequest("capital?", { stream: true }),
        (text) => partials.push(text),
        undefined,
      );

      expect(reply.content).toEqual([{ type: "text", text: "Paris." }]);
      expect(partials).toEqual(["Paris."]);
      expect(forwarded.map((message) => message.kind)).toEqual(["text"]);
    });

    it("answers a forwarded generateObject request", async () => {
      const { forwarding } = forwardingTo(
        new LLMMockResponder([{ object: { name: "Ada" } }]),
      );

      const reply = await forwarding.generateObject(
        objectRequest("who?"),
        undefined,
      );

      expect(reply.object).toEqual({ name: "Ada" });
    });

    it("fails a forwarded request with the failure the orchestrator met", async () => {
      const responder = new LLMMockResponder([{ error: "busy" }]);
      const { forwarding } = forwardingTo(responder);

      await expect(
        forwarding.sendRequest(textRequest("a"), undefined, undefined),
      ).rejects.toThrow("busy");
      await expect(forwarding.generateObject(objectRequest("b"), undefined))
        .rejects.toThrow("No llmMocks entry answers a generateObject request");
      expect(responder.unanswered.length).toBe(1);
    });

    it("rejects an aborted request without forwarding it", async () => {
      const { forwarding, forwarded } = forwardingTo(
        new LLMMockResponder([{ text: "hi" }]),
      );
      const controller = new AbortController();
      controller.abort(new Error("gone"));

      await expect(
        forwarding.sendRequest(textRequest("a"), undefined, controller.signal),
      ).rejects.toThrow("gone");
      await expect(
        forwarding.generateObject(objectRequest("b"), controller.signal),
      )
        .rejects.toThrow("gone");
      expect(forwarded).toEqual([]);
    });

    it("rejects a request it could not post, forgetting it", async () => {
      const forwarding = new LLMForwardingResponder(() => {
        throw new Error("could not clone");
      });

      await expect(
        forwarding.sendRequest(textRequest("a"), undefined, undefined),
      ).rejects.toThrow("could not clone");
      forwarding.receive({ llmAnswer: 0, error: "late" });
    });

    it("refuses an answer of the wrong kind", async () => {
      const replies = [
        { kind: "object" as const, reply: { object: {} } },
        {
          kind: "text" as const,
          reply: { role: "assistant" as const, content: "", id: "x" },
          partials: [],
        },
      ];
      const forwarding: LLMForwardingResponder = new LLMForwardingResponder(
        (message) =>
          queueMicrotask(() =>
            forwarding.receive({
              llmAnswer: message.llmRequest,
              ...replies[message.llmRequest],
            })
          ),
      );

      await expect(
        forwarding.sendRequest(textRequest("a"), undefined, undefined),
      ).rejects.toThrow("A text request was answered with an object.");
      await expect(forwarding.generateObject(objectRequest("b"), undefined))
        .rejects.toThrow("A generateObject request was answered with text.");
    });
  });
});
