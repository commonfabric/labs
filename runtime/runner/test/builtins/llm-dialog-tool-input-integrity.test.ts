/**
 * The tool-input integrity gate's walk, driven directly over schema and value
 * shapes the dialog-level suite does not build: references that resolve to no
 * object, schema groups that lead back to themselves, arrays whose slots
 * declare nothing, and references to values the walk cannot read into.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import { llmToolExecutionHelpers } from "../../src/builtins/llm-dialog.ts";
import { createLLMFriendlyLink } from "../../src/link-utils.ts";
import { decomposeSchema } from "../../src/schema-decompose.ts";
import { registerSchemaDocument } from "../../src/schema-registry.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const { toolInputMalformedFloor, toolInputRequiredIntegrityFailure } =
  llmToolExecutionHelpers;

const signer = await Identity.fromPassphrase("llm dialog tool input integrity");
const space = signer.did();

const KERNEL_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Builtin",
  name: "agent-kernel-demo-v1",
} as const;

const FLOOR = { ifc: { requiredIntegrity: [KERNEL_ATOM] } };

describe("llm-dialog", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  function gate(schema: unknown, value: unknown) {
    return toolInputRequiredIntegrityFailure(
      runtime,
      space,
      schema,
      value,
      "",
      {},
    );
  }

  /** Registers `schema` as a schema document and returns a reference to it. */
  function registeredRefTo(schema: JSONSchema): string {
    const { rootRef, documents } = decomposeSchema(
      schema as Parameters<typeof decomposeSchema>[0],
    );
    for (const [hash, document] of documents) {
      registerSchemaDocument(hash, document);
    }
    return rootRef;
  }

  /** Stores `value` and returns the reference a model would pass to it. */
  async function referenceTo(cause: string, value: unknown) {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    cell.set(value);
    await tx.commit().settled;
    await runtime.idle();
    return {
      "@link": createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
    };
  }

  describe("toolInputMalformedFloor()", () => {
    it("returns `undefined` for a reference to the schema that accepts anything", () => {
      expect(
        toolInputMalformedFloor(
          { $ref: "#/$defs/Anything", $defs: { Anything: true } },
          "",
        ),
      ).toBeUndefined();
      expect(
        toolInputMalformedFloor(
          {
            $ref: "#/$defs/Malformed",
            $defs: { Malformed: { ifc: { requiredIntegrity: "kernel" } } },
          },
          "",
        ),
      ).toContain("declares a requiredIntegrity that is not a list");
    });
  });

  describe("toolInputRequiredIntegrityFailure()", () => {
    it("returns `undefined` for a reference to the schema that accepts anything", () => {
      expect(
        gate(
          { $ref: "#/$defs/Anything", $defs: { Anything: true } },
          "literal",
        ),
      ).toBeUndefined();
      expect(
        gate({ $ref: registeredRefTo(FLOOR as JSONSchema) }, "literal"),
      ).toContain('field "(root)" requires integrity');
    });

    it("gates a literal against the floor of a group that leads back to itself", () => {
      const schema = internSchema({
        $ref: "#/$defs/Loop",
        $defs: { Loop: { anyOf: [{ $ref: "#/$defs/Loop" }, FLOOR] } },
      } as JSONSchema);

      expect(gate(schema, "literal")).toBe(
        'field "(root)" requires integrity the model-supplied value does not ' +
          "carry (pass an integrity-bearing reference, not a literal)",
      );
    });

    it("returns `undefined` for an array whose elements meet a slot schema that declares nothing", () => {
      // The floor sits on a property no array supplies, so the walk visits
      // each element and finds nothing to gate there.
      expect(
        gate(
          { type: "array", items: true, properties: { x: FLOOR } },
          ["a", "b"],
        ),
      ).toBeUndefined();
      expect(
        gate({ type: "array", items: FLOOR }, ["a", "b"]),
      ).toContain('field "[0]" requires integrity');
    });

    it("returns `undefined` where every compound branch passes and the floor guards a field left out", () => {
      expect(
        gate(
          {
            type: "object",
            properties: { recipient: FLOOR },
            anyOf: [{ type: "object" }, { required: [] }],
          },
          { subject: "hello" },
        ),
      ).toBeUndefined();
      expect(
        gate(
          {
            type: "object",
            properties: { recipient: FLOOR },
            anyOf: [{ type: "object" }, { required: [] }],
          },
          { recipient: "bob@example.com" },
        ),
      ).toContain('field "recipient" requires integrity');
    });

    describe("a reference to a value the walk cannot read into", () => {
      it("returns an unreadable-value failure for a floor on a stored error", async () => {
        const reference = await referenceTo("stored error", new Error("boom"));

        expect(gate(FLOOR, reference)).toBe(
          'field "(root)" holds a reference whose value or labels this ' +
            "session cannot read; refusing the call (fail closed)",
        );
      });

      it("returns an unreadable-value failure for a floor on a value one part of which is an error", async () => {
        const reference = await referenceTo("value holding an error", {
          detail: new Error("boom"),
        });

        expect(gate(FLOOR, reference)).toBe(
          'field "(root)" holds a reference whose value or labels this ' +
            "session cannot read; refusing the call (fail closed)",
        );
      });

      it("returns an unreadable-contents failure for a floor beneath a stored error", async () => {
        const reference = await referenceTo(
          "error under a field floor",
          new Error("boom"),
        );

        expect(
          gate({ type: "object", properties: { message: FLOOR } }, reference),
        ).toBe(
          'field "(root)" holds a reference to a value whose contents this ' +
            "session cannot read; refusing the call (fail closed)",
        );
      });
    });
  });
});
