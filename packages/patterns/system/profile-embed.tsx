import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import type {
  SetProfileAvatarEvent,
  SetProfileBioEvent,
  SetProfileNameEvent,
} from "./profile-home.tsx";

/**
 * Profile embed (CT-1833) — a clean, host-embeddable presentation of the
 * VIEWER's own profile.
 *
 * Mechanism decision (Ben): this is a SEPARATE labs-owned presentation pattern,
 * NOT a new UI-variant kind, NOT a Lit context, NOT a wish-query extension. UI
 * variants (chip/tile) stay a pure size spectrum; "which chrome" is expressed by
 * choosing which pattern a host mounts. A host (e.g. Loom's "Your Profile")
 * instantiates this pattern standalone and mounts it at a known location; it can
 * also be linked from the main profile surface later.
 *
 * The pattern takes NO profile input — it wishes `#profile` itself and renders
 * the viewer's profile. The profile it renders is always the viewer's own
 * (`#profile` resolves the viewer's default profile), so "owner" reduces to
 * "profile resolved": once `result` is present the viewer is the owner and gets
 * the amend-in-place edit affordance. Visitors never reach this pattern with
 * someone else's profile — there is no profile input to point elsewhere.
 *
 * Presentation is deliberately minimal and theme-token compliant: a
 * `<cf-profile-badge variant="hero">` bound to the REAL live profile cell (the
 * blessed identity idiom — bind the cell, not a snapshot) plus a bio paragraph.
 * Pinned elements / "Pin a piece" developer chrome are HIDDEN in this v1 (it is
 * a presentation of upstream-owned data, not a second source of truth).
 *
 * Editing is amend-in-place: prefilled draft cells (seeded from the current
 * values when the viewer enters edit mode) write back through the profile's
 * EXPORTED owner-protected streams (`setName` / `setAvatar` / `setBio`) on the
 * wish `result`. Cross-pattern stream dispatch is the sanctioned path; this
 * pattern owns NO copy of name/avatar/bio beyond those transient drafts.
 * CT-1828's empty-string guards make an accidental empty submit safe, and the
 * UI additionally avoids sending empty names.
 */

// The wish publishes a display view and the profile's mutation capabilities.
// Field write policy belongs to the profile's stored documents; this view does
// not redeclare it on the foreign reference. Older profiles default bio to an
// empty string and may omit its mutation stream.
type ProfileResult = {
  name: string;
  avatar: string;
  bio: Default<string, "">;
  setName: Stream<SetProfileNameEvent>;
  setAvatar: Stream<SetProfileAvatarEvent>;
  setBio?: Stream<SetProfileBioEvent>;
};

const trimmed = (value?: string): string => (value ?? "").trim();

/**
 * Enter edit mode and seed the draft inputs from the current profile values so
 * the viewer amends (not retypes from blank). Seeding is done here — at the
 * transition into edit mode — rather than with a two-way `$value` onto the
 * upstream (owner-protected) cells, which CFC would reject.
 */
const startEditing = handler<
  void,
  {
    editing: Writable<boolean>;
    nameDraft: Writable<string>;
    avatarDraft: Writable<string>;
    bioDraft: Writable<string>;
    currentName?: string;
    currentAvatar?: string;
    currentBio?: string;
  }
>((_event, state) => {
  state.nameDraft.set(trimmed(state.currentName));
  state.avatarDraft.set(trimmed(state.currentAvatar));
  state.bioDraft.set(trimmed(state.currentBio));
  state.editing.set(true);
});

const stopEditing = handler<void, { editing: Writable<boolean> }>(
  (_event, state) => {
    state.editing.set(false);
  },
);

/**
 * Amend the profile name: reads the draft and dispatches into the profile's
 * exported `setName` stream (the one owner-authorized writer). Empty/whitespace
 * sends are suppressed here too so the UI never asks the upstream guard to
 * reject — a name is never intentionally cleared.
 */
const saveName = handler<
  void,
  { draft: Writable<string>; setName?: Stream<SetProfileNameEvent> }
>((_event, state) => {
  const name = trimmed(state.draft.get());
  if (!name) return;
  state.setName?.send({ name });
});

const saveAvatar = handler<
  void,
  { draft: Writable<string>; setAvatar?: Stream<SetProfileAvatarEvent> }
>((_event, state) => {
  const avatar = trimmed(state.draft.get());
  if (!avatar) return;
  state.setAvatar?.send({ avatar });
});

const saveBio = handler<
  void,
  { draft: Writable<string>; setBio?: Stream<SetProfileBioEvent> }
>((_event, state) => {
  // Bio is deliberately clearable (unlike name/avatar), so an empty draft is a
  // valid amend. CT-1828's guards keep this safe upstream.
  state.setBio?.send({ bio: trimmed(state.draft.get()) });
});

export type ProfileEmbedInput = Record<string, never>;

export type ProfileEmbedOutput = {
  [NAME]: string;
  [UI]: VNode;
  // Whether the viewer's profile has resolved (a profile exists). When false the
  // wish fallback (the trusted create surface) is rendered.
  hasProfile: boolean;
  // Raw edit-mode toggle state (the viewer's intent).
  isEditing: boolean;
};

