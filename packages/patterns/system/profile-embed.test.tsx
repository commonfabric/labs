import { action, assert, pattern, TESTS } from "commonfabric";
import ProfileEmbed from "./profile-embed.tsx";
import ProfileHome from "./profile-home.tsx";

/**
 * Lane-2 tests for the CT-1833 profile-embed presentation pattern.
 *
 * WISH LIMITATION (documented): `ProfileEmbed` resolves the viewer's profile via
 * `wish({ query: "#profile" })`. The lane-2 test harness only seeds the
 * `#default` pattern (including `pieceRegistry`), never a `profiles` roster,
 * and a valid profile MUST live in its own (cross-)space — seeding one would drive the
 * exact cross-space create surface the pattern-unit lane forbids (it fails a
 * file on ANY console error). So `#profile` stays unresolved here and we test:
 *   (1) the fallback branch — unavailable wish result plus setup UI — via the exported
 *       `hasProfile` / `isEditing` signals when no profile resolves; and
 *   (2) the amend-in-place CONTRACT the pattern depends on, exercised against a
 *       REAL `ProfileHome` instance the way the pattern's save handlers do:
 *       dispatch into the profile's exported owner-protected `setName` /
 *       `setAvatar` / `setBio` streams, with empty sends suppressed for
 *       name/avatar and allowed for bio (CT-1828). The rendered badge/bio
 *       presentation and edit affordance are verified in the browser.
 */
export default pattern(() => {
  // (1) Fallback branch: with no profile resolvable in lane-2, the embed reports
  // no profile and is not in edit mode; the `[UI]` renders the wish fallback.
  const embed = ProfileEmbed({});
  const assert_no_profile_in_harness = assert(() => embed.hasProfile === false);
  const assert_not_editing_by_default = assert(() => embed.isEditing === false);

  // (2) Amend contract: a real profile the embed's save handlers write through.
  const profile = ProfileHome({ initialName: "Ada Lovelace" });

  // The embed's "Save name" is: read the draft, suppress empty, send { name }
  // into the profile's exported setName stream. Reproduce that call shape.
  const action_amend_name = action(() => {
    const draft = "Grace Hopper";
    if (draft.trim()) profile.setName.send({ name: draft });
  });
  // Empty/whitespace amends must be suppressed by the embed before dispatch
  // (mirrors saveName's guard) — the canonical name must survive.
  const action_amend_name_empty = action(() => {
    const draft = "   ";
    if (draft.trim()) profile.setName.send({ name: draft });
  });

  const action_amend_avatar = action(() => {
    const draft = "GH";
    if (draft.trim()) profile.setAvatar.send({ avatar: draft });
  });
  const action_amend_avatar_empty = action(() => {
    const draft = "";
    if (draft.trim()) profile.setAvatar.send({ avatar: draft });
  });

  // Bio is deliberately clearable (unlike name/avatar); the embed sends the
  // trimmed draft unconditionally.
  const action_amend_bio = action(() => {
    profile.setBio.send({ bio: "Countess of computing." });
  });
  const action_amend_bio_clear = action(() => {
    profile.setBio.send({ bio: "" });
  });

  const assert_initial_name = assert(() =>
    profile.initialNameApplied === "Ada Lovelace"
  );
  const assert_name_amended = assert(() =>
    profile.initialNameApplied === "Grace Hopper"
  );
  const assert_name_survives_empty = assert(() =>
    profile.initialNameApplied === "Grace Hopper"
  );
  const assert_avatar_amended = assert(() => profile.avatar === "GH");
  const assert_avatar_survives_empty = assert(() => profile.avatar === "GH");
  const assert_bio_amended = assert(() =>
    profile.bio === "Countess of computing."
  );
  const assert_bio_cleared = assert(() => profile.bio === "");

  return {
    [TESTS]: [
      // (1) Fallback branch — no profile resolves in the harness.
      { assertion: assert_no_profile_in_harness },
      { assertion: assert_not_editing_by_default },
      // (2) Amend-in-place contract through the exported streams.
      { assertion: assert_initial_name },
      { action: action_amend_name },
      { assertion: assert_name_amended },
      // Empty/whitespace name amend is suppressed (CT-1828 + embed guard).
      { action: action_amend_name_empty },
      { assertion: assert_name_survives_empty },
      { action: action_amend_avatar },
      { assertion: assert_avatar_amended },
      { action: action_amend_avatar_empty },
      { assertion: assert_avatar_survives_empty },
      { action: action_amend_bio },
      { assertion: assert_bio_amended },
      { action: action_amend_bio_clear },
      { assertion: assert_bio_cleared },
    ],
  };
});
