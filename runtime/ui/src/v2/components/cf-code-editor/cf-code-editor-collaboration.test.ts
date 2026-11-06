import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  ChangeSet,
  Compartment,
  EditorState,
  StateEffect,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  type ApplyOpResolution,
  CellHandle,
  type CellRef,
  CODEMIRROR_CHANGESET_CODEC,
  type OperationFieldSnapshot,
  type PresenceEvent,
  type PresenceRecord,
  type PresenceRoomHandle,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import { CFCodeEditor } from "./cf-code-editor.ts";
import {
  highlightAnchors,
  highlightField,
  setHighlightAnchorsEffect,
} from "./features/highlights.ts";
import { CodeMirrorCollaborationController } from "./codemirror-collaboration.ts";
import { codeMirrorPresenceState } from "./codemirror-presence.ts";
import { backlinkField } from "./features/backlinks.ts";
import { mentionRefField, refShortNameField } from "./features/mention-refs.ts";

const operationPath = [] as unknown as OperationFieldSnapshot["path"];

type ApplyRequest = Parameters<RuntimeClient["applyOperation"]>[1];

function inactiveSnapshot(materialized = "abc") {
  return {
    branch: "",
    id: "of:editor",
    scopeKey: "",
    path: operationPath,
    active: false,
    codec: null,
    cursor: null,
    baselineHash: "baseline",
    materialized,
    anchors: {},
    operations: [],
  } as const;
}

function statefulView(extensions: unknown[] = []) {
  return {
    hasFocus: false,
    state: EditorState.create({
      doc: "abc",
      extensions: extensions as never[],
    }),
    dispatch(spec: never) {
      this.state = this.state.update(spec).state;
    },
  };
}

/** A room handle that records what the editor does to it. */
class FakePresenceHandle implements PresenceRoomHandle {
  participantId = "participant:self";
  participants: PresenceRecord[] = [];
  readonly names: string[] = [];
  readonly facets: Array<[string, unknown]> = [];
  readonly focus: boolean[] = [];
  leaves = 0;
  readonly #listeners = new Set<(event: PresenceEvent) => void>();

  constructor(readonly room: string) {}

  setName(name: string): void {
    this.names.push(name);
  }

  setFacet(facet: string, value: unknown): void {
    this.facets.push([facet, value]);
  }

  clearFacet(): void {}

  setFocused(focused: boolean): void {
    this.focus.push(focused);
  }

