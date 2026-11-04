import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface EchoArgs {
  message: string;
}

export const echoScenario: PatternIntegrationScenario<EchoArgs> = {
  name: "echo returns provided argument",
  module: new URL("./echo.pattern.ts", import.meta.url),
  exportName: "echoPattern",
  argument: { message: "hello" },
  steps: [{ expect: [{ path: "message", value: "hello" }] }],
};

export const scenarios = [echoScenario];

describe("echo", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
