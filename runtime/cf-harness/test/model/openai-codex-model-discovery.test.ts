import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { OpenAICodexOAuthCredential } from "../../src/auth/types.ts";
import { OpenAICodexResponsesClient } from "../../src/model/openai-codex-responses.ts";

describe("OpenAICodexResponsesClient", () => {
  describe("instance members", () => {
    describe("listModels()", () => {
      it("rejects with the signal's reason when aborted during the JSON read", async () => {
        const credential: OpenAICodexOAuthCredential = {
          type: "oauth",
          providerId: "openai-codex",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: 60_000,
          accountId: "account",
        };
        const controller = new AbortController();
        const reason = new Error("canceled during model JSON read");
        let reads = 0;
        const response = Response.json({ models: [] });
        response.json = () => {
          reads++;
          controller.abort(reason);
          return Promise.resolve({ models: [] });
        };
        const client = new OpenAICodexResponsesClient({
          credentialResolver: { resolve: () => Promise.resolve(credential) },
          fetchFn: () => Promise.resolve(response),
        });

        await expect(client.listModels(controller.signal)).rejects.toBe(reason);
        expect(reads).toBe(1);
      });
    });
  });
});
