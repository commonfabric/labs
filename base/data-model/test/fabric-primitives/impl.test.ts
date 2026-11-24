/**
 * What `fabric-primitives/impl.ts` derives from its set of classes, and that
 * set's agreement with the vocabularies that range over the classes. Nothing
 * here names a class: each case ranges over `codecClasses()`, over one of
 * those vocabularies, or over the primitives the shared corpus holds, so a
 * class added to the package is covered without an edit here.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricPrimitive, type FabricPrimitiveSchemaType } from "@";
import { JSON_CODEC } from "@/codec-common";
import {
  codecClasses,
  FABRIC_PRIMITIVE_CODEC_TYPE_TAGS,
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  fabricPrimitiveClassesByName,
  fabricPrimitiveClassOfSchemaType,
  isFabricPrimitiveSchemaType,
} from "@/fabric-primitives";
import { LAYER_CORPUS } from "../fabric-value-corpus.ts";

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

    it("lists classes whose reported `.schemaType`s are exactly `FABRIC_PRIMITIVE_SCHEMA_TYPES`", () => {
      const names = codecClasses().map((cls) => cls.prototype.schemaType);
      expect(new Set<string>(names)).toEqual(
        new Set<string>(FABRIC_PRIMITIVE_SCHEMA_TYPES),
      );
    });

    it("lists classes whose JSON codecs' type tags are exactly `FABRIC_PRIMITIVE_CODEC_TYPE_TAGS`", () => {
      const tags = codecClasses().map((cls) =>
        cls[JSON_CODEC].recognizedTypeTag
      );
      expect(new Set(tags).size).toBe(tags.length);
      expect(new Set(tags)).toEqual(
        new Set<string | undefined>(
          Object.values(FABRIC_PRIMITIVE_CODEC_TYPE_TAGS),
        ),
      );
    });

    it("lists the class of every `FabricPrimitive` in the corpus", () => {
      expect(PRIMITIVES.length).toBeGreaterThan(0);
      const classes = new Set<unknown>(codecClasses());
      for (const [, value] of PRIMITIVES) {
        expect(classes.has(value.constructor)).toBe(true);
      }
    });
  });

  describe("fabricPrimitiveClassesByName()", () => {
    it("returns exactly the classes `codecClasses()` lists", () => {
      const named = Object.values(fabricPrimitiveClassesByName());
      expect(new Set<unknown>(named)).toEqual(new Set<unknown>(codecClasses()));
      expect(named.length).toBe(codecClasses().length);
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
      expect(FABRIC_PRIMITIVE_SCHEMA_TYPES.length).toBe(codecClasses().length);
    });
  });

  describe("fabricPrimitiveClassOfSchemaType()", () => {
    it("returns each listed class given the `.schemaType` it reports", () => {
      for (const cls of codecClasses()) {
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
      for (const cls of codecClasses()) {
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
