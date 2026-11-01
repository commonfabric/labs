import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { emptyReplyDiagnostic } from "../../src/model/empty-reply.ts";

describe("empty-reply", () => {
  it("bounds the raw payload and records its original UTF-8 byte count", () => {
    const payload = { content: "🍩".repeat(3_000) };
    const serialized = JSON.stringify(payload);
    const diagnostic = emptyReplyDiagnostic(
      { role: "assistant", content: "" },
      "responses",
      payload,
    );
    expect(diagnostic?.responseBodyExcerpt).toBe(serialized.slice(0, 2_048));
    expect(diagnostic?.responseBodyTruncated).toBe(true);
    expect(diagnostic?.responseBodyBytes).toBe(
      new TextEncoder().encode(serialized).length,
    );
  });

  it("omits evidence for a tool-only reply", () => {
    expect(emptyReplyDiagnostic(
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
      "chat-completions",
      { content: null },
    )).toBeUndefined();
  });
});
