/**
 * Tests that a comment is its author's to delete: two people on one note,
 * each with a profile of their own, and the one who did not write a comment
 * is refused deleting it, leaving it and its anchors as they were.
 */

import {
  action,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { SharedNoteCore, type StoredComment } from "./main.tsx";
import {
  profileGesture,
  type TestProfile,
  writeOwnProfile,
} from "./test-profile.ts";

const BODY = "# Plan\n\nShip it\n";

interface Setup {
  /** The note's body. */
  content: Writable<string>;

  /** The note's comments. */
  comments: Writable<StoredComment[]>;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  content: Writable.of<string>(BODY),
  comments: Writable.of<StoredComment[]>([]),
}));

/** The posted comments among `comments`. */
const posted = (
  comments: readonly (StoredComment | undefined)[],
): StoredComment[] =>
  comments.filter((c): c is StoredComment => c?.status === "posted");

export const ada = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>();
  const note = SharedNoteCore({
    content: setup.content,
    comments: setup.comments,
    myProfile: profile,
    participantName: "Ada",
  });
  const action_comment = action(() =>
    note.addComment.send({ quote: "Ship it", body: "Friday" })
  );
  return {
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Ada" }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: action_comment },
      {
        assertion: assert(() =>
          posted(setup.comments.get()).length === 1 &&
          posted(setup.comments.get())[0]?.body === "Friday"
        ),
      },
      { label: "ada-commented" },
    ],
  };
});

export const grace = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>();
  const note = SharedNoteCore({
    content: setup.content,
    comments: setup.comments,
    myProfile: profile,
    participantName: "Grace",
  });
  const action_delete_adas_comment = action(() =>
    note.deleteComment.send({ id: posted(setup.comments.get())[0]?.id ?? "" })
  );
  return {
    // The refused verb throws inside its handler, which the runner reports
    // as a runtime error; it is expected.
    expectRuntimeErrors: ["Only its author can delete a comment."],
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Grace" }),
        event: {},
        trustedUi: profileGesture,
      },
      { await: "ada-commented" },
      {
        assertion: assert(() =>
          posted(setup.comments.get())[0]?.body === "Friday"
        ),
      },
      { action: action_delete_adas_comment },
      {
        // Ada's comment stays, and so do the two anchors that hold it on
        // its text, which a delete would have removed.
        assertion: assert(() => {
          const [comment] = posted(setup.comments.get());
          const anchors = note.commentAnchors ?? {};
          return posted(setup.comments.get()).length === 1 &&
            comment?.body === "Friday" &&
            anchors[`${comment.id}:from`] === BODY.indexOf("Ship it") &&
            anchors[`${comment.id}:to`] ===
              BODY.indexOf("Ship it") + "Ship it".length;
        }),
      },
    ],
  };
});

export default multiUserTest({ setup, participants: { ada, grace } });
