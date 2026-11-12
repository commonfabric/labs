/**
 * What `fabric-primitives/impl.ts` derives from its set of classes, and that
 * set's agreement with the vocabularies that range over the classes. Nothing
 * here names a class: each case ranges over `codecClasses()`, over
 * `fabricPrimitiveClassesByName()`, over one of those vocabularies, or over the
 * primitives the shared corpus holds, so a class added to the package is
 * covered without an edit here.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricPrimitive, type FabricPrimitiveSchemaType } from "@";
import { JSON_CODEC, REALM_CODEC } from "@/codec-common";
import {
  codecClasses,
  FABRIC_PRIMITIVE_CODEC_TYPE_TAGS,
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  fabricPrimitiveClassesByName,
  fabricPrimitiveClassOfSchemaType,
  isFabricPrimitiveSchemaType,
} from "@/fabric-primitives";
import { LAYER_CORPUS } from "../fabric-value-corpus.ts";

/** Every primitive class, whether or not it binds a codec. */
const ALL_CLASSES = Object.values(fabricPrimitiveClassesByName());

/**
 * The `FabricPrimitive`s among the corpus, labeled as the corpus labels them.
 */
const PRIMITIVES = LAYER_CORPUS.filter(
  (entry): entry is [string, FabricPrimitive] =>
    entry[1] instanceof FabricPrimitive,
);

describe("fabric-primitives/impl", () => {
  describe("codecClasses()", () => {
    it("lists classes which each report a distinct `.schemaType`", () => {
      const names = codecClasses().map((cls) => cls.prototype.schemaType);
      expect(new Set(names).size).toBe(names.length);
    });

    it("lists exactly the classes which bind a codec for each format", () => {
      const bindsCodecs = (cls: object) =>
        (JSON_CODEC in cls) && (REALM_CODEC in cls);
      expect(new Set<unknown>(codecClasses())).toEqual(
        new Set<unknown>(ALL_CLASSES.filter(bindsCodecs)),
      );
    });

    it("leaves out only classes which bind a codec for no format", () => {
      const listed = new Set<unknown>(codecClasses());
      for (const cls of ALL_CLASSES.filter((cls) => !listed.has(cls))) {
        expect(JSON_CODEC in cls).toBe(false);
        expect(REALM_CODEC in cls).toBe(false);
      }
    });

    it("lists classes whose JSON codecs' type tags are exactly `FABRIC_PRIMITIVE_CODEC_TYPE_TAGS`", () => {
      const tags = codecClasses().map((cls) =>
        (JSON_CODEC in cls) ? cls[JSON_CODEC].recognizedTypeTag : undefined
      );
      expect(new Set(tags).size).toBe(tags.length);
      expect(new Set(tags)).toEqual(
        new Set<string | undefined>(
          Object.values(FABRIC_PRIMITIVE_CODEC_TYPE_TAGS),
        ),
      );
    });
  });

  describe("fabricPrimitiveClassesByName()", () => {
    it("returns every class `codecClasses()` lists", () => {
      const named = new Set<unknown>(ALL_CLASSES);
      for (const cls of codecClasses()) {
        expect(named.has(cls)).toBe(true);
      }
    });

    it("returns classes whose reported `.schemaType`s are exactly `FABRIC_PRIMITIVE_SCHEMA_TYPES`", () => {
      const names = ALL_CLASSES.map((cls) => cls.prototype.schemaType);
      expect(new Set(names).size).toBe(names.length);
      expect(new Set<string>(names)).toEqual(
        new Set<string>(FABRIC_PRIMITIVE_SCHEMA_TYPES),
      );
    });

    it("returns a frozen record", () => {
      expect(Object.isFrozen(fabricPrimitiveClassesByName())).toBe(true);
    });

    it("keys each class by the class's own `.name`", () => {
      // The record's keys are written by hand, and this is the run-time check
      // of them. It holds where tests run, which is unminified.

      for (
        const [name, cls] of Object.entries(fabricPrimitiveClassesByName())
      ) {
        expect(cls.name).toBe(name);
      }
    });

    for (const [label, value] of PRIMITIVES) {
      it(`holds the class of ${label} under that class's name`, () => {
        const byName: Record<string, unknown> = fabricPrimitiveClassesByName();
        expect(byName[value.constructor.name]).toBe(value.constructor);
      });
    }
  });

  describe("FABRIC_PRIMITIVE_SCHEMA_TYPES", () => {
    it("is a frozen array with one entry per listed class", () => {
      expect(Object.isFrozen(FABRIC_PRIMITIVE_SCHEMA_TYPES)).toBe(true);
      expect(FABRIC_PRIMITIVE_SCHEMA_TYPES.length).toBe(ALL_CLASSES.length);
    });
  });

  describe("fabricPrimitiveClassOfSchemaType()", () => {
    it("returns each listed class given the `.schemaType` it reports", () => {
      for (const cls of ALL_CLASSES) {
        expect(fabricPrimitiveClassOfSchemaType(cls.prototype.schemaType))
          .toBe(cls);
      }
    });

    for (const [label, value] of PRIMITIVES) {
      it(`returns the class of ${label} given its \`.schemaType\``, () => {
        expect(fabricPrimitiveClassOfSchemaType(value.schemaType))
          .toBe(value.constructor);
      });
    }

    it("throws given a name no class reports", () => {
      expect(() =>
        fabricPrimitiveClassOfSchemaType("Bogus" as FabricPrimitiveSchemaType)
      ).toThrow(/`Bogus`/);
    });
  });

  describe("isFabricPrimitiveSchemaType()", () => {
    it("returns `true` for the `.schemaType` of every listed class", () => {
      for (const cls of ALL_CLASSES) {
        expect(isFabricPrimitiveSchemaType(cls.prototype.schemaType))
          .toBe(true);
      }
    });

    it("returns `false` for a type name outside the vocabulary", () => {
      expect(isFabricPrimitiveSchemaType("object")).toBe(false);
      expect(isFabricPrimitiveSchemaType("FabricNope")).toBe(false);
    });
  });
});
