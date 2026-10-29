/**
 * The two pure halves of verb documentation, tested directly against
 * constructed schemas: reading an author's prose out of a compiled pattern's
 * result schema, and folding it into the schema a caller is served.
 *
 * Its companion `verb-prose-live.test.ts` drives the same code through
 * `cf piece verbs` and `cf piece call --help` against compiled, run patterns,
 * and that is where the behavior a caller sees is pinned. This file exists for
 * the shapes a compiled pattern does not produce and a served schema may still
 * hold: a reference naming a definition that is not there, a definition that is
 * a boolean, a tuple, an `allOf`. Those are the branches nothing would exercise
 * otherwise, and an unexercised branch is the one that inverts unnoticed.
 *
 * The division is deliberate. A constructed schema is a claim about the world,
 * and this file is careful to make only claims the live file does not need to
 * carry — every position class here that a pattern CAN produce is asserted
 * there as well, against output the compiler actually emitted.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { decomposeSchema } from "@commonfabric/runner";
import { registerSchemaDocument } from "../../runner/src/schema-registry.ts";
import { externalRefTo } from "../../runner/test/schema-ref-helpers.ts";

/**
 * The root reference of `schema`, with its closure registered the way the
 * link writer's stamping registers one — decomposition alone only computes.
 */
function registeredRefTo(schema: JSONSchema): string {
  const { rootRef, documents } = decomposeSchema(schema as JSONSchemaObj);
  for (const [hash, document] of documents) {
    registerSchemaDocument(hash, document);
  }
  return rootRef;
}

import { declaredVerbProse, withDeclaredFieldProse } from "../lib/piece.ts";

/** `withDeclaredFieldProse` with both sides as plain objects. */
function fold(
  served: JSONSchema | true,
  declared: JSONSchema | undefined,
): any {
  return withDeclaredFieldProse(served, declared);
}

/** An object schema with the given properties, as both documents spell one. */
function object(properties: Record<string, unknown>, rest: object = {}) {
  return { type: "object", properties, ...rest } as unknown as JSONSchema;
}

