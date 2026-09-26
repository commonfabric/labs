import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { BuiltInLLMMessage } from "@commonfabric/api";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import {
  clearMockResponses,
  enableMockMode,
  loadConversationFixture,
} from "@commonfabric/llm/client";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { waitForLlmMessages } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runner-cfc-llm-derived-stamp");

// Epic D1 (docs/history/plans/cfc-future-work-implementation.md): model output must
// carry an explicit LlmDerived provenance stamp instead of representing
// untrust as mere absence of integrity. This file starts with the stamping
// MECHANISM kernel: a builtin-identity write through an item schema carrying
// ifc.addIntegrity persists the atom on exactly the written element — and
// only there (a sibling written through the plain schema stays unstamped).

const LLM_DERIVED_ATOM = {
  type: "https://commonfabric.org/cfc/atom/LlmDerived",
} as const;

const messageSchema = {
  type: "object",
  properties: {
    role: { type: "string" },
    content: { type: "string" },
  },
} as const satisfies JSONSchema;

const messagesSchema = {
  type: "array",
  items: messageSchema,
} as const satisfies JSONSchema;

const stampingMessagesSchema = {
  type: "array",
  items: {
    ...messageSchema,
    ifc: { addIntegrity: [LLM_DERIVED_ATOM] },
  },
} as const satisfies JSONSchema;

