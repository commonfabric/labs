import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { InvalidIfcLabelError, parseIfcLabel } from "@commonfabric/runner/cfc";

const USER = {
  type: CFC_ATOM_TYPE.User,
  subject: "did:key:alice",
};

/** Asserts that parsing `value` refuses it at `path`. */
const expectInvalid = (value: unknown, path: string): void => {
  try {
    parseIfcLabel(value);
    throw new Error("Expected parseIfcLabel() to throw.");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidIfcLabelError);
    if (!(error instanceof InvalidIfcLabelError)) throw error;
    expect(error.path).toBe(path);
  }
};

describe("label-parser", () => {
  describe("parseIfcLabel()", () => {
    it("returns an empty label from an empty object", () => {
      expect(parseIfcLabel({})).toEqual({});
    });

    it("returns labels with either or both dimensions", () => {
      expect(parseIfcLabel({ confidentiality: [USER] })).toEqual({
        confidentiality: [USER],
      });
      expect(parseIfcLabel({
        confidentiality: [USER],
        integrity: [USER],
      })).toEqual({
        confidentiality: [USER],
        integrity: [USER],
      });
    });

    it("accepts a canonical `Caveat` atom", () => {
      const caveat = {
        type: CFC_ATOM_TYPE.Caveat,
        kind: "https://example.com/caveat/untrusted-text",
        source: {
          space: "did:key:alice",
          id: "of:message",
          path: ["body"],
        },
      };
      expect(parseIfcLabel({ confidentiality: [caveat] })).toEqual({
        confidentiality: [caveat],
      });
    });

    it("preserves an unknown type URI and rejects padding", () => {
      const extension = {
        type: "https://example.com/cfc/atom/Extension",
        claim: { level: 2 },
      };
      expect(parseIfcLabel({ integrity: [extension] })).toEqual({
        integrity: [extension],
      });
      extension.type = ` ${extension.type}`;
      expectInvalid({ integrity: [extension] }, "/integrity/0/type");
    });

    it("accepts empty and multi-alternative confidentiality `anyOf` clauses", () => {
      expect(parseIfcLabel({ confidentiality: [{ anyOf: [] }] })).toEqual({
        confidentiality: [{ anyOf: [] }],
      });
      const service = {
        type: "https://example.com/cfc/atom/Service",
        subject: "did:web:service.example",
      };
      expect(parseIfcLabel({
        confidentiality: [{ anyOf: [USER, service] }],
      })).toEqual({
        confidentiality: [{ anyOf: [USER, service] }],
      });
    });

    it("throws for a nested `anyOf` clause", () => {
      expectInvalid({
        confidentiality: [{ anyOf: [{ anyOf: [USER] }] }],
      }, "/confidentiality/0/anyOf/0");
    });

    it("throws for an `anyOf` clause in integrity", () => {
      expectInvalid({ integrity: [{ anyOf: [USER] }] }, "/integrity/0");
    });

    for (const dimension of ["confidentiality", "integrity"] as const) {
      it(`throws for a principal string in \`${dimension}\``, () => {
        expectInvalid({ [dimension]: ["did:key:alice"] }, `/${dimension}/0`);
      });
    }

    it("throws for malformed `anyOf` clauses", () => {
      expectInvalid(
        { confidentiality: [{ anyOf: USER }] },
        "/confidentiality/0/anyOf",
      );
      expectInvalid({
        confidentiality: [{ anyOf: [USER], comment: "extra" }],
      }, "/confidentiality/0");
    });

    it("throws without evaluating accessor-backed objects or arrays", () => {
      let reads = 0;
      const atom = {};
      Object.defineProperty(atom, "type", {
        enumerable: true,
        get() {
          reads++;
          return CFC_ATOM_TYPE.User;
        },
      });

      expectInvalid({ confidentiality: [atom] }, "/confidentiality/0/type");
      const confidentiality = [USER];
      Object.defineProperty(confidentiality, 0, {
        enumerable: true,
        get() {
          reads++;
          return USER;
        },
      });

      expectInvalid({ confidentiality }, "/confidentiality/0");
      expect(reads).toBe(0);
    });

    it("throws for an unknown root property", () => {
      expectInvalid({ confidentiality: [], opaque: [] }, "/opaque");
    });

    for (
      const [description, value] of [
        ["undefined", undefined],
        ["a non-finite number", Number.NaN],
      ] as const
    ) {
      it(`throws for ${description} inside an atom`, () => {
        expectInvalid({
          integrity: [{
            type: "https://example.com/cfc/atom/Extension",
            value,
          }],
        }, "/integrity/0/value");
      });
    }

    it("throws for a type that is not an absolute URI", () => {
      expectInvalid(
        { integrity: [{ type: "cfc/atom/Extension" }] },
        "/integrity/0/type",
      );
    });

    it("throws for a symbol-keyed property on an object", () => {
      expectInvalid({ [Symbol("hidden")]: [] }, "/");
    });

    it("throws for a non-enumerable property on an object", () => {
      const atom = { type: "https://example.com/cfc/atom/Extension" };
      Object.defineProperty(atom, "hidden", { enumerable: false, value: 1 });
      expectInvalid({ integrity: [atom] }, "/integrity/0/hidden");
    });

    it("throws for a symbol-keyed property on an array", () => {
      const integrity = Object.assign([USER], { [Symbol("hidden")]: 1 });
      expectInvalid({ integrity }, "/integrity");
    });

    it("throws for a named property on an array", () => {
      const integrity = Object.assign([USER], { extra: 1 });
      expectInvalid({ integrity }, "/integrity/extra");
    });

    it("throws for a sparse array", () => {
      const integrity = [USER];
      integrity.length = 2;
      expectInvalid({ integrity }, "/integrity/1");
    });

    it("throws for a value that contains itself", () => {
      const atom: Record<string, unknown> = {
        type: "https://example.com/cfc/atom/Extension",
      };
      atom.self = atom;
      expectInvalid({ integrity: [atom] }, "/integrity/0/self");
    });

    it("returns the path and reason of a refusal on the error", () => {
      try {
        parseIfcLabel({ opaque: [] });
        throw new Error("Expected parseIfcLabel() to throw.");
      } catch (error) {
        if (!(error instanceof InvalidIfcLabelError)) throw error;
        expect(error.name).toBe("InvalidIfcLabelError");
        expect(error.path).toBe("/opaque");
        expect(error.reason).toBe("unknown label property");
        expect(error.message).toBe(
          "Invalid IFC label at /opaque: unknown label property",
        );
      }
    });

    it("returns a deeply detached label", () => {
      const source = {
        confidentiality: [{
          anyOf: [{
            type: "https://example.com/cfc/atom/Extension",
            detail: { values: [1, 2] },
          }],
        }],
      };
      const parsed = parseIfcLabel(source);

      expect(parsed).toEqual(source);
      expect(parsed).not.toBe(source);
      expect(parsed.confidentiality).not.toBe(source.confidentiality);
      expect(parsed.confidentiality?.[0]).not.toBe(source.confidentiality[0]);

      source.confidentiality[0].anyOf[0].detail.values[0] = 9;
      expect(parsed).toEqual({
        confidentiality: [{
          anyOf: [{
            type: "https://example.com/cfc/atom/Extension",
            detail: { values: [1, 2] },
          }],
        }],
      });
    });
  });
});