describe("verb prose", () => {
  describe("withDeclaredFieldProse()", () => {
    describe("positions it walks", () => {
      it("fills a property's description", () => {
        const result = fold(
          object({ title: { type: "string" } }),
          object({ title: { type: "string", description: "The title." } }),
        );
        expect(result.properties.title.description).toBe("The title.");
      });

      it("fills a description inside a single-schema `items`", () => {
        const result = fold(
          {
            type: "array",
            items: object({ x: { type: "string" } }),
          } as unknown as JSONSchema,
          {
            type: "array",
            items: object({ x: { type: "string", description: "An x." } }),
          } as unknown as JSONSchema,
        );
        expect(result.items.properties.x.description).toBe("An x.");
      });

      it("fills a description at a `prefixItems` position, by index", () => {
        const result = fold(
          {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
          } as unknown as JSONSchema,
          {
            type: "array",
            prefixItems: [
              { type: "string", description: "First." },
              { type: "number", description: "Second." },
            ],
          } as unknown as JSONSchema,
        );
        // Index is a tuple position's whole identity, so the two descriptions
        // must not be swapped — asserted as a pair for that reason.
        expect(result.prefixItems.map((p: any) => p.description)).toEqual([
          "First.",
          "Second.",
        ]);
        // And the list is still a list. Addressing an index and then
        // object-spreading the container would hand back `{"0": …, "1": …}`.
        expect(Array.isArray(result.prefixItems)).toBe(true);
      });

      it("fills a description at a positional `items` entry, by index", () => {
        const result = fold(
          {
            type: "array",
            items: [{ type: "string" }],
          } as unknown as JSONSchema,
          {
            type: "array",
            items: [{ type: "string", description: "The only one." }],
          } as unknown as JSONSchema,
        );
        expect(Array.isArray(result.items)).toBe(true);
        expect(result.items[0].description).toBe("The only one.");
      });

      for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
        it(`fills a description inside a \`${keyword}\` member, by index`, () => {
          const result = fold(
            {
              [keyword]: [object({ x: { type: "string" } })],
            } as unknown as JSONSchema,
            {
              [keyword]: [
                object({ x: { type: "string", description: "An x." } }),
              ],
            } as unknown as JSONSchema,
          );
          expect(result[keyword][0].properties.x.description).toBe("An x.");
          expect(Array.isArray(result[keyword])).toBe(true);
          expect(result[keyword]).toHaveLength(1);
        });
      }

      it("visits one definition once per arm that names it", () => {
        // Both arms reference `Cat`, each adding its own sentence at the ref
        // site. A guard recording "this reference has been seen" rather than
        // "this reference is open on the path" drops the second arm whole, and
        // with it the only account of `loud`.
        const result = fold(
          object({ quiet: { type: "string" }, loud: { type: "string" } }),
          {
            anyOf: [
              {
                $ref: "#/$defs/Cat",
                properties: { quiet: { description: "Barely heard." } },
              },
              {
                $ref: "#/$defs/Cat",
                properties: { loud: { description: "Heard next door." } },
              },
            ],
            $defs: {
              Cat: object({
                quiet: { type: "string" },
                loud: { type: "string" },
              }),
            },
          } as unknown as JSONSchema,
        );
        expect(result.properties.quiet.description).toBe("Barely heard.");
        expect(result.properties.loud.description).toBe("Heard next door.");
      });

      it("prefers the arm that documents a field over one that merely declares it", () => {
        // The first arm mentions `meow` without saying anything about it.
        // Taking the first arm that HAS the key, rather than the first that
        // SAYS something, loses the only sentence written about this field.
        const result = fold(
          object({ meow: { type: "string" } }),
          {
            anyOf: [
              object({ meow: { type: "string" } }),
              object({ meow: { type: "string", description: "How loud." } }),
            ],
          } as unknown as JSONSchema,
        );
        expect(result.properties.meow.description).toBe("How loud.");
      });

      it("resolves a nested reference against the document root, not the definition's own `$defs`", () => {
        // `Outer` carries `$defs` of its own, but its `pet` names the `Cat`
        // at the event root: `#/$defs/Cat` is a root pointer, and the `$defs`
        // below the root's map is inert.
        const result = fold(
          object({ pet: object({ meow: { type: "string" } }) }),
          {
            $ref: "#/$defs/Outer",
            $defs: {
              Outer: object({ pet: { $ref: "#/$defs/Cat" } }, {
                $defs: {
                  Cat: object({ meow: { type: "string" } }),
                },
              }),
              Cat: object({
                meow: { type: "string", description: "The root cat." },
              }),
            },
          } as unknown as JSONSchema,
        );
        expect(result.properties.pet.properties.meow.description)
          .toBe("The root cat.");
      });

      it("finds a property's prose in whichever declared arm declares it", () => {
        // The served side spells a union as one merged object, which is what
        // the compiler emits when a handler reads fields from both arms. The
        // prose for each field is inside a different arm.
        const result = fold(
          object({ meow: { type: "string" }, woof: { type: "string" } }),
          {
            anyOf: [
              object({ meow: { type: "string", description: "How loud." } }),
              object({ woof: { type: "string", description: "How deep." } }),
            ],
          } as unknown as JSONSchema,
        );
        expect(result.properties.meow.description).toBe("How loud.");
        expect(result.properties.woof.description).toBe("How deep.");
      });

      it("reaches one served definition from every position that names it", () => {
        // Two served positions share `$defs/Cat`. The first position's declared
        // account says nothing; the second's documents the field. A guard that
        // retires a served definition after one visit stops at the first and
        // the prose is never found — the same "seen once" mistake as on the
        // declared side, on the other document.
        const served = object({
          stray: { $ref: "#/$defs/Cat" },
          housecat: { $ref: "#/$defs/Cat" },
        }, { $defs: { Cat: object({ meow: { type: "string" } }) } });
        const result = fold(
          served,
          object({
            stray: object({ meow: { type: "string" } }),
            housecat: object({
              meow: { type: "string", description: "How loud." },
            }),
          }),
        );
        expect(result.$defs.Cat.properties.meow.description).toBe("How loud.");
      });

      it("gives a shared served definition the first account of it", () => {
        // Both positions reach `$defs/Cat` and both are documented, so both
        // want to write the same slot. A definition is shared, so one of them
        // has to lose: the first in document order wins, deterministically.
        // Letting the later one through would make the words a caller reads
        // depend on property ordering.
        const served = object({
          alpha: { $ref: "#/$defs/Cat" },
          beta: { $ref: "#/$defs/Cat" },
        }, { $defs: { Cat: object({ meow: { type: "string" } }) } });
        const result = fold(
          served,
          object({
            alpha: object({
              meow: { type: "string", description: "Alpha's account." },
            }),
            beta: object({
              meow: { type: "string", description: "Beta's account." },
            }),
          }),
        );
        expect(result.$defs.Cat.properties.meow.description)
          .toBe("Alpha's account.");
      });

      it("follows a reference on either side to reach a position", () => {
        const result = fold(
          object({ pet: { $ref: "#/$defs/Cat" } }, {
            $defs: { Cat: object({ meow: { type: "string" } }) },
          }),
          object({ pet: { $ref: "#/$defs/Cat" } }, {
            $defs: {
              Cat: object({ meow: { type: "string", description: "Loud." } }),
            },
          }),
        );
        // Written into the served definition, and the reference to it left
        // exactly as it was.
        expect(result.$defs.Cat.properties.meow.description).toBe("Loud.");
        expect(result.properties.pet).toEqual({ $ref: "#/$defs/Cat" });
      });
    });

    describe("what it refuses to do", () => {
      it("gives no arm the description of the position holding it", () => {
        // The served side spells a disjunction the declared side does not, so
        // the arms cannot be paired. The declared node's own sentence describes
        // the position, not any one alternative, and copying it onto every arm
        // would describe each of them wrongly.
        const result = fold(
          {
            anyOf: [
              object({ x: { type: "string" } }),
              object({ y: { type: "string" } }),
            ],
          } as unknown as JSONSchema,
          object({ x: { type: "string", description: "An x." } }, {
            description: "The whole thing.",
          }),
        );
        expect(result.anyOf[0].description).toBeUndefined();
        expect(result.anyOf[1].description).toBeUndefined();
        // Nested positions are still reached, which is the whole reason the
        // unpaired case descends at all.
        expect(result.anyOf[0].properties.x.description).toBe("An x.");
      });

      it("never overwrites a description the served schema already carries", () => {
        const result = fold(
          object({ title: { type: "string", description: "Served says." } }),
          object({ title: { type: "string", description: "Declared says." } }),
        );
        expect(result.properties.title.description).toBe("Served says.");
      });

      it("adds no property the served schema does not carry", () => {
        const result = fold(
          object({ title: { type: "string" } }),
          object({
            title: { type: "string" },
            extra: { type: "string", description: "Not served." },
          }),
        );
        expect(Object.keys(result.properties)).toEqual(["title"]);
      });

      it("takes no description for the root position", () => {
        // The root's prose belongs to the VERB and rides the spec's own
        // `description`; putting it here would make it a claim about the event
        // object a caller sends.
        const result = fold(
          object({ title: { type: "string" } }),
          object({ title: { type: "string" } }, { description: "The verb." }),
        );
        expect(result.description).toBeUndefined();
      });

      it("returns the same object when there is nothing to fill", () => {
        const served = object({ title: { type: "string" } });
        // Identity, not equality: every subtree no edit touches is shared, so a
        // rebuild that copied the document wholesale would fail here even
        // though its output looked right.
        expect(fold(served, object({ title: { type: "string" } })))
          .toBe(served);
      });

      it("returns an unconstrained served schema untouched", () => {
        expect(fold(true, object({ x: { type: "string" } }))).toBe(true);
      });
    });

    describe("references it expands", () => {
      it("serves a content-addressed reference expanded, with the declared names put back", () => {
        // A served schema stored as a reference reaches the caller in the
        // expanded form, and the recomposition takes its `$defs` names from
        // the declared document — the stored form knows a definition only
        // by its hash. A sibling riding beside the reference stays beside
        // the expansion.
        const declared = object({ row: { $ref: "#/$defs/Row" } }, {
          $defs: {
            Row: object({ label: { type: "string", description: "L." } }),
          },
        });
        const rootRef = registeredRefTo(declared);
        const result = fold(
          { $ref: rootRef, description: "kept" } as JSONSchema,
          declared,
        );
        expect(result.description).toBe("kept");
        expect(result.properties.row.$ref).toBe("#/$defs/Row");
        expect(result.$defs.Row.properties.label.description).toBe("L.");
      });

      it("restores the declared name when the served definition dropped the prose", () => {
        // Descriptions participate in schema hashing, so a served document
        // whose definitions carry no prose hashes differently from the
        // declaration that documents them. The name map must bridge that
        // gap, or the definitions an author documented best are exactly the
        // ones renamed def_XXXX.
        const declared = object({ pet: { $ref: "#/$defs/Pet" } }, {
          $defs: {
            Pet: {
              type: "object",
              description: "A household pet.",
              properties: {
                name: { type: "string", description: "The pet's name." },
              },
            },
          },
        });
        const servedSource = object({ pet: { $ref: "#/$defs/Pet" } }, {
          $defs: {
            Pet: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        });
        const rootRef = registeredRefTo(servedSource);
        const result = fold({ $ref: rootRef } as JSONSchema, declared);
        expect(Object.keys(result.$defs)).toEqual(["Pet"]);
        expect(result.properties.pet.$ref).toBe("#/$defs/Pet");
      });

      it("strips schema prose without rewriting application data", () => {
        // A `default` carries DATA, and data may contain a member named
        // `description`. The name map's prose-stripped hash must remove
        // only schema prose, or the definition hashes to a third form
        // nothing served ever carries — and the authored name is lost for
        // exactly the definitions that ship default data.
        const declared = object({ pet: { $ref: "#/$defs/Pet" } }, {
          $defs: {
            Pet: {
              type: "object",
              description: "A household pet.",
              default: { description: "literal application data" },
              properties: { name: { type: "string" } },
            },
          },
        });
        const servedSource = object({ pet: { $ref: "#/$defs/Pet" } }, {
          $defs: {
            Pet: {
              type: "object",
              default: { description: "literal application data" },
              properties: { name: { type: "string" } },
            },
          },
        });
        const rootRef = registeredRefTo(servedSource);
        const result = fold({ $ref: rootRef } as JSONSchema, declared);
        expect(Object.keys(result.$defs)).toEqual(["Pet"]);
        expect(result.$defs.Pet.default).toEqual({
          description: "literal application data",
        });
      });

      it("serves a reference to a boolean document as that boolean", () => {
        // A definition can be a boolean, so a document can be one too, and
        // a boolean has no siblings to keep or prose to fold.
        const ref = externalRefTo(true);
        registerSchemaDocument(
          ref.$ref!.slice("cid:".length),
          true,
        );
        expect(fold(ref as JSONSchema, undefined)).toBe(true);
      });

      it("serves hash-derived names when a declared definition will not decompose", () => {
        // The name map decomposes each declared definition against the whole
        // declared `$defs`, so a dangling reference anywhere in that group —
        // here, `Dangling` — fails every definition's decomposition. The
        // expansion itself must not fail with it: the closure is still
        // served, under the hash-derived names the stored form knows.
        const row = object({ label: { type: "string" } });
        const servedSource = object({ row: { $ref: "#/$defs/Row" } }, {
          $defs: { Row: row },
        });
        const rootRef = registeredRefTo(servedSource);
        const declared = object({ row: { $ref: "#/$defs/Row" } }, {
          $defs: {
            Row: row,
            Dangling: { $ref: "#/$defs/Missing" },
          },
        });
        const result = fold({ $ref: rootRef } as JSONSchema, declared);
        const defNames = Object.keys(result.$defs);
        expect(defNames.length).toBe(1);
        expect(defNames[0].startsWith("def_")).toBe(true);
        expect(result.properties.row.$ref).toBe(`#/$defs/${defNames[0]}`);
      });
    });

    describe("shapes it cannot read", () => {
      it("leaves a served reference naming no definition alone", () => {
        const served = object({ pet: { $ref: "#/$defs/Missing" } }, {
          $defs: { Cat: object({ meow: { type: "string" } }) },
        });
        const result = fold(
          served,
          object({
            pet: object({ meow: { type: "string", description: "L." } }),
          }),
        );
        expect(result).toBe(served);
      });

      it("leaves a served reference alone when the root defines nothing", () => {
        const served = object({ pet: { $ref: "#/$defs/Cat" } });
        const result = fold(
          served,
          object({
            pet: object({ meow: { type: "string", description: "L." } }),
          }),
        );
        expect(result).toBe(served);
      });

      it("leaves a served reference to a non-schema definition alone", () => {
        const served = object({ pet: { $ref: "#/$defs/Cat" } }, {
          $defs: { Cat: true },
        });
        const result = fold(
          served,
          object({
            pet: object({ meow: { type: "string", description: "L." } }),
          }),
        );
        expect(result).toBe(served);
      });

      it("leaves a position alone when the declared reference does not resolve", () => {
        const served = object({ pet: object({ meow: { type: "string" } }) });
        const result = fold(
          served,
          object({ pet: { $ref: "#/$defs/Gone" } }),
        );
        expect(result).toBe(served);
      });

      it("leaves a served position with no declared counterpart alone", () => {
        const served = object({ title: { type: "string" } });
        expect(fold(served, object({ other: { type: "string" } })))
          .toBe(served);
      });

      it("leaves served tuple positions alone when the declared side has none", () => {
        // A tuple pairs by index and by nothing else, so a declared side that
        // spells the same position as a single element schema offers no index
        // to pair with. Filling from it would put the element type's prose on
        // whichever tuple slot happened to come first.
        const served = {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
        } as unknown as JSONSchema;
        const declared = {
          type: "array",
          items: { type: "string", description: "Every element." },
        } as unknown as JSONSchema;
        expect(fold(served, declared)).toBe(served);
      });

      it("skips a combinator member that is not a schema object", () => {
        // `anyOf: [true, …]` is legal and carries no positions. Asking it for
        // one must skip it rather than treat `true` as a node with properties.
        const result = fold(
          object({ x: { type: "string" } }),
          {
            anyOf: [
              true,
              object({ x: { type: "string", description: "An x." } }),
            ],
          } as unknown as JSONSchema,
        );
        expect(result.properties.x.description).toBe("An x.");
      });

      it("leaves a non-object served position alone", () => {
        const served = object({ anything: true });
        expect(
          fold(
            served,
            object({ anything: { type: "string", description: "A." } }),
          ),
        ).toBe(served);
      });

      it("walks none of the keywords outside its enumerated list", () => {
        // The contract names what it walks; this is the other half of that
        // claim, and it fails the day one of these is added without the
        // documentation catching up.
        const served = object({}, {
          additionalProperties: object({ x: { type: "string" } }),
          not: object({ y: { type: "string" } }),
          if: object({ z: { type: "string" } }),
        });
        const declared = object({}, {
          additionalProperties: object({
            x: { type: "string", description: "An x." },
          }),
          not: object({ y: { type: "string", description: "A y." } }),
          if: object({ z: { type: "string", description: "A z." } }),
        });
        expect(fold(served, declared)).toBe(served);
      });
    });

    describe("termination", () => {
      it("returns for a schema whose definitions reference each other", () => {
        // Reaching this assertion at all is what it pins: a walk that follows
        // references without refusing a definition it has already visited
        // exhausts the stack before returning.
        const cyclic = (described: boolean) =>
          object({ root: { $ref: "#/$defs/Node" } }, {
            $defs: {
              Node: object({
                label: described
                  ? { type: "string", description: "Its name." }
                  : { type: "string" },
                kids: { type: "array", items: { $ref: "#/$defs/Node" } },
              }),
            },
          });
        const result = fold(cyclic(false), cyclic(true));
        expect(result.$defs.Node.properties.label.description)
          .toBe("Its name.");
      });

      it("returns for a combinator whose members reference each other", () => {
        const cyclic = (described: boolean) =>
          object({ root: { $ref: "#/$defs/Loop" } }, {
            $defs: {
              Loop: {
                anyOf: [
                  { $ref: "#/$defs/Loop" },
                  object({
                    end: described
                      ? { type: "string", description: "The end." }
                      : { type: "string" },
                  }),
                ],
              },
            },
          });
        const result = fold(cyclic(false), cyclic(true));
        expect(result.$defs.Loop.anyOf[1].properties.end.description)
          .toBe("The end.");
      });
    });
  });

  describe("declaredVerbProse()", () => {
    it("returns a verb's own description and its resolved event schema", () => {
      const prose = declaredVerbProse({
        resultSchema: object({
          add: { $ref: "#/$defs/AddEvent", description: "Add one." },
        }, {
          $defs: { AddEvent: object({ title: { type: "string" } }) },
        }),
      });
      expect(prose.get("add")?.description).toBe("Add one.");
      expect(prose.get("add")?.eventSchema).toMatchObject({
        properties: { title: { type: "string" } },
      });
    });

    it("skips a result property that is not a schema object", () => {
      const prose = declaredVerbProse({
        resultSchema: object({ anything: true, add: { description: "Add." } }),
      });
      expect(prose.has("anything")).toBe(false);
      expect(prose.get("add")?.description).toBe("Add.");
    });

    it("skips a property whose reference resolves to nothing and says nothing", () => {
      // No description of its own and no reachable event schema: there is
      // nothing to report, and an entry here would be an empty promise a caller
      // of the map has to re-check.
      const prose = declaredVerbProse({
        resultSchema: object({ add: { $ref: "#/$defs/Gone" } }),
      });
      expect(prose.has("add")).toBe(false);
    });

    it("returns nothing for a pattern with no result schema", () => {
      expect(declaredVerbProse(undefined).size).toBe(0);
      expect(declaredVerbProse({}).size).toBe(0);
      expect(declaredVerbProse({ resultSchema: true }).size).toBe(0);
    });
  });

  describe("a result schema that is a reference at its root", () => {
    it("reads the verbs from the definition the root names", () => {
      // A pattern whose result is a NAMED type compiles this way, which is
      // every piece a verb creates: its result is the type its author
      // declared, so the properties live in `$defs` rather than on the root.
      // A root piece, whose result is written inline, kept its prose while a
      // created one lost all of it.
      const pattern = {
        resultSchema: {
          $ref: "#/$defs/Item",
          $defs: {
            Item: {
              type: "object",
              properties: {
                blockOn: {
                  $ref: "#/$defs/BlockOnEvent",
                  asCell: ["stream"],
                  description: "Record that this item waits on another.",
                },
              },
            },
            BlockOnEvent: { type: "object", properties: { on: {} } },
          },
        },
      };

      const prose = declaredVerbProse(pattern);
      expect(prose.get("blockOn")?.description)
        .toBe("Record that this item waits on another.");
    });

    it("still reads an inline result schema", () => {
      // The root-piece shape, which worked before and must keep working.
      const pattern = {
        resultSchema: {
          type: "object",
          properties: { addItem: { description: "File a new root item." } },
        },
      };
      expect(declaredVerbProse(pattern).get("addItem")?.description)
        .toBe("File a new root item.");
    });

    it("returns nothing for a root reference that resolves to nothing", () => {
      const pattern = { resultSchema: { $ref: "#/$defs/Absent" } };
      expect(declaredVerbProse(pattern).size).toBe(0);
    });

    it("resolves a property reference against the document root, not the definition's own `$defs`", () => {
      // `#/$defs/Ev` names the root's definition. The `$defs` the named
      // definition carries of its own is inert below the root's map, so the
      // property of `Item` reads the outer `Ev`.
      const pattern = {
        resultSchema: {
          $ref: "#/$defs/Item",
          $defs: {
            Item: {
              type: "object",
              properties: { act: { $ref: "#/$defs/Ev", description: "Act." } },
              $defs: {
                Ev: {
                  type: "object",
                  properties: { inner: { type: "string" } },
                },
              },
            },
            Ev: {
              type: "object",
              properties: { outer: { type: "string" } },
            },
          },
        },
      };

      const eventSchema = declaredVerbProse(pattern).get("act")
        ?.eventSchema as Record<string, unknown> | undefined;
      const props = eventSchema?.properties as Record<string, unknown>;
      expect(Object.keys(props)).toEqual(["outer"]);
    });
  });
});
