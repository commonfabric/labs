import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { OpenAICodexOAuthCredential } from "../../src/auth/types.ts";
import { HarnessControlError } from "../../src/control-errors.ts";
import { OpenAICodexResponsesClient } from "../../src/model/openai-codex-responses.ts";

const credential: OpenAICodexOAuthCredential = {
  type: "oauth",
  providerId: "openai-codex",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 60_000,
  accountId: "account",
};

describe("OpenAICodexResponsesClient", () => {
  describe("instance members", () => {
    describe("listModels()", () => {
      const clientServing = (respond: () => Promise<Response>) =>
        new OpenAICodexResponsesClient({
          credentialResolver: { resolve: () => Promise.resolve(credential) },
          fetchFn: respond,
        });

      const rejectionOf = async (
        promise: Promise<unknown>,
      ): Promise<unknown> => {
        try {
          await promise;
        } catch (error) {
          return error;
        }
        throw new Error("expected a rejection");
      };

      it("rejects with the signal's reason when aborted during the JSON read", async () => {
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

      it("rejects with the signal's reason when aborted while the JSON read fails", async () => {
        const controller = new AbortController();
        const reason = new Error("canceled during a failing JSON read");
        const response = new Response("{");
        const json = response.json.bind(response);
        response.json = () => {
          controller.abort(reason);
          return json();
        };
        const client = clientServing(() => Promise.resolve(response));

        await expect(client.listModels(controller.signal)).rejects.toBe(reason);
      });

      it("rejects with the signal's reason without fetching when aborted while resolving credentials", async () => {
        const controller = new AbortController();
        const reason = new Error("canceled during credential resolution");
        let fetches = 0;
        const client = new OpenAICodexResponsesClient({
          credentialResolver: {
            resolve: () => {
              controller.abort(reason);
              return Promise.resolve(credential);
            },
          },
          fetchFn: () => {
            fetches += 1;
            return Promise.resolve(Response.json({ models: [] }));
          },
        });

        await expect(client.listModels(controller.signal)).rejects.toBe(reason);
        expect(fetches).toBe(0);
      });

      it("rejects with the signal's reason when the fetch fails after an abort", async () => {
        const controller = new AbortController();
        const reason = new Error("canceled during the fetch");
        const client = clientServing(() => {
          controller.abort(reason);
          return Promise.reject(new TypeError("fetch aborted"));
        });

        await expect(client.listModels(controller.signal)).rejects.toBe(reason);
      });

      it("cancels the body and rejects with the signal's reason when aborted as the response arrives", async () => {
        const controller = new AbortController();
        const reason = new Error("canceled as the response arrived");
        let canceledWith: unknown;
        const client = clientServing(() => {
          controller.abort(reason);
          return Promise.resolve(
            new Response(
              new ReadableStream({
                cancel(cancelReason) {
                  canceledWith = cancelReason;
                },
              }),
            ),
          );
        });

        await expect(client.listModels(controller.signal)).rejects.toBe(reason);
        expect(canceledWith).toBe(reason);
      });

      for (
        const [name, body, message] of [
          [
            "a body that is not JSON",
            "{",
            "OpenAI Codex model discovery returned invalid JSON",
          ],
          [
            "a body without a models array",
            JSON.stringify({ data: [] }),
            "OpenAI Codex model discovery omitted the models array",
          ],
          [
            "a model that is not an object",
            JSON.stringify({ models: ["gpt-5.4"] }),
            "OpenAI Codex model discovery returned an invalid model",
          ],
          [
            "a model without a display name",
            JSON.stringify({ models: [{ slug: "gpt-5.4" }] }),
            "OpenAI Codex model discovery returned an invalid model",
          ],
        ] as const
      ) {
        it(`rejects as provider-unavailable for ${name}`, async () => {
          const client = clientServing(() =>
            Promise.resolve(new Response(body))
          );

          const error = await rejectionOf(client.listModels());

          expect(error).toBeInstanceOf(HarnessControlError);
          expect(error).toMatchObject({
            code: "provider-unavailable",
            message,
          });
        });
      }
    });
  });
});
