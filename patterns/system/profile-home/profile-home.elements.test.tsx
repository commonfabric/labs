/**
 * The profile's pinned elements as each surface adds them — the catalog card
 * and link form the edit form binds, and the `addPiece` stream — together with
 * what the presentation shows of them, the Enter gate on the name and avatar
 * inputs, and the form a verified identity must be in to be collected.
 *
 * The edit form is offered only to a viewer whose `#profile` candidates hold
 * this profile, and `#profile` resolves nothing in this lane, so the form's
 * catalog-card and link-form bindings are made here over the profile's own
 * `elements`, as instances of the one writer the form binds.
 */
import {
  action,
  assert,
  pattern,
  spaceOf,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElementByText,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import ProfileHome, {
  isCanonicalVerifiedIdentity,
  mutateElements,
} from "./profile-home.tsx";

const VERIFIED_AT = "2026-07-16T20:00:00.000Z";

export default pattern(() => {
  const profile = ProfileHome({ initialName: "Ada Lovelace" });
  const linkUrl = Writable.of("https://example.com/card.tsx");
  const linkTitle = Writable.of("");
  const linkTag = Writable.of("");
  const addCard = mutateElements({
    elements: profile.elements,
    mode: "addCard",
    userTags: ["person"],
  });
  const addLink = mutateElements({
    elements: profile.elements,
    mode: "addLink",
    patternUrl: linkUrl,
    title: linkTitle,
    tag: linkTag,
    userTags: ["work"],
  });

  const action_add_card = action(() => addCard.send({}));
  const action_add_link = action(() => addLink.send({}));
  // A piece's URL pasted whole into the space field is split into its space
  // and its id.
  const action_pin_piece_url = action(() => {
    profile.addPiece.send({
      pieceSpace: `https://example.com/${spaceOf(linkUrl)}/fid1:pinned`,
      title: "Pinned",
    });
  });
  const action_pin_piece = action(() => {
    profile.addPiece.send({
      pieceSpace: spaceOf(linkUrl)!,
      pieceId: "of:fid1:second",
    });
  });
  const action_pin_nothing = action(() => profile.addPiece.send({}));
  const action_add_external_link = action(() => {
    profile.addExternalLink.send({
      label: "GitHub",
      url: "https://github.com/ada",
    });
  });
  // A key other than Enter is a keystroke, not a send.
  const action_type_name_and_avatar = action(() => {
    profile.setName.send({ name: "Grace Hopper", key: "r" });
    profile.setAvatar.send({ avatar: "GH", key: "H" });
  });
  const action_enter_name_and_avatar = action(() => {
    profile.setName.send({ name: "Grace Hopper", key: "Enter" });
    profile.setAvatar.send({ avatar: "GH", key: "Enter" });
  });
  // A send naming no identity changes nothing, whichever way it goes.
  const action_send_no_identities = action(() => {
    profile.publishVerifiedIdentities.send({});
    profile.revokeVerifiedIdentities.send({ identities: [] });
  });
  // An identity not in canonical form is not collected: the profile writes
  // nothing, rather than a write that the identity's missing Loom integrity
  // would then have refused. Revoking one the profile does not hold leaves the
  // list as it was.
  const offForm = Writable.of({
    type: "GitHub.login",
    value: "ada",
    verifiedAt: VERIFIED_AT,
  });
  const action_send_off_form_identity = action(() => {
    profile.publishVerifiedIdentities.send({ identities: [offForm] });
    profile.revokeVerifiedIdentities.send({ identities: [offForm] });
  });

  return {
    [TESTS]: [
      { action: action_add_card },
      {
        assertion: assert(() =>
          profile.elements.length === 1 &&
          profile.elements[0]?.title === "Profile card" &&
          profile.elements[0]?.tag === "#profileCard" &&
          profile.elements[0]?.source === "catalog" &&
          profile.elements[0]?.userTags.join() === "person"
        ),
      },

      // A link with no title or tag of its own goes by its URL, and the form
      // is cleared once it is saved, so saving it again adds nothing.
      { action: action_add_link },
      {
        assertion: assert(() =>
          profile.elements.length === 2 &&
          profile.elements[1]?.title === "https://example.com/card.tsx" &&
          profile.elements[1]?.tag === "https://example.com/card.tsx" &&
          profile.elements[1]?.source === "url" &&
          profile.elements[1]?.userTags.join() === "work"
        ),
      },
      { assertion: assert(() => linkUrl.get() === "") },
      { action: action_add_link },
      { assertion: assert(() => profile.elements.length === 2) },

      { action: action_pin_piece_url },
      {
        assertion: assert(() =>
          profile.elements.length === 3 &&
          profile.elements[2]?.title === "Pinned" &&
          profile.elements[2]?.tag === "fid1:pinned" &&
          profile.elements[2]?.source === "piece"
        ),
      },
      // The same piece pinned again is the piece already pinned.
      { action: action_pin_piece_url },
      { assertion: assert(() => profile.elements.length === 3) },
      // A piece pinned without a title goes by its id.
      { action: action_pin_piece },
      { action: action_pin_nothing },
      {
        assertion: assert(() =>
          profile.elements.length === 4 &&
          profile.elements[3]?.title === "of:fid1:second"
        ),
      },

      // The presentation shows each element by its title, with its tags, and
      // each external link as a link.
      { action: action_add_external_link },
      { assertion: assert(() => hasText(profile[UI], "Pinned")) },
      { assertion: assert(() => hasText(profile[UI], "#work")) },
      {
        assertion: assert(() =>
          propValue(findElementByText(profile[UI], "a", "GitHub"), "href") ===
            "https://github.com/ada"
        ),
      },

      { action: action_type_name_and_avatar },
      {
        assertion: assert(() =>
          profile.initialNameApplied === "Ada Lovelace" &&
          profile.avatar === ""
        ),
      },
      { action: action_enter_name_and_avatar },
      {
        assertion: assert(() =>
          profile.initialNameApplied === "Grace Hopper" &&
          profile.avatar === "GH"
        ),
      },

      { action: action_send_no_identities },
      { action: action_send_off_form_identity },
      { assertion: assert(() => profile.verifiedIdentities.length === 0) },
      {
        assertion: assert(() =>
          isCanonicalVerifiedIdentity({
            type: "github.login",
            value: "ada",
            verifiedAt: VERIFIED_AT,
          }) === true
        ),
      },
      // A `verifiedAt` naming the same instant in another form is not the
      // canonical one.
      {
        assertion: assert(() =>
          isCanonicalVerifiedIdentity({
              type: "github.login",
              value: "ada",
              verifiedAt: "2026-07-16T22:00:00.000+02:00",
            }) === false &&
          isCanonicalVerifiedIdentity({
              type: "github.login",
              value: "ada",
              verifiedAt: "2026-07-16T20:00:00Z",
            }) === false
        ),
      },
      // Neither does one naming no instant at all.
      {
        assertion: assert(() =>
          isCanonicalVerifiedIdentity({
              type: "github.login",
              value: "ada",
              verifiedAt: "2026-02-31T00:00:00.000Z",
            }) === false &&
          isCanonicalVerifiedIdentity({
              type: "github.login",
              value: "ada",
              verifiedAt: "2026-07-16T20:00:00.000+24:00",
            }) === false &&
          isCanonicalVerifiedIdentity({
              type: "github.login",
              value: "ada",
              verifiedAt: "yesterday",
            }) === false
        ),
      },
      {
        assertion: assert(() =>
          isCanonicalVerifiedIdentity({
              type: "GitHub.login",
              value: "ada",
              verifiedAt: VERIFIED_AT,
            }) === false &&
          isCanonicalVerifiedIdentity({
              type: "github.login",
              value: " ada",
              verifiedAt: VERIFIED_AT,
            }) === false
        ),
      },
    ],
    profile,
  };
});
