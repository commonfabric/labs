import {
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  type PerSpace,
  UI,
  type VNode,
  wish,
} from "commonfabric";

import { normalizePresenceParticipantName } from "./participant-name.ts";
export { normalizePresenceParticipantName } from "./participant-name.ts";

const DEFAULT_NOTE = "# Collaborative note\n\nStart writing together.";
export interface CollaborativeNoteInput {
  /** Note body shared by every viewer of this piece. */
  note?: PerSpace<string | Default<typeof DEFAULT_NOTE>>;
}

export interface CollaborativeNoteOutput {
  [NAME]: string;
  [UI]: VNode;
  note: PerSpace<string | Default<typeof DEFAULT_NOTE>>;
  participantName: string;
}

/**
 * A minimal shared note that pairs Memory-backed text with ephemeral cursors.
 * The editor derives its room from the shared field, the host supplies the
 * service URL, and the pattern derives each viewer's label from their profile.
 */
export default pattern<CollaborativeNoteInput, CollaborativeNoteOutput>(
  ({ note }) => {
    // `#profile` owns the create/pick UI and live profile identity. The field
    // wish is the profile-backed plain-text label expected by cf-code-editor.
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const participantName = computed(() =>
      normalizePresenceParticipantName(profileNameWish.result ?? "")
    );
    const hasProfile = computed(() =>
      normalizePresenceParticipantName(profileNameWish.result ?? "") !== "" &&
      profileWish.result !== undefined
    );

    return {
      [NAME]: "Collaborative note",
      [UI]: (
        <cf-screen>
          <cf-vstack
            gap="4"
            style={{ padding: "1rem", maxWidth: "760px", margin: "0 auto" }}
          >
            <cf-hstack justify="between" align="center" gap="4">
              <cf-vstack gap="1">
                <cf-heading level={2}>Collaborative note</cf-heading>
                <cf-text tone="muted">
                  The note is durable; names and live selections are ephemeral.
                </cf-text>
              </cf-vstack>
              {ifElse(
                hasProfile,
                <cf-profile-badge
                  variant="chip"
                  $profile={profileWish.result}
                />,
                <div id="collaborative-note-profile-setup">
                  {profileWish[UI]}
                </div>,
              )}
            </cf-hstack>

            <cf-code-editor
              $value={note}
              collaborative
              participantName={participantName}
              language="text/markdown"
              mode="prose"
              wordWrap
              placeholder="Write something together…"
              style={{ minHeight: "24rem" }}
            />
          </cf-vstack>
        </cf-screen>
      ),
      note,
      participantName,
    };
  },
);
