import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { Stream } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { LLMClient } from "@commonfabric/llm/client";

import type { Cell } from "../src/cell.ts";
import { PARTIAL_BATCH_MS } from "../src/builtins/llm.ts";
import { resolveLocalProgram } from "../src/harness/local-program.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { UI } from "../src/shared.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

interface ChatNoteResult {
  [UI]: unknown;
  content: string;
  isGenerating: boolean;
  editContent: Stream<{ detail: { value: string } }>;
}

describe("Chat Note availability", () => {
  async function startNote(content: string) {
    const signer = await Identity.fromPassphrase("chat note availability");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: fromFileUrl(
            new URL(
              "../../patterns/experimental/chat-note.tsx",
              import.meta.url,
            ),
          ),
        },
      );
      const compiled = await runtime.patternManager.compileOrGetPattern(
        program,
        signer.did(),
      );
      await runtime.patternManager.flushCompileCacheWrites();
      const tx = runtime.edit();
      const home = runtime.getHomeSpaceCell(tx);
      const catalog = runtime.getCell(
        signer.did(),
        "chat note catalog",
        undefined,
        tx,
      );
      catalog.set({ pieceRegistry: [], backlinksIndex: { mentionable: [] } });
      home.key("defaultPattern").set(catalog);
      runtime.getCell(signer.did(), signer.did(), undefined, tx)
        .key("defaultPattern").set(catalog);
      const cell = runtime.getCell<ChatNoteResult>(
        signer.did(),
        "chat note subject",
        compiled.resultSchema,
        tx,
      );
      const result = runtime.run(tx, compiled, { content }, cell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await waitForCellValue(
        runtime,
        result.key("content"),
        (v) => v === content,
      );
      await runtime.idle();
      return { runtime, storageManager, result };
    } catch (error) {
      await runtime.dispose();
      await storageManager.close();
      throw error;
    }
  }

  function generate(result: Cell<ChatNoteResult>) {
    const shortcut = result.key(UI).key("children").key(1);
    expect(shortcut.key("name").get()).toBe("cf-keybind");
    expect(shortcut.key("props").key("code").get()).toBe("Enter");
    shortcut.key("props").key("oncf-keybind").send({});
  }

  it("restores a failed streamed draft and retries the same user prompt", async () => {
    const prompt = "What is a reactive cell?";
    const { runtime, storageManager, result } = await startNote(prompt);
    const started = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<never>();
    let requestCount = 0;
    const provider = stub(
      LLMClient.prototype,
      "sendRequest",
      async (_, partial) => {
        if (++requestCount === 1) {
          partial?.("unfinished answer");
          started.resolve();
          return await failure.promise;
        }
        return {
          role: "assistant" as const,
          content: "complete answer",
          id: "retry",
        };
      },
    );
    try {
      generate(result);
      await started.promise;
      await waitForCellValue<string>(
        runtime,
        result.key("content"),
        (value) => value?.endsWith("unfinished answer") === true,
      );
      failure.reject(new Error("provider unavailable"));
      await waitForCellValue(runtime, result.key("isGenerating"), (v) => !v);
      expect(result.key("content").get()).toBe(prompt);

      generate(result);
      await waitForCellValue(
        runtime,
        result.key("content"),
        (value) => value === `${prompt}\n---\n## AI\ncomplete answer\n---\n`,
      );
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[1].args[0].messages).toEqual(
        provider.calls[0].args[0].messages,
      );
      expect(result.key("isGenerating").get()).toBe(false);
    } finally {
      failure.reject(new Error("test disposed"));
      provider.restore();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  for (const outcome of ["error", "success"] as const) {
    it(`preserves an edit through later streaming and ${outcome}`, async () => {
      const { runtime, storageManager, result } = await startNote(
        "Initial prompt",
      );
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<
        Awaited<ReturnType<LLMClient["sendRequest"]>>
      >();
      let publish: Parameters<LLMClient["sendRequest"]>[1];
      const provider = stub(
        LLMClient.prototype,
        "sendRequest",
        (_, partial) => {
          publish = partial;
          partial?.("first draft");
          started.resolve();
          return finish.promise;
        },
      );
      try {
        generate(result);
        await started.promise;
        await waitForCellValue<string>(
          runtime,
          result.key("content"),
          (value) => value?.endsWith("first draft") === true,
        );
        result.key("editContent").send({
          detail: { value: "Concurrent edit" },
        });
        await waitForCellValue(
          runtime,
          result.key("content"),
          (value) => value === "Concurrent edit",
        );
        if (!publish) throw new Error("Expected a streaming provider callback");
        publish("later draft");
        await clock.tick(PARTIAL_BATCH_MS);
        await runtime.idle();
        expect(result.key("content").get()).toBe("Concurrent edit");

        if (outcome === "error") {
          finish.reject(new Error("provider unavailable"));
        } else {
          finish.resolve({
            role: "assistant",
            content: "final answer",
            id: "edit",
          });
        }
        await waitForCellValue(runtime, result.key("isGenerating"), (v) => !v);
        expect(result.key("content").get()).toBe("Concurrent edit");
        expect(provider.calls).toHaveLength(1);
      } finally {
        finish.reject(new Error("test disposed"));
        provider.restore();
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }
});
