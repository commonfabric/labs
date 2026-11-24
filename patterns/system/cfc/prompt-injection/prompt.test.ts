import { assertEquals } from "@std/assert";
import { promptInputMessage } from "./prompt.ts";
import { parseResultSchemaInput } from "./result-schema.ts";

Deno.test("promptInputMessage replaces repeated clipboard attachment tokens", () => {
  const message = promptInputMessage({
    detail: {
      text: "Use [Notes](#clip-1), then compare [Notes](#clip-1).",
      attachments: [{
        id: "clip-1",
        name: "Notes",
        type: "clipboard",
        data: "trusted clipboard text",
      }],
    },
  });

  assertEquals(message, {
    role: "user",
    content: [{
      type: "text",
      text: "Use trusted clipboard text, then compare trusted clipboard text.",
    }],
  });
});

Deno.test("parseResultSchemaInput fails closed for malformed schema strings", () => {
  assertEquals(parseResultSchemaInput("{not json"), false);
  assertEquals(
    parseResultSchemaInput('["array-is-not-a-schema-object"]'),
    false,
  );
  assertEquals(parseResultSchemaInput("123"), false);
  assertEquals(parseResultSchemaInput('{"type":"object"}'), {
    type: "object",
  });
});

Deno.test("parseResultSchemaInput accepts direct schemas and rejects other values", () => {
  const schema = { type: "object", properties: {} } as const;
  assertEquals(parseResultSchemaInput(true), true);
  assertEquals(parseResultSchemaInput(schema), schema);
  assertEquals(parseResultSchemaInput(["not-a-schema-object"]), false);
  assertEquals(parseResultSchemaInput(null), false);
});
