import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

// CT-1334: fetchJson() + computed() projection inside sub-pattern causes
// callback:error
//
// This test goes through the full ts-transformer pipeline (via default-on CTS transforms)
// to verify that computed() closures capturing pattern params in template
// literals are properly transformed and execute without callback:error.

let originalFetch: typeof globalThis.fetch;

describe("CT-1334: fetchJson + computed inside sub-pattern (transformed)", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      // Only mock our test endpoint
      if (url.includes("localhost:59999/api/contacts")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              connections: [
                { name: "Alice" },
                { name: "Bob" },
                { name: "Carol" },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }

      return originalFetch(input, _init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const scenario: PatternIntegrationScenario<{ token: string }> = {
    name:
      "CT-1334: sub-pattern with computed template literal + fetchJson + computed",
    module: new URL(
      "./ct-1334-fetchjson-derive-subpattern.pattern.ts",
      import.meta.url,
    ),
    argument: { token: "test-auth-token-123" },
    steps: [
      {
        expect: [
          { path: "pending", value: false },
          { path: "contacts", value: ["Alice", "Bob", "Carol"] },
        ],
      },
    ],
  };

  it(scenario.name, async () => {
    await runPatternScenario(scenario);
  });
});
