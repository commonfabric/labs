import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  assertOpenAIReasoningEffortSupported,
  supportedOpenAIReasoningEfforts,
} from "../../src/model/openai-reasoning.ts";

describe("openai-reasoning", () => {
  it("retains `none` for GPT-5.6 models", () => {
    expect(supportedOpenAIReasoningEfforts("gpt-5.6-terra")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(() => assertOpenAIReasoningEffortSupported("gpt-5.6-sol", "none"))
      .not.toThrow();
  });

  it("leaves omitted efforts to the provider default", () => {
    expect(() => assertOpenAIReasoningEffortSupported("gpt-6.1-sol", undefined))
      .not.toThrow();
  });

  it("leaves unknown model vocabularies to the provider", () => {
    expect(supportedOpenAIReasoningEfforts("custom-model")).toEqual([]);
    expect(() => assertOpenAIReasoningEffortSupported("custom-model", "custom"))
      .not.toThrow();
  });
});
