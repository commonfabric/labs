/**
 * Boots the toolshed registry in a fresh process for each gateway catalog, then
 * exercises the real generation routes against a provider with stubbed HTTP.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const packageRoot = fromFileUrl(new URL("../../../", import.meta.url));
const repositoryRoot = fromFileUrl(new URL("../../../../../", import.meta.url));
const fixture = fromFileUrl(
  new URL("../../fixtures/default-model-bootstrap.ts", import.meta.url),
);

describe("default-model", () => {
  for (
    const { description, models, expected } of [
      {
        description: "uses gateway GPT-5.4 mini when no Sonnet is registered",
        models: ["gpt-5.4", "gpt-5.4-mini"],
        expected: "gpt-5.4-mini",
      },
      {
        description: "prefers gateway Sonnet over other registered models",
        models: ["gpt-5.4-mini", "claude-sonnet-4-6"],
        expected: "claude-sonnet-4-6",
      },
      {
        description:
          "uses the first registered language model without a preferred model",
        models: ["gpt-5.4", "123", "gpt-5"],
        expected: "gpt-5.4",
      },
      {
        description: "refuses default when only image models are available",
        models: [],
        expected: null,
      },
    ]
  ) {
    it(description, async () => {
      const output = await runDenoCommandWithTemporaryLock({
        root: repositoryRoot,
        cwd: packageRoot,
        args: (lockPath) => [
          "run",
          "--no-check",
          "--cached-only",
          "--frozen=true",
          `--lock=${lockPath}`,
          "--allow-env",
          "--allow-read",
          "--allow-sys=hostname",
          fixture,
          JSON.stringify({ models, expected }),
        ],
        env: {
          ENV: "test",
          LOG_LEVEL: "silent",
          OTEL_ENABLED: "false",
          CFTS_AI_GATEWAY_URL: "https://gateway.invalid",
          CFTS_AI_LLM_ANTHROPIC_API_KEY: "",
          CFTS_AI_LLM_OPENAI_API_KEY: "",
          CFTS_AI_LLM_GROQ_API_KEY: "",
          CFTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS: "",
          CFTS_AI_LLM_GOOGLE_VERTEX_PROJECT: "",
          CFTS_AI_LLM_GOOGLE_VERTEX_LOCATION: "",
        },
      });
      if (!output.success) {
        console.error(new TextDecoder().decode(output.stderr));
      }
      expect(output.code).toBe(0);
    });
  }
});
