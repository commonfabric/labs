import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_CONCEPT_KIND, cfcAtom } from "@commonfabric/api/cfc";

import { defaultDisplayCeiling } from "../src/cfc/default-display-ceiling.ts";
import { PROMPT_CAVEAT_FAMILY_KINDS } from "../src/cfc/prompt-caveat-kinds.ts";

describe("cfc-default-display-ceiling", () => {
  describe("defaultDisplayCeiling()", () => {
    const actingUser = "did:key:z6Mkacting";

    it("returns the atoms naming exactly the acting user", () => {
      expect(defaultDisplayCeiling(actingUser).atoms).toEqual([
        cfcAtom.user(actingUser),
        cfcAtom.personalSpace(actingUser),
        actingUser,
      ]);
    });

    it("returns the whole prompt-caveat family, and no other caveat kind", () => {
      const { caveatKinds } = defaultDisplayCeiling(actingUser);

      expect(caveatKinds).toEqual([...PROMPT_CAVEAT_FAMILY_KINDS]);
      expect(caveatKinds).toContain(
        CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
      );
    });

    it("returns lists a caller may change without changing another's", () => {
      const first = defaultDisplayCeiling(actingUser);
      first.caveatKinds.pop();

      expect(defaultDisplayCeiling(actingUser).caveatKinds).toHaveLength(
        PROMPT_CAVEAT_FAMILY_KINDS.length,
      );
    });
  });
});
