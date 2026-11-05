import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { BuiltInLLMMessage } from "@commonfabric/api";

import createApp from "@/lib/create-app.ts";
import router from "./llm.index.ts";
import { MessageSchema } from "./llm.routes.ts";

/** The request body schema this route publishes, as JSON Schema. */
function publishedRequestSchema(path: string): Record<string, any> {
  const document = createApp().route("/", router).getOpenAPIDocument({
    openapi: "3.0.0",
    info: { version: "1.0.0", title: "Toolshed API" },
  });
  const operation = (document.paths as Record<string, any>)[path].post;
  return operation.requestBody.content["application/json"].schema;
}

/**
 * `BuiltInLLMMessage`'s roles written out as values. The `satisfies` clause
 * refuses a role listed here that the type does not carry, and
 * `EveryRoleIsListed` below refuses one the type carries that is missing here.
 */
const MESSAGE_ROLES = [
  "user",
  "assistant",
  "tool",
] as const satisfies readonly BuiltInLLMMessage["role"][];

/** Its argument is `never` only while `MESSAGE_ROLES` names every role. */
type AssertNever<T extends never> = T;

type EveryRoleIsListed = AssertNever<
  Exclude<BuiltInLLMMessage["role"], typeof MESSAGE_ROLES[number]>
>;

describe("llm.routes", () => {
  describe("LLMRequestSchema", () => {
    // `cache` is the one field of a request whose absence means something
    // other than "leave it alone", so what the document says about it when it
    // is left out is part of the contract rather than an implementation
    // detail.

    it("publishes `cache` as optional, with a default of `true`", () => {
      const schema = publishedRequestSchema("/api/ai/llm");
      expect(schema.required).not.toContain("cache");
      expect(schema.properties.cache).toEqual({
        type: "boolean",
        default: true,
      });
    });
  });

  describe("GenerateObjectRequestSchema", () => {
    it("publishes `cache` as optional, with a default of `true`", () => {
      const schema = publishedRequestSchema("/api/ai/llm/generateObject");
      expect(schema.required).not.toContain("cache");
      expect(schema.properties.cache).toEqual({
        type: "boolean",
        default: true,
      });
    });
  });

  describe("MessageSchema", () => {
    it("accepts the roles `BuiltInLLMMessage` carries and no others", () => {
      // The route's validator is the fourth declaration of the role set, after
      // the type, the runtime schema in `llm-schemas.ts`, and the guard in
      // `@commonfabric/llm`. It is also the one a caller sending JSON meets
      // first, so it is worth holding to the type by itself rather than by
      // the agreement of the other three.
      assertEquals(
        [...MessageSchema.shape.role.options].sort(),
        [...MESSAGE_ROLES].sort(),
      );
    });

    it("names the field a system instruction belongs in", () => {
      // System content travels in the request's own `system` field, and this
      // is where a caller is told so: every other rejected role falls through
      // to zod's own wording.
      const refusal = MessageSchema.safeParse({
        role: "system",
        content: "Be brief",
      });
      expect(refusal.success).toBe(false);
      expect(refusal.error?.issues[0].message).toContain("'system' field");
    });

    it("uses zod's own wording for any other unrecognized role", () => {
      const refusal = MessageSchema.safeParse({
        role: "wizard",
        content: "Be brief",
      });
      expect(refusal.success).toBe(false);
      expect(refusal.error?.issues[0].message).not.toContain("'system' field");
    });
  });
});
