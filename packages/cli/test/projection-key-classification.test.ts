import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { ANNOTATION_KEYS } from "@commonfabric/piece/schema-compatibility";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  deriveSelectedValue,
  outputSchemaWithSourceRequired,
  parseSelectionProjection,
  PROJECTION_ANNOTATION_EXCEPTIONS,
  projectionKeyTier,
  TOLERATED_PROJECTION_KEYS,
} from "../lib/cell-selection.ts";

const signer = await Identity.fromPassphrase(
  "cf-projection-key-classification",
);
const space = signer.did();

/** The keywords the reader drives the projection from. */
const HONORED = [
  "type",
  "properties",
  "items",
  "additionalProperties",
  "$link",
];

/**
 * The keywords the reader consults for container inference and then consumes.
 * Every one of them changes which container an untyped position describes.
 */
const CONSULTED = [
  "required",
  "minProperties",
  "maxProperties",
  "minItems",
  "maxItems",
  "uniqueItems",
];

/**
 * A value each tolerated keyword is probed with — one the key could plausibly
 * disturb a read by carrying, since a probe the runner would ignore whatever
 * the tier said proves nothing.
 *
 * This is a fixture, not a registry. The keys the inertness loop walks are
 * derived from {@link TOLERATED_PROJECTION_KEYS}, and a tier T key missing
 * from here fails rather than being skipped: membership in `ANNOTATION_KEYS`
 * makes a keyword a *candidate*, and that carrying it changes nothing is a
 * separate obligation discharged against the runner, per key. A loop over its
 * own hard-coded list would carry a newly-admitted keyword across the read
 * boundary and never test it — which is how `$comment` got in.
 */
const TOLERATED_PROBE_VALUES = new Map<string, unknown>([
  // `$comment` carries the value the runner reserves as a control marker,
  // which is the only value of it that could disturb a read.
  ["$comment", "emptyProperties"],
  ["$id", "https://example.com/caller.json"],
  ["$schema", "https://json-schema.org/draft/2020-12/schema"],
  ["deprecated", true],
  ["description", "what the caller thinks this is"],
  ["examples", ["an example"]],
  ["tags", ["a tag"]],
  ["tier", "wrapper"],
  ["title", "A title"],
]);

/** Every key in keyword position anywhere in `schema`. */
function keywordsIn(schema: unknown, into = new Set<string>()): Set<string> {
  if (!isObjectNotArray(schema)) {
    return into;
  }
  for (
    const [key, child] of Object.entries(schema as Record<string, unknown>)
  ) {
    into.add(key);
    if (key === "properties") {
      if (isObjectOrArray(child)) {
        for (const value of Object.values(child as Record<string, unknown>)) {
          keywordsIn(value, into);
        }
      }
    } else if (key === "items" || key === "additionalProperties") {
      keywordsIn(child, into);
    }
  }
  return into;
}

