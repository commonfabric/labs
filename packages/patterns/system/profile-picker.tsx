import {
  computed,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import ProfileCreate, {
  profileLinkListSchema,
  profileLinkSchema,
  type ProfileReferenceValue,
  type ProfileRoster,
  setDefaultProfile,
  setMruProfile,
  TRUSTED_PROFILE_PICKER_SURFACE,
  TRUSTED_PROFILE_SET_DEFAULT_ACTION,
  TRUSTED_PROFILE_SET_MRU_ACTION,
} from "./profile-create.tsx";

// The profile picker rendered as the `[UI]` of a #profile wish when the user
// has 2+ profiles and no valid default. It renders each profile natively
// (name + avatar + a link), offers an inline "create another" affordance, lets
// the user pick a default, and stamps most-recently-used (MRU) on selection.
//
// The picker is purely the SWITCHING affordance (CT-1829): the wish `.result`
// does NOT flow through this pattern. The wish builtin resolves `.result`
// eagerly to the single best profile — default (if set) ⟶ else MRU head ⟶
// else first (wish.ts getProfileCandidateCells) — in every mode. Selection
// writes MRU and the "set default" control writes `defaultProfile`, both as
// trusted picker-surface actions (owner-protected; see profile-create); those
// writes reorder the builtin's candidates, which is what flips `.result`.
//
// The picker output is only `[UI]` — it does NOT surface a `result` /
// `candidates` (the wish builtin owns those); its former `resultIndex` / `result`
// computeds were vestigial after CT-1829 (#4512) and are removed (CT-1843).

type ProfilePickerInput = {
  profiles: ProfileRoster;
  defaultProfile: Writable<ProfileReferenceValue | undefined>;
  mru: ProfileRoster;
};

// Whether two profile cells name the SAME profile — compared by the profile's
// own SPACE, NOT by `equals` / entity id (CT-1843; mirrors the runner-side
// `sameProfileCell` in wish.ts landed by CT-1842 #4534).
//
// The `defaultProfile` link and a `profiles`-list entry for the SAME profile
// reach it through DIFFERENT links — different entity `id` (and scope) WITHIN
// that profile's own space (the list stores one cell, the default link another).
// `equals` compares id (and scope), so it returns false cross-space and the
// default badge is mislabeled/omitted. The stable per-profile identity is the
// profile's own SPACE: each profile is a distinct anonymous
// `ProfileHome.inSpace()` whose DID is unique per user and per creation event,
// so equal space ⇒ same profile.
//
// `homeSpace` guards the degenerate case: the `profiles` / `defaultProfile` /
// `mru` container links live in the home space, so an unmaterialized / invalid
// entry that still resolves into the home space must never match.
//
// Both sides must be link CELLS: the default read as a cell ref, and the row's
// profile re-read from the `profiles` list by index. The map callback's element
// parameter is not usable for this — inside a `computed` it is the opaque
// reference, not a cell, so it carries no link and every row compared as "not
// the default" (the badge never lit; 2026-09-11, the estuary profile preflight).
//
// Uses `getAsNormalizedFullLink().space` via the `as any` escape hatch — the
// pattern-facing surface has no typed space accessor (precedent:
// home-ben.tsx). Defensive: any throw / missing space ⇒ no match.

// A cell's own space DID, or undefined if it isn't a resolvable link. Module
// scope (not pattern context), so the `as any` escape hatch + `?.` are fine.
// deno-lint-ignore no-explicit-any
const linkSpace = (cell: unknown): string | undefined => {
  try {
    return (cell as any)?.getAsNormalizedFullLink?.()?.space as
      | string
      | undefined;
  } catch {
    return undefined;
  }
};

const sameProfileCell = (
  a: unknown,
  b: unknown,
  homeSpace: string | undefined,
): boolean => {
  const spaceA = linkSpace(a);
  const spaceB = linkSpace(b);
  if (!spaceA || !spaceB) return false;
  if (spaceA === homeSpace || spaceB === homeSpace) return false;
  return spaceA === spaceB;
};

export default pattern<
  ProfilePickerInput,
  { [UI]: VNode }
>(({ profiles, defaultProfile, mru }) => {
  // Home space of the `profiles`/`defaultProfile`/`mru` container links — used
  // to reject entries that resolve into the home space (see sameProfileCell).
  const homeSpace = linkSpace(profiles);

  const profileCreate = ProfileCreate({
    profiles: profiles as any,
    inputId: "wish-profile-picker-name-input",
  });

  return {
    [NAME]: "Choose a profile",
    [UI]: (
      <cf-vstack
        id="profile-picker"
        gap="2"
        data-ui-pattern={TRUSTED_PROFILE_PICKER_SURFACE}
        data-ui-event-integrity={TRUSTED_PROFILE_PICKER_SURFACE}
        style={{ padding: "8px" }}
      >
        <h3 style={{ margin: 0, fontSize: "14px" }}>Your profiles</h3>
        {profiles.map((p, i) => (
          <cf-hstack gap="2" align="center">
            <div style={{ flex: "1" }}>
              {
                /* Profiles are identities — rendered via cf-cell-link (the
                  identity idiom is cf-profile-badge), not the generic piece
                  chip variant. */
              }
              <cf-cell-link $cell={p as any} />
            </div>
            {ifElse(
              computed(() => {
                // Read the default link and this row's list entry as cell REFS
                // (asCell) so a cross-space profile not yet loaded here doesn't
                // collapse to `undefined`, then match by the profile's own
                // SPACE (CT-1843) — `equals` returns false cross-space
                // (different entity id + scope). The entry comes from the list
                // by index, not from `p`: see sameProfileCell.
                const entries = ((profiles as any).asSchema(
                  profileLinkListSchema(),
                ).get() ?? []) as unknown[];
                const entry = entries[i as any];
                const def = (defaultProfile as any).asSchema(
                  profileLinkSchema(),
                ).get();
                return def && entry
                  ? sameProfileCell(def, entry, homeSpace)
                  : false;
              }),
              <span style={{ color: "#0a7", fontSize: "12px" }}>default</span>,
              <cf-button
                size="sm"
                variant="ghost"
                data-ui-action={TRUSTED_PROFILE_SET_DEFAULT_ACTION}
                onClick={setDefaultProfile({
                  defaultProfile: defaultProfile as any,
                  profile: p,
                })}
              >
                Set default
              </cf-button>,
            )}
            <cf-button
              size="sm"
              data-ui-action={TRUSTED_PROFILE_SET_MRU_ACTION}
              onClick={setMruProfile({ mru: mru as any, profile: p })}
            >
              Use
            </cf-button>
          </cf-hstack>
        ))}
        <hr style={{ border: "none", borderTop: "1px solid #e5e5e7" }} />
        <h4 style={{ margin: 0, fontSize: "12px", color: "#888" }}>
          Add another profile
        </h4>
        {profileCreate}
      </cf-vstack>
    ),
  };
});
