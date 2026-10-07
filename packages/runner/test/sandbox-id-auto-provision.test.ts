/**
 * Verifies the framework auto-provides a stable, per-instance `sandboxId` to
 * tools that declare it (the bash tool's contract), instead of patterns minting
 * one from entropy.
 *
 * The contract under test: the framework provides the id *whenever the tool
 * declares a `sandboxId` input and the author does not*. So three cases:
 *   A. declares `sandboxId`, author does not pre-fill  -> framework provides it,
 *      and the id is non-empty, resource-safe, identical across an instance's
 *      calls (one persistent sandbox), distinct between instances (no
 *      cross-instance/user sharing), and overrides any model-supplied value
 *      (the model cannot target another instance's sandbox).
 *   B. declares `sandboxId`, author pre-fills via extraParams -> framework
 *      defers to the author's value.
 *   C. does not declare `sandboxId` -> framework injects nothing.
 *
 * Observation: handleInvoke creates each tool's result cell with the tool-call
 * id as its cause (`runtime.getCell(space, toolCall.id, ...)`). The echo tool
 * returns the `sandboxId` it received, so re-deriving that cell by tool-call id
 * reads exactly what the bash tool would have sent to the sandbox service.
 *
 * The `sandboxId`-declaring schema here is the bash tool's exact argumentSchema
 * (five fields, `sandboxId` required alongside `command`); the real bash
 * pattern's runtime argumentSchema declares `sandboxId` the same way, so it
 * falls under case A when wired as `patternTool(bash)`.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  loadConversationFixture,
  resetMockMode,
} from "@commonfabric/llm/client";
import type { BuiltInLLMMessage, BuiltInLLMTool } from "@commonfabric/api";
import type { JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { llmToolExecutionHelpers } from "../src/builtins/llm-dialog.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { generateObjectState } from "../src/builder/built-in.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Mirrors the real bash tool's argumentSchema (packages/patterns/system/
// common-fabric.tsx): five fields with `sandboxId` required alongside
// `command`. Using bash's exact shape exercises the same gate input the bash
// tool presents at invoke time.
const BASH_LIKE_ARG_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    command: { type: "string" },
    workingDirectory: { type: "string" },
    timeout: { type: "number" },
    environment: {
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
    },
    // Same field name and "Automatically provided — do not set" contract.
    sandboxId: { type: "string" },
  },
  required: ["command", "sandboxId"],
};

// A tool that does NOT declare `sandboxId`; reads any extra input loosely.
const NO_SANDBOX_ARG_SCHEMA: JSONSchema = {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
  additionalProperties: true,
};

// `command` always settles the result; `received` is the sandboxId the tool
// got, which is absent when the framework injects nothing (case C).
const ECHO_RESULT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    received: { type: "string" },
    command: { type: "string" },
  },
  required: ["command"],
};

const PRESENT_SCHEMA: JSONSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

describe("auto-provided sandboxId", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let patternTool: ReturnType<
    typeof createBuilder
  >["commonfabric"]["patternTool"];
  let generateObject: typeof generateObjectState;

  beforeEach(() => {
    enableMockMode();
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
      patternTool,
    } = commonfabric);
    generateObject = generateObjectState;
  });

  afterEach(async () => {
    resetMockMode();
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Run one agent-loop instance that calls the echo tool once per entry in
  // `calls`, then finishes. Returns the `sandboxId` the tool received on each
  // call (read back from each tool result cell by its tool-call id).
  async function runInstance(opts: {
    tag: string;
    calls: Array<{ callId: string; modelInput: Record<string, unknown> }>;
    argSchema: JSONSchema;
    extraParams?: Record<string, unknown>;
  }): Promise<unknown[]> {
    const { tag, calls, argSchema, extraParams } = opts;
    clearMockResponses();
    loadConversationFixture({
      description: tag,
      responses: [
        ...calls.map((call, i) => ({
          type: "sendRequest" as const,
          response: {
            role: "assistant" as const,
            content: [{
              type: "tool-call" as const,
              toolCallId: call.callId,
              toolName: "echoSandbox",
              input: call.modelInput,
            }],
            id: `${tag}-s${i}`,
          },
        })),
        {
          type: "sendRequest" as const,
          response: {
            role: "assistant" as const,
            content: [{
              type: "tool-call" as const,
              toolCallId: `${tag}-present`,
              toolName: "presentResult",
              input: { ok: true },
            }],
            id: `${tag}-present-resp`,
          },
        },
      ],
    });

    const echoSandbox = pattern(
      ({ command, sandboxId }: { command: string; sandboxId: string }) => ({
        received: sandboxId,
        command,
      }),
      argSchema,
      ECHO_RESULT_SCHEMA,
    );

    const toolDef = extraParams
      ? patternTool(echoSandbox, extraParams as never)
      : patternTool(echoSandbox);

    const testPattern = pattern<Record<string, never>>(() =>
      generateObject({
        prompt: `auto-sandbox-${tag}`,
        schema: PRESENT_SCHEMA,
        tools: { echoSandbox: toolDef as unknown as BuiltInLLMTool },
      })
    );

    const runTx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      `auto-sandbox-instance-${tag}`,
      testPattern.resultSchema,
      runTx,
    );
    const result = runtime.run(runTx, testPattern, {}, resultCell);
    runTx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("error").get()).toBeUndefined();

    return calls.map((call) =>
      runtime.getCell(space, call.callId, ECHO_RESULT_SCHEMA)
        .key("received").get()
    );
  }

  it(
    "A: two patterns each call bash twice -> shared within a pattern, distinct across patterns",
    async () => {
      // The model supplies the SAME sandboxId on every call — an attempt to make
      // the four calls share one sandbox. It must be discarded.
      const modelPin = "shared-by-model";
      // Pattern 1 calls the tool twice.
      const [p1a, p1b] = await runInstance({
        tag: "p1",
        argSchema: BASH_LIKE_ARG_SCHEMA,
        calls: [
          {
            callId: "p1-1",
            modelInput: { command: "echo a", sandboxId: modelPin },
          },
          {
            callId: "p1-2",
            modelInput: { command: "echo b", sandboxId: modelPin },
          },
        ],
      });
      // Pattern 2 calls the tool twice.
      const [p2a, p2b] = await runInstance({
        tag: "p2",
        argSchema: BASH_LIKE_ARG_SCHEMA,
        calls: [
          {
            callId: "p2-1",
            modelInput: { command: "echo c", sandboxId: modelPin },
          },
          {
            callId: "p2-2",
            modelInput: { command: "echo d", sandboxId: modelPin },
          },
        ],
      });

      console.log("pattern 1 sandboxId (both calls):", p1a, "/", p1b);
      console.log("pattern 2 sandboxId (both calls):", p2a, "/", p2b);

      // All four ids are non-empty, resource-safe, and not the model value.
      for (const v of [p1a, p1b, p2a, p2b]) {
        expect(typeof v).toBe("string");
        expect((v as string).length).toBeGreaterThan(0);
        expect(v as string).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(v).not.toBe(modelPin);
      }
      // Within each pattern, the two bash calls share one sandbox.
      expect(p1a).toBe(p1b);
      expect(p2a).toBe(p2b);
      // Across the two patterns, the sandboxes are distinct.
      expect(p1a).not.toBe(p2a);
    },
  );

  it(
    "B: a pattern that pins sandboxId via extraParams is flagged as an error",
    async () => {
      // If a pattern could pin `sandboxId`, two patterns pinning the same value
      // would share one server-side sandbox — a cross-instance/user leak. Rather
      // than silently drop the pin, the framework rejects it so the authoring
      // mistake surfaces.
      let toolOutput: { type?: string; value?: unknown } | undefined;
      addMockResponse(
        (req) =>
          req.messages.some((m) =>
            typeof m.content === "string" && m.content.includes("pin-via-extra")
          ),
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: "pin-1",
            toolName: "echoSandbox",
            input: { command: "ls" },
          }],
          id: "pin-s0",
        },
      );
      addMockResponse(
        (req) => {
          const toolMsg = req.messages.find((m) => m.role === "tool") as
            | BuiltInLLMMessage
            | undefined;
          const content = Array.isArray(toolMsg?.content)
            ? toolMsg!.content[0] as {
              output?: { type?: string; value?: unknown };
            }
            : undefined;
          if (content?.output) toolOutput = content.output;
          return toolOutput !== undefined;
        },
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: "pin-present",
            toolName: "presentResult",
            input: { ok: true },
          }],
          id: "pin-s1",
        },
      );

      const echoSandbox = pattern(
        ({ command, sandboxId }: { command: string; sandboxId: string }) => ({
          received: sandboxId,
          command,
        }),
        BASH_LIKE_ARG_SCHEMA,
        ECHO_RESULT_SCHEMA,
      );
      const testPattern = pattern<Record<string, never>>(() =>
        generateObject({
          prompt: "pin-via-extra",
          schema: PRESENT_SCHEMA,
          tools: {
            echoSandbox: patternTool(
              echoSandbox,
              { sandboxId: "pinned-by-pattern" } as never,
            ) as unknown as BuiltInLLMTool,
          },
        })
      );

      const runTx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        "pin-via-extra-instance",
        testPattern.resultSchema,
        runTx,
      );
      const result = runtime.run(runTx, testPattern, {}, resultCell);
      runTx.commit();
      await waitForLlmSettled(runtime, result);

      // The bash call surfaced an error, not a silently-overridden result.
      expect(toolOutput?.type).toBe("error-text");
      expect(String(toolOutput?.value)).toContain("framework-provided");
    },
  );

  it(
    "C: does not declare sandboxId -> framework injects nothing",
    async () => {
      const [received] = await runInstance({
        tag: "nodecl",
        argSchema: NO_SANDBOX_ARG_SCHEMA,
        calls: [
          // Model sends no sandboxId; the framework must not fabricate one.
          { callId: "nodecl-1", modelInput: { command: "ls" } },
        ],
      });
      expect(received).toBeUndefined();
    },
  );

  it(
    "D: one pattern with two separate bash tools -> the two tools get distinct sandboxes",
    async () => {
      // Two distinct `patternTool(bash)` nodes (toolA, toolB) in a single
      // instance. The id is keyed to the tool-definition cell, so each node is
      // its own sandbox even within one pattern.
      clearMockResponses();
      loadConversationFixture({
        description: "two-tools",
        responses: [
          {
            type: "sendRequest",
            response: {
              role: "assistant",
              content: [{
                type: "tool-call",
                toolCallId: "d-A",
                toolName: "toolA",
                input: { command: "echo a" },
              }],
              id: "d-s0",
            },
          },
          {
            type: "sendRequest",
            response: {
              role: "assistant",
              content: [{
                type: "tool-call",
                toolCallId: "d-B",
                toolName: "toolB",
                input: { command: "echo b" },
              }],
              id: "d-s1",
            },
          },
          {
            type: "sendRequest",
            response: {
              role: "assistant",
              content: [{
                type: "tool-call",
                toolCallId: "d-present",
                toolName: "presentResult",
                input: { ok: true },
              }],
              id: "d-s2",
            },
          },
        ],
      });

      const echoSandbox = pattern(
        ({ command, sandboxId }: { command: string; sandboxId: string }) => ({
          received: sandboxId,
          command,
        }),
        BASH_LIKE_ARG_SCHEMA,
        ECHO_RESULT_SCHEMA,
      );

      const testPattern = pattern<Record<string, never>>(() =>
        generateObject({
          prompt: "two-bash-tools",
          schema: PRESENT_SCHEMA,
          tools: {
            toolA: patternTool(echoSandbox) as unknown as BuiltInLLMTool,
            toolB: patternTool(echoSandbox) as unknown as BuiltInLLMTool,
          },
        })
      );

      const runTx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        "two-bash-tools-instance",
        testPattern.resultSchema,
        runTx,
      );
      const result = runtime.run(runTx, testPattern, {}, resultCell);
      runTx.commit();

      await waitForLlmSettled(runtime, result);
      expect(result.key("error").get()).toBeUndefined();

      const recvA = runtime.getCell(space, "d-A", ECHO_RESULT_SCHEMA)
        .key("received").get() as unknown;
      const recvB = runtime.getCell(space, "d-B", ECHO_RESULT_SCHEMA)
        .key("received").get() as unknown;
      console.log("toolA sandboxId:", recvA);
      console.log("toolB sandboxId:", recvB);

      for (const v of [recvA, recvB]) {
        expect(typeof v).toBe("string");
        expect((v as string).length).toBeGreaterThan(0);
      }
      // Two distinct bash tool nodes -> two distinct sandboxes.
      expect(recvA).not.toBe(recvB);
    },
  );

  it(
    "E: the framework-provided field is stripped from the model-facing schema",
    async () => {
      // The model should never be asked for `sandboxId` — it can't set it.
      let toolJson: string | undefined;
      addMockResponse(
        (req) => {
          const tools = (req as { tools?: Record<string, unknown> }).tools;
          if (tools && tools.echoSandbox) {
            toolJson = JSON.stringify(tools.echoSandbox);
          }
          return toolJson !== undefined;
        },
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: "e-present",
            toolName: "presentResult",
            input: { ok: true },
          }],
          id: "e-s0",
        },
      );

      const echoSandbox = pattern(
        ({ command, sandboxId }: { command: string; sandboxId: string }) => ({
          received: sandboxId,
          command,
        }),
        BASH_LIKE_ARG_SCHEMA,
        ECHO_RESULT_SCHEMA,
      );
      const testPattern = pattern<Record<string, never>>(() =>
        generateObject({
          prompt: "strip-model-schema",
          schema: PRESENT_SCHEMA,
          tools: {
            echoSandbox: patternTool(echoSandbox) as unknown as BuiltInLLMTool,
          },
        })
      );

      const runTx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        "strip-model-schema-instance",
        testPattern.resultSchema,
        runTx,
      );
      const result = runtime.run(runTx, testPattern, {}, resultCell);
      runTx.commit();
      await waitForLlmSettled(runtime, result);

      console.log("model-facing echoSandbox schema:", toolJson);
      expect(toolJson).toBeDefined();
      // The model sees `command` but not the framework-provided `sandboxId`.
      expect(toolJson!).toContain("command");
      expect(toolJson!).not.toContain("sandboxId");
    },
  );
});

describe("framework-provided field helpers", () => {
  // Direct unit tests for the framework-provided-field helpers, covering the
  // defensive branches the dialog-driven cases above don't reach: malformed
  // schemas and the fail-closed path when no stable instance id can be derived.

  const { stripFrameworkProvidedFields, applyAutoProvidedSandboxId } =
    llmToolExecutionHelpers;

  // A pattern stub whose argumentSchema declares `sandboxId` (only the schema is
  // read by applyAutoProvidedSandboxId).
  const declaresSandboxId = {
    argumentSchema: {
      type: "object",
      properties: { command: {}, sandboxId: {} },
    },
  } as never;

  it("stripFrameworkProvidedFields: leaves a non-object schema unchanged", () => {
    const schema = true as unknown as JSONSchema;
    expect(stripFrameworkProvidedFields(schema)).toBe(schema);
  });

  it("stripFrameworkProvidedFields: leaves a schema with no properties unchanged", () => {
    const schema = { type: "object" } as JSONSchema;
    expect(stripFrameworkProvidedFields(schema)).toBe(schema);
  });

  it("stripFrameworkProvidedFields: removes sandboxId from properties and required, without mutating the input", () => {
    const schema = {
      type: "object",
      properties: {
        command: { type: "string" },
        sandboxId: { type: "string" },
      },
      required: ["command", "sandboxId"],
    } as JSONSchema;
    const out = stripFrameworkProvidedFields(schema) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(out.properties)).toEqual(["command"]);
    expect(out.required).toEqual(["command"]);
    // Input schema is not mutated.
    expect(
      (schema as { properties: Record<string, unknown> }).properties.sandboxId,
    ).toBeDefined();
  });

  it("stripFrameworkProvidedFields: leaves a schema without framework fields unchanged", () => {
    const schema = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    } as JSONSchema;
    expect(stripFrameworkProvidedFields(schema)).toBe(schema);
  });

  it("applyAutoProvidedSandboxId: no-op when the pattern does not declare sandboxId", () => {
    const args: Record<string, unknown> = { command: "ls" };
    applyAutoProvidedSandboxId(
      args,
      {
        argumentSchema: { type: "object", properties: { command: {} } },
      } as never,
      {},
      undefined,
    );
    expect(args).toEqual({ command: "ls" });
  });

  it("applyAutoProvidedSandboxId: rejects an author-pinned sandboxId via extraParams", () => {
    expect(() =>
      applyAutoProvidedSandboxId(
        { command: "ls" },
        declaresSandboxId,
        { sandboxId: "author-pinned" },
        undefined,
      )
    ).toThrow("framework-provided");
  });

  it("applyAutoProvidedSandboxId: fails closed when no stable entity id can be derived", () => {
    // No identity cell -> no entity id. The function must throw rather than fall
    // through to an empty, shared sandbox name.
    expect(() =>
      applyAutoProvidedSandboxId(
        { command: "ls" },
        declaresSandboxId,
        {},
        undefined,
      )
    ).toThrow("no stable entity id");
  });
});