describe("projection-key-classification", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      errorHandlers: [() => {}],
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** A cell holding `value` under `schema`, committed and read back fresh. */
  async function seed(
    cause: string,
    schema: JSONSchema,
    value: unknown,
  ): Promise<Cell<unknown>> {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, schema, tx);
    cell.set(value as never);
    expect((await tx.commit()).ok).toBeDefined();
    return runtime.getCell(space, cause, schema);
  }

  /** `source` read through the JSON `--schema` spelled by `projection`. */
  async function read(
    source: Cell<unknown>,
    projection: unknown,
  ): Promise<unknown> {
    return await deriveSelectedValue(runtime, space, source, {
      projection: await parseSelectionProjection(JSON.stringify(projection)),
    });
  }

  /** The schema `deriveSelectedValue` re-asserts on its output cell. */
  async function outputSchemaOf(
    source: Cell<unknown>,
    projection: unknown,
  ): Promise<JSONSchema | undefined> {
    let outputCell: Cell<unknown> | undefined;
    await deriveSelectedValue(runtime, space, source, {
      projection: await parseSelectionProjection(JSON.stringify(projection)),
    }, { onOutputCell: (cell) => outputCell = cell });
    return outputCell?.schema;
  }

  describe("a key in no tier", () => {
    it("refuses the projection, naming the key and the position it sat at", async () => {
      await expect(
        parseSelectionProjection(
          '{"type":"object","propertes":{"title":true}}',
        ),
      ).rejects.toThrow(
        'Invalid --schema at <root>: "propertes" is not a projection schema keyword',
      );
    });

    it("names the nested position a refused key sat at", async () => {
      await expect(parseSelectionProjection(JSON.stringify({
        properties: { notes: { minLenght: 3 } },
      }))).rejects.toThrow('Invalid --schema at <root>.notes: "minLenght"');
    });

    it("names the honored vocabulary a caller can write instead", async () => {
      await expect(parseSelectionProjection('{"pattern":"^a"}')).rejects
        .toThrow(
          'Projection reads "type", "properties", "items", ' +
            '"additionalProperties", "$link"',
        );
    });

    it("suggests the honored keyword a misspelling is one edit from", async () => {
      await expect(parseSelectionProjection('{"propertes":{"a":true}}')).rejects
        .toThrow('Did you mean "properties"?');
      await expect(parseSelectionProjection('{"type":"array","itmes":true}'))
        .rejects.toThrow('Did you mean "items"?');
    });

    it("refuses a misspelled `properties` beside a stated `type` rather than returning the whole object", async () => {
      const source = await seed("classification-widening-source", {
        type: "object",
        properties: {
          title: { type: "string" },
          secret: { type: "string" },
        },
      }, { title: "Visible", secret: "not asked for" });

      await expect(
        read(source, { type: "object", propertes: { title: true } }),
      ).rejects.toThrow('"propertes" is not a projection schema keyword');
    });

    it("refuses a misspelled `properties` with no stated `type` rather than reading nothing", async () => {
      const source = await seed("classification-narrowing-source", {
        type: "object",
        properties: { title: { type: "string" } },
      }, { title: "Visible" });

      await expect(read(source, { propertes: { title: true } })).rejects
        .toThrow('"propertes" is not a projection schema keyword');
    });

    it("returns a tier for every keyword the reader accepts", () => {
      for (const key of HONORED) {
        expect(projectionKeyTier(key)).toBe("honored");
      }
      for (const key of CONSULTED) {
        expect(projectionKeyTier(key)).toBe("consulted");
      }
      for (const key of TOLERATED_PROJECTION_KEYS) {
        expect(projectionKeyTier(key)).toBe("tolerated");
      }
      for (const key of ["propertes", "pattern", "minLength", "format"]) {
        expect(projectionKeyTier(key)).toBe("refused");
      }
    });
  });

  describe("a tier C key the caller wrote", () => {
    it("names the array container an untyped position describes", async () => {
      expect((await parseSelectionProjection('{"minItems":1}')).schema).toEqual(
        {
          type: "array",
        },
      );
      expect((await parseSelectionProjection('{"uniqueItems":true}')).schema)
        .toEqual({ type: "array" });
    });

    it("names the object container an untyped position describes", async () => {
      expect((await parseSelectionProjection('{"required":["id"]}')).schema)
        .toEqual({ type: "object", additionalProperties: true });
      expect((await parseSelectionProjection('{"minProperties":1}')).schema)
        .toEqual({ type: "object", additionalProperties: true });
    });

    it("leaves no caller-written tier C constraint in the output schema", async () => {
      const source = await seed("classification-tier-c-source", {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          notes: { type: "array", items: { type: "string" } },
        },
      }, { id: 1, title: "Visible", notes: ["one"] });

      const schema = await outputSchemaOf(source, {
        type: "object",
        minProperties: 1,
        maxProperties: 9,
        required: ["id"],
        properties: {
          title: true,
          notes: {
            type: "array",
            minItems: 1,
            maxItems: 9,
            uniqueItems: true,
            items: true,
          },
        },
      });

      const carried = keywordsIn(schema);
      for (const key of CONSULTED) {
        // `required` may appear from the reader's own derivation; here the
        // source requires nothing, so no origin can put one there.
        expect([...carried]).not.toContain(key);
      }
    });

    it("returns the projected fields for a projection naming a `required` field it does not project", async () => {
      const source = await seed("classification-5734-source", {
        type: "object",
        properties: {
          title: { type: "string" },
          secret: { type: "string" },
        },
      }, { title: "Visible", secret: "not asked for" });

      expect(
        await read(source, {
          type: "object",
          required: ["secret"],
          properties: { title: true },
        }),
      ).toEqual({ title: "Visible" });
    });
  });

  describe("a tier T key the caller wrote", () => {
    it("has a probe value for every keyword the tier admits", () => {
      const undischarged = [...TOLERATED_PROJECTION_KEYS]
        .filter((key) => !TOLERATED_PROBE_VALUES.has(key))
        .map((key) =>
          `${key}: tier T admits this keyword, and nothing has shown that ` +
          "carrying it changes no read. Add a value it could plausibly " +
          "disturb to TOLERATED_PROBE_VALUES and watch the read below come " +
          "back unchanged. Membership in ANNOTATION_KEYS makes a keyword a " +
          "candidate; inertness is a separate obligation, discharged per key " +
          "against the runner, and `$comment` is in the tree because nobody " +
          "discharged it."
        );
      expect(undischarged).toEqual([]);

      // The other direction: a probe value for a keyword the tier no longer
      // admits is a fixture nothing walks, and it would quietly stop covering
      // the key it was written for.
      const stranded = [...TOLERATED_PROBE_VALUES.keys()]
        .filter((key) => !TOLERATED_PROJECTION_KEYS.has(key));
      expect(stranded).toEqual([]);
    });

    it("returns what the same projection returns without it", async () => {
      const source = await seed("classification-tier-t-source", {
        type: "object",
        properties: { title: { type: "string" } },
      }, { title: "Visible" });

      const baseline = await read(source, {
        type: "object",
        properties: { title: {} },
      });
      expect(baseline).toEqual({ title: "Visible" });

      // Derived from the tier, so a keyword admitted to `ANNOTATION_KEYS`
      // tomorrow is read through here without anyone remembering to add it.
      for (const key of TOLERATED_PROJECTION_KEYS) {
        expect(
          await read(source, {
            type: "object",
            properties: { title: { [key]: TOLERATED_PROBE_VALUES.get(key) } },
          }),
        ).toEqual(baseline);
      }
    });

    it("refuses every stated exception through the denylist that claims it", async () => {
      const byFallThrough: string[] = [];
      for (const key of PROJECTION_ANNOTATION_EXCEPTIONS) {
        expect(projectionKeyTier(key)).toBe("refused");

        let message = "<accepted, and should not have been>";
        try {
          await parseSelectionProjection(JSON.stringify({ [key]: {} }));
        } catch (error) {
          message = (error as Error).message;
        }
        // Refused is not enough on its own: an exception dropped from its
        // denylist is still refused, by fall-through, because the exception
        // set is what keeps it out of tier T. What changes is the answer. The
        // denylists say WHY — `default` is the source schema's to state, the
        // definition keys have no meaning without the `$ref` projection also
        // refuses — while the fall-through says only that the reader does not
        // know the key, which is a poor answer for one it knows perfectly well
        // and refuses on purpose.
        if (
          !message.includes(`"${key}"`) ||
          message.includes("is not a projection schema keyword")
        ) {
          byFallThrough.push(`${key}: ${message}`);
        }
      }
      expect(byFallThrough).toEqual([]);
    });

    it("is `ANNOTATION_KEYS` less projection's stated exceptions, in both directions", () => {
      for (const key of ANNOTATION_KEYS) {
        expect(
          projectionKeyTier(key) === "tolerated" ||
            PROJECTION_ANNOTATION_EXCEPTIONS.has(key),
        ).toBe(true);
      }
      for (const key of PROJECTION_ANNOTATION_EXCEPTIONS) {
        expect(ANNOTATION_KEYS.has(key)).toBe(true);
      }
    });
  });

  describe("the `required` the reader derives from the source", () => {
    const requiredSourceSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        title: { type: "string" },
      },
      required: ["id", "title"],
    } as const satisfies JSONSchema;

    it("carries a source-required projected property into the output schema", async () => {
      const source = await seed(
        "classification-derived-required-source",
        requiredSourceSchema,
        { id: 1, title: "Visible" },
      );

      const schema = await outputSchemaOf(source, {
        type: "object",
        properties: { title: true },
      });

      expect((schema as Record<string, unknown>).required).toEqual(["title"]);
    });

    it("leaves the caller's own `required` out of the schema it carries a derived one into", async () => {
      const source = await seed(
        "classification-two-origins-source",
        requiredSourceSchema,
        { id: 1, title: "Visible" },
      );

      const schema = await outputSchemaOf(source, {
        type: "object",
        required: ["id"],
        properties: { title: true },
      });

      // The caller named `id`; the source requires `title` as well. Only the
      // reader's own derivation reaches the boundary, so `id` — which the
      // projection does not name at all — is not there.
      expect((schema as Record<string, unknown>).required).toEqual(["title"]);
    });

    it("returns the object without a source-required property the caller narrowed to a mismatched scalar", async () => {
      const source = await seed("classification-scalar-mismatch-source", {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
        },
        required: ["id"],
      }, { id: 1, title: "Visible" });

      expect(
        await read(source, {
          type: "object",
          properties: { id: { type: "string" }, title: true },
        }),
      ).toEqual({ title: "Visible" });
    });

    it("returns the object without a source-required position the source declares as an array or a string", async () => {
      const source = await seed("classification-union-type-source", {
        type: "object",
        properties: {
          values: { type: ["array", "string"] },
          title: { type: "string" },
        },
        required: ["values"],
      }, { values: "not a list", title: "Visible" });

      // The source admits an array here but does not require one, and what is
      // stored is the other branch. The caller's array projection rejects it,
      // so a `required` derived from "the source could be an array" voids the
      // object around a position that simply declined to be read.
      expect(
        await read(source, {
          type: "object",
          properties: { values: { type: "array", items: true }, title: true },
        }),
      ).toEqual({ title: "Visible" });
    });

    it("returns the object without a source-required position an `anyOf` declares as an array or a string", async () => {
      const source = await seed("classification-union-anyof-source", {
        type: "object",
        properties: {
          values: {
            anyOf: [
              { type: "array", items: { type: "number" } },
              { type: "string" },
            ],
          },
          title: { type: "string" },
        },
        required: ["values"],
      }, { values: "not a list", title: "Visible" });

      expect(
        await read(source, {
          type: "object",
          properties: { values: { type: "array", items: true }, title: true },
        }),
      ).toEqual({ title: "Visible" });
    });

    it("carries a source-required array into the output schema where the source declares only an array", async () => {
      const source = await seed("classification-only-array-source", {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
          title: { type: "string" },
        },
        required: ["values"],
      }, { values: [1], title: "Visible" });

      const schema = await outputSchemaOf(source, {
        type: "object",
        properties: { values: { type: "array", items: true }, title: true },
      });

      expect((schema as Record<string, unknown>).required).toEqual(["values"]);
    });

    it("carries a source-required array into the output schema where every `anyOf` branch is an array", async () => {
      // The positive of the union rule. Every branch names the container the
      // caller projected, so whichever one the value took, the projection does
      // not reject it — nothing the union admits can void the object.
      const source = await seed("classification-anyof-all-arrays-source", {
        type: "object",
        properties: {
          values: {
            anyOf: [
              { type: "array", items: { type: "number" } },
              { type: "array", items: { type: "string" } },
            ],
          },
          title: { type: "string" },
        },
        required: ["values"],
      }, { values: [1], title: "Visible" });

      const schema = await outputSchemaOf(source, {
        type: "object",
        properties: { values: { type: "array", items: true }, title: true },
      });

      expect((schema as Record<string, unknown>).required).toEqual(["values"]);
    });

    it("carries a source-required object into the output schema where the source declares only an object", async () => {
      const source = await seed("classification-only-object-source", {
        type: "object",
        properties: {
          topic: {
            type: "object",
            properties: { title: { type: "string" } },
          },
          title: { type: "string" },
        },
        required: ["topic"],
      }, { topic: { title: "Inner" }, title: "Visible" });

      const schema = await outputSchemaOf(source, {
        type: "object",
        properties: {
          topic: { type: "object", properties: { title: true } },
          title: true,
        },
      });

      expect((schema as Record<string, unknown>).required).toEqual(["topic"]);
    });

    it("carries a source-required array into the output schema where a `$ref` names it", async () => {
      const source = await seed("classification-ref-source", {
        type: "object",
        properties: {
          values: { $ref: "#/$defs/Values" },
          title: { type: "string" },
        },
        required: ["values"],
        $defs: { Values: { type: "array", items: { type: "number" } } },
      }, { values: [1], title: "Visible" });

      const schema = await outputSchemaOf(source, {
        type: "object",
        properties: { values: { type: "array", items: true }, title: true },
      });

      expect((schema as Record<string, unknown>).required).toEqual(["values"]);
    });

    it("carries a source-required array into the output schema where a `$ref` below the root names it", async () => {
      const source = await seed("classification-ref-depth-source", {
        type: "object",
        properties: {
          topic: {
            type: "object",
            properties: {
              values: { $ref: "#/$defs/Values" },
              name: { type: "string" },
            },
            required: ["values"],
          },
          title: { type: "string" },
        },
        $defs: { Values: { type: "array", items: { type: "number" } } },
      }, { topic: { values: [1], name: "a" }, title: "Visible" });

      const schema = await outputSchemaOf(source, {
        type: "object",
        properties: {
          topic: {
            type: "object",
            properties: { values: { type: "array", items: true }, name: true },
          },
          title: true,
        },
      });

      // The reference names the ROOT document's `$defs` from two levels down,
      // so the walk has to carry the document rather than the subtree it is
      // standing in.
      const topic = (schema as { properties: Record<string, unknown> })
        .properties.topic as Record<string, unknown>;
      expect(topic.required).toEqual(["values"]);
    });

    it("derives no `required` for a position whose container the source spells under `allOf`", async () => {
      const source = await seed("classification-allof-source", {
        type: "object",
        properties: {
          values: {
            allOf: [
              { type: "array", items: { type: "number" } },
              { minItems: 1 },
            ],
          },
          title: { type: "string" },
        },
        required: ["values"],
      }, { values: [1], title: "Visible" });

      const schema = await outputSchemaOf(source, {
        type: "object",
        properties: { values: { type: "array", items: true }, title: true },
      });

      // A conjunction constrains one value from several members at once, which
      // is not a shape this derivation can state. Declining to require costs a
      // key that would have survived; requiring wrongly costs the whole read.
      expect((schema as Record<string, unknown>).required).toBeUndefined();
    });

    it("returns the object without a source-required array whose items the caller narrowed to a mismatched scalar", async () => {
      const source = await seed("classification-item-mismatch-source", {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
          title: { type: "string" },
        },
        required: ["values"],
      }, { values: [1], title: "Visible" });

      expect(
        await read(source, {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "string" } },
            title: true,
          },
        }),
      ).toEqual({ title: "Visible" });
    });

    it("returns a source-required array of objects whose leaf the caller narrowed to a mismatched scalar", async () => {
      const source = await seed("classification-item-object-source", {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                name: { type: "string" },
              },
              required: ["id"],
            },
          },
          title: { type: "string" },
        },
        required: ["rows"],
      }, { rows: [{ id: 1, name: "a" }], title: "Visible" });

      expect(
        await read(source, {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, name: true },
              },
            },
            title: true,
          },
        }),
      ).toEqual({ rows: [{ name: "a" }], title: "Visible" });
    });
  });

  describe("a `$ref` the derivation cannot follow", () => {
    /**
     * These reach {@link outputSchemaWithSourceRequired} directly rather than
     * through a read. The runner resolves a source schema's references eagerly
     * — `resolveCfcSchemaRefsOrThrow` — so a source carrying an unresolvable
     * reference or a circle with no base case fails the read outright, before
     * any derivation is consulted. That is behavior this change neither
     * introduces nor alters, and asserting through a read would pin it instead
     * of the question here: what the derivation does when a reference gives it
     * nothing.
     */
    async function derivedRequired(
      source: JSONSchema,
      projection: unknown,
    ): Promise<unknown> {
      const parsed = await parseSelectionProjection(JSON.stringify(projection));
      const derived = outputSchemaWithSourceRequired(
        parsed.schema,
        source,
        source,
      );
      return (derived as Record<string, unknown>).required;
    }

    const arrayProjection = {
      type: "object",
      properties: { values: { type: "array", items: true }, title: true },
    };

    it("derives `required` for every projected property where the source's own root is a `$ref`", async () => {
      // A root spelled as a reference is followed like any other, so the
      // target's own `required` reaches every projected property beneath it
      // rather than none of them. Distinct from a referenced child because
      // one unresolved hop here would strand the whole schema, not one
      // position — which is why the case is pinned separately.
      expect(
        await derivedRequired({
          $ref: "#/$defs/Board",
          $defs: {
            Board: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
                title: { type: "string" },
              },
              required: ["values", "title"],
            },
          },
        }, arrayProjection),
      ).toEqual(["values", "title"]);
    });

    it("derives `required` where a `$ref` names one of the runner's embedded documents", async () => {
      // An embedded reference names a whole other document, so a reference
      // INSIDE it resolves against itself. The vnode document's own root is
      // `{"$ref": "#/$defs/VNode"}`, and that name exists only there — a
      // reader that kept the referring document as the scope resolves nothing
      // and proves no container.
      expect(
        await derivedRequired({
          type: "object",
          properties: {
            ui: { $ref: "https://commonfabric.org/schemas/vnode.json" },
            title: { type: "string" },
          },
          required: ["ui"],
        }, {
          type: "object",
          properties: {
            ui: { type: "object", properties: { type: true } },
            title: true,
          },
        }),
      ).toEqual(["ui"]);
    });

    it("derives no `required` for a position whose `$ref` names nothing in the document", async () => {
      // A reference that does not resolve proves nothing, and proving nothing
      // declines to require. Resolving optimistically would require a position
      // whose shape the reader never established.
      expect(
        await derivedRequired({
          type: "object",
          properties: {
            values: { $ref: "#/$defs/Missing" },
            title: { type: "string" },
          },
          required: ["values"],
          $defs: { Values: { type: "array", items: { type: "number" } } },
        }, arrayProjection),
      ).toBeUndefined();
    });

    it("derives no `required` for a position whose `$ref` chain closes a circle", async () => {
      // Returning at all is half of what this pins; the other half is that a
      // circle proves no container.
      expect(
        await derivedRequired({
          type: "object",
          properties: {
            values: { $ref: "#/$defs/Left" },
            title: { type: "string" },
          },
          required: ["values"],
          $defs: {
            Left: { $ref: "#/$defs/Right" },
            Right: { $ref: "#/$defs/Left" },
          },
        }, arrayProjection),
      ).toBeUndefined();
    });

    it("derives no `required` for a position whose union refers back to itself", async () => {
      expect(
        await derivedRequired({
          type: "object",
          properties: {
            values: { $ref: "#/$defs/Loop" },
            title: { type: "string" },
          },
          required: ["values"],
          $defs: {
            Loop: { anyOf: [{ $ref: "#/$defs/Loop" }, { type: "string" }] },
          },
        }, arrayProjection),
      ).toBeUndefined();
    });

    it("derives `required` for a `$ref` chain that resolves through two hops", async () => {
      // The negative beside the three above: a chain the resolver can follow
      // still proves what it names, so "never follow a reference" does not
      // pass this block.
      expect(
        await derivedRequired({
          type: "object",
          properties: {
            values: { $ref: "#/$defs/Alias" },
            title: { type: "string" },
          },
          required: ["values"],
          $defs: {
            Alias: { $ref: "#/$defs/Values" },
            Values: { type: "array", items: { type: "number" } },
          },
        }, arrayProjection),
      ).toEqual(["values"]);
    });
  });

  describe("the output schema the reader constructs", () => {
    it("omits a nested scalar leaf whose declared type does not match the stored value", async () => {
      const source = await seed("classification-nested-scalar-source", {
        type: "object",
        properties: {
          topic: {
            type: "object",
            properties: {
              id: { type: "number" },
              title: { type: "string" },
            },
          },
        },
      }, { topic: { id: 1, title: "Visible" } });

      expect(
        await read(source, {
          type: "object",
          properties: {
            topic: {
              type: "object",
              properties: { id: { type: "string" }, title: true },
            },
          },
        }),
      ).toEqual({ topic: { title: "Visible" } });
    });

    it("returns none of an object source's fields for a scalar projection over it", async () => {
      const source = await seed("classification-scalar-over-object-source", {
        type: "object",
        properties: {
          title: { type: "string" },
          secret: { type: "string" },
        },
      }, { title: "Visible", secret: "not asked for" });

      expect(await read(source, { type: "string" })).toBeUndefined();
    });
  });
});
