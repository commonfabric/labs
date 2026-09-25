/** A shared Markdown document with Fabric profile names on live cursors. */

import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  TILE_UI,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import { normalizePresenceParticipantName } from "../collaborative-note/participant-name.ts";

/** Initial document values, shared by every viewer of this piece. */
export interface SharedNoteInput {
  /** Editable document title, independent of Markdown frontmatter. */
  title?: PerSpace<string | Default<"Untitled note">>;

  /** LF-normalized Markdown; live editing uses CodeMirror operations. */
  content?: PerSpace<string | Default<"">>;
}

/** Readable Markdown and the same compact view for standalone and embedded use. */
export interface SharedNoteOutput {
  [NAME]: string;
  [UI]: VNode;
  [TILE_UI]: VNode;
  title: PerSpace<string>;
  content: PerSpace<string>;
  participantName: PerUser<string>;
}

const reportError = handler<
  { detail: { message?: string } },
  { error: Writable<string> }
>((event, { error }) => {
  error.set(
    event.detail.message || "Editing paused. Reopen this note to reconnect.",
  );
});

const preserveUnsentText = handler<
  { detail: { localValue: string } },
  { recovery: Writable<string | null> }
>((event, { recovery }) => {
  recovery.set(event.detail.localValue);
});

export default pattern<SharedNoteInput, SharedNoteOutput>(
  ({ title, content }) => {
    const profile = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileName = wish<string>({ query: "#profileName" });
    const participantName = computed(() =>
      normalizePresenceParticipantName(profileName.result ?? "")
    );
    const hasProfile = computed(() =>
      normalizePresenceParticipantName(profileName.result ?? "") !== "" &&
      profile.result !== undefined
    );
    const error = new Writable.perSession("");
    const recovery = new Writable.perSession<string | null>(null);
    const hasError = computed(() => error.get() !== "");
    const hasRecovery = computed(() => recovery.get() !== null);
    const recoveryText = computed(() => recovery.get() ?? "");

    const view = (
      <cf-vstack
        gap="3"
        style={{ padding: "1rem", width: "100%", boxSizing: "border-box" }}
      >
        <cf-hstack
          gap="3"
          align="center"
          justify="between"
          wrap
        >
          <cf-input
            $value={title}
            aria-label="Note title"
            placeholder="Untitled note"
            style={{ flex: "1 1 16rem", minWidth: "0" }}
          />
          {ifElse(
            hasProfile,
            <cf-profile-badge variant="chip" $profile={profile.result} />,
            <div
              id="shared-note-profile-setup"
              style={{ minWidth: "0", maxWidth: "100%" }}
            >
              <cf-text>Choose a Fabric profile to label your cursor.</cf-text>
              {profile[UI]}
            </div>,
          )}
        </cf-hstack>
        {hasError ? <cf-text role="alert">{error}</cf-text> : null}
        {hasRecovery
          ? (
            <cf-vstack gap="2">
              <cf-text role="alert">
                Editing paused. Copy your unsent text below before reopening
                this note.
              </cf-text>
              <cf-textarea
                id="shared-note-recovery"
                aria-label="Unsent text to recover"
                value={recoveryText}
                readonly
                rows={8}
              />
            </cf-vstack>
          )
          : null}
        <cf-code-editor
          $value={content}
          collaborative
          participantName={participantName}
          language="text/markdown"
          mode="prose"
          wordWrap
          tabIndent
          placeholder="Start writing…"
          oncf-error={reportError({ error })}
          oncf-collaboration-reconcile={preserveUnsentText({ recovery })}
          style={{ minHeight: "20rem" }}
        />
      </cf-vstack>
    );

    return {
      [NAME]: title,
      [UI]: view,
      [TILE_UI]: view,
      title,
      content,
      participantName,
    };
  },
);