describe("CFC LlmDerived stamping mechanism", () => {
  it("mints the atom with and without a model binding", () => {
    // The default mint omits `model` so the persisted atom stays canonical
    // across models; the model arm exists for audit/display consumers.
    expect(cfcAtom.llmDerived()).toEqual(LLM_DERIVED_ATOM);
    expect(cfcAtom.llmDerived("mock-model")).toEqual({
      ...LLM_DERIVED_ATOM,
      model: "mock-model",
    });
  });

  it("stamps exactly the element pushed through the addIntegrity schema", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      // Model-output push: builtin identity, item schema carries the stamp.
      const modelTx = runtime.edit();
      setCfcImplementationIdentity(modelTx, {
        kind: "builtin",
        builtinId: "llm-dialog",
      });
      const stamping = runtime.getCell(
        signer.did(),
        "llm-derived-messages",
        stampingMessagesSchema,
        modelTx,
      );
      stamping.push({ role: "assistant", content: "model bytes" });
      modelTx.prepareCfc();
      expect((await modelTx.commit()).ok).toBeDefined();

      // User push into the SAME array through the plain schema: no stamp.
      const userTx = runtime.edit();
      const plain = runtime.getCell(
        signer.did(),
        "llm-derived-messages",
        messagesSchema,
        userTx,
      );
      plain.push({ role: "user", content: "typed by the user" });
      userTx.prepareCfc();
      expect((await userTx.commit()).ok).toBeDefined();

      const readTx = runtime.edit();
      const messages = runtime.getCell(
        signer.did(),
        "llm-derived-messages",
        messagesSchema,
        readTx,
      );

      const assistantView = cfcLabelViewForCell(messages.key(0));
      const assistantIntegrity = (assistantView?.entries ?? []).flatMap(
        (entry) => entry.label.integrity ?? [],
      );
      expect(assistantIntegrity).toContainEqual(LLM_DERIVED_ATOM);

      const userView = cfcLabelViewForCell(messages.key(1));
      const userIntegrity = (userView?.entries ?? []).flatMap(
        (entry) => entry.label.integrity ?? [],
      );
      expect(userIntegrity).not.toContainEqual(LLM_DERIVED_ATOM);
      readTx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("stamps a split element on its own doc", async () => {
    // Exercises the generic split mechanism directly, via frame anchoring.
    // Dialog messages reach the same shape by a different route -- the dialog
    // creates each message's document explicitly -- and either way the stamp
    // must land on the split doc and surface through the element's label view.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const modelTx = runtime.edit();
      setCfcImplementationIdentity(modelTx, {
        kind: "builtin",
        builtinId: "llm-dialog",
      });
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "llm-derived-id-split",
        reactives: new Set(),
      });
      try {
        const stamping = runtime.getCell(
          signer.did(),
          "llm-derived-id-split",
          stampingMessagesSchema,
          modelTx,
        );
        stamping.push({
          role: "assistant",
          content: "model bytes",
        } as unknown as { role: string; content: string });
      } finally {
        popFrame(frame);
      }
      modelTx.prepareCfc();
      expect((await modelTx.commit()).ok).toBeDefined();

      const readTx = runtime.edit();
      const messages = runtime.getCell(
        signer.did(),
        "llm-derived-id-split",
        messagesSchema,
        readTx,
      );
      const view = cfcLabelViewForCell(messages.key(0));
      const integrity = (view?.entries ?? []).flatMap(
        (entry) => entry.label.integrity ?? [],
      );
      expect(integrity).toContainEqual(LLM_DERIVED_ATOM);
      readTx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("strips an author-minted LlmDerived (runtime-minted evidence gate)", async () => {
    // LlmDerived is registered runtime-minted evidence (audit S4 posture):
    // a NON-builtin author pushing through the same stamping schema must not
    // persist the atom — pattern code can neither forge the stamp nor author
    // schemas that mint it.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const authorTx = runtime.edit();
      const stamping = runtime.getCell(
        signer.did(),
        "llm-derived-forge",
        stampingMessagesSchema,
        authorTx,
      );
      stamping.push({ role: "assistant", content: "forged provenance" });
      authorTx.prepareCfc();
      expect((await authorTx.commit()).ok).toBeDefined();

      const readTx = runtime.edit();
      const messages = runtime.getCell(
        signer.did(),
        "llm-derived-forge",
        messagesSchema,
        readTx,
      );
      const view = cfcLabelViewForCell(messages.key(0));
      const integrity = (view?.entries ?? []).flatMap(
        (entry) => entry.label.integrity ?? [],
      );
      expect(integrity).not.toContainEqual(LLM_DERIVED_ATOM);
      readTx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("llmDialog LlmDerived stamping (end to end)", () => {
  it("stamps the assistant message; the user message stays unstamped", async () => {
    enableMockMode();
    clearMockResponses();
    loadConversationFixture({
      description: "LlmDerived stamping: single reply",
      responses: [
        {
          type: "sendRequest",
          expectRequest: { messagesContain: ["Hello"], messageCount: 1 },
          response: { role: "assistant", content: "Hi there!", id: "d1-r1" },
        },
      ],
    });

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, llmDialog, Cell } = commonfabric;

    try {
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
          const dialog = llmDialog({ messages });
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
        signer.did(),
        "llm-derived-e2e",
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const addMessage = await result.key("addMessage").pull();
      addMessage.send({ role: "user", content: "Hello" });

      await waitForLlmMessages(runtime, result, 2);

      // The contract is the PERSISTED metadata on each message's own entity
      // doc (every message is its own document); read it there directly — the
      // multi-hop handle chain (result → messages link → element link) is a
      // separate label-view surfacing concern.
      const messagesCell = result.key("messages");
      const rtx = runtime.edit();
      const integrityAtDoc = (index: number): unknown[] => {
        const raw = messagesCell.withTx(rtx).key(index).getRaw();
        const link = parseLink(raw);
        if (link?.id === undefined) return [];
        const metadata = readStoredCfcMetadata(rtx, {
          space: link.space ?? signer.did(),
          id: link.id,
          scope: link.scope === "inherit" ? undefined : link.scope,
        });
        return (metadata?.labelMap.entries ?? []).flatMap(
          (entry) => entry.label.integrity ?? [],
        );
      };
      expect(integrityAtDoc(1)).toContainEqual(cfcAtom.llmDerived());
      expect(integrityAtDoc(0)).not.toContainEqual(cfcAtom.llmDerived());
      rtx.commit();
    } finally {
      clearMockResponses();
      await runtime.idle();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not stamp when CFC enforcement is disabled", async () => {
    // The disabled dial must be a strict no-op: messages flow through the
    // plain push path and no CFC metadata is minted on the message docs.
    enableMockMode();
    clearMockResponses();
    loadConversationFixture({
      description: "LlmDerived stamping: disabled dial",
      responses: [
        {
          type: "sendRequest",
          expectRequest: { messagesContain: ["Hello"], messageCount: 1 },
          response: { role: "assistant", content: "Hi there!", id: "d1-r2" },
        },
      ],
    });

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The assertion below reads that the assistant message document carries
      // no stored CFC metadata. That holds at the `disabled` rung.
      cfcEnforcementMode: "disabled",
    });
    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, llmDialog, Cell } = commonfabric;

    try {
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
          const dialog = llmDialog({ messages });
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
        signer.did(),
        "llm-derived-e2e-disabled",
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const addMessage = await result.key("addMessage").pull();
      addMessage.send({ role: "user", content: "Hello" });

      await waitForLlmMessages(runtime, result, 2);

      const messagesCell = result.key("messages");
      const rtx = runtime.edit();
      const raw = messagesCell.withTx(rtx).key(1).getRaw();
      const link = parseLink(raw);
      expect(link?.id).toBeDefined();
      const metadata = readStoredCfcMetadata(rtx, {
        space: link!.space ?? signer.did(),
        id: link!.id!,
        scope: link!.scope === "inherit" ? undefined : link!.scope,
      });
      expect(metadata).toBeUndefined();
      rtx.commit();
    } finally {
      clearMockResponses();
      await runtime.idle();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
