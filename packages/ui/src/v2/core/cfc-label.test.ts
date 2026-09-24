import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CfcLabelView } from "@commonfabric/runner/cfc";
import {
  authorPrincipalCandidates,
  cfcLabelViewIsPublic,
  ownerPrincipalFromLabel,
} from "./cfc-label.ts";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_DID = "did:key:z6MkoTHERoTHERoTHERoTHERoTHERoTHERoTHERoTHERoT";

const representsAt = (path: string[], subject: string) => ({
  path,
  label: { integrity: [{ kind: "represents-principal", subject }] },
});

const view = (entries: CfcLabelView["entries"]): CfcLabelView => ({
  version: 1,
  entries,
});

describe("ownerPrincipalFromLabel", () => {
  it("extracts the subject from an object-form represents-principal atom on a field path", () => {
    // Owner-protected profile fields carry the atom at their own path, not root.
    const label = view([
      {
        path: ["name"],
        label: { integrity: [{ kind: "represents-principal", subject: DID }] },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBe(DID);
  });

  it("trims object-form subjects to match the string-form normalization", () => {
    const label = view([
      {
        path: ["name"],
        label: {
          integrity: [{ kind: "represents-principal", subject: `  ${DID}  ` }],
        },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBe(DID);
  });

  it("extracts the subject from a string-form atom", () => {
    const label = view([
      {
        path: ["avatar"],
        label: { integrity: [`represents-principal:${DID}`] },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBe(DID);
  });

  it("ignores unrelated integrity atoms", () => {
    const label = view([
      {
        path: [],
        label: { integrity: ["profile-link", "authored-by:someone"] },
      },
      {
        path: ["x"],
        label: { integrity: [{ kind: "owned-by", subject: DID }] },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBeUndefined();
  });

  it("returns undefined for an empty or missing label", () => {
    expect(ownerPrincipalFromLabel(undefined)).toBeUndefined();
    expect(ownerPrincipalFromLabel(view([]))).toBeUndefined();
  });
});

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
      { path: ["name"], label: { integrity: [`represents-principal:${DID}`] } },
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

describe("cfcLabelViewIsPublic (egress check)", () => {
  // Host-embedding contract seam 4 (docs/features/host-embedding.md §4): the
  // egress check an embedder uses to fail closed on non-public data. Goes red
  // if the "public iff no non-empty confidentiality clause" contract changes.

  it("treats an absent label as public", () => {
    expect(cfcLabelViewIsPublic(undefined)).toBe(true);
  });

  it("treats an empty entries array as public", () => {
    expect(cfcLabelViewIsPublic(view([]))).toBe(true);
  });

  it("treats integrity-only labels as public (integrity is orthogonal)", () => {
    const label = view([
      {
        path: ["name"],
        label: { integrity: [{ kind: "represents-principal", subject: DID }] },
      },
    ]);
    expect(cfcLabelViewIsPublic(label)).toBe(true);
  });

  it("treats an empty confidentiality array as public", () => {
    const label = view([{ path: ["bio"], label: { confidentiality: [] } }]);
    expect(cfcLabelViewIsPublic(label)).toBe(true);
  });

  it("fails closed on any non-empty confidentiality clause", () => {
    const label = view([
      { path: ["name"], label: { integrity: ["profile-link"] } },
      { path: ["ssn"], label: { confidentiality: [["clause-a"]] } },
    ]);
    expect(cfcLabelViewIsPublic(label)).toBe(false);
  });
});
