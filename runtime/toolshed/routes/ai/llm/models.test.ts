import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { generateText } from "ai";
import { GOOGLE_SEARCH_NATIVE_MODEL_TOOL } from "@commonfabric/llm/types";

import {
  createModelRegistry,
  DEFAULT_MODEL_ALIAS,
  type ModelRegistryOptions,
} from "./models.ts";
import { recordingLogger, refusingFetch } from "@/test/fixtures/llm-models.ts";

const GATEWAY_URL = "https://gateway.test";

/** A gateway `/v1/models` entry for `id` with the given capabilities. */
function gatewayModel(
  id: string,
  capabilities: Record<string, unknown> = {},
  owner = "vendor",
) {
  return { id, object: "model", owned_by: owner, capabilities };
}

/** A registry built from `options`, with a logger the test can read. */
function build(options: Partial<ModelRegistryOptions> = {}) {
  const logger = recordingLogger();
  const registry = createModelRegistry({
    fetch: refusingFetch,
    logger,
    ...options,
  });
  return { registry, logger };
}

/** A fetch that answers gateway discovery with `models` and records requests. */
function gatewayFetch(models: unknown[]) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === `${GATEWAY_URL}/v1/models`) {
      return Promise.resolve(Response.json({ object: "list", data: models }));
    }
    return Promise.resolve(Response.json({
      id: "completion",
      object: "chat.completion",
      created: 0,
      model: "x",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "gateway answer" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  };
  return { fetch, requests };
}

describe("models", () => {
  describe("createModelRegistry()", () => {
    describe("without providers", () => {
      it("registers no model", async () => {
        const { registry } = build();
        await registry.whenReady();
        expect(Object.keys(registry.models)).toEqual([]);
      });

      it("returns `undefined` for a name that is no model", async () => {
        const { registry } = build();
        expect(await registry.resolve("nonexistent:model-xyz")).toBeUndefined();
        expect(await registry.resolve("")).toBeUndefined();
      });

      it("returns `undefined` for the name of an Object.prototype member", async () => {
        const { registry } = build();
        expect(await registry.resolve("constructor")).toBeUndefined();
        expect(await registry.resolve("toString")).toBeUndefined();
      });

      it("leaves `default` unregistered and warns that it did", async () => {
        const { registry, logger } = build();
        await registry.whenReady();
        expect(await registry.resolve(DEFAULT_MODEL_ALIAS)).toBeUndefined();
        expect(logger.warnings).toEqual([
          expect.stringContaining("No default model available"),
        ]);
        expect(registry.taskModels.coding).toBe("anthropic:claude-sonnet-4-6");
      });
    });

    describe("register()", () => {
      it("registers a model under its name and each alias", async () => {
        const { registry } = build();
        const config = {
          name: "mock:primary",
          model: "unused",
          aliases: ["primary", "mock:primary-latest"],
          capabilities: {
            contextWindow: 1,
            maxOutputTokens: 1,
            streaming: true,
            systemPrompt: true,
            stopSequences: true,
            prefill: false,
            images: false,
            reasoning: false,
          },
        };
        registry.register(config);
        expect(await registry.resolve("mock:primary")).toBe(config);
        expect(await registry.resolve("primary")).toBe(config);
        expect(await registry.resolve("mock:primary-latest")).toBe(config);
        expect([...registry.aliasNames]).toEqual([
          "primary",
          "mock:primary-latest",
        ]);
      });
    });

    describe("direct providers", () => {
      it("registers Anthropic's models only when its key is set", async () => {
        const { registry, logger } = build({ anthropicApiKey: "test-key" });
        const sonnet = await registry.resolve("anthropic:claude-sonnet-4-6");
        expect(sonnet?.capabilities).toMatchObject({
          contextWindow: 200_000,
          maxOutputTokens: 64000,
          images: true,
        });
        expect(await registry.resolve("sonnet-4.6")).toBe(sonnet);
        expect(await registry.resolve("claude-opus-4-1")).toBeDefined();
        expect(await registry.resolve("haiku-4-5")).toBeDefined();
        expect(logger.lines).toContain(" Adding 🤖 anthropic");

        const { registry: without } = build();
        expect(await without.resolve("sonnet-4.6")).toBeUndefined();
      });

      it("registers Groq's models only when its key is set", async () => {
        const { registry } = build({ groqApiKey: "test-key" });
        const kimi = await registry.resolve("groq:moonshotai/kimi-k2-instruct");
        expect(kimi?.capabilities.maxOutputTokens).toBe(16384);
        expect(await registry.resolve("kimi-k2-instruct")).toBe(kimi);
        expect(await registry.resolve("gpt-oss-120b")).toBeDefined();
        expect(await registry.resolve("openai:gpt-5")).toBeUndefined();
      });

      it("registers OpenAI's models only when its key is set", async () => {
        const { registry } = build({ openaiApiKey: "test-key" });
        expect(await registry.resolve("gpt-5")).toBe(
          await registry.resolve("openai:gpt-5"),
        );
        expect(await registry.resolve("gpt-5-mini")).toBeDefined();
        expect(await registry.resolve("groq:gpt-oss-120b")).toBeUndefined();
      });

      it("registers Vertex's models from the credentials file it names", async () => {
        const credentials = await Deno.makeTempFile({ suffix: ".json" });
        try {
          await Deno.writeTextFile(
            credentials,
            JSON.stringify({ client_email: "a@b.test", private_key: "x" }),
          );
          const { registry } = build({
            googleApplicationCredentials: credentials,
            googleVertexProject: "project",
            googleVertexLocation: "us-central1",
          });

          const flash = await registry.resolve("gemini-3.5-flash");
          expect(flash?.name).toBe("google:gemini-3.5-flash");
          expect(flash?.capabilities.nativeModelToolIds).toEqual([
            GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
          ]);
          expect(
            flash?.nativeModelToolFactories
              ?.[GOOGLE_SEARCH_NATIVE_MODEL_TOOL]?.(),
          ).toMatchObject({ type: "provider", id: "google.google_search" });

          const pro = await registry.resolve("gemini-3-pro");
          expect(pro?.capabilities.nativeModelToolIds).toBeUndefined();
          expect(pro?.nativeModelToolFactories).toBeUndefined();
        } finally {
          await Deno.remove(credentials);
        }
      });

      it("sends a direct provider's requests through the given fetch", async () => {
        const requests: Request[] = [];
        const { registry } = build({
          anthropicApiKey: "test-key",
          fetch: (input, init) => {
            requests.push(new Request(input, init));
            return Promise.resolve(Response.json({
              id: "msg",
              type: "message",
              role: "assistant",
              model: "claude-haiku-4-5",
              content: [{ type: "text", text: "direct answer" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }));
          },
        });
        const haiku = await registry.resolve("haiku-4.5");

        const result = await generateText({
          model: haiku!.model,
          prompt: "hi",
        });

        expect(result.text).toBe("direct answer");
        expect(requests.map((request) => request.url)).toEqual([
          "https://api.anthropic.com/v1/messages",
        ]);
        expect(requests[0].headers.get("x-api-key")).toBe("test-key");
        expect((await requests[0].json()).model).toBe("claude-haiku-4-5");
      });

      it("makes no direct provider the default", async () => {
        const { registry } = build({
          anthropicApiKey: "a",
          groqApiKey: "g",
          openaiApiKey: "o",
        });
        await registry.whenReady();
        expect(await registry.resolve(DEFAULT_MODEL_ALIAS)).toBeUndefined();
      });
    });

    describe("gateway discovery", () => {
      it("registers each language model the gateway lists", async () => {
        const { fetch } = gatewayFetch([
          gatewayModel("image-only", { type: "image-generation" }),
          gatewayModel("plain"),
          gatewayModel("described", {
            contextWindow: 50_000,
            maxOutputTokens: 2_000,
            streaming: false,
            systemPrompt: false,
            stopSequences: false,
            prefill: true,
            images: true,
            reasoning: true,
            nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL, "no-such"],
          }),
        ]);
        const { registry, logger } = build({
          gatewayUrl: `${GATEWAY_URL}//`,
          fetch,
        });
        await registry.whenReady();

        expect(await registry.resolve("gateway:image-only")).toBeUndefined();
        expect((await registry.resolve("gateway:plain"))?.capabilities)
          .toEqual({
            contextWindow: 128_000,
            maxOutputTokens: 4_096,
            streaming: true,
            systemPrompt: true,
            stopSequences: true,
            prefill: false,
            images: false,
            reasoning: false,
            nativeModelToolIds: undefined,
          });
        expect((await registry.resolve("gateway:described"))?.capabilities)
          .toEqual({
            contextWindow: 50_000,
            maxOutputTokens: 2_000,
            streaming: false,
            systemPrompt: false,
            stopSequences: false,
            prefill: true,
            images: true,
            reasoning: true,
            nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
          });
        expect(logger.lines).toContain(
          ` Adding 🤖 gateway (2 models from ${GATEWAY_URL})`,
        );
      });

      it("aliases a gateway model by its id and owner unless taken", async () => {
        const { fetch } = gatewayFetch([
          gatewayModel("gpt-5", {}, "openai"),
          gatewayModel("fresh", {}, "vendor"),
        ]);
        const { registry } = build({
          openaiApiKey: "o",
          gatewayUrl: GATEWAY_URL,
          fetch,
        });
        await registry.whenReady();

        const direct = await registry.resolve("openai:gpt-5");
        expect(await registry.resolve("gpt-5")).toBe(direct);
        expect((await registry.resolve("gateway:gpt-5"))?.aliases).toEqual([]);

        const fresh = await registry.resolve("gateway:fresh");
        expect(fresh?.aliases).toEqual(["fresh", "vendor:fresh"]);
        expect(await registry.resolve("vendor:fresh")).toBe(fresh);
      });

      it("asks the gateway for its models with provenance", async () => {
        const { fetch, requests } = gatewayFetch([]);
        const { registry } = build({ gatewayUrl: GATEWAY_URL, fetch });
        await registry.whenReady();

        expect(requests.map((request) => request.url)).toEqual([
          `${GATEWAY_URL}/v1/models`,
        ]);
        const headers = new Headers(requests[0].init?.headers);
        expect(headers.get("User-Agent")).toMatch(/^toolshed \(/);
        expect([...headers.values()]).toContain("list-models");
      });

      it("sends a gateway model's requests to the gateway under its own id", async () => {
        const { fetch, requests } = gatewayFetch([
          gatewayModel("us.amazon.nova-pro-v1:0"),
        ]);
        const { registry } = build({ gatewayUrl: GATEWAY_URL, fetch });
        const nova = await registry.resolve("gateway:us.amazon.nova-pro-v1:0");

        const result = await generateText({ model: nova!.model, prompt: "hi" });

        expect(result.text).toBe("gateway answer");
        const completion = requests[1];
        expect(completion.url).toBe(`${GATEWAY_URL}/v1/chat/completions`);
        expect(JSON.parse(String(completion.init?.body)).model).toBe(
          "us.amazon.nova-pro-v1:0",
        );
        expect(new Headers(completion.init?.headers).get("User-Agent"))
          .toMatch(/^toolshed \(/);
        expect(completion.init).toHaveProperty("client");
      });

      it("returns a direct model without waiting for discovery", async () => {
        const discovery = Promise.withResolvers<Response>();
        const { registry } = build({
          anthropicApiKey: "a",
          gatewayUrl: GATEWAY_URL,
          fetch: () => discovery.promise,
        });

        expect((await registry.resolve("sonnet-4.6"))?.name).toBe(
          "anthropic:claude-sonnet-4-6",
        );

        let resolved = false;
        const gateway = registry.resolve("gateway:late").then((config) => {
          resolved = true;
          return config;
        });
        await Promise.resolve();
        expect(resolved).toBe(false);
        discovery.resolve(
          Response.json({ object: "list", data: [gatewayModel("late")] }),
        );
        expect((await gateway)?.name).toBe("gateway:late");
      });

      it("skips gateway models when the gateway answers with an error", async () => {
        const { registry, logger } = build({
          anthropicApiKey: "a",
          gatewayUrl: GATEWAY_URL,
          fetch: () =>
            Promise.resolve(
              new Response("down", {
                status: 503,
                statusText: "Service Unavailable",
              }),
            ),
        });
        await registry.whenReady();

        expect(logger.warnings[0]).toBe(
          `[gateway] Skipping gateway models: 503 Service Unavailable from ${GATEWAY_URL}`,
        );
        expect(await registry.resolve("sonnet-4.6")).toBeDefined();
        expect(await registry.resolve(DEFAULT_MODEL_ALIAS)).toBeUndefined();
      });

      it("skips gateway models when the gateway cannot be reached", async () => {
        const { registry, logger } = build({
          gatewayUrl: GATEWAY_URL,
          fetch: () => Promise.reject(new TypeError("connection refused")),
        });
        await registry.whenReady();

        expect(logger.warnings[0]).toBe(
          `[gateway] Could not reach ${GATEWAY_URL} (connection refused); skipping gateway models.`,
        );
        expect(Object.keys(registry.models)).toEqual([]);
      });

      for (
        const { description, body } of [
          { description: "a body that is not JSON", body: "<html>" },
          { description: "a body without a model list", body: "{}" },
        ]
      ) {
        it(`skips gateway models for ${description}`, async () => {
          const { registry, logger } = build({
            gatewayUrl: GATEWAY_URL,
            fetch: () => Promise.resolve(new Response(body)),
          });
          await registry.whenReady();

          expect(logger.warnings[0]).toMatch(
            /^\[gateway\] Could not reach https:\/\/gateway\.test \(.+\); skipping gateway models\.$/,
          );
          expect(Object.keys(registry.models)).toEqual([]);
        });
      }
    });

    describe("default model", () => {
      for (
        const { listed, chosen } of [
          {
            listed: ["gemini-3.5-flash", "gpt-5.6-luna", "claude-sonnet-5"],
            chosen: "gateway:claude-sonnet-5",
          },
          {
            listed: ["gemini-3.5-flash", "gpt-5.6-luna"],
            chosen: "gateway:gpt-5.6-luna",
          },
          {
            listed: ["gpt-5.4-mini", "gemini-3.5-flash"],
            chosen: "gateway:gemini-3.5-flash",
          },
        ]
      ) {
        it(`chooses ${chosen} from ${listed.join(", ")}`, async () => {
          const { fetch } = gatewayFetch(listed.map((id) => gatewayModel(id)));
          const { registry, logger } = build({
            gatewayUrl: GATEWAY_URL,
            fetch,
          });
          await registry.whenReady();

          expect(await registry.resolve(DEFAULT_MODEL_ALIAS)).toBe(
            await registry.resolve(chosen),
          );
          expect(registry.aliasNames.has(DEFAULT_MODEL_ALIAS)).toBe(true);
          expect(registry.taskModels).toEqual({
            coding: chosen,
            json: chosen,
            creative: "openai:gpt-5",
            vision: "google:gemini-3-pro-preview",
          });
          expect(logger.lines).toContain(` Default model: ${chosen}`);
        });
      }

      it("leaves `default` unregistered when no candidate is listed", async () => {
        const { fetch } = gatewayFetch([gatewayModel("gpt-5.4-mini")]);
        const { registry, logger } = build({ gatewayUrl: GATEWAY_URL, fetch });
        await registry.whenReady();

        expect(await registry.resolve("gateway:gpt-5.4-mini")).toBeDefined();
        expect(await registry.resolve(DEFAULT_MODEL_ALIAS)).toBeUndefined();
        expect(registry.aliasNames.has(DEFAULT_MODEL_ALIAS)).toBe(false);
        expect(logger.warnings).toEqual([
          expect.stringContaining("No default model available"),
        ]);
      });
    });
  });
});
