/**
 * Which of the two builders puts a confidential argument's label on the schema
 * it produces. A module joins it onto its own result schema, because its
 * implementation is handed the argument and reads it. A pattern stores the
 * schema its author declared, and what its result carries is per field:
 * `pattern.test.ts` measures that, where the alias into a node's output holds
 * the label its module joined on.
 *
 * The `result bindings` block measures the same division one level down, over
 * the cells a result binds rather than over the result schema's root: the
 * field carrying an author's `ifc` declaration is the only one whose binding
 * carries it, and a public sibling's binding carries none.
 *
 * The last block here holds the property the rest of that rests on. A pattern
 * body is handed reactive references rather than values, so its build carries
 * no observation of an argument to join — the structural exclusion of CFC
 * §8.9.2, rather than a claim about the code under §8.9.1. A build that could
 * read an argument would be a decision point, and safety invariant 9 would
 * reach the result again.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createNodeFactory, lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { Frame, JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const HEALTH_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "SensitiveHealthRecord",
  subject: "did:example:patient",
} as const;

// One confidential field, the shape a `Confidential<...>` argument compiles to,
// and one confidential array, for the builders that reduce over a collection.
const ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", ifc: { confidentiality: [HEALTH_ATOM] } },
    revealSensitive: { type: "boolean" },
    readings: {
      type: "array",
      items: { type: "number" },
      ifc: { confidentiality: [HEALTH_ATOM] },
    },
  },
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    $NAME: { type: "string" },
    $UI: { $ref: "https://commonfabric.org/schemas/vnode.json" },
  },
} as const satisfies JSONSchema;

const confidentialityOf = (schema: JSONSchema | undefined) =>
  (schema as JSONSchemaObj | undefined)?.ifc?.confidentiality;

// The clauses a schema holds only as its producer's input join, which a
// runtime persisting flow labels leaves to its measurement.
const inputConfidentialityOf = (schema: JSONSchema | undefined) =>
  (schema as JSONSchemaObj | undefined)?.ifc?.inputConfidentiality;

describe("cfc-argument-ifc-propagation", () => {
  describe("pattern()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;
    let frame: Frame;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
      frame = pushFrame({
        cause: "cfc-argument-ifc-propagation",
        space,
        runtime,
        tx,
        generatedIdCounter: 0,
      });
    });

    afterEach(async () => {
      popFrame(frame);
      await tx.commit().settled;
      await runtime?.dispose();
      await storageManager?.close();
    });

    const surface = () =>
      pattern(
        (input: { content: string; revealSensitive: boolean }) => ({
          $NAME: "surface",
          $UI: null,
          revealSensitive: input.revealSensitive,
        }),
        ARGUMENT_SCHEMA,
        RESULT_SCHEMA,
      );

    it("returns a factory whose result schema is the declared one", () => {
      expect(confidentialityOf(surface().resultSchema)).toBeUndefined();
    });

    it("returns a factory whose argument schema keeps the field's label", () => {
      const properties = (surface().argumentSchema as JSONSchemaObj | undefined)
        ?.properties;

      expect(confidentialityOf(properties?.content)).toEqual([HEALTH_ATOM]);
      expect(confidentialityOf(properties?.revealSensitive)).toBeUndefined();
    });

    describe("result bindings", () => {
      // Every cell a result binds, measured through the alias that binds it.
      // `revealSensitive` is the discriminating field: it sits in the same
      // argument as `content` and carries no declaration of its own, so a
      // label on its binding, or on a lift reading it, could only have come
      // from its neighbor.

      // deno-lint-ignore no-explicit-any
      const aliasSchema = (binding: any) =>
        resolvedSchema(binding?.$alias?.schema);

      const bindings = () => {
        const factory = pattern(
          (
            input: {
              content: string;
              revealSensitive: boolean;
              readings: number[];
            },
          ) => ({
            $NAME: "surface",
            $UI: null,
            content: input.content,
            revealSensitive: input.revealSensitive,
            derived: lift((word: string) => word.length)(input.content),
            derivedPublic: lift((shown: boolean) => !shown)(
              input.revealSensitive,
            ),
            // deno-lint-ignore no-explicit-any
            total: (input.readings as any).sum(),
          }),
          ARGUMENT_SCHEMA,
          RESULT_SCHEMA,
        );
        // deno-lint-ignore no-explicit-any
        return factory.result as any;
      };

      it("binds the declared field to a schema carrying its label", () => {
        expect(confidentialityOf(aliasSchema(bindings().content))).toEqual([
          HEALTH_ATOM,
        ]);
        expect(inputConfidentialityOf(aliasSchema(bindings().content)))
          .toBeUndefined();
      });

      it("binds a public sibling to a schema carrying no label", () => {
        expect(confidentialityOf(aliasSchema(bindings().revealSensitive)))
          .toBeUndefined();
      });

      it("binds a lift's output to a schema carrying the module's join", () => {
        expect(confidentialityOf(aliasSchema(bindings().derived))).toEqual([
          HEALTH_ATOM,
        ]);
      });

      it("names a lift's join as its input join, which the runtime measures", () => {
        expect(inputConfidentialityOf(aliasSchema(bindings().derived)))
          .toEqual([HEALTH_ATOM]);
      });

      it("binds a lift over a public field to a schema carrying no label", () => {
        expect(confidentialityOf(aliasSchema(bindings().derivedPublic)))
          .toBeUndefined();
      });

      it("binds an aggregate to a schema carrying its source's label", () => {
        // A sum has no per-value attribution, so CFC §8.17.1 gives it the join
        // of its contributors. The built-in writes its own scalar schema over
        // the cell its node factory labeled, which is where the label would go
        // missing.
        const total = aliasSchema(bindings().total) as JSONSchemaObj;

        expect(total?.type).toBe("number");
        expect(confidentialityOf(total)).toEqual([HEALTH_ATOM]);
        // The aggregate is a replayable built-in, whose writes are measured.
        expect(inputConfidentialityOf(total)).toEqual([HEALTH_ATOM]);
      });
    });

    // `build` runs the body for its effect on the reference it is handed and
    // returns what that reference did, so each case below states one thing a
    // pattern body can learn about a confidential argument.
    const build = <T>(body: (content: unknown) => T): T => {
      let observed!: T;
      pattern(
        (input: { content: string }) => {
          observed = body(input.content);
          return { $NAME: "surface", $UI: null };
        },
        ARGUMENT_SCHEMA,
        RESULT_SCHEMA,
      );
      return observed;
    };

    it("hands the body a reference rather than the argument's value", () => {
      expect(build((content) => typeof content)).toBe("object");
      expect(build((content) => JSON.stringify(content))).toBe("null");
    });

    it("throws when the body coerces an argument field to a primitive", () => {
      expect(() => build((content) => `${content}`)).toThrow(
        /reactive reference outside a reactive context/,
      );
    });

    it("takes the same branch for an argument field either way", () => {
      // The reference is an object, so it is truthy whatever the cell holds:
      // a build-time branch on it cannot depend on the value, which is what
      // keeps the assembled graph independent of every argument.
      expect(build((content) => (content ? "then" : "else"))).toBe("then");
    });
  });

  describe("createNodeFactory()", () => {
    it("returns a factory whose result schema carries the argument's label", () => {
      const factory = createNodeFactory({
        type: "javascript",
        implementation: (input: { content: string }) => input.content.length,
        argumentSchema: ARGUMENT_SCHEMA,
        resultSchema: { type: "number" },
      });

      expect(confidentialityOf(factory.resultSchema)).toEqual([HEALTH_ATOM]);
    });

    it("names the argument's label as the input join of a JavaScript module", () => {
      const factory = createNodeFactory({
        type: "javascript",
        implementation: (input: { content: string }) => input.content.length,
        argumentSchema: ARGUMENT_SCHEMA,
        resultSchema: { type: "number" },
      });

      expect(inputConfidentialityOf(factory.resultSchema)).toEqual([
        HEALTH_ATOM,
      ]);
    });

    it("names no input join for a built-in that writes after a fetch", () => {
      // What the fetch returns is written in a later transaction than the one
      // that read the argument, so nothing measures it against the argument
      // and the join stays the result's declared floor.
      const factory = createNodeFactory({
        type: "ref",
        implementation: "fetchJson",
        argumentSchema: ARGUMENT_SCHEMA,
        resultSchema: { type: "object" },
      });

      expect(confidentialityOf(factory.resultSchema)).toEqual([HEALTH_ATOM]);
      expect(inputConfidentialityOf(factory.resultSchema)).toBeUndefined();
    });

    it("names no input join for a clause the result schema declares itself", () => {
      const factory = createNodeFactory({
        type: "javascript",
        implementation: (input: { content: string }) => input.content.length,
        argumentSchema: ARGUMENT_SCHEMA,
        resultSchema: {
          type: "number",
          ifc: { confidentiality: [HEALTH_ATOM] },
        },
      });

      expect(confidentialityOf(factory.resultSchema)).toEqual([HEALTH_ATOM]);
      expect(inputConfidentialityOf(factory.resultSchema)).toBeUndefined();
    });
  });
});
