import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CfcLabelView } from "@commonfabric/runner/cfc";
import {
  authorPrincipalFromLabel,
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

describe("authorPrincipalFromLabel", () => {
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
    expect(authorPrincipalFromLabel(label)).toBe(DID);
  });

  it("returns the root's DID over a different one on a field", () => {
    const label = view([
      representsAt(["name"], OTHER_DID),
      representsAt([], DID),
    ]);
    expect(authorPrincipalFromLabel(label)).toBe(DID);
  });

  it("returns `undefined` when field atoms name two DIDs", () => {
    const label = view([
      representsAt(["name"], DID),
      representsAt(["avatar"], OTHER_DID),
    ]);
    expect(authorPrincipalFromLabel(label)).toBeUndefined();
  });

  it("returns `undefined` when root atoms name two DIDs, whatever the fields name", () => {
    const label = view([
      representsAt([], DID),
      representsAt([], OTHER_DID),
      representsAt(["name"], DID),
    ]);
    expect(authorPrincipalFromLabel(label)).toBeUndefined();
  });

  it("returns the DID of string-form atoms", () => {
    const label = view([
      { path: ["name"], label: { integrity: [`represents-principal:${DID}`] } },
      representsAt(["avatar"], DID),
    ]);
    expect(authorPrincipalFromLabel(label)).toBe(DID);
  });

  it("returns `undefined` for a label with no represents-principal atom", () => {
    const label = view([
      {
        path: [],
        label: { integrity: [{ kind: "authored-by", subject: DID }] },
      },
    ]);
    expect(authorPrincipalFromLabel(label)).toBeUndefined();
    expect(authorPrincipalFromLabel(view([]))).toBeUndefined();
    expect(authorPrincipalFromLabel(undefined)).toBeUndefined();
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
