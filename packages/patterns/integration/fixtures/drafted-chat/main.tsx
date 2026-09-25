import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/**
 * A chat whose names and messages are typed into draft cells and committed by
 * separate events — fixture for the multi-runtime tests of drafts
 * (`cellset-lww.test.ts`, `drafted-chat-chained-event-gate-multi-runtime.test.ts`,
 * `drafted-chat-scopes-multi-runtime.test.ts`).
 *
 * A draft is written by one event and read by the event that commits it, so
 * the pair races across streams. The profile save writes the trimmed name back
 * into its draft, a handler echo standing on the document the next typed name
 * is written to. A send reads its draft, skips an empty one, and clears it.
 * `sessionDraft` is the one draft scoped to a session rather than a user.
 */

type DraftCell = Writable<string | Default<"">>;

export interface ChatMessage {
  body: string;
}

type MessagesCell = Writable<ChatMessage[] | Default<[]>>;

export interface DraftedChatInput {
  profileDraft?: PerUser<DraftCell>;
  profileName?: PerUser<DraftCell>;
  messageDraft?: PerUser<DraftCell>;
  sessionDraft?: PerSession<DraftCell>;
  messages?: PerSpace<MessagesCell>;
}

export interface DraftedChatOutput {
  [NAME]: string;
  [UI]: VNode;
  profileDraft: PerUser<DraftCell>;
  messageDraft: PerUser<DraftCell>;
  sessionDraft: PerSession<DraftCell>;
  messages: PerSpace<MessagesCell>;
  currentProfileName: string;
  setProfileDraft: Stream<string>;
  setMessageDraft: Stream<string>;
  setSessionDraft: Stream<string>;
  saveProfile: Stream<void>;
  sendMessage: Stream<void>;
}

const writeDraft = handler<string, { draft: DraftCell }>(
  (text, { draft }) => {
    draft.set(text);
  },
);

const saveProfile = handler<void, {
  profileDraft: DraftCell;
  profileName: DraftCell;
}>((_, { profileDraft, profileName }) => {
  const name = (profileDraft.get() ?? "").trim();
  if (!name) return;
  profileName.set(name);
  profileDraft.set(name);
});

const sendMessage = handler<void, {
  messageDraft: DraftCell;
  messages: MessagesCell;
}>((_, { messageDraft, messages }) => {
  const body = (messageDraft.get() ?? "").trim();
  if (!body) return;
  messages.push({ body });
  messageDraft.set("");
});

export default pattern<DraftedChatInput, DraftedChatOutput>(
  ({ profileDraft, profileName, messageDraft, sessionDraft, messages }) => {
    const profileDraftCell: DraftCell = profileDraft!;
    const profileNameCell: DraftCell = profileName!;
    const messageDraftCell: DraftCell = messageDraft!;
    const sessionDraftCell: DraftCell = sessionDraft!;
    const messagesCell: MessagesCell = messages!;
    return {
      [NAME]: "drafted chat fixture",
      [UI]: (
        <div>
          <span>drafted chat fixture</span>
        </div>
      ),
      profileDraft: profileDraftCell as PerUser<DraftCell>,
      messageDraft: messageDraftCell as PerUser<DraftCell>,
      sessionDraft: sessionDraftCell as PerSession<DraftCell>,
      messages: messagesCell as PerSpace<MessagesCell>,
      currentProfileName: computed(() => profileNameCell.get() ?? ""),
      setProfileDraft: writeDraft({ draft: profileDraftCell }),
      setMessageDraft: writeDraft({ draft: messageDraftCell }),
      setSessionDraft: writeDraft({ draft: sessionDraftCell }),
      saveProfile: saveProfile({
        profileDraft: profileDraftCell,
        profileName: profileNameCell,
      }),
      sendMessage: sendMessage({
        messageDraft: messageDraftCell,
        messages: messagesCell,
      }),
    };
  },
);
