import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CfcLabelView } from "../../src/cfc/label-view-core.ts";
import { authorPrincipalCandidates } from "../../src/cfc/represents-principal.ts";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_DID = "did:key:z6MkoTHERoTHERoTHERoTHERoTHERoTHERoTHERoTHERoT";

const view = (entries: CfcLabelView["entries"]): CfcLabelView => ({
  version: 1,
  entries,
});

const representsAt = (path: string[], subject: string) => ({
  path,
  label: { integrity: [{ kind: "represents-principal", subject }] },
});

describe("represents-principal", () => {
  describe("authorPrincipalCandidates", () => {
    it("returns the DID a profile's field atoms name when the root has none", () => {
      // A message's link to a Fabric profile: the root holds the message's own
      // `authored-by`, and the profile's owner-protected fields their owner.
      const label = view([
        {
          path: [],
          label: { integrity: [{ kind: "authored-by", subject: OTHER_DID }] },
        },
        representsAt(["avatar"], DID),
        representsAt(["bio"], DID),
        representsAt(["elements"], DID),
      ]);
      expect(authorPrincipalCandidates(label)).toEqual([DID]);
    });

    it("returns the root's DID for an author labeled only at its root", () => {
      const label = view([representsAt([], DID)]);
      expect(authorPrincipalCandidates(label)).toEqual([DID]);
    });

    it("returns one DID when the root and a top-level field agree", () => {
      const label = view([representsAt([], DID), representsAt(["name"], DID)]);
      expect(authorPrincipalCandidates(label)).toEqual([DID]);
    });

    it("returns both DIDs when the root and a top-level field disagree", () => {
      // A link slot that is itself labeled with the principal who wrote it,
      // holding a profile someone else owns.
      const label = view([
        representsAt([], OTHER_DID),
        representsAt(["name"], DID),
      ]);
      expect(authorPrincipalCandidates(label)).toEqual([OTHER_DID, DID]);
    });

    it("returns both DIDs when top-level fields disagree", () => {
      const label = view([
        representsAt(["name"], DID),
        representsAt(["avatar"], OTHER_DID),
      ]);
      expect(authorPrincipalCandidates(label)).toEqual([DID, OTHER_DID]);
    });

    it("does not count atoms below the top-level fields", () => {
      // A profile that pins a piece owned by someone else holds a copy of that
      // piece's label below the field that links it.
      const label = view([
        representsAt(["name"], DID),
        representsAt(["elements"], DID),
        representsAt(["elements", "0", "cell"], OTHER_DID),
      ]);
      expect(authorPrincipalCandidates(label)).toEqual([DID]);
    });

    it("returns the DID of a string-form atom", () => {
      const label = view([
        {
          path: ["name"],
          label: { integrity: [`represents-principal:${DID}`] },
        },
      ]);
      expect(authorPrincipalCandidates(label)).toEqual([DID]);
    });

    it("returns no DID for a label with no represents-principal atom", () => {
      const label = view([
        {
          path: [],
          label: { integrity: [{ kind: "authored-by", subject: DID }] },
        },
      ]);
      expect(authorPrincipalCandidates(label)).toEqual([]);
      expect(authorPrincipalCandidates(view([]))).toEqual([]);
      expect(authorPrincipalCandidates(undefined)).toEqual([]);
    });
  });
});
