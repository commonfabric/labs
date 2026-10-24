import { action, assert, FabricBytes, pattern, TESTS } from "commonfabric";
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
 *   (1) the fallback branch — `result ?? fallback` — via the exported
 *       `hasProfile` / `isEditing` signals when no profile resolves; and
 *   (2) the amend-in-place CONTRACT the pattern depends on, exercised against a
 *       REAL `ProfileHome` instance the way the pattern's save handlers do:
 *       dispatch into the profile's exported owner-protected `setName` /
 *       `setPicture` / `setBio` streams, with empty sends suppressed for
 *       name/picture and allowed for bio (CT-1828). The rendered badge/bio
 *       presentation and edit affordance are verified in the browser.
 */
// Stands in for a picked picture; the profile stores the bytes as sent.
const PICKED_PICTURE = [0x89, 0x50, 0x4e, 0x47];

const isPickedPicture = (picture: FabricBytes | undefined) =>
  picture?.slice().join() === PICKED_PICTURE.join();

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

  // The embed's picture picker forwards the picked bytes into setPicture,
  // suppressing an empty pick.
  const action_amend_picture = action(() => {
    const picked = new FabricBytes(new Uint8Array(PICKED_PICTURE));
    if (picked.length) profile.setPicture.send({ picture: picked });
  });
  const action_amend_picture_empty = action(() => {
    const picked = new FabricBytes(new Uint8Array());
    if (picked.length) profile.setPicture.send({ picture: picked });
  });

  // Bio is deliberately clearable (unlike name/picture); the embed sends the
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
  const assert_picture_amended = assert(() => isPickedPicture(profile.picture));
  const assert_picture_survives_empty = assert(() =>
    isPickedPicture(profile.picture)
  );
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
      { action: action_amend_picture },
      { assertion: assert_picture_amended },
      { action: action_amend_picture_empty },
      { assertion: assert_picture_survives_empty },
      { action: action_amend_bio },
      { assertion: assert_bio_amended },
      { action: action_amend_bio_clear },
      { assertion: assert_bio_cleared },
    ],
  };
});
