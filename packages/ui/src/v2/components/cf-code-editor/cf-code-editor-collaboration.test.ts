import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  Compartment,
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  CellHandle,
  type CellRef,
  CODEMIRROR_CHANGESET_CODEC,
  type OperationFieldSnapshot,
  type PresenceEvent,
  type PresenceRecord,
  type PresenceRoomHandle,
} from "@commonfabric/runtime-client";
import { CFCodeEditor } from "./cf-code-editor.ts";
import { CodeMirrorCollaborationController } from "./codemirror-collaboration.ts";
import { codeMirrorPresenceState } from "./codemirror-presence.ts";
import { backlinkField } from "./features/backlinks.ts";
import { mentionRefField } from "./features/mention-refs.ts";

const operationPath = [] as unknown as OperationFieldSnapshot["path"];

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

const synchronizedField = {
  space: "did:key:editor-space",
  branch: "main",
  id: "of:editor-document",
  scopeKey: "space",
  path: ["value", "body"],
} as const;

describe("CFCodeEditor collaboration", () => {
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

    invoke(undefined);
    expect(calls).toEqual([
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
    expect(calls).toEqual(["mentioned", "subscriptions"]);

    calls.length = 0;
    const cellSync = (CFCodeEditor as any)._cellSyncAnnotation;
    invoke(cellSync);
    invoke(undefined, false);
    expect(calls).toEqual([]);

    invoke(undefined, false, true);
    expect(calls).toEqual(["presence"]);

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
    const previous = {
      stop: () => Promise.reject("pending edit"),
      dispose: () => events.push("disposed"),
    };
    const element = new CFCodeEditor();
    (element as any)._editorView = { dispatch: () => events.push("dispatch") };
    (element as any)._collaboration = previous;
    (element as any).emit = (_name: string, detail: unknown) =>
      events.push(detail);
    element.collaborative = true;

    await (element as any)._setupCollaboration();

    expect((element as any)._collaboration).toBeUndefined();
    expect(events).toContain("disposed");
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
      expect(events).toHaveLength(3);
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
        lastRead: () => ({ value: reads++ === 0 ? "New" : "📝 New" }),
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
        lastRead: () => ({ value: key === "title" ? "New" : "📝 New" }),
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
        lastRead: () => ({ value: key === "title" ? "New" : "📝 New" }),
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
