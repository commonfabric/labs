import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { cloneKeyExpression } from "../../src/utils/reactive-keys.ts";

describe("reactive-keys", () => {
  describe("cloneKeyExpression()", () => {
    const factory = ts.factory;

    it("returns a new identifier with the same name for an identifier", () => {
      const key = factory.createIdentifier("count");
      const clone = cloneKeyExpression(key, factory);
      expect(clone).not.toBe(key);
      expect(ts.isIdentifier(clone) && clone.text).toBe("count");
    });

    it("returns a new string literal with the same text for a string literal", () => {
      const key = factory.createStringLiteral("a key");
      const clone = cloneKeyExpression(key, factory);
      expect(clone).not.toBe(key);
      expect(ts.isStringLiteral(clone) && clone.text).toBe("a key");
    });

    it("returns a new numeric literal with the same text for a numeric literal", () => {
      const key = factory.createNumericLiteral("42");
      const clone = cloneKeyExpression(key, factory);
      expect(clone).not.toBe(key);
      expect(ts.isNumericLiteral(clone) && clone.text).toBe("42");
    });

    it("returns a string literal with the template's text for a template without substitutions", () => {
      const key = factory.createNoSubstitutionTemplateLiteral("k");
      const clone = cloneKeyExpression(key, factory);
      expect(ts.isStringLiteral(clone) && clone.text).toBe("k");
    });

    it("returns any other expression itself", () => {
      const key = factory.createPropertyAccessExpression(
        factory.createIdentifier("keys"),
        "first",
      );
      expect(cloneKeyExpression(key, factory)).toBe(key);
    });
  });
});
