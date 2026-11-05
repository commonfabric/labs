import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { freeName, isValidName, MAX_NAME_BYTES, utf8Length } from "./names.ts";

describe("names", () => {
  describe("utf8Length()", () => {
    it("returns the number of bytes a string takes as UTF-8", () => {
      expect(utf8Length("a")).toBe(1);
      expect(utf8Length("é")).toBe(2);
      expect(utf8Length("€")).toBe(3);
      expect(utf8Length("😺")).toBe(4);
      expect(utf8Length("aé€😺")).toBe(10);
    });
  });

  describe("isValidName()", () => {
    it("returns `true` for an ordinary file name", () => {
      expect(isValidName("photo.png")).toBe(true);
      expect(isValidName("Notes")).toBe(true);
      expect(isValidName("résumé (final).pdf")).toBe(true);
    });

    it("returns `true` for a name of exactly the most bytes allowed", () => {
      expect(isValidName("é".repeat(MAX_NAME_BYTES / 2 | 0) + "a")).toBe(true);
    });

    it("returns `false` for a name longer than the most bytes allowed", () => {
      expect(isValidName("a".repeat(MAX_NAME_BYTES + 1))).toBe(false);
      expect(isValidName("é".repeat(128))).toBe(false);
    });

    it("returns `false` for a name holding a path separator or a control character", () => {
      for (const name of ["a/b", "a\\b", "a\u0000b", "a\nb", "a\u007fb"]) {
        expect({ name, valid: isValidName(name) }).toEqual({
          name,
          valid: false,
        });
      }
    });

    it("returns `false` for a hidden or dot-only name", () => {
      for (const name of [".", "..", ".profile"]) {
        expect({ name, valid: isValidName(name) }).toEqual({
          name,
          valid: false,
        });
      }
    });

    it("returns `false` for a name ending with a space or a `.`", () => {
      expect(isValidName("photo ")).toBe(false);
      expect(isValidName("photo.")).toBe(false);
    });

    it("returns `false` for a name not in Normalization Form C", () => {
      expect(isValidName("é")).toBe(false);
      expect(isValidName("é")).toBe(true);
    });

    it("returns `false` for an empty, ill-formed, or non-string name", () => {
      for (const name of ["", "\ud800", 7, undefined]) {
        expect({ name, valid: isValidName(name) }).toEqual({
          name,
          valid: false,
        });
      }
    });
  });

  describe("freeName()", () => {
    const takenOf = (...names: string[]) => (name: string) =>
      names.includes(name);

    it("returns the name itself when it is free", () => {
      expect(freeName("photo.png", takenOf())).toBe("photo.png");
    });

    it("returns the name numbered before its last extension when it is taken", () => {
      expect(freeName("photo.png", takenOf("photo.png"))).toBe(
        "photo (2).png",
      );
      expect(freeName("archive.tar.gz", takenOf("archive.tar.gz"))).toBe(
        "archive.tar (2).gz",
      );
    });

    it("returns the name numbered at its end when it has no extension", () => {
      expect(freeName("Notes", takenOf("Notes"))).toBe("Notes (2)");
    });

    it("returns the first number that is free", () => {
      expect(
        freeName("a.txt", takenOf("a.txt", "a (2).txt", "a (3).txt")),
      ).toBe("a (4).txt");
    });

    it("returns a valid name when the extension alone leaves no room for the number", () => {
      const long = "a." + "x".repeat(MAX_NAME_BYTES - 2);
      const free = freeName(long, takenOf(long));

      expect(free.endsWith(" (2)")).toBe(true);
      expect(utf8Length(free)).toBeLessThanOrEqual(MAX_NAME_BYTES);
      expect(isValidName(free)).toBe(true);
    });

    it("returns a valid name when the number would take the name past the most bytes allowed", () => {
      const long = "a".repeat(MAX_NAME_BYTES - 4) + ".png";
      const free = freeName(long, takenOf(long));

      expect(free.endsWith(" (2).png")).toBe(true);
      expect(utf8Length(free)).toBeLessThanOrEqual(MAX_NAME_BYTES);
      expect(isValidName(free)).toBe(true);
    });
  });
});