  subscribe(listener: (event: PresenceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  leave(): Promise<void> {
    this.leaves++;
    return Promise.resolve();
  }

  emit(event: PresenceEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

/** A runtime stand-in whose only presence is what `joinPresenceRoom` records. */
function presenceRuntime(options: { failJoin?: Error } = {}) {
  const runtime = {
    joins: [] as Array<{ room?: string }>,
    handles: [] as FakePresenceHandle[],
    joinPresenceRoom(
      _cell: CellHandle<string>,
      joinOptions: { room?: string } = {},
    ): Promise<PresenceRoomHandle> {
      runtime.joins.push(joinOptions);
      if (options.failJoin !== undefined) {
        return Promise.reject(options.failJoin);
      }
      const handle = new FakePresenceHandle(joinOptions.room ?? "derived");
      runtime.handles.push(handle);
      return Promise.resolve(handle);
    },
  };
  return runtime;
}

/** Lets a join that settles on the microtask queue land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function caretRecord(
  participantId: string,
  revision = 1,
): PresenceRecord {
  return {
    participantId,
    revision,
    name: "Peer",
    facets: {
      caret: {
        focused: true,
        cursor: { epoch: 2, version: 4 },
        selection: { ranges: [{ anchor: 0, head: 1, assoc: -1 }], main: 0 },
        basis: "confirmed",
      },
    },
  };
}

function operationCell(
  runtime: Record<string, unknown>,
  ref: CellRef = {
    space: "did:key:editor-space" as CellRef["space"],
    id: "of:editor-document" as CellRef["id"],
    scope: "space",
    path: ["body"],
  },
  resolvedRef: CellRef = ref,
): CellHandle<string> {
  const makeCell = (cellRef: CellRef): CellHandle<string> => {
    const cell = Object.create(CellHandle.prototype);
    Object.defineProperty(cell, "runtime", { value: () => runtime });
    Object.defineProperty(cell, "ref", { value: () => cellRef });
    Object.defineProperty(cell, "space", { value: () => cellRef.space });
    Object.defineProperty(cell, "resolveAsCell", {
      configurable: true,
      value: () => Promise.resolve(cell),
    });
    return cell;
  };
  const resolved = makeCell(resolvedRef);
  if (resolvedRef === ref) return resolved;
  const source = makeCell(ref);
  Object.defineProperty(source, "resolveAsCell", {
    configurable: true,
    value: () => Promise.resolve(resolved),
  });
  return source;
}

/** The ranges `state` draws highlight marks over, in document order. */
function drawnRanges(state: EditorState): Array<[number, number]> {
  const drawn: Array<[number, number]> = [];
  state.field(highlightField).decorations.between(
    0,
    state.doc.length,
    (from, to) => {
      drawn.push([from, to]);
    },
  );
  return drawn;
}

const synchronizedField = {
  space: "did:key:editor-space",
  branch: "main",
  id: "of:editor-document",
  scopeKey: "space",
  path: ["value", "body"],
} as const;

describe("CFCodeEditor collaboration", () => {
  it("restates highlight anchors only when the anchors or their version change", () => {
    const element = new CFCodeEditor();
    const view = statefulView([highlightField]);
    // Counts the dispatches that restate the anchors.
    let dispatches = 0;
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (spec: never) => {
      const effects = (spec as { effects?: unknown }).effects;
      if (
        effects instanceof StateEffect && effects.is(setHighlightAnchorsEffect)
      ) {
        dispatches++;
      }
      dispatch(spec);
    };
    (element as any)._editorView = view;
    (element as any).emit = () => {};
    const anchors = { from: 0, to: 2 };
    const snapshot = (version: number, map = anchors, pending = []) => ({
      confirmedCursor: { epoch: 1, version },
      pendingChanges: pending,
      field: synchronizedField,
      anchors: map,
    });

    (element as any)._handleCollaborationSynchronization(snapshot(4));
    expect(highlightAnchors(view.state)).toEqual({ from: 0, to: 2 });
    expect(dispatches).toBe(1);

    // Equal anchors in another object at the same version: nothing to
    // restate.
    (element as any)._handleCollaborationSynchronization(
      snapshot(4, { from: 0, to: 2 }),
    );
    expect(dispatches).toBe(1);

    // Pending edits that do not end at the editor's text: the anchors stay.
    (element as any)._handleCollaborationSynchronization(
      snapshot(5, { from: 1, to: 2 }, [
        ChangeSet.of({ from: 0, insert: "XYZ" }, 9).desc,
      ] as never),
    );
    expect(highlightAnchors(view.state)).toEqual({ from: 0, to: 2 });
    expect(dispatches).toBe(1);

    // A newer version restates them.
    (element as any)._handleCollaborationSynchronization(
      snapshot(6, { from: 1, to: 3 }),
    );
    expect(highlightAnchors(view.state)).toEqual({ from: 1, to: 3 });
    expect(dispatches).toBe(2);

    // A newer version that states what the editor already holds dispatches
    // nothing.
    (element as any)._handleCollaborationSynchronization(
      snapshot(7, { from: 1, to: 3 }),
    );
    expect(dispatches).toBe(2);
  });

  it("draws each highlight between its anchors, moved over the edits Memory has not confirmed", () => {
    // Memory has confirmed "abc" with "bc" marked; the editor holds "Xabc",
    // its insertion at the start still pending.

    const element = new CFCodeEditor();
    const view = statefulView([highlightField]);
    view.dispatch({ changes: { from: 0, insert: "X" } } as never);
    (element as any)._editorView = view;
    (element as any).emit = () => {};
    element.highlights = [{ id: "h", fromAnchor: "from", toAnchor: "to" }];
    (element as any).updated(new Map([["highlights", []]]));

    (element as any)._handleCollaborationSynchronization({
      confirmedCursor: { epoch: 1, version: 4 },
      pendingChanges: [ChangeSet.of({ from: 0, insert: "X" }, 3).desc],
      field: synchronizedField,
      anchors: { from: 1, to: 3 },
    });

    expect(highlightAnchors(view.state)).toEqual({ from: 2, to: 4 });
    expect(drawnRanges(view.state)).toEqual([[2, 4]]);
  });

  it("forgets the anchors when collaboration ends", () => {
    const element = new CFCodeEditor();
    const view = statefulView([highlightField]);
    (element as any)._editorView = view;
    (element as any).emit = () => {};
    (element as any)._handleCollaborationSynchronization({
      confirmedCursor: { epoch: 1, version: 4 },
      pendingChanges: [],
      field: synchronizedField,
      anchors: { from: 0, to: 2 },
    });

    (element as any)._handleCollaborationSynchronization(null);

    expect(highlightAnchors(view.state)).toEqual({});
  });

  it("draws the highlights of a field with no collaborative edit", () => {
    const element = new CFCodeEditor();
    const view = statefulView([highlightField]);
    (element as any)._editorView = view;
    (element as any).emit = () => {};
    element.highlights = [{ id: "h", fromAnchor: "from", toAnchor: "to" }];
    (element as any).updated(new Map([["highlights", []]]));

    (element as any)._handleCollaborationSynchronization({
      confirmedCursor: null,
      pendingChanges: [],
      field: synchronizedField,
      anchors: { from: 1, to: 3 },
    });

    expect(highlightAnchors(view.state)).toEqual({ from: 1, to: 3 });
    expect(drawnRanges(view.state)).toEqual([[1, 3]]);
  });

  it("keeps a highlight drawn, moved over the pending edit, while the first edit activates the field", () => {
    // The field holds "abc" with "bc" marked and has no version. The person
    // types "X" at the start; Memory then confirms it as version 1.

    const element = new CFCodeEditor();
    const view = statefulView([highlightField]);
    // What the editor draws after each dispatch.
    const drawn: Array<Array<[number, number]>> = [];
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (spec: never) => {
      dispatch(spec);
      drawn.push(drawnRanges(view.state));
    };
    (element as any)._editorView = view;
    (element as any).emit = () => {};
    element.highlights = [{ id: "h", fromAnchor: "from", toAnchor: "to" }];
    (element as any).updated(new Map([["highlights", []]]));
    const stored = { from: 1, to: 3 };
    const synchronize = (
      confirmedCursor: { epoch: number; version: number } | null,
      pendingChanges: unknown[],
      anchors: Record<string, number>,
    ) =>
      (element as any)._handleCollaborationSynchronization({
        confirmedCursor,
        pendingChanges,
        field: synchronizedField,
        anchors,
      });

    synchronize(null, [], stored);
    drawn.length = 0;
    view.dispatch({ changes: { from: 0, insert: "X" } } as never);
    synchronize(null, [ChangeSet.of({ from: 0, insert: "X" }, 3).desc], stored);
    synchronize({ epoch: 1, version: 1 }, [], { from: 2, to: 4 });

    expect(highlightAnchors(view.state)).toEqual({ from: 2, to: 4 });
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((ranges) => ranges.length === 1)).toBe(true);
    expect(drawn.map((ranges) => ranges[0])).toEqual(
      drawn.map(() => [2, 4]),
    );
  });

  it("joins no presence room until the field has a confirmed cursor", async () => {
    const runtime = presenceRuntime();
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      (element as any)._editorView = statefulView([presence.of([])]);
      const collaboration: {
        active: boolean;
        cell: CellHandle<string>;
        synchronizationSnapshot: {
          confirmedCursor: { epoch: number; version: number } | null;
          pendingChanges: never[];
          field: typeof synchronizedField;
          anchors: Record<string, number>;
        };
      } = {
        active: true,
        cell: operationCell(runtime),
        synchronizationSnapshot: {
          confirmedCursor: null,
          pendingChanges: [],
          field: synchronizedField,
          anchors: {},
        },
      };
      (element as any)._collaboration = collaboration;
      element.collaborative = true;
      element.participantName = "Ada";

      (element as any)._handleCollaborationSynchronization(
        collaboration.synchronizationSnapshot,
      );
      (element as any)._setupPresence();
      (element as any)._handlePresenceFocus();
      await settle();
      expect(runtime.joins).toEqual([]);

      collaboration.synchronizationSnapshot = {
        ...collaboration.synchronizationSnapshot,
        confirmedCursor: { epoch: 1, version: 1 },
      };
      (element as any)._handleCollaborationSynchronization(
        collaboration.synchronizationSnapshot,
      );
      await settle();
      expect(runtime.joins).toEqual([{}]);
      expect(runtime.handles[0].facets).toEqual([["caret", {
        focused: false,
        cursor: { epoch: 1, version: 1 },
        selection: null,
        basis: "confirmed",
      }]]);

      // A release takes the field's version away, and presence with it.
      collaboration.synchronizationSnapshot = {
        ...collaboration.synchronizationSnapshot,
        confirmedCursor: null,
      };
      (element as any)._handleCollaborationSynchronization(
        collaboration.synchronizationSnapshot,
      );
      await settle();
      expect(runtime.handles[0].leaves).toBe(1);
      expect(runtime.joins).toHaveLength(1);
    } finally {
      (element as any)._cleanupPresence();
    }
  });

  it("reports no selection and draws nothing before the editor has a view", () => {
    const events: unknown[] = [];
    const element = new CFCodeEditor();
    (element as any).emit = (_name: string, detail: unknown) =>
      events.push(detail);

    (element as any)._reportSelection();
    (element as any)._handleCollaborationSynchronization({
      confirmedCursor: { epoch: 1, version: 1 },
      pendingChanges: [],
      field: synchronizedField,
      anchors: { from: 0, to: 1 },
    });

    expect(events).toEqual([]);
  });

  it("hands a changed highlights property to the editor", () => {
    const element = new CFCodeEditor();
    const view = statefulView([highlightField]);
    (element as any)._editorView = view;
    element.highlights = [
      { id: "h", fromAnchor: "from", toAnchor: "to", kind: "active" },
    ];

    (element as any).updated(new Map([["highlights", []]]));

    expect(view.state.field(highlightField).highlights).toEqual([
      { id: "h", fromAnchor: "from", toAnchor: "to", kind: "active" },
    ]);
  });

  describe("cf-selection-change", () => {
    // Each case holds a selection in an editor, over "abc", that has
    // reported nothing yet. `report()` stands in for the editor seeing its
    // selection change, `change()` for a transaction that changes the
    // document and names no selection, and `confirm()` for the collaboration
    // controller publishing a synchronization snapshot: at a version, for a
    // field with no version, or as collaboration ends. `events` collects the
    // details of the `cf-selection-change` events the editor emits.

    const NOTHING = { from: 0, to: 0, text: "", value: "" };

    const snapshotAt = (
      version: number | "unversioned",
      pending: unknown[] = [],
    ) => ({
      confirmedCursor: version === "unversioned" ? null : { epoch: 1, version },
      pendingChanges: pending,
      field: synchronizedField,
      anchors: {},
    });

    const selectionHarness = (anchor: number, head: number) => {
      const events: unknown[] = [];
      const element = new CFCodeEditor();
      // The state carries the fields the editor reads on every change to the
      // document, and a read-only editor writes nothing back for one.
      const view = statefulView([
        backlinkField,
        mentionRefField,
        refShortNameField,
      ]);
      view.dispatch({ selection: { anchor, head } } as never);
      (element as any)._editorView = view;
      (element as any).readonly = true;
      (element as any).emit = (name: string, detail: unknown) => {
        if (name === "cf-selection-change") events.push(detail);
      };
      const confirm = (
        version: number | "unversioned" | "ended",
        pending: unknown[] = [],
      ) =>
        (element as any)._handleCollaborationSynchronization(
          version === "ended" ? null : snapshotAt(version, pending),
        );
      const report = () => (element as any)._reportSelection();
      const change = (changes: unknown) => {
        const startState = view.state;
        const transaction = startState.update({ changes } as never);
        view.state = transaction.state;
        (element as any)._handleEditorUpdate({
          transactions: [transaction],
          docChanged: true,
          selectionSet: false,
          state: transaction.state,
          startState,
        });
      };
      return { events, view, confirm, report, change };
    };

    it("reports the range, its text and the editor's document", () => {
      const { events, report } = selectionHarness(0, 2);

      report();

      expect(events).toEqual([{ from: 0, to: 2, text: "ab", value: "abc" }]);
    });

    it("reports that nothing is selected in an editor that has reported nothing yet", () => {
      const { events, report } = selectionHarness(0, 0);

      report();

      expect(events).toEqual([NOTHING]);
    });

    it("reports nothing more as the caret moves, as the person types, or as collaborators' edits arrive", () => {
      const { events, view, confirm, report, change } = selectionHarness(0, 0);
      report();

      view.dispatch({ selection: { anchor: 2 } } as never);
      report();
      view.dispatch({
        changes: { from: 2, insert: "X" },
        selection: { anchor: 3 },
      } as never);
      report();
      confirm(4, [ChangeSet.of({ from: 2, insert: "X" }, 3).desc]);
      confirm(5);
      change({ from: 0, insert: "remote " });
      confirm(6);

      expect(events).toEqual([NOTHING]);
    });

    it("reports a held selection again where a change to the document moved it, with collaboration off", () => {
      // A change that names no selection still moves the one held, as a
      // rename of a reference ahead of it does.

      const { events, report, change } = selectionHarness(1, 3);
      report();

      change({ from: 0, insert: "longer " });

      expect(events).toEqual([
        { from: 1, to: 3, text: "bc", value: "abc" },
        { from: 8, to: 10, text: "bc", value: "longer abc" },
      ]);
    });

    it("reports a held selection again against the new document when a change after it leaves its range in place", () => {
      const { events, report, change } = selectionHarness(0, 2);
      report();

      change({ from: 3, insert: "!" });

      expect(events).toEqual([
        { from: 0, to: 2, text: "ab", value: "abc" },
        { from: 0, to: 2, text: "ab", value: "abc!" },
      ]);
    });

    it("states a selection against the editor's document while the editor's own edit is unconfirmed", () => {
      // Memory has confirmed "abc"; the editor holds ">abc", its insertion
      // still pending, and the person selects "ab".

      const { events, view, confirm, report } = selectionHarness(0, 0);
      view.dispatch({
        changes: { from: 0, insert: ">" },
        selection: { anchor: 1, head: 3 },
      } as never);
      confirm(4, [ChangeSet.of({ from: 0, insert: ">" }, 3).desc]);

      report();

      expect(events).toEqual([{ from: 1, to: 3, text: "ab", value: ">abc" }]);
    });

    it("reports nothing for a synchronization snapshot, at a version, without one, or as collaboration ends", () => {
      const { events, confirm, report } = selectionHarness(0, 2);
      report();

      confirm(5);
      confirm("unversioned");
      confirm(6, [ChangeSet.of({ from: 0, insert: ">" }, 3).desc]);
      confirm("ended");

      expect(events).toEqual([{ from: 0, to: 2, text: "ab", value: "abc" }]);
    });
  });

  it("routes local, remote, and cell-originated editor updates correctly", () => {
    const calls: string[] = [];
    const collaboration = {
      active: true,
      localDocChanged: () => calls.push("operation"),
    };
    const self = {
      readonly: false,
      language: "text/markdown",
      _collaboration: collaboration,
      _publishPresence: () => calls.push("presence"),
      _reportSelection: () => calls.push("selection"),
      emit: () => calls.push("change"),
      setValue: () => calls.push("value"),
      _updateMentionedFromContent: () => calls.push("mentioned"),
      _setupPieceNameSubscriptions: () => calls.push("subscriptions"),
      _detectAndSyncNameChanges: () => calls.push("names"),
      _syncMentionRefs: () => calls.push("refs"),
    };
    const invoke = (
      annotation: unknown,
      docChanged = true,
      selectionSet = false,
    ) =>
      (CFCodeEditor.prototype as any)._handleEditorUpdate.call(self, {
        docChanged,
        selectionSet,
        state: { doc: { toString: () => "new" } },
        startState: { doc: { toString: () => "old" } },
        transactions: [{
          annotation: (key: unknown) => key === annotation,
        }],
      });

    // Every change to the document restates the selection, which it may
    // have moved, whoever made it.
    invoke(undefined);
    expect(calls).toEqual([
      "selection",
      "operation",
      "presence",
      "change",
      "mentioned",
      "subscriptions",
      "names",
      "refs",
    ]);

    calls.length = 0;
    invoke(Transaction.remote);
    expect(calls).toEqual(["selection", "mentioned", "subscriptions"]);

    calls.length = 0;
    const cellSync = (CFCodeEditor as any)._cellSyncAnnotation;
    invoke(cellSync);
    expect(calls).toEqual(["selection"]);

    calls.length = 0;
    invoke(undefined, false);
    expect(calls).toEqual([]);

    invoke(undefined, false, true);
    expect(calls).toEqual(["presence", "selection"]);

    calls.length = 0;
    self._collaboration = undefined as never;
    invoke(undefined);
    expect(calls).toContain("value");
  });

  it("leaves operation authority in charge of ordinary Cell echoes", () => {
    const self = {
      _editorView: {},
      _collaboration: { active: true },
      getValue: () => {
        throw new Error("ordinary Cell value was consulted");
      },
    };

    expect(() =>
      (CFCodeEditor.prototype as any)._updateEditorFromCellValue.call(self)
    ).not.toThrow();
  });

  it("freezes editing and reports a previous-controller stop failure", async () => {
    const events: unknown[] = [];
    const previous = { stop: () => Promise.reject("pending edit") };
    const element = new CFCodeEditor();
    (element as any)._editorView = { dispatch: () => events.push("dispatch") };
    (element as any)._collaboration = previous;
    (element as any).emit = (_name: string, detail: unknown) =>
      events.push(detail);
    element.collaborative = true;

    await (element as any)._setupCollaboration();

    expect((element as any)._collaboration).toBeUndefined();
    expect((events.at(-1) as { message: string }).message).toBe("pending edit");
  });

  it("requires a CellHandle and restores ordinary editing when disabled", async () => {
    const errors: unknown[] = [];
    const element = new CFCodeEditor();
    (element as any)._editorView = { dispatch: () => {} };
    (element as any).emit = (_name: string, detail: unknown) =>
      errors.push(detail);
    element.collaborative = true;
    element.value = "plain text";
    await (element as any)._setupCollaboration();
    expect((errors[0] as { message: string }).message).toContain("CellHandle");

    let synced = 0;
    element.collaborative = false;
    (element as any)._updateEditorFromCellValue = () => synced++;
    await (element as any)._setupCollaboration();
    expect(synced).toBe(1);
  });

  it("starts a controller and fails closed on a malformed live snapshot", async () => {
    let subscriber: ((snapshot: unknown) => void) | undefined;
    const errors: Array<[string, unknown]> = [];
    const runtime = {
      operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
      queryOperationField: () => Promise.resolve(inactiveSnapshot()),
      subscribeOperationField: (
        _cell: unknown,
        callback: (value: unknown) => void,
      ) => {
        subscriber = callback;
        return Promise.resolve(() => {});
      },
      closeOperationSession: () => Promise.resolve(),
    };
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const collaboration = (element as any)._collaborationComp as Compartment;
    (element as any)._editorView = statefulView([
      readonly.of(EditorState.readOnly.of(false)),
      collaboration.of([]),
    ]);
    (element as any).emit = (name: string, detail: unknown) =>
      errors.push([name, detail]);
    element.value = operationCell(runtime);
    element.collaborative = true;

    await (element as any)._setupCollaboration();
    expect((element as any)._collaboration.active).toBe(true);
    (element as any)._editorView.dispatch({
      changes: { from: 0, insert: "local:" },
    });
    subscriber?.(inactiveSnapshot("canonical"));
    expect(errors.at(-2)?.[0]).toBe("cf-collaboration-reconcile");
    expect(errors.at(-1)?.[0]).toBe("cf-error");
    expect((element as any)._collaborationFailed).toBe(true);

    const invalid = new CFCodeEditor();
    (invalid as any)._editorView = statefulView([
      (invalid as any)._readonly.of(EditorState.readOnly.of(false)),
      (invalid as any)._collaborationComp.of([]),
    ]);
    (invalid as any).emit = (name: string, detail: unknown) =>
      errors.push([name, detail]);
    invalid.value = operationCell({
      operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
      queryOperationField: () =>
        Promise.resolve({ ...inactiveSnapshot(), materialized: 42 }),
      closeOperationSession: () => Promise.resolve(),
    });
    invalid.collaborative = true;
    await (invalid as any)._setupCollaboration();
    expect((invalid as any)._collaborationFailed).toBe(true);
    expect(errors.at(-1)?.[0]).toBe("cf-error");
  });

  it("confirms an edit made before setup finishes when collaboration is disabled", async () => {
    // The controller is ready once its first snapshot is installed, while
    // its subscription is still being opened. An edit made in that window is
    // in flight when collaboration is disabled, and the subscription opens
    // only after the disabling setup has started stopping the controller.
    const subscribing = Promise.withResolvers<void>();
    const subscribed = Promise.withResolvers<() => void>();
    let unsubscribes = 0;
    let closes = 0;
    const applying = Promise.withResolvers<ApplyRequest>();
    const applied = Promise.withResolvers<ApplyOpResolution>();
    const address = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path: operationPath,
    };
    const runtime = {
      operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
      queryOperationField: (_cell: unknown, cursor: unknown) =>
        Promise.resolve(
          cursor === undefined ? inactiveSnapshot() : {
            ...inactiveSnapshot("abc!"),
            active: true,
            codec: CODEMIRROR_CHANGESET_CODEC,
            cursor: { epoch: 1, version: 1 },
          },
        ),
      subscribeOperationField: () => {
        subscribing.resolve();
        return subscribed.promise;
      },
      applyOperation: (_cell: unknown, request: ApplyRequest) => {
        applying.resolve(request);
        return applied.promise;
      },
      closeOperationSession: () => {
        closes++;
        return Promise.resolve();
      },
    };
    const errors: unknown[] = [];
    const element = new CFCodeEditor();
    (element as any)._editorView = statefulView([
      (element as any)._readonly.of(EditorState.readOnly.of(false)),
      (element as any)._collaborationComp.of([]),
    ]);
    (element as any).emit = (_name: string, detail: unknown) =>
      errors.push(detail);
    (element as any)._updateEditorFromCellValue = () => {};
    element.value = operationCell(runtime);
    element.collaborative = true;

    const starting = (element as any)._setupCollaboration();
    await subscribing.promise;
    const controller = (element as any)._collaboration;
    expect(controller.active).toBe(true);
    (element as any)._editorView.dispatch({
      changes: { from: 3, insert: "!" },
    });
    const editing = controller.localDocChanged();
    const request = await applying.promise;

    element.collaborative = false;
    const stopping = (element as any)._setupCollaboration();
    subscribed.resolve(() => unsubscribes++);
    await starting;
    applied.resolve({
      operationIndex: 0,
      address,
      codec: CODEMIRROR_CHANGESET_CODEC,
      submissionId: request.submissionId,
      from: { epoch: 1, version: 0 },
      to: { epoch: 1, version: 1 },
      operations: [{
        opId: "op:1",
        cursor: { epoch: 1, version: 1 },
        submissionId: request.submissionId,
        payload: request.payload,
      }],
      duplicate: false,
    });
    await Promise.all([editing, stopping]);

    expect(errors).toEqual([]);
    expect((element as any)._collaboration).toBeUndefined();
    expect((element as any)._collaborationFailed).toBe(false);
    expect((element as any)._editorView.state.readOnly).toBe(false);
    expect((element as any)._editorView.state.doc.toString()).toBe("abc!");
    expect(unsubscribes).toBe(1);
    expect(closes).toBe(1);
  });

  it("resolves the bound handle before pinning collaboration identity", async () => {
    const sourceRef: CellRef = {
      space: "did:key:source-space" as CellRef["space"],
      id: "of:alias" as CellRef["id"],
      scope: "space",
      path: ["body"],
    };
    const resolvedRef: CellRef = {
      space: "did:key:target-space" as CellRef["space"],
      id: "computed:document" as CellRef["id"],
      scope: "user",
      path: ["content", "markdown"],
    };
    const snapshot = {
      ...inactiveSnapshot("abc"),
      branch: "main",
      id: resolvedRef.id,
      scopeKey: "user:ada",
      path: [
        "value",
        ...resolvedRef.path,
      ] as unknown as OperationFieldSnapshot["path"],
      active: true,
      codec: CODEMIRROR_CHANGESET_CODEC,
      cursor: { epoch: 1, version: 0 },
    } as const;
    let openedCell: CellHandle<string> | undefined;
    const runtime = {
      operationCodecs: (cell: CellHandle<string>) => {
        openedCell = cell;
        return Promise.resolve([CODEMIRROR_CHANGESET_CODEC]);
      },
      queryOperationField: () => Promise.resolve(snapshot),
      subscribeOperationField: () => Promise.resolve(() => {}),
      closeOperationSession: () => Promise.resolve(),
    };
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const collaboration = (element as any)
      ._collaborationComp as Compartment;
    (element as any)._editorView = statefulView([
      readonly.of(EditorState.readOnly.of(false)),
      collaboration.of([]),
    ]);
    element.value = operationCell(runtime, sourceRef, resolvedRef);
    element.collaborative = true;

    await (element as any)._setupCollaboration();

    expect(openedCell?.ref()).toEqual(resolvedRef);
    expect((element as any)._collaboration.synchronizationSnapshot.field)
      .toEqual({
        space: "did:key:target-space",
        branch: "main",
        id: "computed:document",
        scopeKey: "user:ada",
        path: ["value", "content", "markdown"],
      });
  });

  it("joins the field's room through the cell's runtime and republishes without rejoining", async () => {
    const runtime = presenceRuntime();
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      (element as any)._editorView = statefulView([presence.of([])]);
      const collaboration = {
        active: true,
        cell: operationCell(runtime),
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 4 },
          pendingChanges: [],
          field: synchronizedField,
          anchors: {},
        },
      };
      (element as any)._collaboration = collaboration;
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";

      (element as any)._setupPresence();
      await settle();
      expect(runtime.joins).toEqual([{ room: "abcdefghijklmnopqrstuv" }]);
      expect(runtime.handles[0].names).toEqual(["Ada"]);
      expect(runtime.handles[0].facets).toEqual([["caret", {
        focused: false,
        cursor: { epoch: 2, version: 4 },
        selection: null,
        basis: "confirmed",
      }]]);

      element.participantName = "Grace";
      (element as any)._setupPresence();
      expect(runtime.joins).toHaveLength(1);
      expect(runtime.handles[0].names).toEqual(["Ada", "Grace"]);

      collaboration.synchronizationSnapshot = {
        confirmedCursor: { epoch: 3, version: 0 },
        pendingChanges: [],
        field: synchronizedField,
        anchors: {},
      };
      (element as any)._handleCollaborationSynchronization(
        collaboration.synchronizationSnapshot,
      );
      await settle();
      expect(runtime.handles[0].leaves).toBe(1);
      expect(runtime.joins).toHaveLength(2);

      element.presenceRoom = "zyxwvutsrqponmlkjihgfe";
      (element as any)._setupPresence();
      await settle();
      expect(runtime.joins[2]).toEqual({ room: "zyxwvutsrqponmlkjihgfe" });
      expect(runtime.handles[1].leaves).toBe(1);

      element.presenceRoom = "";
      (element as any)._setupPresence();
      await settle();
      expect(runtime.joins[3]).toEqual({});
      expect(runtime.handles[3].room).toBe("derived");
    } finally {
      (element as any)._cleanupPresence();
    }
  });

  it("joins every editor's room and marks only the focused one", async () => {
    const runtime = presenceRuntime();
    const createEditor = (room: string) => {
      const element = new CFCodeEditor();
      const presence = (element as any)._presenceComp as Compartment;
      (element as any)._editorView = statefulView([presence.of([])]);
      (element as any)._collaboration = {
        active: true,
        cell: operationCell(runtime),
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 4 },
          pendingChanges: [],
          field: synchronizedField,
          anchors: {},
        },
      };
      element.collaborative = true;
      element.presenceRoom = room;
      element.participantName = "Ada";
      return element;
    };
    const first = createEditor("aaaaaaaaaaaaaaaaaaaaaa");
    const second = createEditor("bbbbbbbbbbbbbbbbbbbbbb");
    try {
      (first as any)._setupPresence();
      (second as any)._setupPresence();
      await settle();
      expect(runtime.joins).toEqual([
        { room: "aaaaaaaaaaaaaaaaaaaaaa" },
        { room: "bbbbbbbbbbbbbbbbbbbbbb" },
      ]);
      const focusedOf = (handle: FakePresenceHandle) =>
        handle.facets.map(([, caret]) =>
          (caret as { focused: boolean }).focused
        );
      expect(focusedOf(runtime.handles[0])).toEqual([false]);
      expect(focusedOf(runtime.handles[1])).toEqual([false]);

      ((first as any)._editorView as { hasFocus: boolean }).hasFocus = true;
      (first as any)._handlePresenceFocus();
      await settle();
      expect(runtime.joins).toHaveLength(2);
      expect(focusedOf(runtime.handles[0])).toEqual([false, true]);

      ((first as any)._editorView as { hasFocus: boolean }).hasFocus = false;
      (first as any)._publishPresence();
      ((second as any)._editorView as { hasFocus: boolean }).hasFocus = true;
      (second as any)._handlePresenceFocus();
      await settle();
      expect(runtime.joins).toHaveLength(2);
      expect(focusedOf(runtime.handles[0])).toEqual([false, true, false]);
      expect(focusedOf(runtime.handles[1])).toEqual([false, true]);
      expect(runtime.handles[0].focus).toEqual([false, true, false]);
      expect(runtime.handles[1].focus).toEqual([false, true]);
      expect(runtime.handles.map((handle) => handle.leaves)).toEqual([0, 0]);

      (second as any)._cleanupPresence();
      expect(runtime.handles.map((handle) => handle.leaves)).toEqual([0, 1]);
      (first as any)._setupPresence();
      await settle();
      expect(runtime.joins).toHaveLength(2);
    } finally {
      (first as any)._cleanupPresence();
      (second as any)._cleanupPresence();
    }
  });

  it("publishes no selection before focus and retains it after blur", async () => {
    const runtime = presenceRuntime();
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      const view = statefulView([presence.of([])]);
      view.hasFocus = false;
      view.dispatch({ selection: { anchor: 1, head: 2 } } as never);
      (element as any)._editorView = view;
      (element as any)._collaboration = {
        active: true,
        cell: operationCell(runtime),
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 4 },
          pendingChanges: [],
          field: synchronizedField,
          anchors: {},
        },
      };
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";

      (element as any)._setupPresence();
      await settle();
      const handle = runtime.handles[0];
      expect(handle.facets[0]).toEqual(["caret", {
        focused: false,
        cursor: { epoch: 2, version: 4 },
        selection: null,
        basis: "confirmed",
      }]);

      view.hasFocus = true;
      (element as any)._publishPresence();
      expect(handle.facets[1]).toEqual(["caret", {
        focused: true,
        cursor: { epoch: 2, version: 4 },
        selection: {
          ranges: [{ anchor: 1, head: 2, assoc: -1 }],
          main: 0,
        },
        basis: "confirmed",
      }]);

      view.hasFocus = false;
      (element as any)._publishPresence();
      expect(handle.facets[2]).toEqual(["caret", {
        focused: false,
        cursor: { epoch: 2, version: 4 },
        selection: {
          ranges: [{ anchor: 1, head: 2, assoc: -1 }],
          main: 0,
        },
        basis: "confirmed",
      }]);
    } finally {
      (element as any)._cleanupPresence();
    }
  });

  it("keeps the presence cursor advancing while a join is still in flight", async () => {
    const joining = Promise.withResolvers<PresenceRoomHandle>();
    const runtime = {
      joins: 0,
      joinPresenceRoom: () => {
        runtime.joins++;
        return joining.promise;
      },
    };
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      const view = statefulView([presence.of([])]);
      (element as any)._editorView = view;
      const collaboration = {
        active: true,
        cell: operationCell(runtime),
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 4 },
          pendingChanges: [],
          field: synchronizedField,
          anchors: {},
        },
      };
      (element as any)._collaboration = collaboration;
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";

      (element as any)._setupPresence();
      expect(runtime.joins).toBe(1);
      expect(codeMirrorPresenceState(view.state)?.cursor).toEqual({
        epoch: 2,
        version: 4,
      });
      collaboration.synchronizationSnapshot = {
        confirmedCursor: { epoch: 2, version: 7 },
        pendingChanges: [],
        field: synchronizedField,
        anchors: {},
      };
      (element as any)._handleCollaborationSynchronization(
        collaboration.synchronizationSnapshot,
      );
      expect(runtime.joins).toBe(1);
      expect(codeMirrorPresenceState(view.state)?.cursor).toEqual({
        epoch: 2,
        version: 7,
      });

      const handle = new FakePresenceHandle("abcdefghijklmnopqrstuv");
      joining.resolve(handle);
      await settle();
      expect((element as any)._presence).toBe(handle);
      expect(handle.facets.at(-1)).toEqual(["caret", {
        focused: false,
        cursor: { epoch: 2, version: 7 },
        selection: null,
        basis: "confirmed",
      }]);
    } finally {
      (element as any)._cleanupPresence();
    }
  });

  it("reports presence failure without making Memory collaboration read-only", () => {
    const events: Array<[string, unknown]> = [];
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const presence = (element as any)._presenceComp as Compartment;
    const view = statefulView([
      readonly.of(EditorState.readOnly.of(false)),
      presence.of([]),
    ]);
    const collaboration = { active: true };
    const handle = new FakePresenceHandle("abcdefghijklmnopqrstuv");
    (element as any)._editorView = view;
    (element as any)._collaboration = collaboration;
    (element as any)._presence = handle;
    (element as any).emit = (name: string, detail: unknown) =>
      events.push([name, detail]);

    (element as any)._failPresence("protocol");

    expect((element as any)._collaboration).toBe(collaboration);
    expect(view.state.readOnly).toBe(false);
    expect(handle.leaves).toBe(1);
    expect(events).toEqual([["cf-presence-error", { category: "protocol" }]]);
  });

  it("reports a refused join once until the room or name changes", async () => {
    const unsupported = new Error("memory server does not support presence");
    unsupported.name = "ProtocolError";
    const runtime = presenceRuntime({ failJoin: unsupported });
    const events: Array<[string, unknown]> = [];
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      (element as any)._editorView = statefulView([presence.of([])]);
      (element as any)._collaboration = {
        active: true,
        cell: operationCell(runtime),
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 1, version: 0 },
          pendingChanges: [],
          field: synchronizedField,
          anchors: {},
        },
      };
      (element as any).emit = (name: string, detail: unknown) =>
        events.push([name, detail]);
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";

      (element as any)._setupPresence();
      await settle();
      (element as any)._setupPresence();
      (element as any)._setupPresence(undefined, true);
      await settle();

      expect((element as any)._collaboration.active).toBe(true);
      expect(events).toEqual([
        ["cf-presence-error", { category: "configuration" }],
      ]);
      expect(runtime.joins).toHaveLength(1);

      element.participantName = "Grace";
      (element as any)._setupPresence();
      await settle();
      expect(runtime.joins).toHaveLength(2);
    } finally {
      (element as any)._cleanupPresence();
    }
  });

  it("retries a failed room on focus and renders the records it delivers", async () => {
    const runtime = presenceRuntime();
    const events: Array<[string, unknown]> = [];
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      const view = statefulView([presence.of([])]);
      (element as any)._editorView = view;
      const synchronizationSnapshot = {
        confirmedCursor: { epoch: 2, version: 4 },
        pendingChanges: [],
        field: synchronizedField,
        anchors: {},
      };
      (element as any)._collaboration = {
        active: true,
        cell: operationCell(runtime),
        synchronizationSnapshot,
      };
      (element as any).emit = (name: string, detail: unknown) =>
        events.push([name, detail]);
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";

      (element as any)._setupPresence();
      await settle();
      const failed = runtime.handles[0];
      failed.emit({
        kind: "failure",
        error: new Error("memory session closed"),
      });
      expect(events).toEqual([
        ["cf-presence-join", undefined],
        ["cf-presence-error", { category: "connection" }],
      ]);
      expect(failed.leaves).toBe(1);

      (element as any)._handleCollaborationSynchronization(
        synchronizationSnapshot,
      );
      await settle();
      expect(runtime.joins).toHaveLength(1);

      (element as any)._handlePresenceFocus();
      await settle();
      expect(runtime.joins).toHaveLength(2);
      const handle = runtime.handles[1];
      expect((element as any)._presenceParticipantId).toBe("participant:self");
      expect(events.at(-1)).toEqual(["cf-presence-join", undefined]);

      handle.emit({ kind: "upsert", participant: caretRecord("peer:1") });
      expect(
        [...codeMirrorPresenceState(view.state)!.participants.keys()],
      ).toEqual(["peer:1"]);
      handle.emit({
        kind: "upsert",
        participant: { ...caretRecord("peer:1", 2), facets: {} },
      });
      expect(codeMirrorPresenceState(view.state)!.participants.size).toBe(0);
      handle.emit({ kind: "upsert", participant: caretRecord("peer:2") });
      handle.emit({ kind: "remove", participantId: "peer:2" });
      expect(codeMirrorPresenceState(view.state)!.participants.size).toBe(0);
      handle.emit({
        kind: "snapshot",
        participantId: "participant:self:again",
        participants: [caretRecord("peer:3")],
      });
      expect((element as any)._presenceParticipantId).toBe(
        "participant:self:again",
      );
      expect(
        [...codeMirrorPresenceState(view.state)!.participants.keys()],
      ).toEqual(["peer:3"]);
      // The editor also reports its selection on the synchronization, which
      // is no part of what presence emits.
      expect(
        events.map(([name]) => name).filter((name) =>
          name.startsWith("cf-presence-")
        ),
      ).toEqual([
        "cf-presence-join",
        "cf-presence-error",
        "cf-presence-join",
      ]);
    } finally {
      (element as any)._cleanupPresence();
    }
  });

  it("renders no remote caret from presence that arrives while the field has no confirmed cursor", async () => {
    // The room is joined at a version. The collaboration then holds a
    // snapshot with no version, as it does once the field is released, and
    // the room delivers before the editor has left it.

    const runtime = presenceRuntime();
    const element = new CFCodeEditor();
    try {
      const presence = (element as any)._presenceComp as Compartment;
      const view = statefulView([presence.of([])]);
      (element as any)._editorView = view;
      const versioned = {
        confirmedCursor: { epoch: 2, version: 4 },
        pendingChanges: [],
        field: synchronizedField,
        anchors: {},
      };
      const collaboration: {
        active: boolean;
        cell: CellHandle<string>;
        synchronizationSnapshot: {
          confirmedCursor: { epoch: number; version: number } | null;
          pendingChanges: never[];
          field: typeof synchronizedField;
          anchors: Record<string, number>;
        };
      } = {
        active: true,
        cell: operationCell(runtime),
        synchronizationSnapshot: versioned,
      };
      (element as any)._collaboration = collaboration;
      (element as any).emit = () => {};
      element.collaborative = true;
      element.participantName = "Ada";
      (element as any)._setupPresence();
      await settle();
      const handle = runtime.handles[0];
      const participants = () => [
        ...codeMirrorPresenceState(view.state)!.participants.keys(),
      ];

      collaboration.synchronizationSnapshot = {
        ...versioned,
        confirmedCursor: null,
      };
      const unchanged = view.state;
      handle.emit({ kind: "upsert", participant: caretRecord("peer:1") });
      handle.emit({
        kind: "snapshot",
        participantId: "participant:self",
        participants: [caretRecord("peer:2")],
      });
      (element as any)._applyPresenceSnapshot([caretRecord("peer:3")]);
      expect(view.state).toBe(unchanged);
      expect(participants()).toEqual([]);

      // The same deliveries at a version render their carets.
      collaboration.synchronizationSnapshot = versioned;
      handle.emit({ kind: "upsert", participant: caretRecord("peer:1") });
      expect(participants()).toEqual(["peer:1"]);
      (element as any)._applyPresenceSnapshot([caretRecord("peer:3")]);
      expect(participants()).toEqual(["peer:3"]);
    } finally {
      (element as any)._cleanupPresence();
    }
  });

  it("submits external backlink title rewrites through collaboration", async () => {
    let state = EditorState.create({
      doc: "[[Old (piece:1)]]",
      extensions: [backlinkField],
    });
    const events: Array<[string, unknown]> = [];
    let localChanges = 0;
    let reads = 0;
    const self = {
      language: "text/markdown",
      _editorView: {
        get state() {
          return state;
        },
        dispatch(spec: never) {
          state = state.update(spec).state;
        },
      },
      _collaboration: {
        active: true,
        prepareExternalChange: () => Promise.resolve(true),
        localDocChanged: () => localChanges++,
      },
      _previousBacklinkNames: new Map(),
      emit: (name: string, detail: unknown) => events.push([name, detail]),
      _updateMentionedFromContent: () => {},
      setValue: () => {
        throw new Error("ordinary value path used");
      },
    };
    const piece = {
      key: () => ({
        get: () => reads++ === 0 ? "New" : "📝 New",
      }),
    };

    await (CFCodeEditor.prototype as any)._handleExternalTitleChange.call(
      self,
      "piece:1",
      piece,
    );

    expect(state.doc.toString()).toBe("[[📝 New (piece:1)]]");
    expect(localChanges).toBe(1);
    expect(events[0][0]).toBe("cf-change");
  });

  it("submits external reference title rewrites through collaboration", async () => {
    let state = EditorState.create({
      doc: "[Old][ref-1]",
      extensions: [mentionRefField],
    });
    const events: Array<[string, unknown]> = [];
    let localChanges = 0;
    const self = {
      language: "text/markdown",
      _editorView: {
        get state() {
          return state;
        },
        dispatch(spec: never) {
          state = state.update(spec).state;
        },
      },
      _refMap: () => ({ "ref-1": { modifiedTitle: false } }),
      _documentRefs: () => [{
        key: "ref-1",
        label: "Old",
        labelFrom: 1,
        labelTo: 4,
      }],
      _collaboration: {
        active: true,
        prepareExternalChange: () => Promise.resolve(true),
        localDocChanged: () => localChanges++,
      },
      _previousRefLabels: new Map(),
      emit: (name: string, detail: unknown) => events.push([name, detail]),
      _updateMentionedFromContent: () => {},
      setValue: () => {
        throw new Error("ordinary value path used");
      },
    };

    await (CFCodeEditor.prototype as any)._handleExternalRefTitleChange.call(
      self,
      "ref-1",
      "New",
    );

    expect(state.doc.toString()).toBe("[New][ref-1]");
    expect(localChanges).toBe(1);
    expect(events[0][0]).toBe("cf-change");
  });

  it("confirms ordinary local edits before an external rewrite", async () => {
    let state = EditorState.create({
      doc: "draft [[Old (piece:1)]]",
      extensions: [backlinkField],
    });
    const firstFlush = Promise.withResolvers<void>();
    let flushes = 0;
    const collaboration = {
      active: true,
      prepareExternalChange: () => {
        flushes++;
        return firstFlush.promise.then(() => true);
      },
      localDocChanged: () => {
        flushes++;
        return Promise.resolve();
      },
    };
    const self = {
      language: "text/markdown",
      _editorView: {
        get state() {
          return state;
        },
        dispatch(spec: never) {
          state = state.update(spec).state;
        },
      },
      _collaboration: collaboration,
      _previousBacklinkNames: new Map(),
      emit: () => {},
      _updateMentionedFromContent: () => {},
      setValue: () => {
        throw new Error("ordinary value path used");
      },
    };
    const piece = {
      key: (key: string) => ({
        get: () => key === "title" ? "New" : "📝 New",
      }),
    };

    const rewriting = (CFCodeEditor.prototype as any)
      ._handleExternalTitleChange.call(self, "piece:1", piece);
    await Promise.resolve();
    expect(state.doc.toString()).toBe("draft [[Old (piece:1)]]");

    firstFlush.resolve();
    await rewriting;
    expect(state.doc.toString()).toBe("draft [[📝 New (piece:1)]]");
    expect(flushes).toBe(2);
  });

  it("reports a final send that fails while detaching", async () => {
    const events: unknown[] = [];
    const element = new CFCodeEditor();
    (element as any)._collaboration = {
      active: true,
      stop: () => Promise.reject(new Error("pending edit")),
    };
    (element as any).emit = (name: string, detail: unknown) =>
      events.push([name, detail]);
    element.collaborative = true;

    (element as any)._cleanupCollaboration();
    await Promise.resolve();
    await Promise.resolve();

    expect((element as any)._collaboration).toBeUndefined();
    expect(events).toEqual([
      ["cf-error", {
        error: new Error("pending edit"),
        message: "pending edit",
      }],
    ]);
  });

  it("detaches without releasing and explicitly releases active collaboration", async () => {
    const events: string[] = [];
    const element = new CFCodeEditor();
    (element as any)._collaboration = {
      active: true,
      stop: () => Promise.reject(new Error("ignored on disconnect")),
      release: () => {
        events.push("release");
        return Promise.resolve();
      },
    };
    element.collaborative = true;
    element.requestUpdate = () => events.push("update");

    (element as any)._cleanupCollaboration();
    await Promise.resolve();
    expect((element as any)._collaboration).toBeUndefined();

    const active = {
      active: true,
      release: () => {
        events.push("release");
        return Promise.resolve();
      },
    };
    (element as any)._collaboration = active;
    await element.releaseCollaboration();
    expect(element.collaborative).toBe(false);
    expect(events).toContain("release");
    expect(events).toContain("update");

    (element as any)._collaboration = undefined;
    await element.releaseCollaboration();
    (element as any)._cleanupCollaboration();
  });

  it("makes the editor read-only before release settles", async () => {
    const release = Promise.withResolvers<void>();
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const collaboration = (element as any)._collaborationComp as Compartment;
    const view = statefulView([
      readonly.of(EditorState.readOnly.of(false)),
      collaboration.of([]),
    ]);
    (element as any)._editorView = view;
    (element as any)._collaboration = {
      active: true,
      release: () => release.promise,
    };

    const releasing = element.releaseCollaboration();
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    release.resolve();
    await releasing;
  });

  it("restores synchronization and presence when release fails", async () => {
    const runtime = presenceRuntime();
    const element = new CFCodeEditor();
    try {
      const readonly = (element as any)._readonly as Compartment;
      const collaborationComp = (element as any)
        ._collaborationComp as Compartment;
      const presence = (element as any)._presenceComp as Compartment;
      const view = statefulView([
        readonly.of(EditorState.readOnly.of(false)),
        collaborationComp.of([]),
        presence.of([]),
      ]);
      const snapshot = {
        confirmedCursor: { epoch: 1, version: 3 },
        pendingChanges: [],
        field: synchronizedField,
        anchors: {},
      };
      let observerRegistrations = 0;
      const collaboration = {
        active: true,
        cell: operationCell(runtime),
        synchronizationSnapshot: snapshot,
        release: () => Promise.reject(new Error("release failed")),
        observeSynchronization: (
          observer: (value: typeof snapshot) => void,
        ) => {
          observerRegistrations++;
          observer(snapshot);
          return () => {};
        },
      };
      (element as any)._editorView = view;
      (element as any)._collaboration = collaboration;
      (element as any)._collaborationSyncUnsub = () => {};
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";
      (element as any)._setupPresence();
      await settle();

      let failure: unknown;
      try {
        await element.releaseCollaboration();
      } catch (error) {
        failure = error;
      }
      await settle();

      expect((failure as Error).message).toBe("release failed");
      expect(observerRegistrations).toBe(1);
      expect(runtime.joins).toHaveLength(2);
      expect(runtime.handles[0].leaves).toBe(1);
      expect((element as any)._presence).toBe(runtime.handles[1]);
      expect(view.state.facet(EditorState.readOnly)).toBe(false);
      expect((element as any)._collaboration).toBe(collaboration);
    } finally {
      (element as any)._cleanupPresence();
    }
  });

  it("clears presence before a new Memory epoch replaces the document", async () => {
    const initial: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path: operationPath,
      active: true,
      codec: CODEMIRROR_CHANGESET_CODEC,
      cursor: { epoch: 1, version: 0 },
      baselineHash: "baseline:1",
      materialized: "abc",
      anchors: {},
      operations: [],
    };
    let subscriber:
      | ((snapshot: OperationFieldSnapshot) => void)
      | undefined;
    const runtime = {
      operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
      queryOperationField: () => Promise.resolve(initial),
      subscribeOperationField: (
        _cell: CellHandle<string>,
        callback: (snapshot: OperationFieldSnapshot) => void,
      ) => {
        subscriber = callback;
        return Promise.resolve(() => {});
      },
      closeOperationSession: () => Promise.resolve(),
      ...presenceRuntime(),
    };
    const element = new CFCodeEditor();
    const collaborationComp = (element as any)
      ._collaborationComp as Compartment;
    const presenceComp = (element as any)._presenceComp as Compartment;
    let state = EditorState.create({
      doc: "abc",
      extensions: [collaborationComp.of([]), presenceComp.of([])],
    });
    let presenceInstalledAtReplacement: boolean | undefined;
    const view = {
      hasFocus: false,
      get state() {
        return state;
      },
      dispatch(...specs: readonly TransactionSpec[]) {
        const transaction = state.update(...specs);
        if (
          transaction.docChanged && transaction.newDoc.toString() === "reset"
        ) {
          presenceInstalledAtReplacement =
            codeMirrorPresenceState(state) !== undefined;
        }
        state = transaction.state;
      },
    } as unknown as EditorView;
    const controller = new CodeMirrorCollaborationController({
      runtime: runtime as never,
      cell: operationCell(runtime),
      view,
      compartment: collaborationComp,
      onError: (error) => {
        throw error;
      },
    });

    try {
      await controller.start();
      (element as any)._editorView = view;
      (element as any)._collaboration = controller;
      element.collaborative = true;
      element.presenceRoom = "abcdefghijklmnopqrstuv";
      element.participantName = "Ada";
      (element as any)._setupPresence();
      (element as any)._observeCollaboration(controller);
      expect(codeMirrorPresenceState(view.state)).toBeDefined();

      subscriber?.({
        ...initial,
        cursor: { epoch: 2, version: 0 },
        baselineHash: "baseline:2",
        materialized: "reset",
      });

      expect(presenceInstalledAtReplacement).toBe(false);
      expect(view.state.doc.toString()).toBe("reset");
      expect((element as any)._presenceEpoch).toBe(2);
    } finally {
      (element as any)._collaborationSyncUnsub?.();
      (element as any)._cleanupPresence();
      controller.dispose();
    }
  });

  it("defers a programmatic title rewrite until release settles", async () => {
    const release = Promise.withResolvers<void>();
    const element = new CFCodeEditor();
    const readonly = (element as any)._readonly as Compartment;
    const collaborationComp = (element as any)
      ._collaborationComp as Compartment;
    const view = {
      state: EditorState.create({
        doc: "[[Old (piece:1)]]",
        extensions: [
          readonly.of(EditorState.readOnly.of(false)),
          collaborationComp.of([]),
          backlinkField,
        ],
      }),
      dispatch(spec: never) {
        this.state = this.state.update(spec).state;
      },
    };
    (element as any)._editorView = view;
    (element as any)._collaboration = {
      active: true,
      release: () => release.promise,
    };
    (element as any)._updateMentionedFromContent = () => {};
    let persisted: string | undefined;
    (element as any).setValue = (value: string) => persisted = value;
    (element as any)._cellController = { flush: () => {}, getCell: () => null };
    const piece = {
      key: (key: string) => ({
        get: () => key === "title" ? "New" : "📝 New",
      }),
    };

    const releasing = element.releaseCollaboration();
    const rewriting = (element as any)._handleExternalTitleChange(
      "piece:1",
      piece,
    );
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("[[Old (piece:1)]]");

    release.resolve();
    await Promise.all([releasing, rewriting]);
    expect(view.state.doc.toString()).toBe("[[📝 New (piece:1)]]");
    expect(persisted).toBe("[[📝 New (piece:1)]]");
  });

  it("handles superseded setup and reactive collaboration lifecycle hooks", async () => {
    const element = new CFCodeEditor();
    await (element as any)._setupCollaboration();

    const dispatches: unknown[] = [];
    (element as any)._editorView = {
      dispatch: (value: unknown) => dispatches.push(value),
    };
    const previous = {
      stop: () => Promise.resolve(),
      dispose: () => {},
    };
    (element as any)._collaboration = previous;
    element.collaborative = false;
    (element as any)._updateEditorFromCellValue = () => {};
    await (element as any)._setupCollaboration();
    expect((element as any)._collaboration).toBeUndefined();

    let setup = 0;
    (element as any)._setupCollaboration = () => {
      setup++;
      return Promise.resolve();
    };
    Object.defineProperty(element, "hasUpdated", { value: true });
    element.updated(new Map([["collaborative", false]]));
    expect(setup).toBe(1);

    (element as any)._collaborationFailed = true;
    element.updated(new Map([["readonly", false]]));
    expect(dispatches.length).toBeGreaterThan(0);

    const noMentions = {
      mentioned: null,
      getValue: () => "value",
    };
    (CFCodeEditor.prototype as any)._updateMentionedFromContent.call(
      noMentions,
    );
  });
});
