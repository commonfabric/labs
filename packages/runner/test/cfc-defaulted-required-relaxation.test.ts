import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  localRefTarget,
  relaxDefaultedRequired,
  validateSchemaValue,
} from "../src/cfc/schema-sanitization.ts";

/** The composition the CLI's pre-dispatch verb gate applies to a present
 * payload (`verbInputSchemaError`, `packages/piece/src/verb-input.ts`), and the
 * one C5's server-side closed-world enforcement shares: validate against the
 * schema with defaulted properties relaxed out of `required`. These tests
 * moved here with the helpers (verb contract D6) because they pin the
 * relaxation semantics, not the CLI's refusal behavior. */
const relaxedValidationError = (
  input: unknown,
  schema: JSONSchema,
): string | undefined =>
  validateSchemaValue(relaxDefaultedRequired(schema, schema, new Map()), input);

describe("relaxDefaultedRequired", () => {
  // The runtime injects a property's default when a present payload omits it,
  // so requiring it here would refuse a call the verb would have accepted.

  it("treats a defaulted property as satisfied when omitted", () => {
    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { type: "string", default: "fast" } },
      required: ["mode"],
    })).toBeUndefined();
  });

  it("treats a defaulted property as satisfied when nested", () => {
    expect(relaxedValidationError({ opts: {} }, {
      type: "object",
      properties: {
        opts: {
          type: "object",
          properties: { mode: { type: "string", default: "fast" } },
          required: ["mode"],
        },
      },
      required: ["opts"],
    })).toBeUndefined();
  });

  it("treats a defaulted property as satisfied behind a $ref", () => {
    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Mode" } },
      required: ["mode"],
      $defs: { Mode: { type: "string", default: "fast" } },
    })).toBeUndefined();
  });

  describe("JSON Pointer escapes in a $defs name", () => {
    // Resolution is the canonical resolver's, JSON Pointer escapes included:
    // `#/$defs/A~1B` names the `"A/B"` definition. The previous hand-rolled
    // regex indexed `$defs` by the UNDECODED text, missed the default, left
    // `mode` required, and both gates refused `{}` even though runtime
    // materialization accepts it and supplies the default (review repro on the
    // D5/D6 PR).

    it("relaxes a default behind a JSON-Pointer-escaped name (A~1B names A/B)", () => {
      expect(relaxedValidationError({}, {
        type: "object",
        properties: { mode: { $ref: "#/$defs/A~1B" } },
        required: ["mode"],
        $defs: { "A/B": { type: "string", default: "fast" } },
      })).toBeUndefined();
    });

    it("relaxes a default behind a ~0 escape (A~0B names A~B)", () => {
      expect(relaxedValidationError({}, {
        type: "object",
        properties: { mode: { $ref: "#/$defs/A~0B" } },
        required: ["mode"],
        $defs: { "A~B": { type: "string", default: "fast" } },
      })).toBeUndefined();
    });
  });

  it("keeps a property required whose `$ref` names a document definition without a default, whatever the subtree's own `$defs` say", () => {
    // `#/$defs/Mode` names the document root's definition; the `$defs` on the
    // property is inert below it. The root's `Mode` carries no default, so
    // `mode` stays required and `{}` is refused.

    expect(relaxedValidationError({}, {
      type: "object",
      properties: {
        mode: {
          $ref: "#/$defs/Mode",
          $defs: { Mode: { type: "string", default: "fast" } },
        },
      },
      required: ["mode"],
      $defs: { Mode: { type: "number" } },
    })).toBeDefined();
  });

  describe("a nested object's own $defs", () => {
    // The recursion threads the document root through every level, so a
    // property `$ref` beneath a nested object resolves against the root's
    // `$defs`; a `$defs` the nested object declares is inert.

    it("relaxes a defaulted-required behind a nested object's ref into the root's $defs", () => {
      expect(relaxedValidationError({ opts: {} }, {
        type: "object",
        properties: {
          opts: {
            type: "object",
            properties: { mode: { $ref: "#/$defs/Mode" } },
            required: ["mode"],
          },
        },
        required: ["opts"],
        $defs: { Mode: { type: "string", default: "fast" } },
      })).toBeUndefined();
    });

    it("keeps a nested object's property required when only the nested object's own $defs define its ref", () => {
      expect(relaxedValidationError({ opts: {} }, {
        type: "object",
        properties: {
          opts: {
            type: "object",
            properties: { mode: { $ref: "#/$defs/Mode" } },
            required: ["mode"],
            $defs: { Mode: { type: "string", default: "fast" } },
          },
        },
        required: ["opts"],
      })).toBeDefined();
    });

    it("resolves a nested object's ref against the root's $defs when the root declares one", () => {
      expect(relaxedValidationError({ opts: {} }, {
        type: "object",
        properties: {
          opts: {
            type: "object",
            properties: { mode: { $ref: "#/$defs/Mode" } },
            required: ["mode"],
            $defs: { Mode: { type: "string", default: "fast" } },
          },
        },
        required: ["opts"],
        // Same name in the document root, WITHOUT a default: that is the
        // definition the ref names, so `mode` stays required.
        $defs: { Mode: { type: "number" } },
      })).toBeDefined();
    });
  });

  it("follows a $ref chain to find the default", () => {
    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Mode" } },
      required: ["mode"],
      $defs: {
        Mode: { $ref: "#/$defs/RealMode" },
        RealMode: { type: "string", default: "fast" },
      },
    })).toBeUndefined();
  });

  it("relaxes a defaulted property inside array items", () => {
    expect(relaxedValidationError([{}], {
      type: "array",
      items: {
        type: "object",
        properties: { mode: { type: "string", default: "fast" } },
        required: ["mode"],
      },
    })).toBeUndefined();
  });

  it("relaxes a defaulted property inside a prefixItems slot", () => {
    // Tuple slots are ordinary present objects to the runtime's default
    // materialization, so their schemas get the same relaxation as `items`.

    expect(relaxedValidationError([{}], {
      type: "array",
      prefixItems: [{
        type: "object",
        properties: { mode: { type: "string", default: "fast" } },
        required: ["mode"],
      }],
    } as unknown as JSONSchema)).toBeUndefined();
  });

  it("relaxes on a ref-site sibling default", () => {
    // The runtime's default-injection read consults the property schema's own
    // `default` directly, without resolving the ref — so a ref-site sibling
    // default satisfies the property even when the referenced definition
    // carries none.

    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Mode", default: "fast" } },
      required: ["mode"],
      $defs: { Mode: { type: "string" } },
    })).toBeUndefined();
  });

  it("does not relax on a default stranded mid-way through a broken chain", () => {
    // The inverse boundary: a default stranded on an UNRESOLVABLE chain's last
    // reachable wrapper is one the runtime never injects — the property schema
    // itself has no default, and the chain cannot resolve to a view carrying
    // one. Crediting it would admit `{}` and spend the invocation id on a
    // handling missing the field; unresolvable keeps the field required.

    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/A" } },
      required: ["mode"],
      $defs: {
        A: { $ref: "#/$defs/Missing", default: "fast" },
      },
    } as unknown as JSONSchema)).toMatch(/mode/);
  });

  it("relaxes a defaulted property inside a combinator branch", () => {
    expect(relaxedValidationError({}, {
      anyOf: [
        {
          type: "object",
          properties: { mode: { type: "string", default: "fast" } },
          required: ["mode"],
        },
      ],
    } as JSONSchema)).toBeUndefined();
  });

  it("leaves a non-local $ref untouched", () => {
    // A reference that names nothing local cannot be followed to a default.
    // Relaxation leaves it exactly as written rather than guessing.

    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "https://example.com/Mode" } },
    } as JSONSchema)).toMatch(/cannot resolve schema reference/);
  });

  it("does not relax on a default behind a #/definitions ref", () => {
    // Hoisting emits `$defs`; a `definitions` ref is one the runtime cannot
    // resolve either. Relaxing on a default behind one would admit a payload
    // the verb then receives as an absent event, spending the invocation id.

    expect(relaxedValidationError({}, {
      type: "object",
      properties: { mode: { $ref: "#/definitions/Mode" } },
      required: ["mode"],
      definitions: { Mode: { type: "string", default: "fast" } },
    } as unknown as JSONSchema)).toMatch(/mode/);
  });

  it("leaves a $ref naming a missing definition untouched", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Absent" } },
      $defs: { Present: { type: "string" } },
    } as JSONSchema)).toMatch(/cannot resolve schema reference/);
  });

  it("ignores a malformed $defs pool instead of indexing it", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Mode" } },
      $defs: null,
    } as unknown as JSONSchema)).toMatch(/cannot resolve schema reference/);
  });

  it("handles a $ref whose target is a boolean schema", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/Anything" } },
      $defs: { Anything: true },
    } as JSONSchema)).toBeUndefined();
  });

  it("passes a boolean property schema through unchanged", () => {
    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: true },
    } as JSONSchema)).toBeUndefined();
  });

  it("terminates on a $ref cycle instead of looping", () => {
    // A ref cycle names no schema to check against. Relaxation walks it without
    // looping and hands it on unchanged; the validator is what reports it.

    expect(relaxedValidationError({ mode: "x" }, {
      type: "object",
      properties: { mode: { $ref: "#/$defs/A" } },
      $defs: {
        A: { $ref: "#/$defs/B" },
        B: { $ref: "#/$defs/A" },
      },
    })).toMatch(/cannot resolve schema reference/);
  });

  it("still rejects a non-defaulted sibling of a defaulted property", () => {
    expect(relaxedValidationError({}, {
      type: "object",
      properties: {
        mode: { type: "string", default: "fast" },
        target: { type: "string" },
      },
      required: ["mode", "target"],
    })).toMatch(/target/);
  });

  it("terminates on a self-referential schema", () => {
    const cyclic: Record<string, unknown> = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    (cyclic.properties as Record<string, unknown>).child = cyclic;
    expect(relaxedValidationError({ name: "a" }, cyclic as JSONSchema))
      .toBeUndefined();
  });
});

