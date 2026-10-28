import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { handlerVerbTiers } from "../src/verb-listing.ts";

describe("verb-listing", () => {
  describe("handlerVerbTiers()", () => {
    // The link and node shapes are the ones `patternManager.compilePattern`
    // emits: a `Writable.perSession` cell's link carries its scope, while an
    // argument cell's link names a path into the declared argument.
    const internal = (
      cause: unknown,
      scope: "space" | "session" = "space",
    ) => ({
      $alias: { partialCause: cause, scope, path: [] },
    });
    const argument = (...path: string[]) => ({
      $alias: { cell: "argument", path },
    });
    const VOID_ACTION: JSONSchema = false;
    const VOID_HANDLER: JSONSchema = { asCell: ["opaque"] };
    const PAYLOAD: JSONSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    };
    const node = (
      stream: string,
      event: JSONSchema,
      ctx: Record<string, unknown>,
    ) => ({
      module: {
        wrapper: "handler",
        argumentSchema: {
          type: "object",
          properties: { $event: event, $ctx: { type: "object" } },
        },
      },
      inputs: { $ctx: ctx, $event: internal({ stream }) },
    });
    const SESSION_ARGUMENT: JSONSchema = {
      type: "object",
      properties: {
        newTitle: {
          type: "string",
          asCell: [{ kind: "cell", scope: "session" }],
        },
        shared: { type: "string", asCell: ["cell"] },
      },
    };

    it("names a void action bound to a session-scoped internal cell", () => {
      const tiers = handlerVerbTiers({
        result: { openComposer: internal({ stream: "openComposer" }) },
        nodes: [
          node("openComposer", VOID_ACTION, {
            draft: internal("draft", "session"),
          }),
        ],
      });
      expect([...tiers]).toEqual(["openComposer"]);
    });

    it("names a void handler bound to an argument the pattern declares session-scoped", () => {
      const tiers = handlerVerbTiers({
        argumentSchema: SESSION_ARGUMENT,
        result: { submit: internal({ stream: "submit" }) },
        nodes: [
          node("submit", VOID_HANDLER, {
            newTitle: argument("newTitle"),
            titles: internal("titles"),
          }),
        ],
      });
      expect([...tiers]).toEqual(["submit"]);
    });

    it("finds a session-scoped link nested inside the bound state", () => {
      const tiers = handlerVerbTiers({
        result: { open: internal({ stream: "open" }) },
        nodes: [
          node("open", VOID_ACTION, {
            form: { fields: [internal("draft", "session")] },
          }),
        ],
      });
      expect([...tiers]).toEqual(["open"]);
    });

    it("reads an argument path through a referenced definition", () => {
      const tiers = handlerVerbTiers({
        argumentSchema: {
          $ref: "#/$defs/Input",
          $defs: {
            Input: {
              type: "object",
              properties: {
                form: {
                  type: "object",
                  scope: "session",
                  properties: { draft: { type: "string" } },
                },
              },
            },
          },
        },
        result: { open: internal({ stream: "open" }) },
        nodes: [
          node("open", VOID_HANDLER, { draft: argument("form", "draft") }),
        ],
      });
      expect([...tiers]).toEqual(["open"]);
    });

    it("omits a verb with an event payload that also touches a session cell", () => {
      // The board's `addTopic`: a real create that clears the composer draft
      // afterwards is headless.

      const tiers = handlerVerbTiers({
        result: { create: internal({ stream: "create" }) },
        nodes: [
          node("create", PAYLOAD, {
            titles: internal("titles"),
            draft: internal("draft", "session"),
          }),
        ],
      });
      expect(tiers.size).toBe(0);
    });

    it("omits a void verb whose bound state is all space-scoped", () => {
      const tiers = handlerVerbTiers({
        argumentSchema: SESSION_ARGUMENT,
        result: { reset: internal({ stream: "reset" }) },
        nodes: [
          node("reset", VOID_ACTION, {
            titles: internal("titles"),
            shared: argument("shared"),
          }),
        ],
      });
      expect(tiers.size).toBe(0);
    });

    it("omits a stream two handler nodes share", () => {
      const draft = { draft: internal("draft", "session") };
      const tiers = handlerVerbTiers({
        result: { open: internal({ stream: "open" }) },
        nodes: [
          node("open", VOID_ACTION, draft),
          node("open", VOID_ACTION, draft),
        ],
      });
      expect(tiers.size).toBe(0);
    });
  });
});
