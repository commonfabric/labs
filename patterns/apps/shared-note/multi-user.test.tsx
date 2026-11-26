/**
 * Tests that a comment is its author's to delete: two people on one note,
 * each with a profile of their own, and the one who did not write a comment
 * is refused deleting it, leaving it and its anchors as they were. And that
 * each activity row is labeled with the person whose action wrote it.
 */

import {
  action,
  assert,
  multiUserTest,
  pattern,
  principalOf,
  TESTS,
  Writable,
} from "commonfabric";
import {
  type ActivityRow,
  SharedNoteCore,
  type StoredComment,
} from "./main.tsx";
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

  /** The note's title. */
  title: Writable<string>;

  /** The note's activity rows. */
  activity: Writable<ActivityRow[]>;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  content: Writable.of<string>(BODY),
  comments: Writable.of<StoredComment[]>([]),
  title: Writable.of<string>("Plan"),
  activity: Writable.of<ActivityRow[]>([]),
}));

/** The posted comments among `comments`. */
const posted = (
  comments: readonly (StoredComment | undefined)[],
): StoredComment[] =>
  comments.filter((c): c is StoredComment => c?.status === "posted");

/** The principal the activity row at `index` is labeled as written by. */
const rowAuthor = (setup: Setup, index: number): string | undefined =>
  principalOf(setup.activity.key(index), "authored-by");

/** The principal the first comment is labeled as written by: Ada. */
const commentAuthor = (setup: Setup): string | undefined =>
  principalOf(setup.comments.key(0), "authored-by");

export const ada = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>();
  const note = SharedNoteCore({
    content: setup.content,
    comments: setup.comments,
    title: setup.title,
    activity: setup.activity,
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
      {
        // Ada's comment is reported as hers: the row's author is the
        // comment's.
        assertion: assert(() =>
          setup.activity.get().length === 1 &&
          setup.activity.get()[0]?.body === 'commented on "Plan"' &&
          rowAuthor(setup, 0) !== undefined &&
          rowAuthor(setup, 0) === commentAuthor(setup)
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
    title: setup.title,
    activity: setup.activity,
    myProfile: profile,
    participantName: "Grace",
  });
  const action_delete_adas_comment = action(() =>
    note.deleteComment.send({ id: posted(setup.comments.get())[0]?.id ?? "" })
  );
  const action_append = action(() =>
    note.appendLine.send({ text: "- [ ] Tell Ada" })
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
      {
        // Grace's refused delete reported nothing.
        assertion: assert(() => setup.activity.get().length === 1),
      },
      { action: action_append },
      {
        // Grace's edit is reported under an author of its own.
        assertion: assert(() =>
          setup.activity.get()[1]?.body === 'edited "Plan"' &&
          rowAuthor(setup, 1) !== undefined &&
          rowAuthor(setup, 1) !== rowAuthor(setup, 0)
        ),
      },
      { label: "grace-edited" },
    ],
  };
});

export default multiUserTest({ setup, participants: { ada, grace } });
