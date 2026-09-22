import {
  action,
  assert,
  equals,
  NAME,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import ProfileHome, {
  identityProfileUrl,
  isFreshIdentity,
  isShownIdentity,
  VerifiedIdentitiesSection,
  VerifiedIdentityRow,
} from "./profile-home.tsx";

export default pattern(() => {
  const profile = ProfileHome({ initialName: "Ada Lovelace" });

  // Verified identities reach the profile only as Loom-labeled cells, which a
  // pattern test cannot mint, so the display rules are checked on the helpers
  // and the row directly. The rendered list is covered by
  // packages/html/test/profile-home-verified-identities.test.ts.
  const nowMs = Date.parse("2026-07-17T20:00:00.000Z");
  const freshLogin = {
    type: "github.login",
    value: "ada lovelace",
    verifiedAt: "2026-07-16T20:00:00.000Z",
  };
  const assert_fresh_login_is_shown = assert(() =>
    isShownIdentity(freshLogin, nowMs) === true
  );
  const assert_stale_login_is_hidden = assert(() =>
    isShownIdentity(
      { ...freshLogin, verifiedAt: "2026-07-14T20:00:00.000Z" },
      nowMs,
    ) === false
  );
  const assert_node_id_is_hidden = assert(() =>
    isShownIdentity({ ...freshLogin, type: "github.node_id" }, nowMs) === false
  );
  const assert_undated_identity_is_hidden = assert(() =>
    isShownIdentity({ ...freshLogin, verifiedAt: undefined }, nowMs) ===
      false
  );
  const assert_unreadable_date_or_clock_hides_identity = assert(() =>
    isFreshIdentity(freshLogin.verifiedAt, undefined) === false &&
    isFreshIdentity("not a timestamp", nowMs) === false
  );
  const assert_profile_url_encodes_the_login = assert(() =>
    identityProfileUrl("github.login", "ada lovelace") ===
      "https://github.com/ada%20lovelace" &&
    identityProfileUrl("github.node_id", "MDQ6VXNlcjE=") === ""
  );
  const freshRow = VerifiedIdentityRow({ assertion: freshLogin, nowMs });
  const staleLogin = Writable.of({
    ...freshLogin,
    verifiedAt: "2026-07-14T20:00:00.000Z",
  });
  const nodeId = Writable.of({
    ...freshLogin,
    type: "github.node_id",
    value: "MDQ6VXNlcjE=",
  });
  const sectionWithFreshLogin = VerifiedIdentitiesSection({
    identities: [nodeId, Writable.of(freshLogin), staleLogin],
    nowMs,
  });
  const sectionWithoutShownIdentity = VerifiedIdentitiesSection({
    identities: [nodeId, staleLogin],
    nowMs,
  });
  const assert_section_shown_for_a_fresh_login = assert(() =>
    sectionWithFreshLogin.shown === true
  );
  const assert_section_hidden_without_a_shown_identity = assert(() =>
    sectionWithoutShownIdentity.shown === false
  );
  const assert_row_links_the_profile = assert(() =>
    freshRow.profileUrl === "https://github.com/ada%20lovelace"
  );

  // CT-1748: the rendered profile view. Single context, so the owner-protected
  // name/avatar/elements resolve cleanly (no cross-stamp moduleIdentity
  // divergence — that only bites the browser piece-view, and is CT-1740). These
  // assertions prove the read-only presentation renders, distinct from the edit
  // form, and the toggle swaps between them.
  const action_toggle_editing = action(() => {
    profile.toggleEditing.send();
  });

  const action_set_avatar = action(() => {
    profile.setAvatar.send({ avatar: "AL" });
  });
  // The share inbox link. Loom sends it serialized, as the `link@1` sigil
  // naming the inbox piece and its space; here the link is a live cell, the
  // catalog card added below, because a link into a space the harness does
  // not hold resolves to nothing and the action never runs.
  const action_set_inbox = action(() => {
    const first = profile.elements[0];
    if (first) profile.setInbox.send({ inbox: first.cell });
  });
  const action_add_second_card = action(() => {
    profile.addElement.send({
      catalogId: "profile-card",
      title: "Second card",
      tag: "#second",
      userTags: ["person"],
    });
  });
  const action_set_inbox_to_second = action(() => {
    const second = profile.elements[1];
    if (second) profile.setInbox.send({ inbox: second.cell });
  });
  const action_clear_inbox = action(() => {
    profile.setInbox.send({});
  });
  const assert_inbox_absent_at_birth = assert(() =>
    profile.inbox?.piece === undefined
  );
  const assert_inbox_links_the_first_card = assert(() =>
    profile.inbox?.piece !== undefined &&
    equals(profile.inbox?.piece, profile.elements[0]?.cell)
  );
  const assert_inbox_links_the_second_card = assert(() =>
    profile.inbox?.piece !== undefined &&
    equals(profile.inbox?.piece, profile.elements[1]?.cell)
  );
  // Both cards keep their content through every pointer write: the pointer
  // is re-bound and cleared in place, never written through into a card.
  // Each card's name is read back through its cell, so a write that reached
  // a card's document — or re-bound a card's slot to the other card — reads
  // as the wrong name, not as an object of some kind.
  const assert_both_cards_intact = assert(() =>
    profile.elements.length === 2 &&
    profile.elements[0]?.cell?.[NAME] === "Profile card" &&
    profile.elements[1]?.cell?.[NAME] === "Second card"
  );
  const assert_inbox_cleared = assert(() => profile.inbox?.piece === undefined);
  const action_remove_second_card = action(() => {
    const second = profile.elements[1];
    if (second) profile.removeElement.send({ cell: second.cell });
  });

  // CT-1828: same empty-after-trim guard applies to setAvatar.
  const action_clear_avatar = action(() => {
    profile.setAvatar.send({ avatar: "" });
  });

  // CT-1748 note: the presentation-vs-edit *content* lives behind `ifElse`, and
  // [UI] vnode traversal doesn't resolve through this test harness's `.get()`,
  // so the toggle is asserted via the exported `isEditing` and the bound data
  // below. The rendered presentation itself (real cf-profile-badge + card tiles,
  // distinct from the edit form) is verified in the browser.

  // Visiting a profile starts in the read-only presentation, not the edit form.
  const assert_not_editing = assert(() => profile.isEditing === false);
  // The toggle flips into the edit form, then back.
  const assert_editing = assert(() => profile.isEditing === true);

  // The avatar the badge binds resolves (single context — owner-protected reads
  // are clean here; cross-stamp masking is the browser-only CT-1740 issue).
  const assert_avatar_set = assert(() => profile.avatar === "AL");
  // CT-1828: an empty send must not clear a previously-set avatar.
  const assert_avatar_unchanged_after_empty = assert(() =>
    profile.avatar === "AL"
  );

  const action_add_catalog_element = action(() => {
    profile.addElement.send({
      catalogId: "profile-card",
      title: "Profile card",
      tag: "#profileCard",
      userTags: ["person"],
    });
  });

  const action_remove_catalog_element = action(() => {
    const first = profile.elements[0];
    if (first) {
      profile.removeElement.send({ cell: first.cell });
    }
  });

  // A remove event without a cell must be a no-op — the consolidated
  // mutateElements writer dispatches on the instance's bound mode, so a
  // malformed remove must never fall through to an add (cf-review on
  // CT-1698).
  const action_remove_with_empty_event = action(() => {
    profile.removeElement.send({});
  });

  // CT-1828: an empty (or whitespace-only) send must be a no-op — it must
  // NOT clear the canonical name. Clearing here would fall back to the
  // literal "Profile" display product-wide (unlike setBio, which is
  // deliberately left clearable).
  const action_clear_name = action(() => {
    profile.setName.send({ name: "" });
  });

  const action_whitespace_name = action(() => {
    profile.setName.send({ name: "   " });
  });

  const action_set_name = action(() => {
    profile.setName.send({ name: "Grace Hopper" });
  });

  const action_add_external_profile_link = action(() => {
    profile.addExternalLink.send({
      label: "GitHub",
      url: "https://github.com/gracehopper",
    });
  });

  const action_add_unsafe_external_profile_link = action(() => {
    profile.addExternalLink.send({
      label: "Unsafe",
      url: "javascript:alert(1)",
    });
  });

  const action_remove_external_profile_link = action(() => {
    profile.removeExternalLink.send({
      url: "https://github.com/gracehopper",
    });
  });

  const assert_initial_state = assert(() =>
    profile.initialNameApplied === "Ada Lovelace" &&
    profile.externalLinks.length === 0 &&
    profile.verifiedIdentities.length === 0 &&
    profile.elements.length === 0
  );

  const assert_name_set = assert(() =>
    profile.initialNameApplied === "Grace Hopper"
  );

  // The prior (non-empty) name must survive both an empty and a
  // whitespace-only send.
  const assert_name_unchanged_after_empty = assert(() =>
    profile.initialNameApplied === "Grace Hopper"
  );

  const assert_external_profile_link_added = assert(() =>
    profile.externalLinks.length === 1 &&
    profile.externalLinks[0]?.label === "GitHub" &&
    profile.externalLinks[0]?.url === "https://github.com/gracehopper"
  );

  const assert_unsafe_external_profile_link_rejected = assert(() =>
    profile.externalLinks.length === 1
  );

  const assert_external_profile_link_removed = assert(() =>
    profile.externalLinks.length === 0
  );

  const assert_added_element = assert(() => {
    const element = profile.elements[0];
    return profile.elements.length === 1 &&
      element?.tag === "#profileCard" &&
      element?.title === "Profile card" &&
      element?.userTags.includes("person") === true;
  });

  const assert_removed_element = assert(() => profile.elements.length === 0);

  return {
    [TESTS]: [
      { assertion: assert_fresh_login_is_shown },
      { assertion: assert_stale_login_is_hidden },
      { assertion: assert_node_id_is_hidden },
      { assertion: assert_undated_identity_is_hidden },
      { assertion: assert_unreadable_date_or_clock_hides_identity },
      { assertion: assert_profile_url_encodes_the_login },
      { assertion: assert_row_links_the_profile },
      { assertion: assert_section_shown_for_a_fresh_login },
      { assertion: assert_section_hidden_without_a_shown_identity },
      { assertion: assert_inbox_absent_at_birth },
      { assertion: assert_initial_state },
      // CT-1748: a freshly-visited profile starts in the read-only
      // presentation, not the edit form.
      { assertion: assert_not_editing },
      { action: action_set_name },
      { assertion: assert_name_set },
      // CT-1828: empty and whitespace-only sends must not erase the name.
      { action: action_clear_name },
      { assertion: assert_name_unchanged_after_empty },
      { action: action_whitespace_name },
      { assertion: assert_name_unchanged_after_empty },
      // External profile links are owner-authored public https links. Unsafe
      // schemes are rejected at write time, then the owner can remove a link.
      { action: action_add_external_profile_link },
      { assertion: assert_external_profile_link_added },
      { action: action_add_unsafe_external_profile_link },
      { assertion: assert_unsafe_external_profile_link_rejected },
      { action: action_remove_external_profile_link },
      { assertion: assert_external_profile_link_removed },
      // CT-1748: the avatar the badge binds resolves.
      { action: action_set_avatar },
      { assertion: assert_avatar_set },
      // CT-1828: an empty send must not erase the avatar either.
      { action: action_clear_avatar },
      { assertion: assert_avatar_unchanged_after_empty },
      // Add/remove exercise the full owner-protected element write stack:
      // the same-transaction card instantiation linked into the
      // writeAuthorizedBy-protected list (prepare's setup-schema / child-doc
      // link-label hatches) and the single authorized `mutateElements`
      // writer behind every mutation surface (CT-1698).
      { action: action_add_catalog_element },
      { assertion: assert_added_element },
      // The share inbox link points at a piece; a send without one clears it.
      { action: action_set_inbox },
      { assertion: assert_inbox_links_the_first_card },
      { action: action_add_second_card },
      { action: action_set_inbox_to_second },
      { assertion: assert_inbox_links_the_second_card },
      { assertion: assert_both_cards_intact },
      { action: action_clear_inbox },
      { assertion: assert_inbox_cleared },
      { assertion: assert_both_cards_intact },
      { action: action_remove_second_card },
      { assertion: assert_added_element },
      { action: action_remove_catalog_element },
      { assertion: assert_removed_element },
      // CT-1748: the view/edit toggle flips presentation ⇄ edit form.
      { action: action_toggle_editing },
      { assertion: assert_editing },
      { action: action_toggle_editing },
      { assertion: assert_not_editing },
      { action: action_remove_catalog_element },
      { assertion: assert_removed_element },
      { action: action_remove_with_empty_event },
      { assertion: assert_removed_element },
    ],
  };
});
