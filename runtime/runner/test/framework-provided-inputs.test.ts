import { assertEquals, assertThrows } from "@std/assert";
import {
  applyFrameworkProvidedInputs,
  stripFrameworkProvidedPaths,
} from "../src/framework-provided-inputs.ts";

Deno.test("FrameworkProvided schema stripping prunes system-only parent objects", () => {
  const schema = {
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          sandboxId: { type: "string" },
        },
        required: ["sandboxId"],
      },
      query: { type: "string" },
    },
    required: ["request", "query"],
  } as const;

  assertEquals(
    stripFrameworkProvidedPaths(schema, [["request", "sandboxId"]]),
    {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  );
});

Deno.test("FrameworkProvided injection overwrites nested authored values", () => {
  const authored = {
    request: { query: "tea", sandboxId: "authored" },
  };

  assertEquals(
    applyFrameworkProvidedInputs(
      authored,
      [["request", "sandboxId"]],
      "stable-tool-id",
    ),
    {
      request: { query: "tea", sandboxId: "stable-tool-id" },
    },
  );
  assertEquals(authored.request.sandboxId, "authored");
});

Deno.test("FrameworkProvided injection fails closed without a stable entity id", () => {
  assertThrows(
    () => applyFrameworkProvidedInputs({}, [["sandboxId"]], undefined),
    Error,
    "tool instance has no stable entity id",
  );
});