export default pattern<ProfileEmbedInput, ProfileEmbedOutput>(() => {
  // Resolve the viewer's own profile. `result` is undefined at zero profiles or
  // while resolution is pending; `[UI]` is the wish's fallback surface (the
  // trusted create surface when empty). We render `result ?? fallback`.
  const profileWish = wish<ProfileResult>({ query: "#profile" });

  // Transient local drafts backing the amend inputs. Not a second source of
  // truth — seeded from the live values on entering edit mode, cleared/written
  // through the exported streams on save.
  const nameDraft = new Writable("").for("nameDraft");
  const avatarDraft = new Writable("").for("avatarDraft");
  const bioDraft = new Writable("").for("bioDraft");
  // View toggle: presentation by default, amend form when the owner opts in.
  const editing = new Writable<boolean>(false).for("editing");

  const hasProfile = computed(() => profileWish.result !== undefined);
  const isEditing = computed(() => editing.get() === true);
  const showEditForm = computed(() =>
    profileWish.result !== undefined && editing.get() === true
  );
  const showPresentation = computed(() =>
    profileWish.result !== undefined && editing.get() !== true
  );

  const bio = computed(() => trimmed(profileWish.result?.bio as string));
  const hasBio = computed(() =>
    trimmed(profileWish.result?.bio as string).length > 0
  );

  const displayName = computed(() => {
    const name = trimmed(profileWish.result?.name as string);
    return name.length > 0 ? name : "Profile";
  });

  return {
    [NAME]: displayName,
    hasProfile,
    isEditing,
    [UI]: (
      <cf-screen data-ui-pattern="ProfileEmbed">
        <cf-vstack gap="4" style={{ padding: "16px", maxWidth: "560px" }}>
          {
            /* No profile yet (or pending): render the wish fallback — the
              trusted create surface at zero profiles. `result ?? fallback`. */
          }
          {ifElse(
            hasProfile,
            null,
            <div data-ui-region="profile-embed-fallback">
              {profileWish[UI]}
            </div>,
          )}

          {
            /* Clean presentation: hero badge bound to the REAL live profile cell
              (the wish result) + bio. Elements / "Pin a piece" chrome hidden. */
          }
          {ifElse(
            showPresentation,
            <cf-vstack gap="4" data-ui-region="profile-embed-presentation">
              <cf-profile-badge
                id="profile-embed-badge"
                variant="hero"
                $profile={profileWish.result}
                size="xl"
                noNavigate
              />

              {ifElse(
                hasBio,
                <p
                  data-ui-region="profile-embed-bio"
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    color: "var(--cf-theme-color-text-secondary)",
                  }}
                >
                  {bio}
                </p>,
                null,
              )}

              <cf-hstack>
                <cf-button
                  variant="ghost"
                  size="sm"
                  onClick={startEditing({
                    editing,
                    nameDraft,
                    avatarDraft,
                    bioDraft,
                    currentName: profileWish.result?.name,
                    currentAvatar: profileWish.result?.avatar,
                    currentBio: profileWish.result?.bio,
                  })}
                >
                  Edit profile
                </cf-button>
              </cf-hstack>
            </cf-vstack>,
            null,
          )}

          {
            /* Amend-in-place: prefilled drafts write back through the profile's
              exported owner-protected streams. No developer chrome. */
          }
          {ifElse(
            showEditForm,
            <cf-vstack gap="4" data-ui-region="profile-embed-edit">
              <cf-vstack gap="2">
                <label>Name</label>
                <cf-input $value={nameDraft} placeholder="Your name" />
                <cf-hstack>
                  <cf-button
                    size="sm"
                    onClick={saveName({
                      draft: nameDraft,
                      setName: profileWish.result?.setName,
                    })}
                  >
                    Save name
                  </cf-button>
                </cf-hstack>
              </cf-vstack>

              <cf-vstack gap="2">
                <label>Avatar</label>
                <cf-input
                  $value={avatarDraft}
                  placeholder="Avatar URL or text"
                />
                <cf-hstack>
                  <cf-button
                    size="sm"
                    onClick={saveAvatar({
                      draft: avatarDraft,
                      setAvatar: profileWish.result?.setAvatar,
                    })}
                  >
                    Save avatar
                  </cf-button>
                </cf-hstack>
              </cf-vstack>

              <cf-vstack gap="2">
                <label>Bio</label>
                <cf-textarea
                  $value={bioDraft}
                  placeholder="A short bio…"
                  style="width: 100%;"
                />
                <cf-hstack>
                  <cf-button
                    size="sm"
                    onClick={saveBio({
                      draft: bioDraft,
                      setBio: profileWish.result?.setBio,
                    })}
                  >
                    Save bio
                  </cf-button>
                </cf-hstack>
              </cf-vstack>

              <cf-hstack>
                <cf-button
                  variant="ghost"
                  size="sm"
                  onClick={stopEditing({ editing })}
                >
                  Done
                </cf-button>
              </cf-hstack>
            </cf-vstack>,
            null,
          )}
        </cf-vstack>
      </cf-screen>
    ),
  };
});
