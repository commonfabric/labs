import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  isAllowedTsLibHelperDeclaration,
  normalizeExact,
} from "../src/sandbox/tslib-helpers.ts";

const IMPORT_DEFAULT =
  `var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};`;

describe("tslib-helpers", () => {
  it("returns true for the canonical `__importDefault` declaration", () => {
    expect(isAllowedTsLibHelperDeclaration(normalizeExact(IMPORT_DEFAULT)))
      .toBe(true);
  });

  it("returns false for a helper name bound to anything else", () => {
    expect(
      isAllowedTsLibHelperDeclaration(
        normalizeExact(`var __importDefault = function (mod) { return mod; };`),
      ),
    ).toBe(false);
  });

  it("returns false for a `var` of any other name, and for other statements", () => {
    const renamed = IMPORT_DEFAULT.replace(
      "var __importDefault",
      "var __other",
    );

    expect(isAllowedTsLibHelperDeclaration(normalizeExact(renamed))).toBe(
      false,
    );
    expect(
      isAllowedTsLibHelperDeclaration(
        normalizeExact(IMPORT_DEFAULT.replace("var ", "const ")),
      ),
    ).toBe(false);
  });
});