describe("localRefTarget", () => {
  it("resolves a top-level local $ref to the schema it names", () => {
    const target = { type: "object", properties: {} } as const;
    expect(localRefTarget(
      { $ref: "#/$defs/Event" } as JSONSchema,
      { $ref: "#/$defs/Event", $defs: { Event: target } } as JSONSchema,
    )).toEqual(target);
  });

  it("returns the last reachable schema when a ref cannot be resolved", () => {
    const unresolvable = { $ref: "#/$defs/Absent" } as JSONSchema;
    expect(localRefTarget(
      unresolvable,
      { $defs: { Present: { type: "string" } } } as JSONSchema,
    )).toBe(unresolvable);
  });

  it("decodes JSON Pointer escapes exactly like the canonical resolver", () => {
    const target = { type: "string", default: "fast" } as const;
    expect(localRefTarget(
      { $ref: "#/$defs/A~1B" } as JSONSchema,
      { $defs: { "A/B": target } } as JSONSchema,
    )).toEqual(target);
  });

  it("resolves against the root's $defs rather than the subtree's own", () => {
    const rootDefinition = { type: "number" } as const;
    expect(localRefTarget(
      {
        $ref: "#/$defs/Mode",
        $defs: { Mode: { type: "string", default: "fast" } },
      } as JSONSchema,
      { $defs: { Mode: rootDefinition } } as JSONSchema,
    )).toEqual(rootDefinition);
  });

  it("returns the schema itself when its ref names no root definition, whatever $defs it declares", () => {
    const unresolvable = {
      $ref: "#/$defs/Mode",
      $defs: { Mode: { type: "string", default: "fast" } },
    } as JSONSchema;
    expect(localRefTarget(unresolvable, { type: "object" } as JSONSchema))
      .toBe(unresolvable);
  });
});
