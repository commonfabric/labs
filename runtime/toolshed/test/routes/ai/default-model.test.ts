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
        description: "prefers gateway GPT-5.6 Luna over GPT-5.4 mini",
        models: ["gpt-5.4-mini", "gpt-5.6-luna"],
        expected: "gpt-5.6-luna",
      },
      {
        description:
          "refuses default when only older preferred models are registered",
        models: ["claude-sonnet-4-6", "claude-sonnet-4-5", "gpt-5.4-mini"],
        expected: null,
      },
      {
        description: "refuses default when only GPT-5.4 mini is available",
        models: ["gpt-5.4-mini"],
        expected: null,
      },
      {
        description: "prefers gateway Sonnet over other registered models",
        models: ["gemini-3.5-flash", "gpt-5.6-luna", "claude-sonnet-5"],
        expected: "claude-sonnet-5",
      },
      {
        description:
          "refuses default when only other language models are registered",
        models: ["gpt-5.4", "123", "gpt-5"],
        expected: null,
      },
      {
        description: "prefers gateway GPT-5.6 Luna over Gemini Flash",
        models: ["gemini-3.5-flash", "gpt-5.6-luna"],
        expected: "gpt-5.6-luna",
      },
      {
        description: "uses gateway Gemini Flash without Sonnet or Luna",
        models: ["gpt-5.4-mini", "gemini-3.5-flash"],
        expected: "gemini-3.5-flash",
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
