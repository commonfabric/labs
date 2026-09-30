import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { clearMockResponses, enableMockMode } from "@commonfabric/llm/client";
import type { BuiltInLLMMessage, BuiltInLLMTool } from "@commonfabric/api";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { llmDialog as rawLlmDialog } from "../src/builtins/llm-dialog.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

enableMockMode();

describe("llmDialog demand and idempotency", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let builder: ReturnType<typeof createBuilder>["commonfabric"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ commonfabric: builder } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.settled();
    // `dispose()` closes the storage manager the runtime was given.
    await runtime?.dispose();
  });

  it("writes the same tool catalog on a second run over the same inputs", async () => {
    const { Cell, llmDialog, pattern, patternTool } = builder;
    const echo = pattern(
      () => "pong",
      { type: "object" },
      { type: "string" },
    );

    const testPattern = pattern(() => {
      const messages = Cell.of<BuiltInLLMMessage[]>([]);
      const dialog = llmDialog({
        messages,
        system: "Base system prompt.",
        tools: {
          ping: {
            description: "Run the echo worker.",
            ...patternTool(echo, {
              system: "You are a worker.",
              observationMaxConfidentiality: [
                { type: "atom", class: "RiskA", subject: "did:example:a" },
                { type: "atom", class: "RiskB", subject: "did:example:b" },
              ],
            }),
          } as unknown as BuiltInLLMTool,
        },
      });
      return { flattenedTools: dialog.flattenedTools, messages };
    });

    const resultCell = runtime.getCell(
      space,
      "llmDialog-idempotency",
      {
        type: "object",
        properties: { flattenedTools: { type: "object" } },
      } as const,
      tx,
    );
    runtime.run(tx, testPattern, {}, resultCell);
    await tx.commit();
    await runtime.idle();

    const report = await runtime.scheduler.runIdempotencyCheck();
    if (report.nonIdempotent.length > 0) {
      console.error(
        JSON.stringify(report.nonIdempotent, null, 2).slice(0, 3000),
      );
    }
    expect(report.nonIdempotent).toEqual([]);
  });
  it("declares the caller's messages cell as a write it materializes", async () => {
    // A pattern may render `messages` without ever reading what the dialog
    // returns. Declaring the write is what keeps the node scheduled there:
    // `scheduler-effects.test.ts` pins that a computation carrying an
    // envelope runs without downstream demand.
    const messages = runtime.getCell<BuiltInLLMMessage[]>(
      space,
      "envelope-messages",
      undefined,
      tx,
    );
    messages.set([]);
    const inputsCell = runtime.getCell<Record<string, unknown>>(
      space,
      "envelope-inputs",
      undefined,
      tx,
    );
    inputsCell.set({ messages, system: "Base system prompt." });
    const parentCell = runtime.getCell<unknown>(
      space,
      "envelope-parent",
      undefined,
      tx,
    );
    await tx.commit();

    const built = rawLlmDialog(
      inputsCell as never,
      () => {},
      () => {},
      "envelope-cause",
      parentCell as never,
      runtime,
    );
    const envelopes =
      (built.action as { materializerWriteEnvelopes?: { id: string }[] })
        .materializerWriteEnvelopes ?? [];

    expect(envelopes.map((link) => link.id)).toContain(
      messages.getAsNormalizedFullLink().id,
    );
  });
});
