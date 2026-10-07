import { computed, pattern, UI } from "commonfabric";
import { findNode, propsOf, readValue } from "../test/vnode-helpers.ts";
import PromptInjectionDemo from "./main.tsx";

const FALLBACK_MODEL_ITEMS = [
  { label: "gateway:z-ai/glm-5", value: "gateway:z-ai/glm-5" },
  {
    label: "anthropic:claude-sonnet-4.6",
    value: "anthropic:claude-sonnet-4.6",
  },
  {
    label: "gateway:claude-sonnet-4-6",
    value: "gateway:claude-sonnet-4-6",
  },
];

export const fetchMocks = [{
  urlIncludes: "/api/ai/llm/models",
  status: 503,
  contentType: "application/json",
  body: '{"error":"model directory unavailable"}',
}];

export default pattern(() => {
  const demo = PromptInjectionDemo({});

  const assert_unavailable_model_directory_uses_fallback_items = computed(
    () => {
      const select = findNode(demo[UI], (node) => {
        const value = readValue(node);
        return typeof value === "object" && value !== null &&
          "name" in value && value.name === "cf-select";
      });
      const items = readValue(propsOf(select)?.items);
      return JSON.stringify(items) === JSON.stringify(FALLBACK_MODEL_ITEMS);
    },
  );

  return {
    tests: [
      { settle: true },
      { assertion: assert_unavailable_model_directory_uses_fallback_items },
    ],
    allowConsoleErrors: true,
  };
});
