import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import { LLMToolSchema } from "../src/builtins/llm-schemas.ts";
import { llmToolExecutionHelpers } from "../src/builtins/llm-dialog.ts";
import { RetryWhenReady } from "../src/scheduler/retry-when-ready.ts";
import {
  createTrustedBuilder,
  installTestPatternArtifact,
} from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("cold direct llm factory tool");
const space = signer.did();
const sourceSigner = await Identity.fromPassphrase(
  "cold direct llm factory tool source",
);
const sourceSpace = sourceSigner.did();

Deno.test("a cold direct PatternFactory tool parks catalog construction until its source artifact loads", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const factory = installTestPatternArtifact(
      runtime,
      commonfabric.pattern<{ query: string }, { answer: string }>(
        ({ query }) => ({ answer: query }),
        {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      ),
    );
    const state = sealFactoryState(factory);
    const ref = state.ref;
    let warm = false;
    let loads = 0;
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      artifactSpace,
    ) => identity === ref.identity && artifactSpace === sourceSpace;
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warm && identity === ref.identity && symbol === ref.symbol
        ? factory
        : undefined;
    runtime.patternManager.loadArtifactByIdentity = (
      identity,
      symbol,
      artifactSpace,
    ) => {
      expect({ identity, symbol }).toEqual(ref);
      expect(artifactSpace).toBe(sourceSpace);
      loads++;
      warm = true;
      return Promise.resolve(factory);
    };

    const sourceTx = runtime.edit();
    const sourceFactory = runtime.getCell<unknown>(
      sourceSpace,
      "cold-direct-factory-source",
      undefined,
      sourceTx,
    );
    sourceFactory.set(createFactoryShell(state));
    const { error: sourceError } = await sourceTx.commit().settled;
    expect(sourceError).toBeUndefined();

    const destinationTx = runtime.edit();
    const tools = runtime.getCell<Record<string, unknown>>(
      space,
      "cold-direct-factory-tools",
      { type: "object", additionalProperties: LLMToolSchema },
      destinationTx,
    );
    tools.set({ coldSearch: sourceFactory });
    const { error: destinationError } = await destinationTx.commit().settled;
    expect(destinationError).toBeUndefined();

    let retry: RetryWhenReady | undefined;
    try {
      llmToolExecutionHelpers.buildToolCatalog(tools as never, false);
    } catch (error) {
      expect(error).toBeInstanceOf(RetryWhenReady);
      retry = error as RetryWhenReady;
    }
    expect(retry).toBeDefined();
    await retry!.readiness;
    expect(loads).toBe(1);

    const catalog = llmToolExecutionHelpers.buildToolCatalog(
      tools as never,
      false,
    );
    expect(catalog.llmTools.coldSearch?.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    const [invocation] = await llmToolExecutionHelpers.executeToolCalls(
      runtime,
      space,
      catalog,
      [{
        type: "tool-call",
        toolCallId: "cold-cross-space-call",
        toolName: "coldSearch",
        input: { query: "cross-space" },
      }],
    );
    expect(invocation?.error).toBeUndefined();
    expect(invocation?.result).toMatchObject({
      type: "json",
      value: { result: { answer: "cross-space" } },
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("cancelling a cold PatternFactory tool prevents execution after loading", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    let executions = 0;
    const factory = installTestPatternArtifact(
      runtime,
      commonfabric.pattern<{ query: string }, { answer: string }>(
        ({ query }) => {
          executions++;
          return { answer: query };
        },
        {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      ),
    );
    const state = sealFactoryState(factory);
    const ref = state.ref;
    let warm = true;
    const loadStarted = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      artifactSpace,
    ) => identity === ref.identity && artifactSpace === sourceSpace;
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warm && identity === ref.identity && symbol === ref.symbol
        ? factory
        : undefined;
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      artifactSpace,
    ) => {
      expect({ identity, symbol }).toEqual(ref);
      expect(artifactSpace).toBe(sourceSpace);
      loadStarted.resolve();
      await releaseLoad.promise;
      warm = true;
      return factory;
    };

    const sourceTx = runtime.edit();
    const sourceFactory = runtime.getCell<unknown>(
      sourceSpace,
      "cancelled-cold-factory-source",
      undefined,
      sourceTx,
    );
    sourceFactory.set(createFactoryShell(state));
    expect((await sourceTx.commit().settled).error).toBeUndefined();

    const destinationTx = runtime.edit();
    const tools = runtime.getCell<Record<string, unknown>>(
      space,
      "cancelled-cold-factory-tools",
      { type: "object", additionalProperties: LLMToolSchema },
      destinationTx,
    );
    tools.set({ coldSearch: sourceFactory });
    expect((await destinationTx.commit().settled).error).toBeUndefined();

    const catalog = llmToolExecutionHelpers.buildToolCatalog(
      tools as never,
      false,
    );
    const executionsBeforeInvoke = executions;
    warm = false;
    const abort = new AbortController();
    const execution = llmToolExecutionHelpers.executeToolCalls(
      runtime,
      space,
      catalog,
      [{
        type: "tool-call",
        toolCallId: "cancelled-cold-call",
        toolName: "coldSearch",
        input: { query: "do not run" },
      }],
      undefined,
      undefined,
      undefined,
      abort.signal,
    );
    await loadStarted.promise;
    abort.abort();
    releaseLoad.resolve();

    const [invocation] = await execution;
    expect(invocation?.error).toContain("cancelled");
    expect(executions).toBe(executionsBeforeInvoke);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
