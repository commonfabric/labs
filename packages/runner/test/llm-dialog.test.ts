import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  loadConversationFixture,
} from "@commonfabric/llm/client";
import type {
  BuiltInLLMMessage,
  BuiltInLLMTool,
  JSONSchema,
} from "@commonfabric/api";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { llmToolExecutionHelpers } from "../src/builtins/llm-dialog.ts";
import { createLLMFriendlyLink } from "../src/link-types.ts";
import { waitForLlmMessages } from "./support/llm-result.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Enable mock mode once for all tests
enableMockMode();

describe("llmDialog", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];
  let Writable: ReturnType<typeof createBuilder>["commonfabric"]["Writable"];
  let handler: ReturnType<typeof createBuilder>["commonfabric"]["handler"];
  let patternTool: ReturnType<
    typeof createBuilder
  >["commonfabric"]["patternTool"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let llmDialog: ReturnType<typeof createBuilder>["commonfabric"]["llmDialog"];
  let generateObject: ReturnType<
    typeof createBuilder
  >["commonfabric"]["generateObject"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      pattern,
      llmDialog,
      Cell,
      Writable,
      handler,
      patternTool,
      generateObject,
    } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should support a multi-turn conversation via addMessage", async () => {
    loadConversationFixture({
      description: "Multi-turn conversation: greeting then follow-up",
      responses: [
        {
          type: "sendRequest",
          expectRequest: { messagesContain: ["Hello"], messageCount: 1 },
          response: { role: "assistant", content: "Hi there!", id: "r1" },
        },
        {
          type: "sendRequest",
          expectRequest: {
            messagesContain: ["Hello", "How are you?"],
            messageCount: 3,
          },
          response: {
            role: "assistant",
            content: "I'm doing well, thanks!",
            id: "r2",
          },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Turn 1: send greeting
    addMessage.send({ role: "user", content: "Hello" });
    await waitForLlmMessages(runtime, result, 2);

    // Turn 2: send follow-up
    addMessage.send({ role: "user", content: "How are you?" });
    await waitForLlmMessages(runtime, result, 4);

    const msgs = (await result.key("messages").pull())!;
    expect(msgs[0].content).toBe("Hello");
    expect(msgs[1].content).toBe("Hi there!");
    expect(msgs[2].content).toBe("How are you?");
    expect(msgs[3].content).toBe("I'm doing well, thanks!");
  });

  it("should support handler streams that capture addMessage", async () => {
    loadConversationFixture({
      description: "Handler stream sends a message into llmDialog",
      responses: [
        {
          type: "sendRequest",
          expectRequest: { messagesContain: ["Hello from handler"] },
          response: {
            role: "assistant",
            content: "Handled.",
            id: "handler-r1",
          },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        run: { asCell: ["stream"] },
        pending: { type: "boolean" },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["run"],
    } as const satisfies JSONSchema;

    const sendPrompt = handler(
      true,
      {
        type: "object",
        properties: {
          addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        },
        required: ["addMessage"],
      } as const satisfies JSONSchema,
      (_event: any, { addMessage }: any) => {
        addMessage.send({
          role: "user",
          content: "Hello from handler",
        });
      },
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          run: sendPrompt({ addMessage: dialog.addMessage as any }),
          pending: dialog.pending,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-captured-add-message-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const run = await result.key("run").pull();
    run.send({});

    await waitForLlmMessages(runtime, result, 2);

    const msgs = (await result.key("messages").pull())!;
    expect(msgs[0].content).toBe("Hello from handler");
    expect(msgs[1].content).toBe("Handled.");
  });

  it("should support tool calls in llmDialog", async () => {
    loadConversationFixture({
      description: "Tool call: weather lookup with getWeather tool",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            lastMessageContains: "weather in San Francisco",
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_123",
              toolName: "getWeather",
              input: { location: "San Francisco" },
            }],
            id: "r1",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 3 },
          response: {
            role: "assistant",
            content: "The weather in San Francisco is sunny and 25C.",
            id: "r2",
          },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    let toolCalled = false;

    const getWeatherTool = pattern(
      ({ location: _location }: any) => {
        toolCalled = true;
        return "Sunny, 25C";
      },
      {
        description: "Get the weather for a location",
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      } as const satisfies JSONSchema,
      { type: "string" },
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          tools: {
            getWeather: patternTool(
              getWeatherTool,
            ) as unknown as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-tool-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    addMessage.send({
      role: "user",
      content: "What is the weather in San Francisco?",
    });

    // user msg + assistant tool-call + tool result + assistant final = 4
    await waitForLlmMessages(runtime, result, 4);

    expect(toolCalled).toBe(true);

    const messages = (await result.key("messages").pull())!;
    expect(messages).toHaveLength(4);
    expect(messages[1].role).toBe("assistant");
    const content = messages[1].content as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("tool-call");
    expect(content[0].toolName).toBe("getWeather");
    expect(messages[2].role).toBe("tool");
    expect((messages[2].content as any)[0].toolName).toEqual("getWeather");
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe(
      "The weather in San Francisco is sunny and 25C.",
    );
  });

  it("should prefer explicit handler tool inputSchema in provider requests", async () => {
    let capturedToolSchema: unknown;

    addMockResponse(
      (req) => {
        capturedToolSchema = req.tools?.sendMail?.inputSchema;
        return true;
      },
      {
        role: "assistant",
        content: "Ready.",
        id: "handler-schema-r1",
      },
    );

    const sendMailHandler = handler(
      {
        type: "object",
        properties: {
          recipient: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          result: { type: "object", asCell: ["cell"] },
        },
        required: ["recipient", "subject", "body", "result"],
      },
      {
        type: "object",
        properties: {},
      },
      ({ result }: any) => {
        result.set({ ok: true });
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          builtinTools: false,
          tools: {
            sendMail: {
              description: "Send an email.",
              inputSchema: {
                type: "object",
                properties: {
                  recipient: { type: "string" },
                  subject: { type: "string" },
                  body: { type: "string" },
                },
                required: ["recipient", "subject", "body"],
                additionalProperties: false,
              } as const satisfies JSONSchema,
              handler: sendMailHandler({}),
            } as unknown as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-handler-input-schema-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Send the email." });

    await waitForLlmMessages(runtime, result, 2);
    expect(capturedToolSchema).toMatchObject({
      type: "object",
      properties: {
        recipient: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["recipient", "subject", "body"],
    });
  });

  it("should prefer parent tool schemas over flattened child tool cells", () => {
    const fullSchema = {
      type: "object",
      properties: {
        recipient: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["recipient", "subject", "body"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const toolsCell = {
      get() {
        return {
          sendMail: {
            description: "Send an email.",
            inputSchema: fullSchema,
          },
        };
      },
      key(_name: string) {
        return {
          get() {
            return {
              description: "Send an email.",
              inputSchema: {},
            };
          },
        };
      },
    } as any;

    const catalog = llmToolExecutionHelpers.buildToolCatalog(
      toolsCell,
      false,
    );

    expect(catalog.llmTools.sendMail.inputSchema).toMatchObject({
      type: "object",
      properties: {
        recipient: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["recipient", "subject", "body"],
    });
  });

  it("offers a pattern tool whose argument schema is `false` as taking `{}`, and runs it for `{}`", async () => {
    // A pattern that takes no argument declares the argument schema `false`,
    // which the runner reads as no input. Its tool takes an empty object.

    const ping = pattern(() => "pong", false, { type: "string" });
    const resultSchema = {
      type: "object",
      properties: { tools: true },
      required: ["tools"],
    } as const satisfies JSONSchema;
    const testPattern = pattern(
      () => ({
        tools: { ping: patternTool(ping) as unknown as BuiltInLLMTool },
      }),
      false,
      resultSchema,
    );
    const result = runtime.run(
      tx,
      testPattern,
      {},
      runtime.getCell(
        space,
        "llmDialog-no-argument-pattern-tool",
        resultSchema,
        tx,
      ),
    );
    tx.prepareCfc();
    await tx.commit();
    await runtime.idle();

    const catalog = llmToolExecutionHelpers.buildToolCatalog(
      result.key("tools") as any,
      false,
    );
    expect(catalog.llmTools.ping?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });

    const [call] = await llmToolExecutionHelpers.executeToolCalls(
      runtime,
      space,
      catalog,
      [{
        type: "tool-call",
        toolCallId: "call-ping",
        toolName: "ping",
        input: {},
      }],
    );
    await runtime.idle();

    expect(call?.error).toBeUndefined();
    expect(call?.result).toMatchObject({
      type: "json",
      value: { result: "pong" },
    });
  });

  it("should pass opaque text links through handler tool string inputs", async () => {
    type SentEmail = {
      recipient: string;
      subject: string;
      body: string;
    };
    type SendMailArgs = SentEmail;

    const sendMailInputSchema = {
      type: "object",
      properties: {
        recipient: { type: "string" },
        subject: { type: "string" },
        body: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: { "@link": { type: "string" } },
              required: ["@link"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["recipient", "subject", "body"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sendMail = handler<
      SendMailArgs,
      { emails: any }
    >(
      {
        type: "object",
        properties: {
          recipient: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["recipient", "subject", "body"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          emails: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            asCell: ["cell"],
          },
        },
        required: ["emails"],
      },
      ({ recipient, subject, body }, { emails }) => {
        emails.push({ recipient, subject, body });
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        emails: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        summary: { type: "string", asCell: ["cell"] },
        tools: true,
      },
      required: ["emails", "summary", "tools"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const emails = Writable.of<SentEmail[]>([]);
        const summary = Cell.of("Linked summary text", {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        });

        return {
          emails,
          summary,
          tools: {
            sendMail: {
              description:
                "Send an email. body may be raw text or an opaque text link.",
              inputSchema: sendMailInputSchema,
              handler: sendMail({ emails }),
            },
          },
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-linked-text-tool-body-test",
      resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.prepareCfc();
    await tx.commit();
    await runtime.idle();

    const catalog = llmToolExecutionHelpers.buildToolCatalog(
      result.key("tools") as any,
      false,
    );
    const summaryLink = createLLMFriendlyLink(
      result.key("summary").getAsNormalizedFullLink(),
      space,
    );

    await llmToolExecutionHelpers.executeToolCalls(
      runtime,
      space,
      catalog,
      [{
        type: "tool-call",
        toolCallId: "call-linked-body",
        toolName: "sendMail",
        input: {
          recipient: "john@example.org",
          subject: "not approved",
          body: { "@link": summaryLink },
        },
      }],
    );
    await runtime.idle();

    expect(await result.key("emails").pull()).toEqual([{
      recipient: "john@example.org",
      subject: "not approved",
      body: "Linked summary text",
    }]);
  });

  it("should expand stringified opaque text links in handler tool string inputs", async () => {
    type SentEmail = {
      recipient: string;
      subject: string;
      body: string;
    };
    type SendMailArgs = SentEmail;

    const sendMailInputSchema = {
      type: "object",
      properties: {
        recipient: { type: "string" },
        subject: { type: "string" },
        body: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: { "@link": { type: "string" } },
              required: ["@link"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["recipient", "subject", "body"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sendMail = handler<
      SendMailArgs,
      { emails: any }
    >(
      {
        type: "object",
        properties: {
          recipient: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["recipient", "subject", "body"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          emails: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            asCell: ["cell"],
          },
        },
        required: ["emails"],
      },
      ({ recipient, subject, body }, { emails }) => {
        emails.push({ recipient, subject, body });
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        emails: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        summary: { type: "string", asCell: ["cell"] },
        tools: true,
      },
      required: ["emails", "summary", "tools"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const emails = Writable.of<SentEmail[]>([]);
        const summary = Cell.of("Linked summary text", {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        });

        return {
          emails,
          summary,
          tools: {
            sendMail: {
              description:
                "Send an email. body may be raw text or an opaque text link.",
              inputSchema: sendMailInputSchema,
              handler: sendMail({ emails }),
            },
          },
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-stringified-linked-text-tool-body-test",
      resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.prepareCfc();
    await tx.commit();
    await runtime.idle();

    const catalog = llmToolExecutionHelpers.buildToolCatalog(
      result.key("tools") as any,
      false,
    );
    const summaryLink = createLLMFriendlyLink(
      result.key("summary").getAsNormalizedFullLink(),
      space,
    );

    await llmToolExecutionHelpers.executeToolCalls(
      runtime,
      space,
      catalog,
      [{
        type: "tool-call",
        toolCallId: "call-stringified-linked-body",
        toolName: "sendMail",
        input: {
          recipient: "john@example.org",
          subject: "not approved",
          body: JSON.stringify({ "@link": summaryLink }),
        },
      }],
    );
    await runtime.idle();

    expect(await result.key("emails").pull()).toEqual([{
      recipient: "john@example.org",
      subject: "not approved",
      body: "Linked summary text",
    }]);
  });

  it("should preserve mixed custom tools including subAgent when builtinTools is false", async () => {
    loadConversationFixture({
      description:
        "llmDialog safe demo tool catalog should include subAgent alongside handler tools",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            hasTools: ["readRawBriefing", "subAgent", "sendMail"],
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: "Tool catalog is available.",
            id: "dlg-safe-catalog-r1",
          },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        flattenedTools: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const readRawBriefing = handler(
      {
        type: "object",
        properties: {
          result: { type: "object", asCell: ["cell"] },
        },
        required: ["result"],
      },
      {
        type: "object",
        properties: {
          title: { type: "string" },
          source: { type: "string" },
          body: { type: "object", additionalProperties: true },
        },
        required: ["title", "source", "body"],
      },
      ({ result }: { result: any }, { title, source, body }: any) => {
        result.set({
          title,
          source,
          analystHint: "Untrusted partner source.",
          body,
        });
      },
    );

    const sendMail = handler(
      {
        type: "object",
        properties: {
          recipient: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          result: { type: "object", asCell: ["cell"] },
        },
        required: ["recipient", "subject", "body", "result"],
      },
      {
        type: "object",
        properties: {
          sent: { type: "object", asCell: ["cell"] },
          route: { type: "string" },
        },
        required: ["sent"],
      },
      (
        { recipient, subject, body, result }: any,
        { sent, route }: any,
      ) => {
        sent.set({ recipient, subject, body, route });
        result.set({ ok: true });
      },
    );

    const subAgentPattern = pattern<any, any>(
      ({ prompt, resultSchema, body, emails, route }) => {
        return generateObject({
          prompt,
          system: "Child worker.",
          schema: resultSchema,
          tools: {
            readRawBriefing: {
              description: "Read the nested body.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              } as const satisfies JSONSchema,
              handler: readRawBriefing({
                title: "Briefing",
                source: "https://example.invalid",
                body,
              }),
            } as unknown as BuiltInLLMTool,
            sendMail: {
              description: "Send a nested email.",
              inputSchema: {
                type: "object",
                properties: {
                  recipient: { type: "string" },
                  subject: { type: "string" },
                  body: { type: "string" },
                },
                required: ["recipient", "subject", "body"],
                additionalProperties: false,
              } as const satisfies JSONSchema,
              handler: sendMail({ sent: emails, route }),
            } as unknown as BuiltInLLMTool,
          },
          observationMaxConfidentiality: ["internal"],
        } as any).result;
      },
      {
        type: "object",
        properties: {
          prompt: { type: "string" },
          resultSchema: {
            type: "object",
            additionalProperties: true,
          },
          body: {
            type: "object",
            additionalProperties: true,
            asCell: ["cell"],
          },
          emails: {
            type: "object",
            additionalProperties: true,
            asCell: ["cell"],
          },
          route: { type: "string" },
        },
        required: ["prompt", "resultSchema"],
        additionalProperties: false,
      },
      true,
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const sent = Cell.of({});
        const emails = Cell.of({});
        const hostileBody = Cell.of({ text: "hostile body" });
        const dialog = llmDialog({
          system: "Safe demo parent.",
          messages,
          builtinTools: false,
          observationMaxConfidentiality: ["internal"],
          tools: {
            readRawBriefing: {
              description: "Read the briefing.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              } as const satisfies JSONSchema,
              handler: readRawBriefing({
                title: "Briefing",
                source: "https://example.invalid",
                body: {
                  redacted: true,
                  nextStep: "Use subAgent.",
                },
              }),
            } as unknown as BuiltInLLMTool,
            subAgent: {
              description:
                "Run a higher-clearance worker and return schema-limited JSON.",
              ...(patternTool(subAgentPattern, {
                body: hostileBody,
                emails,
                route: "safe-child",
              }) as unknown as BuiltInLLMTool),
            },
            sendMail: {
              description: "Send an email.",
              inputSchema: {
                type: "object",
                properties: {
                  recipient: { type: "string" },
                  subject: { type: "string" },
                  body: { type: "string" },
                },
                required: ["recipient", "subject", "body"],
                additionalProperties: false,
              } as const satisfies JSONSchema,
              handler: sendMail({ sent, route: "parent" }),
            } as unknown as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          messages,
          flattenedTools: dialog.flattenedTools,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-safe-demo-tool-catalog-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const flattenedTools = await result.key("flattenedTools").pull();
    expect(Object.keys(flattenedTools ?? {}).sort()).toEqual([
      "readRawBriefing",
      "sendMail",
      "subAgent",
    ]);

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Start the safe workflow." });

    await waitForLlmMessages(runtime, result, 2);
    const messages = (await result.key("messages").pull())!;
    expect(messages.at(-1)?.content).toBe("Tool catalog is available.");
  });

  it("should deny low-ceiling tools after internal-conf tool results", async () => {
    loadConversationFixture({
      description: "readInternal then deny publicOnly then finish",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            hasTools: ["readInternal", "publicOnly"],
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_read_internal",
              toolName: "readInternal",
              input: {},
            }],
            id: "deny-r1",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 3 },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_public_only",
              toolName: "publicOnly",
              input: {},
            }],
            id: "deny-r2",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 5 },
          response: {
            role: "assistant",
            content: "Denied as expected.",
            id: "deny-r3",
          },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const readInternal = pattern(
      () => {
        return { note: "internal-only" };
      },
      { type: "object" },
      {
        type: "object",
        properties: {
          note: { type: "string" },
        },
        required: ["note"],
        ifc: { confidentiality: ["internal"] },
      } as const satisfies JSONSchema,
    );

    const publicOnly = pattern(
      () => {
        return { ok: true };
      },
      {
        type: "object",
        ifc: { maxConfidentiality: ["public"] },
      } as const satisfies JSONSchema,
      {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
      } as const satisfies JSONSchema,
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          observationMaxConfidentiality: ["internal"],
          tools: {
            readInternal: patternTool(
              readInternal,
            ) as unknown as BuiltInLLMTool,
            publicOnly: patternTool(publicOnly) as unknown as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-observation-deny-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Start the workflow." });

    await waitForLlmMessages(runtime, result, 6);

    const messages = (await result.key("messages").pull())!;
    expect(messages[4].role).toBe("tool");
    expect((messages[4].content as any)[0].toolName).toBe("publicOnly");
    expect((messages[4].content as any)[0].output.type).toBe("error-text");
    expect((messages[4].content as any)[0].output.value).toContain(
      "Tool call denied",
    );
    expect(messages[5].content).toBe("Denied as expected.");
  });

  it("should support pinning cells via pin tool", async () => {
    loadConversationFixture({
      description: "Pin tool: pin a cell via tool call",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            lastMessageContains: "pin this cell",
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "pin_call_1",
              toolName: "pin",
              input: { path: { "@link": "/of:test123" }, name: "Test Cell" },
            }],
            id: "r1",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 3 },
          response: {
            role: "assistant",
            content: "Cell has been pinned successfully.",
            id: "r2",
          },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        pinnedCells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-pin-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    addMessage.send({ role: "user", content: "Please pin this cell" });
    await waitForLlmMessages(runtime, result, 4);

    const pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells).toBeDefined();
    expect(Array.isArray(pinnedCells)).toBe(true);
    expect(pinnedCells?.length).toBe(1);
    expect(pinnedCells?.[0].path).toBe("/of:test123");
    expect(pinnedCells?.[0].name).toBe("Test Cell");
  });

  it("should support unpinning cells via unpin tool", async () => {
    loadConversationFixture({
      description: "Unpin tool: pin then unpin a cell",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            lastMessageContains: "pin this cell",
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "pin_call_unpin_test",
              toolName: "pin",
              input: { path: { "@link": "/of:test123" }, name: "Test Cell" },
            }],
            id: "r1",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 3 },
          response: {
            role: "assistant",
            content: "Cell has been pinned.",
            id: "r2",
          },
        },
        {
          type: "sendRequest",
          expectRequest: {
            lastMessageContains: "unpin that cell",
            messageCount: 5,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "unpin_call_1",
              toolName: "unpin",
              input: { path: { "@link": "/of:test123" } },
            }],
            id: "r3",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 7 },
          response: {
            role: "assistant",
            content: "Cell has been unpinned.",
            id: "r4",
          },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        pinnedCells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-unpin-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // First pin a cell
    addMessage.send({ role: "user", content: "Please pin this cell" });
    await waitForLlmMessages(runtime, result, 4);

    let pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells?.length).toBe(1);
    expect(pinnedCells?.[0].path).toBe("/of:test123");

    // Now unpin it
    addMessage.send({ role: "user", content: "Please unpin that cell" });
    await waitForLlmMessages(runtime, result, 8);

    pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells).toBeDefined();
    expect(Array.isArray(pinnedCells)).toBe(true);
    expect(pinnedCells?.length).toBe(0);
  });

  it("should include context cells in system prompt", async () => {
    const initialMessage = "What context do you have?";

    let capturedSystemPrompt = "";

    // Mock response that captures the system prompt
    addMockResponse(
      (req) => {
        capturedSystemPrompt = req.system || "";
        return true;
      },
      {
        role: "assistant",
        content: "I have access to the context cells.",
        id: "mock-context-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        pinnedCells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;
    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const contextCell = Cell.of(
          { value: "test context data" },
          {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          } as const satisfies JSONSchema,
        );
        const dialog = llmDialog({
          messages,
          context: {
            testContext: contextCell,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-context-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Send message
    addMessage.send({
      role: "user",
      content: initialMessage,
    });

    // Wait for response
    await waitForLlmMessages(runtime, result, 2);

    // Verify context cells appear in pinnedCells output
    const pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells).toBeDefined();
    expect(Array.isArray(pinnedCells)).toBe(true);
    expect(pinnedCells?.length).toBe(1);
    expect(pinnedCells?.[0].name).toBe("testContext");
    expect(pinnedCells?.[0].path).toContain("/of:");

    // Verify system prompt includes context cells
    expect(capturedSystemPrompt).toContain("# Available Cells");
    expect(capturedSystemPrompt).toContain("testContext");
    expect(capturedSystemPrompt).toContain("test context data");
  });

  it("should merge context and pinned cells in system prompt", async () => {
    const initialMessage = "Tell me about available cells";
    const cellPath = "/of:pinned123";
    const cellName = "Pinned Cell";

    let capturedSystemPrompt = "";

    // Mock response for initial message
    addMockResponse(
      (req) => {
        const lastMsg = req.messages[req.messages.length - 1];
        return (
          typeof lastMsg.content === "string" &&
          lastMsg.content.includes(initialMessage)
        );
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "pin_call_2",
            toolName: "pin",
            input: {
              path: { "@link": cellPath },
              name: cellName,
            },
          },
        ],
        id: "mock-pin-merge-response",
      },
    );

    // Mock response after pin (captures system prompt)
    addMockResponse(
      (req) => {
        capturedSystemPrompt = req.system || "";
        const toolMsg = req.messages.find(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((c) =>
              c.type === "tool-call" && c.toolName === "pin"
            ),
        );
        return !!toolMsg;
      },
      {
        role: "assistant",
        content: "I can see both context and pinned cells now.",
        id: "mock-merge-final-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        pinnedCells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;
    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const contextCell = Cell.of(
          { value: "context data" },
          {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          } as const satisfies JSONSchema,
        );
        const dialog = llmDialog({
          messages,
          context: {
            contextCell,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-merge-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Send message to trigger pin
    addMessage.send({
      role: "user",
      content: initialMessage,
    });

    // Wait for: user message, assistant tool call, tool result, final response
    await waitForLlmMessages(runtime, result, 4);

    // Verify pinnedCells output contains both context cell and tool-pinned cell
    const pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells).toBeDefined();
    expect(Array.isArray(pinnedCells)).toBe(true);
    expect(pinnedCells?.length).toBe(2);
    // Context cell should be first
    expect(pinnedCells?.[0].name).toBe("contextCell");
    expect(pinnedCells?.[0].path).toContain("/of:");
    // Tool-pinned cell should be second
    expect(pinnedCells?.[1].name).toBe(cellName);
    expect(pinnedCells?.[1].path).toBe(cellPath);

    // Verify system prompt includes both context and pinned cells
    expect(capturedSystemPrompt).toContain("# Available Cells");
    expect(capturedSystemPrompt).toContain("contextCell");
    expect(capturedSystemPrompt).toContain("context data");
    // Note: Pinned cell won't appear in system prompt on first request,
    // only after it's been pinned and the next LLM request is made
  });

  it("should omit built-in tools and guidance when builtinTools is false", async () => {
    let capturedRequest: any;

    addMockResponse(
      (req) => {
        capturedRequest = req;
        return true;
      },
      {
        role: "assistant",
        content: "Using only custom tools.",
        id: "mock-no-builtins-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        flattenedTools: {
          type: "object",
          additionalProperties: true,
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const pingTool = pattern(
      () => "pong",
      { type: "object" },
      { type: "string" },
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          builtinTools: false,
          system: "Base system prompt.",
          tools: {
            ping: patternTool(pingTool) as unknown as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          flattenedTools: dialog.flattenedTools,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-no-builtins-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({
      role: "user",
      content: "Reply without built-in tools.",
    });

    await waitForLlmMessages(runtime, result, 2);

    expect(capturedRequest).toBeDefined();
    expect(Object.keys(capturedRequest.tools ?? {})).toEqual(["ping"]);
    expect(capturedRequest.system).not.toContain("# Link and Cell Model");
    expect(capturedRequest.system).not.toContain("call listItems()");

    const flattenedTools = await result.key("flattenedTools").pull();
    expect(Object.keys(flattenedTools ?? {})).toEqual(["ping"]);
  });

  it("should keep pattern-supplied tools out of its standing guidance", async () => {
    const requests: any[] = [];

    addMockResponse(
      (req) => {
        requests.push(req);
        return true;
      },
      {
        role: "assistant",
        content: "Noted.",
        id: "mock-guidance-scope-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const listItemsTool = pattern(
      () => "items",
      { type: "object" },
      { type: "string" },
    );

    // The dialog's own guidance describes what the dialog provides. A tool the
    // pattern supplies is the pattern's to introduce, in the system prompt it
    // passes — the dialog naming one would be guidance it cannot keep true.
    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          tools: {
            listItems: patternTool(
              listItemsTool,
            ) as unknown as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-guidance-scope-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Something vague." });

    await waitForLlmMessages(runtime, result, 2);

    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].system).not.toContain("listItems");
    // The guidance for what the dialog does provide is unaffected.
    expect(requests[0].system).toContain("# Link and Cell Model");
  });

  it("should advertise presentResult whenever a resultSchema is given", async () => {
    let capturedRequest: any;

    addMockResponse(
      (req) => {
        capturedRequest = req;
        return true;
      },
      {
        role: "assistant",
        content: "Noted.",
        id: "mock-present-result-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const pingTool = pattern(
      () => "pong",
      { type: "object" },
      { type: "string" },
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          // presentResult rides resultSchema, not this flag: with the six
          // built-ins off it must still be advertised.
          builtinTools: false,
          resultSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
          tools: {
            ping: patternTool(pingTool) as unknown as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-present-result-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Give me a structured answer." });

    await waitForLlmMessages(runtime, result, 2);

    expect(capturedRequest).toBeDefined();
    expect(Object.keys(capturedRequest.tools ?? {}).sort()).toEqual([
      "ping",
      "presentResult",
    ]);
    expect(capturedRequest.tools.presentResult.inputSchema.properties.answer)
      .toBeDefined();
  });

  it("should omit built-in tools even when llmDialog params are cast to any", async () => {
    let capturedRequest: any;

    addMockResponse(
      (req) => {
        capturedRequest = req;
        return true;
      },
      {
        role: "assistant",
        content: "Using only custom tools.",
        id: "mock-no-builtins-any-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        flattenedTools: {
          type: "object",
          additionalProperties: true,
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const pingTool = pattern(
      () => "pong",
      { type: "object" },
      { type: "string" },
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          builtinTools: false,
          system: "Base system prompt.",
          tools: {
            ping: patternTool(pingTool) as unknown as BuiltInLLMTool,
          },
        } as any);
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          flattenedTools: dialog.flattenedTools,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-no-builtins-any-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({
      role: "user",
      content: "Reply without built-in tools.",
    });

    await waitForLlmMessages(runtime, result, 2);

    expect(capturedRequest).toBeDefined();
    expect(Object.keys(capturedRequest.tools ?? {})).toEqual(["ping"]);

    const flattenedTools = await result.key("flattenedTools").pull();
    expect(Object.keys(flattenedTools ?? {})).toEqual(["ping"]);
  });

  it("should expose handler-based custom tools in flattenedTools", async () => {
    let capturedRequest: any;

    addMockResponse(
      (req) => {
        capturedRequest = req;
        return true;
      },
      {
        role: "assistant",
        content: "Using handler tools.",
        id: "mock-handler-tool-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        flattenedTools: {
          type: "object",
          additionalProperties: true,
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const pingHandler = handler(
      {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      {},
      () => "pong",
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          builtinTools: false,
          system: "Base system prompt.",
          tools: {
            ping: {
              description: "Ping the system.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              handler: pingHandler({}),
            } as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          flattenedTools: dialog.flattenedTools,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-handler-tools-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({
      role: "user",
      content: "Reply with handler tools available.",
    });

    await waitForLlmMessages(runtime, result, 2);

    expect(capturedRequest).toBeDefined();
    expect(Object.keys(capturedRequest.tools ?? {})).toEqual(["ping"]);

    const flattenedTools = await result.key("flattenedTools").pull();
    expect(Object.keys(flattenedTools ?? {})).toEqual(["ping"]);
    expect(flattenedTools?.ping).toMatchObject({
      description: "Ping the system.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it("bounds tool-loop follow-up turns by the deployment sink ceiling (#3993 review)", async () => {
    // A tool-bearing dialog reads a labeled cell during a follow-up turn. The
    // pattern declares a generous observation bound (["internal"]), so without a
    // deployment ceiling the internal note would ship to the LLM in turn 2 — the
    // initial-request ceiling never gates these post-commit tool reads. With a
    // deployment ceiling of llmDialog: [] (public-only) the effective bound must
    // collapse to [] (pattern ∧ deployment) and the note must be redacted.
    const secret = "internal-only-secret-payload";

    let turn2Request: { messages: readonly BuiltInLLMMessage[] } | undefined;
    addMockResponse(
      (req) =>
        req.messages.length === 1 && req.tools?.["readInternal"] !== undefined,
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_read_internal_ceiling",
          toolName: "readInternal",
          input: {},
        }],
        id: "ceiling-turn-1",
      },
    );
    addMockResponse(
      (req) => {
        const matches = req.messages.some((m) =>
          m.role === "tool" && Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolName === "readInternal"
          )
        );
        if (matches) {
          turn2Request = { messages: req.messages };
        }
        return matches;
      },
      {
        role: "assistant",
        content: "Done.",
        id: "ceiling-turn-2",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const readInternal = pattern(
      () => {
        return { note: secret };
      },
      { type: "object" },
      {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        ifc: { confidentiality: ["internal"] },
      } as const satisfies JSONSchema,
    );

    const ceilingStorageManager = StorageManager.emulate({ as: signer });
    const ceilingRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: ceilingStorageManager,
      // Deployment ceiling: the llmDialog sink may carry no confidentiality.
      cfcSinkMaxConfidentiality: { llmDialog: [] },
    });
    const ceilingTx = ceilingRuntime.edit();
    const { commonfabric } = createTrustedBuilder(ceilingRuntime);

    try {
      const testPattern = commonfabric.pattern(
        () => {
          const messages = commonfabric.Cell.of<BuiltInLLMMessage[]>([]);
          const dialog = commonfabric.llmDialog({
            messages,
            // Generous pattern-supplied bound — would let "internal" ship.
            observationMaxConfidentiality: ["internal"],
            tools: {
              readInternal: commonfabric.patternTool(
                readInternal,
              ) as unknown as BuiltInLLMTool,
            },
          });
          return {
            addMessage: dialog.addMessage,
            pending: dialog.pending,
            messages,
          };
        },
        false,
        resultSchema,
      );

      const resultCell = ceilingRuntime.getCell(
        space,
        "llmDialog-sink-ceiling-tool-loop-test",
        resultSchema,
        ceilingTx,
      );

      const result = ceilingRuntime.run(ceilingTx, testPattern, {}, resultCell);
      ceilingTx.commit();

      const addMessage = await result.key("addMessage").pull();
      addMessage.send({ role: "user", content: "Read the briefing." });

      // user, assistant(tool-call), tool(result), assistant(final).
      await waitForLlmMessages(ceilingRuntime, result, 4);

      const messages = (await result.key("messages").pull())!;
      const toolMessage = messages[2];
      expect(toolMessage.role).toBe("tool");
      // The tool EXECUTED (it was not denied and did not error) — the leak is
      // prevented by redacting its labeled result to an opaque link, so a
      // failed invocation must not masquerade as a successful redaction.
      const output = (toolMessage.content as any)[0].output;
      expect(output.type).toBe("json");
      expect(JSON.stringify(output.value)).toContain("@link");
      const toolText = JSON.stringify(toolMessage.content);
      // The secret must not appear in the tool-result that feeds turn 2.
      expect(toolText).not.toContain(secret);

      // And the actual follow-up request the LLM saw must not carry it either.
      expect(turn2Request).toBeDefined();
      expect(JSON.stringify(turn2Request!.messages)).not.toContain(secret);
    } finally {
      await ceilingTx.commit();
      await ceilingRuntime.idle();
      await ceilingRuntime.dispose();
      await ceilingStorageManager.close();
    }
  });
  it("should expose a userland subagent in llmDialog tool catalogs", async () => {
    const childResultSchema = {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["approved", "summary"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    loadConversationFixture({
      description: "llmDialog subAgent tool should be available to the parent",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            hasTools: ["delegate"],
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_delegate",
              toolName: "delegate",
              input: {
                prompt: "analyze the hidden text",
                resultSchema: childResultSchema,
              },
            }],
            id: "dlg-subagent-r1",
          },
        },
        {
          type: "sendRequest",
          expectRequest: {
            hasTools: ["helperTool", "presentResult"],
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_child_present",
              toolName: "presentResult",
              input: {
                approved: false,
                summary: "Not approved.",
              },
            }],
            id: "dlg-subagent-r2",
          },
        },
        {
          type: "sendRequest",
          expectRequest: {
            hasTools: ["delegate"],
            messageCount: 3,
          },
          response: {
            role: "assistant",
            content: "Delegate completed.",
            id: "dlg-subagent-r3",
          },
        },
      ],
    });

    const helperTool = pattern(
      () => ({ ok: true }),
      {
        type: "object",
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      } as const satisfies JSONSchema,
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const subAgentPattern = pattern<any, any>(
      ({ prompt, resultSchema }) => {
        return generateObject({
          prompt,
          schema: resultSchema,
          tools: {
            helperTool: patternTool(
              helperTool,
            ) as unknown as BuiltInLLMTool,
          },
        } as any).result;
      },
      {
        type: "object",
        properties: {
          prompt: { type: "string" },
          resultSchema: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["prompt", "resultSchema"],
        additionalProperties: false,
      },
      true,
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          tools: {
            delegate: {
              description: "Run a child agent and return schema-limited JSON.",
              ...(patternTool(subAgentPattern) as unknown as BuiltInLLMTool),
            },
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-subagent-tool-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Start the workflow." });

    await waitForLlmMessages(runtime, result, 4);
    const messages = (await result.key("messages").pull())!;
    // The conversation reaches its third request whether the delegate returned
    // data or an error, so the closing assertion below cannot see an abandoned
    // delegate. Assert on the tool result itself: a completed delegate reports
    // `{ type: "json", ... }`, an abandoned one reports
    // `{ type: "error-text", ... }`.
    const toolMessage = messages.find((message: any) =>
      message.role === "tool"
    );
    const delegateOutput = (toolMessage?.content as any[])?.find((part) =>
      part?.type === "tool-result" && part.toolName === "delegate"
    )?.output;
    expect(delegateOutput).toMatchObject({ type: "json" });
    expect(messages.at(-1)?.content).toBe("Delegate completed.");
  });
});
