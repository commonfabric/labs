/**
 * The dialog's per-message documents must land in the same partition as the
 * messages array itself. An element anchored by `Cell.push` inherits the
 * array's scope; a document the dialog creates explicitly has to be given that
 * scope, or the document and the readers of its link disagree about the
 * partition: the stored element link is bare, a reader resolves it against the
 * array's scope, and a document minted at the default `"space"` scope is
 * simply not there. A session-scoped messages cell is what makes the
 * difference observable at all -- at `"space"` scope every choice coincides.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  clearMockResponses,
  loadConversationFixture,
} from "@commonfabric/llm/client";
import type { BuiltInLLMMessage } from "@commonfabric/api";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { parseLink } from "../src/link-utils.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { waitForLlmMessages } from "./support/llm-result.ts";

const signer = await Identity.fromPassphrase("llm dialog message scope");

describe("llmDialog message document scope", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    clearMockResponses();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("keeps message documents in a session-scoped messages cell's partition", async () => {
    loadConversationFixture({
      description: "scoped messages: one assistant reply",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "Hi there!", id: "scope-1" },
        },
      ],
    });

    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, llmDialog, Cell } = commonfabric;

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
        const messages = Cell.perSession.of<BuiltInLLMMessage[]>([]);
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
      "llm-message-scope",
      resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    await tx.commit().settled;
    await runtime.idle();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Hello" });

    // The user message plus the assistant reply.
    await waitForLlmMessages(runtime, result, 2);

    const messagesCell = result.key("messages");
    const rtx = runtime.edit();

    // The premise, so the test cannot silently degrade into the trivial
    // all-`"space"` case: the array the dialog wrote to is session-scoped.
    const arrayLink = resolveLink(
      runtime,
      rtx,
      messagesCell.getAsNormalizedFullLink(),
    );
    expect(arrayLink.scope).toBe("session");

    // Roundtrip: both messages read back through the array. This is the loud
    // half of the invariant -- a document minted in a different partition than
    // the array leaves the element link dangling, and the content vanishes.
    const messages = messagesCell.withTx(rtx).get() as
      | readonly BuiltInLLMMessage[]
      | undefined;
    expect(messages?.length).toBe(2);
    expect(String(messages![0]!.content)).toBe("Hello");
    expect(String(messages![1]!.content)).toBe("Hi there!");

    // Shape: each stored element is a bare link -- id only, no `space` or
    // `scope` spelled out -- exactly what an anchored element stores. A
    // document whose scope differed from the array's would have to carry the
    // difference here.
    for (const index of [0, 1]) {
      const raw = messagesCell.withTx(rtx).key(index).getRaw() as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      expect(parseLink(raw)?.id).not.toBe(undefined);
      const payload = raw["/"]?.["link@1"];
      expect(payload).not.toBe(undefined);
      expect(payload!.space).toBe(undefined);
      expect(payload!.scope).toBe(undefined);
    }

    await rtx.commit().settled;
  });
});
