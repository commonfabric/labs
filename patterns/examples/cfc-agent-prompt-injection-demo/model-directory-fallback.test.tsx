/** Checks that an unavailable model directory retains the built-in models. */

import { assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import PromptInjectionDemo from "./main.tsx";

export const fetchMocks = [{
  urlIncludes: "/api/ai/llm/models",
  status: 503,
  contentType: "application/json",
  body: '{"error":"model directory unavailable"}',
}];

export default pattern(() => {
  const demo = PromptInjectionDemo({});
  return {
    [TESTS]: [
      { settle: true },
      {
        assertion: assert(() => {
          const items = propValue(findElement(demo[UI], "cf-select"), "items");
          return JSON.stringify(items) === JSON.stringify([
            { label: "gateway:z-ai/glm-5.2", value: "gateway:z-ai/glm-5.2" },
            {
              label: "anthropic:claude-sonnet-4-6",
              value: "anthropic:claude-sonnet-4-6",
            },
            {
              label: "gateway:claude-sonnet-5",
              value: "gateway:claude-sonnet-5",
            },
          ]);
        }),
      },
    ],
    allowConsoleErrors: true,
  };
});
