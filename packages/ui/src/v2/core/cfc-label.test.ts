import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CfcLabelView } from "@commonfabric/runner/cfc";
import { cfcLabelViewIsPublic, ownerPrincipalFromLabel } from "./cfc-label.ts";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

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

  it("names no owner for a subject with surrounding whitespace", () => {
    const label = view([
      {
        path: ["name"],
        label: {
          integrity: [{ kind: "represents-principal", subject: `  ${DID}  ` }],
        },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBeUndefined();
  });

  it("names no owner for a string-form atom", () => {
    const label = view([
      {
        path: ["avatar"],
        label: { integrity: [`represents-principal:${DID}`] },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBeUndefined();
  });

  it("names no owner from an atom below the top-level fields", () => {
    // A document holding a link to Bob's profile deeper down carries that
    // profile's label there; it is not the owner of this document.
    const label = view([
      {
        path: ["elements", "0", "cell"],
        label: { integrity: [{ kind: "represents-principal", subject: DID }] },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBeUndefined();
  });

  it("names no owner from an entry a link carries", () => {
    const label = view([
      {
        path: ["friend"],
        label: { integrity: [{ kind: "represents-principal", subject: DID }] },
        observes: "followRef",
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBeUndefined();
  });

  it("names no owner when top-level atoms name two principals", () => {
    const label = view([
      {
        path: ["name"],
        label: { integrity: [{ kind: "represents-principal", subject: DID }] },
      },
      {
        path: ["avatar"],
        label: {
          integrity: [{
            kind: "represents-principal",
            subject: DID.replace("z6Mk", "z6Mm"),
          }],
        },
      },
    ]);
    expect(ownerPrincipalFromLabel(label)).toBeUndefined();
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
