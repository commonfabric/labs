import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  CFC_LABEL_READ_FAILED_ATOM,
  type IFCLabel,
} from "@commonfabric/runner/cfc";

import { defaultDisplayFit } from "../src/worker/display-fit.ts";

describe("display-fit", () => {
  const owner = "did:key:z6Mkowner";
  const someoneElse = "did:key:z6Mkothers";

  describe("defaultDisplayFit()", () => {
    it("returns a fit that admits a label naming no one, or only the owner", () => {
      const fits = defaultDisplayFit(owner);

      expect(fits({})).toBe(true);
      expect(fits({
        confidentiality: [cfcAtom.user(owner), cfcAtom.personalSpace(owner)],
      })).toBe(true);
    });

    it("returns a fit that refuses a label naming anyone but the owner", () => {
      const fits = defaultDisplayFit(owner);

      expect(fits({ confidentiality: [cfcAtom.user(someoneElse)] }))
        .toBe(false);
      expect(fits({ confidentiality: [cfcAtom.space(owner)] })).toBe(false);
    });

    it("returns, with no owner, a fit that admits only a label naming no one", () => {
      const fits = defaultDisplayFit();

      expect(fits({})).toBe(true);
      expect(fits({ confidentiality: [cfcAtom.user(owner)] })).toBe(false);
    });

    it("returns a fit that refuses a label unread or too malformed to fit", () => {
      const fits = defaultDisplayFit(owner);
      const malformed: IFCLabel = JSON.parse('{"confidentiality": 7}');

      expect(fits({ confidentiality: [CFC_LABEL_READ_FAILED_ATOM] }))
        .toBe(false);
      expect(fits(malformed)).toBe(false);
    });
  });
});
