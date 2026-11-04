/** Tests CodeMirror-native mapping and rendering of remote editor presence. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { receiveUpdates, sendableUpdates } from "@codemirror/collab";
import {
  type ChangeDesc,
  ChangeSet,
  EditorSelection,
  EditorState,
} from "@codemirror/state";
import type { Decoration, WidgetType } from "@codemirror/view";
import { codeMirrorCollaboration } from "./codemirror-collaboration.ts";
import {
  codeMirrorPresence,
  codeMirrorPresenceClearEffect,
  codeMirrorPresenceCursorEffect,
  codeMirrorPresenceRemoveEffect,
  codeMirrorPresenceState,
  codeMirrorPresenceUpsertEffect,
  composePendingChangeDesc,
  mapSelectionToConfirmed,
  MAX_RENDERED_PRESENCE_NAME_LENGTH,
  type ParticipantPresence,
  type PresenceCursor,
  presenceParticipantColor,
  presenceSelectionToJSON,
} from "./codemirror-presence.ts";

const cursor = (version: number, epoch = 1): PresenceCursor => ({
  epoch,
  version,
});

const participant = (
  overrides: Partial<ParticipantPresence> = {},
): ParticipantPresence => ({
  participantId: "alice",
  revision: 1,
  name: "Alice",
  focused: true,
  cursor: cursor(0),
  selection: presenceSelectionToJSON(EditorSelection.single(2)),
  basis: "confirmed",
  ...overrides,
});

const upsert = (
  value: ParticipantPresence,
  pendingChanges: readonly ChangeDesc[] = [],
) => codeMirrorPresenceUpsertEffect.of({ participant: value, pendingChanges });

const advance = (
  value: PresenceCursor,
  pendingChanges: readonly ChangeDesc[] = [],
) => codeMirrorPresenceCursorEffect.of({ cursor: value, pendingChanges });

const createState = (): EditorState =>
  EditorState.create({
    doc: "abcd",
    extensions: [codeMirrorPresence(cursor(0))],
  });

const createCollaborativeState = (): EditorState =>
  EditorState.create({
    doc: "abc",
    extensions: [
      codeMirrorCollaboration(0, "receiver"),
      codeMirrorPresence(cursor(0)),
    ],
  });

const pendingChanges = (state: EditorState): readonly ChangeDesc[] =>
  sendableUpdates(state).map((update) => update.changes);

const decorationValues = (state: EditorState): Decoration[] => {
  const values: Decoration[] = [];
  codeMirrorPresenceState(state)?.decorations.between(
    0,
    state.doc.length,
    (_from, _to, value) => {
      values.push(value);
    },
  );
  return values;
};

describe("codemirror-presence", () => {
  describe("composePendingChangeDesc()", () => {
    it("composes consecutive CodeMirror change descriptions", () => {
      const first = ChangeSet.of({ from: 0, insert: "X" }, 4);
      const second = ChangeSet.of({ from: 5, insert: "Y" }, 5);

      const composed = composePendingChangeDesc([first, second]);

      expect(composed?.length).toBe(4);
      expect(composed?.newLength).toBe(6);
      expect(composed?.mapPos(2)).toBe(3);
    });

    it("returns `undefined` without pending changes", () => {
      expect(composePendingChangeDesc([])).toBe(undefined);
    });
  });

  describe("mapSelectionToConfirmed()", () => {
    it("round-trips through pending changes and their canonical transaction", () => {
      const first = ChangeSet.of({ from: 0, insert: "X" }, 4);
      const second = ChangeSet.of({ from: 5, insert: "Y" }, 5);
      const composed = first.composeDesc(second);
      const confirmed = EditorSelection.create([
        EditorSelection.range(1, 2),
        EditorSelection.cursor(3),
      ], 1);
      const local = confirmed.map(composed);

      const provisional = mapSelectionToConfirmed(local, [first, second]);

      expect(provisional.toJSON()).toEqual(confirmed.toJSON());
      expect(provisional.map(composed).toJSON()).toEqual(local.toJSON());
    });

    it("returns the same selection without pending changes", () => {
      const selection = EditorSelection.single(2);

      expect(mapSelectionToConfirmed(selection, [])).toBe(selection);
    });

    it("retains which side of an insertion contains a provisional caret", () => {
      const insertion = ChangeSet.of({ from: 1, insert: "X" }, 3);

      const before = mapSelectionToConfirmed(
        EditorSelection.single(1),
        [insertion],
      );
      const after = mapSelectionToConfirmed(
        EditorSelection.single(2),
        [insertion],
      );

      expect(presenceSelectionToJSON(before)).toEqual({
        ranges: [{ anchor: 1, head: 1, assoc: -1 }],
        main: 0,
      });
      expect(presenceSelectionToJSON(after)).toEqual({
        ranges: [{ anchor: 1, head: 1, assoc: 0 }],
        main: 0,
      });
    });

    it("round-trips a selection across a pending deletion", () => {
      const deletion = ChangeSet.of({ from: 1, to: 3 }, 4);
      const local = EditorSelection.single(1);

      const provisional = mapSelectionToConfirmed(local, [deletion]);

      expect(provisional.map(deletion).toJSON()).toEqual(local.toJSON());
    });
  });

  describe("delivery ordering", () => {
    const aliceInsertion = ChangeSet.of({ from: 1, insert: "X" }, 3);

    const provisionalAlice = (): ParticipantPresence => {
      const sender = EditorState.create({
        doc: "abc",
        extensions: [codeMirrorCollaboration(0, "alice")],
      }).update({
        changes: aliceInsertion,
        selection: { anchor: 2 },
      }).state;
      return participant({
        participantId: "alice",
        basis: "provisional",
        selection: presenceSelectionToJSON(mapSelectionToConfirmed(
          sender.selection,
          pendingChanges(sender),
        )),
      });
    };

    const confirmedAlice = (): ParticipantPresence =>
      participant({
        participantId: "alice",
        revision: 2,
        cursor: cursor(1),
        basis: "confirmed",
        selection: presenceSelectionToJSON(EditorSelection.single(2)),
      });

    const receiverWithPendingInsertion = (): EditorState =>
      createCollaborativeState().update({
        changes: { from: 0, insert: "Y" },
      }).state;

    const receiveAliceInsertion = (state: EditorState): EditorState =>
      receiveUpdates(state, [{
        clientID: "alice",
        changes: aliceInsertion,
      }]).state;

    it("maps a presence-first caret with content and a receiver overlay", () => {
      let receiver = receiverWithPendingInsertion();
      receiver = receiver.update({
        effects: upsert(provisionalAlice(), pendingChanges(receiver)),
      }).state;

      expect(
        codeMirrorPresenceState(receiver)?.participants.get("alice")
          ?.displayed?.selection?.main.head,
      ).toBe(2);

      receiver = receiveAliceInsertion(receiver);
      receiver = receiver.update({
        effects: advance(cursor(1), pendingChanges(receiver)),
      }).state;

      expect(receiver.doc.toString()).toBe("YaXbc");
      expect(
        codeMirrorPresenceState(receiver)?.participants.get("alice")
          ?.displayed?.selection?.main.head,
      ).toBe(3);

      receiver = receiver.update({
        effects: upsert(confirmedAlice(), pendingChanges(receiver)),
      }).state;
      expect(
        codeMirrorPresenceState(receiver)?.participants.get("alice")
          ?.displayed?.selection?.main.head,
      ).toBe(3);
    });

    it("discards late provisional state after content arrives first", () => {
      let receiver = receiverWithPendingInsertion();
      receiver = receiveAliceInsertion(receiver);
      receiver = receiver.update({
        effects: advance(cursor(1), pendingChanges(receiver)),
      }).state;

      receiver = receiver.update({
        effects: upsert(provisionalAlice(), pendingChanges(receiver)),
      }).state;
      expect(
        codeMirrorPresenceState(receiver)?.participants.has("alice"),
      ).toBe(false);

      receiver = receiver.update({
        effects: upsert(confirmedAlice(), pendingChanges(receiver)),
      }).state;

      expect(receiver.doc.toString()).toBe("YaXbc");
      expect(
        codeMirrorPresenceState(receiver)?.participants.get("alice")
          ?.displayed?.selection?.main.head,
      ).toBe(3);
    });
  });

  describe("presence state", () => {
    it("installs current records and maps displayed ranges through changes", () => {
      const initial = createState();
      const installed = initial.update({
        effects: upsert(participant({
          selection: presenceSelectionToJSON(EditorSelection.single(2, 3)),
        })),
      }).state;

      const changed = installed.update({
        changes: { from: 0, insert: "XY" },
      }).state;
      const alice = codeMirrorPresenceState(changed)?.participants.get("alice");

      expect(alice?.displayed?.selection?.toJSON()).toEqual(
        EditorSelection.single(4, 5).toJSON(),
      );
      expect(decorationValues(changed)).toHaveLength(2);
    });

    it("maps collapsed ranges according to their wire associations", () => {
      const installed = createState().update({
        effects: [
          upsert(participant({
            selection: {
              ranges: [{ anchor: 2, head: 2, assoc: -1 }],
              main: 0,
            },
          })),
          upsert(participant({
            participantId: "bob",
            selection: {
              ranges: [{ anchor: 2, head: 2, assoc: 1 }],
              main: 0,
            },
          })),
        ],
      }).state;

      const changed = installed.update({
        changes: { from: 2, insert: "X" },
      }).state;
      const presence = codeMirrorPresenceState(changed);

      expect(
        presence?.participants.get("alice")?.displayed?.selection?.main.head,
      ).toBe(2);
      expect(
        presence?.participants.get("bob")?.displayed?.selection?.main.head,
      ).toBe(3);
    });

    it("rejects receiver overlays that do not target the current document", () => {
      const wrongDocument = ChangeSet.of({ from: 0, insert: "X" }, 4);

      const rejected = createState().update({
        effects: upsert(participant(), [wrongDocument]),
      }).state;

      expect(codeMirrorPresenceState(rejected)?.participants.size).toBe(0);
    });

    it("keeps displayed state when a future promotion has an invalid overlay", () => {
      const queued = createState().update({
        effects: [
          upsert(participant()),
          upsert(participant({
            revision: 2,
            cursor: cursor(1),
          })),
        ],
      }).state;
      const wrongDocument = ChangeSet.of({ from: 0, insert: "X" }, 4);

      const rejected = queued.update({
        effects: advance(cursor(1), [wrongDocument]),
      }).state;
      const alice = codeMirrorPresenceState(rejected)?.participants.get(
        "alice",
      );

      expect(alice?.latest).toBe(undefined);
      expect(alice?.displayed?.record.revision).toBe(1);
      expect(alice?.displayed?.selection?.main.head).toBe(2);
    });

    it("keeps displayed state while queueing a future record", () => {
      const initial = createState().update({
        effects: upsert(participant()),
      }).state;

      const queued = initial.update({
        effects: upsert(participant({
          revision: 2,
          cursor: cursor(1),
          selection: presenceSelectionToJSON(EditorSelection.single(4)),
        })),
      }).state;
      const alice = codeMirrorPresenceState(queued)?.participants.get("alice");

      expect(alice?.latest?.revision).toBe(2);
      expect(alice?.displayed?.record.revision).toBe(1);
      expect(alice?.displayed?.selection?.main.head).toBe(2);
      expect(decorationValues(queued)).toHaveLength(1);
    });

    it("maps displayed state before installing a reached future record", () => {
      const queued = createState().update({
        effects: [
          upsert(participant()),
          upsert(participant({
            revision: 2,
            cursor: cursor(1),
            selection: presenceSelectionToJSON(EditorSelection.single(5)),
          })),
        ],
      }).state;

      const advanced = queued.update({
        changes: { from: 0, insert: "X" },
        effects: advance(cursor(1)),
      }).state;
      const alice = codeMirrorPresenceState(advanced)?.participants.get(
        "alice",
      );

      expect(codeMirrorPresenceState(advanced)?.cursor).toEqual(cursor(1));
      expect(alice?.displayed?.record.revision).toBe(2);
      expect(alice?.displayed?.selection?.main.head).toBe(5);
    });

    it("discards a queued record skipped by the Memory cursor", () => {
      const queued = createState().update({
        effects: [
          upsert(participant()),
          upsert(participant({
            revision: 2,
            cursor: cursor(1),
            selection: presenceSelectionToJSON(EditorSelection.single(4)),
          })),
        ],
      }).state;

      const advanced = queued.update({
        changes: { from: 0, insert: "X" },
        effects: advance(cursor(2)),
      }).state;
      const alice = codeMirrorPresenceState(advanced)?.participants.get(
        "alice",
      );

      expect(alice?.latest).toBe(undefined);
      expect(alice?.displayed?.record.revision).toBe(1);
      expect(alice?.displayed?.selection?.main.head).toBe(3);
    });

    it("removes a skipped queue without previously displayed state", () => {
      const queued = createState().update({
        effects: upsert(participant({
          cursor: cursor(1),
          selection: presenceSelectionToJSON(EditorSelection.single(4)),
        })),
      }).state;

      const skipped = queued.update({
        effects: advance(cursor(2)),
      }).state;

      expect(
        codeMirrorPresenceState(skipped)?.participants.has("alice"),
      ).toBe(false);
    });

    it("discards first-seen past records", () => {
      const advanced = createState().update({
        effects: advance(cursor(2)),
      }).state;

      const late = advanced.update({
        effects: upsert(participant({
          revision: 3,
          cursor: cursor(1),
        })),
      }).state;

      expect(
        codeMirrorPresenceState(late)?.participants.has("alice"),
      ).toBe(false);
    });

    it("clears participant state for a mismatched record epoch", () => {
      const installed = createState().update({
        effects: upsert(participant()),
      }).state;

      const mismatched = installed.update({
        effects: upsert(participant({
          revision: 2,
          cursor: cursor(0, 2),
        })),
      }).state;

      expect(
        codeMirrorPresenceState(mismatched)?.participants.has("alice"),
      ).toBe(false);
      expect(decorationValues(mismatched)).toHaveLength(0);
    });

    it("clears every participant when the local epoch changes", () => {
      const installed = createState().update({
        effects: upsert(participant()),
      }).state;

      const reset = installed.update({
        effects: advance(cursor(0, 2)),
      }).state;

      expect(codeMirrorPresenceState(reset)?.cursor).toEqual(cursor(0, 2));
      expect(codeMirrorPresenceState(reset)?.participants.size).toBe(0);
    });

    it("ignores revisions older than displayed state after a future skip", () => {
      const queued = createState().update({
        effects: [
          upsert(participant({ revision: 3 })),
          upsert(participant({
            revision: 4,
            cursor: cursor(1),
            selection: presenceSelectionToJSON(EditorSelection.single(4)),
          })),
        ],
      }).state;
      const skipped = queued.update({
        effects: advance(cursor(2)),
      }).state;

      const old = skipped.update({
        effects: upsert(participant({
          revision: 2,
          cursor: cursor(2),
          selection: presenceSelectionToJSON(EditorSelection.single(0)),
        })),
      }).state;
      const alice = codeMirrorPresenceState(old)?.participants.get("alice");

      expect(alice?.displayed?.record.revision).toBe(3);
      expect(alice?.displayed?.selection?.main.head).toBe(2);
    });

    it("removes one participant or clears the entire field", () => {
      const installed = createState().update({
        effects: upsert(participant()),
      }).state;
      const removed = installed.update({
        effects: codeMirrorPresenceRemoveEffect.of("alice"),
      }).state;
      const restored = removed.update({
        effects: upsert(participant()),
      }).state;
      const cleared = restored.update({
        effects: codeMirrorPresenceClearEffect.of(null),
      }).state;

      expect(codeMirrorPresenceState(removed)?.participants.size).toBe(0);
      expect(codeMirrorPresenceState(cleared)?.participants.size).toBe(0);
      expect(decorationValues(cleared)).toHaveLength(0);
    });

    it("does not retain more than the room participant limit", () => {
      const participants = Array.from(
        { length: 128 },
        (_, index) => participant({ participantId: `participant-${index}` }),
      );
      const full = createState().update({
        effects: participants.map((record) => upsert(record)),
      }).state;

      const overflow = full.update({
        effects: upsert(participant({ participantId: "overflow" })),
      }).state;

      expect(codeMirrorPresenceState(overflow)?.participants.size).toBe(128);
      expect(
        codeMirrorPresenceState(overflow)?.participants.has("overflow"),
      ).toBe(false);
    });
  });

  describe("remote decorations", () => {
    it("keeps an unfocused participant's last selection decorated", () => {
      const state = createState().update({
        effects: upsert(participant({
          focused: false,
          selection: presenceSelectionToJSON(EditorSelection.single(1, 3)),
        })),
      }).state;

      expect(decorationValues(state)).toHaveLength(2);
    });

    it("renders every selection range and caret from a bounded palette", () => {
      const selection = EditorSelection.create([
        EditorSelection.range(0, 1),
        EditorSelection.range(2, 3),
      ], 1);
      const state = createState().update({
        effects: upsert(participant({
          selection: presenceSelectionToJSON(selection),
        })),
      }).state;
      const decorations = decorationValues(state);

      expect(decorations).toHaveLength(4);
      expect(
        decorations.filter((value) =>
          value.spec.attributes?.class?.includes(
            "cm-remote-presence-selection",
          )
        ),
      ).toHaveLength(2);
      expect(presenceParticipantColor("alice")).toBe("#a31545");
    });

    it("renders untrusted names as bounded text content", () => {
      const name = "<img src=x onerror=alert(1)>" + "x".repeat(100);
      const state = createState().update({
        effects: upsert(participant({ name })),
      }).state;
      const widget = decorationValues(state)[0].spec.widget as WidgetType;
      const elements: FakeElement[] = [];
      const ownerDocument = {
        createElement: () => {
          const element = new FakeElement();
          elements.push(element);
          return element;
        },
      };

      widget.toDOM(
        {
          dom: { ownerDocument },
        } as unknown as Parameters<WidgetType["toDOM"]>[0],
      );

      expect(elements).toHaveLength(2);
      expect(elements[1].textContent).toBe(
        Array.from(name).slice(0, MAX_RENDERED_PRESENCE_NAME_LENGTH).join(""),
      );
      expect(elements[1].textContent).toContain("<img");
      expect(elements[0].children).toEqual([elements[1]]);
    });
  });
});

/** Minimal element double used to verify that widgets assign text safely. */
class FakeElement {
  className = "";
  textContent = "";
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();

  /** Records an attribute assignment. */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** Records a child insertion. */
  append(child: FakeElement): void {
    this.children.push(child);
  }
}
