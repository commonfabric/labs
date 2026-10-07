import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  cfcAtom,
} from "@commonfabric/api/cfc";
import {
  CFC_LABEL_READ_FAILED_ATOM,
  type IFCLabel,
} from "@commonfabric/runner/cfc";

import {
  ownerConsoleDisplay,
  publicConsoleDisplay,
} from "../../console/display-ceiling.ts";

describe("console/display-ceiling", () => {
  const owner = "did:key:z6Mkowner";
  const someoneElse = "did:key:z6Mkothers";
  const pageCaveat = cfcAtom.caveat(
    CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
    cfcAtom.resource("WebPage", "https://shop.test"),
  );
  const fits = ownerConsoleDisplay(owner);

  describe("ownerConsoleDisplay()", () => {
    it("returns `true` for a label naming only the owner, or a page's prompt caveat", () => {
      expect(fits({})).toBe(true);
      expect(fits({
        confidentiality: [
          cfcAtom.user(owner),
          cfcAtom.personalSpace(owner),
          owner,
          pageCaveat,
        ],
      })).toBe(true);
    });

    it("returns `false` for a label naming anyone but the owner", () => {
      expect(fits({ confidentiality: [cfcAtom.user(someoneElse)] }))
        .toBe(false);
      expect(fits({
        confidentiality: [cfcAtom.user(owner), cfcAtom.user(someoneElse)],
      })).toBe(false);
      expect(fits({ confidentiality: [someoneElse] })).toBe(false);
    });

    it("returns `false` for a label naming an origin, a space, or a caveat outside the prompt family", () => {
      expect(fits({
        confidentiality: [
          cfcAtom.caveat(
            "https://example.test/not-a-prompt-caveat",
            cfcAtom.user(owner),
          ),
        ],
      })).toBe(false);
      expect(fits({
        confidentiality: [{
          type: CFC_ATOM_TYPE.Origin,
          uri: "https://shop.test",
        }],
      })).toBe(false);
      expect(fits({ confidentiality: [cfcAtom.space(someoneElse)] }))
        .toBe(false);
    });

    it("returns `false` for a label that could not be read", () => {
      expect(fits({ confidentiality: [CFC_LABEL_READ_FAILED_ATOM] }))
        .toBe(false);
    });

    it("returns `false` for a label too malformed to fit at all", () => {
      const malformed: IFCLabel = JSON.parse('{"confidentiality": 7}');

      expect(fits(malformed)).toBe(false);
    });
  });

  describe("publicConsoleDisplay()", () => {
    it("returns `true` only for a label naming no one", () => {
      expect(publicConsoleDisplay({})).toBe(true);
      expect(publicConsoleDisplay({ confidentiality: [cfcAtom.user(owner)] }))
        .toBe(false);
    });
  });
});
