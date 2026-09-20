import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// Host-embedding contract seam 7 (docs/features/host-embedding.md §7): pinning
// an element to a profile is authorized by OWNERSHIP, not by a trusted-UI
// gesture. The single authorized writer of profile `elements` is
// `mutateElements` in profile-home.tsx, typed `OwnerProtectedProfileWrite`
// (WriteAuthorizedBy + ownerPrincipal) with NO `uiContract`. Contrast the
// profile *create* surface (profile-create.tsx), where `uiContract` IS present
// on `TrustedProfileLink` — creating a profile is correctly gesture-gated.
//
// This asymmetry is deliberate and load-bearing: because pinning is owner-gated,
// headless (`cf piece call` into `addPiece`) and cross-pattern pin flows are
// SANCTIONED. A future change that "hardens" pinning by adding a `uiContract`
// to the profile-home write path would silently break those flows — this test
// goes red on that change.
//
// The contract is asserted against the pattern SOURCE TEXT rather than the
// transformed graph so it stays robust across transformer changes and needs no
// runtime; the markers checked (`uiContract`, `OwnerProtectedProfileWrite`,
// `TrustedProfileLink`, `addPiece`) are stable public type/handler names.

const read = (relPath: string): string =>
  Deno.readTextFileSync(new URL(relPath, import.meta.url));

describe("host embedding contract: profile pinning is owner-gated", () => {
  const home = read("./profile-home.tsx");
  const create = read("./profile-create.tsx");

  it("profile-home.tsx (the pin writer) carries NO uiContract", () => {
    // Pinning to an existing profile requires only ownership. If a uiContract
    // appears here, a headless/cross-pattern pin would start failing closed.
    expect(home.includes("uiContract")).toBe(false);
  });

  it("the elements write is typed OwnerProtectedProfileWrite (identity-gated)", () => {
    expect(home).toContain("type OwnerProtectedProfileWrite");
    expect(home).toContain(
      "elements: OwnerProtectedProfileWrite<ProfileElement[], typeof mutateElements>",
    );
    expect(home).toContain("WriteAuthorizedBy");
    expect(home).toContain("ownerPrincipal");
  });

  it("exposes addPiece as a Stream — the sanctioned headless pin path", () => {
    // Required in the PRODUCER type on purpose: ProfileHomeOutput describes a
    // RUNNING profile, which always binds every stream. Stored-doc tolerance
    // lives in BackwardsCompatibleProfile (pinned below), not here.
    expect(home).toContain("addPiece: Stream<MutateProfileElementsEvent>");
    // The stream is bound to mutateElements in the "addPiece" mode.
    expect(home).toContain('mode: "addPiece"');
  });

  it("exports BackwardsCompatibleProfile with every post-genesis stream optional", () => {
    // The consumer-side seam of the 2026-07-22 fleet heal (#4901): consumers
    // of STORED profiles must take this weakened view, where streams added
    // after profile genesis are optional — a required stream in a consumer
    // schema bricks every doc predating the field at argument validation.
    // A stream missing from this union re-bricks old docs; removing the type
    // re-bricks everything. Red here = that regression.
    expect(home).toContain(
      "export type BackwardsCompatibleProfile = PartialBy<",
    );
    for (
      const lateStream of [
        "setBio",
        "setInbox",
        "addExternalLink",
        "removeExternalLink",
        "publishVerifiedIdentities",
        "revokeVerifiedIdentities",
        "addPiece",
        "toggleEditing",
      ]
    ) {
      expect(home).toContain(`| "${lateStream}"`);
    }
    // The two post-genesis DATA fields ride Default<> instead (validation
    // fills absent keys on old docs) — the data-vs-affordance split.
    expect(home).toContain(
      'bio: Default<OwnerProtectedProfileWrite<string, typeof setBio>, "">',
    );
    expect(home).toContain("isEditing: Default<boolean, false>");
    // The share inbox pointer is the post-baseline DATA field that is
    // OPTIONAL rather than defaulted: a stored profile predating the field
    // has no property at all, and a profile with no inbox holds a pointer
    // with no `piece`; its writer an optional late stream like the rest.
    expect(home).toContain(
      "inbox?: OwnerProtectedProfileWrite<ProfileInbox, typeof setInbox>;",
    );
  });

  it("weakens the rendered screen in the consumer view", () => {
    // The other half of the consumer seam. `ProfileHomeOutput` names the screen
    // `VNode`, which is what lets a reader of a profile's own result reach the
    // tree it holds. An argument declaration is checked the other way round: it
    // has to keep accepting every value it accepted before, and a profile
    // stored under any earlier vintage of this type has to pass it. Narrowing
    // this position to `VNode` too would fail pattern-compat at every consumer
    // that takes a stored profile — `system/profile-picker.tsx` on
    // `defaultProfile`, `system/profile-create.tsx` on `profiles[]`.
    expect(home).toContain("[UI]: VNode;");
    expect(home).toContain("& Omit<ProfileHomeOutput, typeof UI>");
    expect(home).toContain("& { [UI]: unknown }");
  });

  it("recognizes every one of the viewer's profiles as owner-editable", () => {
    // `#profile.result` is just the viewer's selected default profile. The
    // candidate list contains every profile linked from their home, so an
    // owner visiting a non-default profile must compare SELF against it.
    expect(home).toContain("viewerProfile.candidates?.some");
    expect(home).toContain("equals(self, profile) === true");
  });

  it("hides the current-links section until a link exists", () => {
    // The empty form should invite an owner to add a link without presenting a
    // misleading empty "Current links" heading. The section itself, not just
    // its rows, is gated by the reactive list predicate.
    expect(home).toContain(
      'hasExternalLinks,\n                    <cf-vstack\n                      gap="1"\n                      data-ui-region="profile-external-links"',
    );
  });

  it("the create surface (profile-create.tsx) DOES carry a uiContract", () => {
    // Creating a profile is correctly gesture-gated — the opposite seam.
    expect(create).toContain("export type TrustedProfileLink");
    expect(create).toContain("uiContract");
    expect(create).toContain("ProfileCreateSurface");
  });
});
