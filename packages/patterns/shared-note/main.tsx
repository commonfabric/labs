/** A shared Markdown document with Fabric profile names on live cursors. */

import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  type Stream,
  TILE_UI,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import { normalizePresenceParticipantName } from "./participant-name.ts";

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

  /** Adds `text` to the end of the document, on a line of its own. */
  appendLine: Stream<LineEvent>;

  /** Adds `text` to the start of the document, on a line of its own. */
  prependLine: Stream<LineEvent>;

  /**
   * Replaces the one occurrence of `old` in the document with `new`, and
   * refuses when `old` is empty, occurs nowhere, or occurs more than once.
   */
  replaceText: Stream<ReplaceTextEvent>;
}

/** Text to add as a line of its own. */
export interface LineEvent {
  /** The line, without a trailing newline. */
  text: string;
}

/** An exact replacement anchored on text the document holds once. */
export interface ReplaceTextEvent {
  /** Text the document holds exactly once, compared code unit for code unit. */
  old: string;

  /** Text that takes its place. */
  new: string;
}

// The verbs edit the body through `applyChanges()` rather than `set()`: once an
// editor has opened the body it accepts only edits, which the open editors
// merge with their own typing. Each edit's positions refer to the text the verb
// read, and land only while the body still holds it; a body that moved on
// refuses the commit, and the verb runs again against the new text.

const appendLine = handler<LineEvent, { content: Writable<string> }>(
  ({ text }, { content }) => {
    const current = content.get();
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    content.applyChanges({ from: current.length, insert: separator + text });
  },
);

const prependLine = handler<LineEvent, { content: Writable<string> }>(
  ({ text }, { content }) => {
    const current = content.get();
    const separator = current === "" || text.endsWith("\n") ? "" : "\n";
    content.applyChanges({ from: 0, insert: text + separator });
  },
);

const replaceText = handler<ReplaceTextEvent, { content: Writable<string> }>(
  (event, { content }) => {
    if (event.old === "") {
      throw new Error(
        "replaceText needs a non-empty `old` to anchor on; to add text, use " +
          "`appendLine` or `prependLine`",
      );
    }
    const current = content.get();
    const from = current.indexOf(event.old);
    if (from === -1) {
      throw new Error(
        "replaceText found no occurrence of `old`; read the note again and " +
          "anchor on text it holds",
      );
    }
    if (current.indexOf(event.old, from + 1) !== -1) {
      throw new Error(
        "replaceText found `old` more than once; anchor on a longer passage " +
          "that occurs once",
      );
    }
    content.applyChanges({
      from,
      to: from + event.old.length,
      insert: event.new,
    });
  },
);

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

// A presence failure removes live cursors and leaves editing alone. The editor
// tries a `configuration` failure again only when the room or name changes,
// and any other failure when it next gains focus. A failure while it has focus
// keeps focus, so the viewer has to leave the note and come back.
const reportPresenceError = handler<
  { detail: { category?: string } },
  { presenceNotice: Writable<string> }
>((event, { presenceNotice }) => {
  presenceNotice.set(
    event.detail.category === "configuration"
      ? "Live cursors are unavailable on this server. Editing still works."
      : "Live cursors are unavailable. Editing still works; click outside the note, then back into it to try again.",
  );
});

const clearPresenceNotice = handler<
  unknown,
  { presenceNotice: Writable<string> }
>((_, { presenceNotice }) => {
  presenceNotice.set("");
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
      participantName !== "" &&
      profile.result !== undefined
    );
    const error = new Writable.perSession("");
    const recovery = new Writable.perSession<string | null>(null);
    const hasError = computed(() => error.get() !== "");
    const presenceNotice = new Writable.perSession("");
    const hasPresenceNotice = computed(() => presenceNotice.get() !== "");
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
          {hasProfile
            ? <cf-profile-badge variant="chip" $profile={profile.result} />
            : (
              <div
                id="shared-note-profile-setup"
                style={{ minWidth: "0", maxWidth: "100%" }}
              >
                <cf-text>Choose a Fabric profile to label your cursor.</cf-text>
                {profile[UI]}
              </div>
            )}
        </cf-hstack>
        {hasError ? <cf-text role="alert">{error}</cf-text> : null}
        {hasPresenceNotice
          ? <cf-text role="status">{presenceNotice}</cf-text>
          : null}
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
          oncf-presence-error={reportPresenceError({ presenceNotice })}
          oncf-presence-join={clearPresenceNotice({ presenceNotice })}
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
      appendLine: appendLine({ content }),
      prependLine: prependLine({ content }),
      replaceText: replaceText({ content }),
    };
  },
);
