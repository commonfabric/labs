import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  receiveUpdates,
  sendableUpdates,
  type Update,
} from "@codemirror/collab";
import {
  ChangeSet,
  Compartment,
  EditorState,
  Text,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type {
  ApplyOpResolution,
  CellHandle,
  OperationFieldSnapshot,
  RuntimeClient,
} from "@commonfabric/runtime-client";
import {
  codeMirrorCollaboration,
  CodeMirrorCollaborationController,
  codeMirrorDedupeUpdates,
  codeMirrorIntegratedUpdates,
  CodeMirrorReconciliationError,
  codeMirrorRewriteDedupeEffect,
  codeMirrorSubmission,
  type CodeMirrorSynchronizationSnapshot,
} from "./codemirror-collaboration.ts";

const path = [] as unknown as OperationFieldSnapshot["path"];

describe("CodeMirror operation collaboration", () => {
  it("serializes local edits and rebases them over canonical operations", () => {
    const initial = EditorState.create({
      doc: "abc",
      extensions: [codeMirrorCollaboration(0, "alice")],
    });
    const local = initial.update({
      changes: { from: 1, insert: "X" },
    }).state;

    expect(codeMirrorSubmission(local)).toEqual({
      baseVersion: 0,
      payload: {
        updates: [{
          clientId: "alice",
          changes: ChangeSet.of({ from: 1, insert: "X" }, 3).toJSON(),
        }],
      },
    });

    const bob = ChangeSet.of({ from: 1, insert: "Y" }, 3);
    const remote: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 1 },
      baselineHash: "baseline",
      materialized: "aYbc",
      operations: [{
        opId: "op:bob-1",
        cursor: { epoch: 1, version: 1 },
        submissionId: "bob-1",
        payload: {
          updates: [{ clientId: "bob", changes: bob.toJSON() }],
        },
      }],
    };
    const rebased = receiveState(
      local,
      remote,
      { epoch: 1, version: 0 },
    );
    const pending = codeMirrorSubmission(rebased);
    expect(pending?.baseVersion).toBe(1);
    expect(pending?.payload.updates).toHaveLength(1);

    const accepted = ChangeSet.fromJSON(
      pending!.payload.updates[0].changes as Parameters<
        typeof ChangeSet.fromJSON
      >[0],
    );
    const materialized = accepted.apply(Text.of(["aYbc"])).toString();
    const confirmed: OperationFieldSnapshot = {
      ...remote,
      cursor: { epoch: 1, version: 2 },
      materialized,
      operations: [{
        opId: "op:alice-1",
        cursor: { epoch: 1, version: 2 },
        submissionId: "alice-1",
        payload: pending!.payload,
      }],
    };
    const final = receiveState(
      rebased,
      confirmed,
      { epoch: 1, version: 1 },
    );
    expect(final.doc.toString()).toBe(materialized);
    expect(sendableUpdates(final)).toHaveLength(0);
  });

  it("serializes deterministic rewrite dedupe metadata", () => {
    const initial = EditorState.create({
      doc: "old",
      extensions: [codeMirrorCollaboration(0, "alice")],
    });
    const local = initial.update({
      changes: { from: 0, to: 3, insert: "new" },
      effects: codeMirrorRewriteDedupeEffect.of("title:old:new"),
    }).state;

    expect(codeMirrorSubmission(local)?.payload.updates[0]).toEqual({
      clientId: "alice",
      changes: ChangeSet.of({ from: 0, to: 3, insert: "new" }, 3).toJSON(),
      dedupeId: "title:old:new",
    });
  });

  it("confirms a local rewrite integrated by another client", () => {
    const initial = EditorState.create({
      doc: "old",
      extensions: [codeMirrorCollaboration(0, "bob")],
    });
    const local = initial.update({
      changes: { from: 0, to: 3, insert: "new" },
      effects: codeMirrorRewriteDedupeEffect.of("title:old:new"),
    }).state;
    const snapshot: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "space",
      path,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 1 },
      baselineHash: "baseline:old",
      materialized: "new",
      operations: [{
        opId: "op:alice:1",
        cursor: { epoch: 1, version: 1 },
        submissionId: "alice:1",
        payload: {
          updates: [{
            clientId: "alice",
            changes: ChangeSet.of(
              { from: 0, to: 3, insert: "new" },
              3,
            ).toJSON(),
            dedupeId: "title:old:new",
          }],
        },
      }],
    };
    const updates = codeMirrorIntegratedUpdates(snapshot, {
      epoch: 1,
      version: 0,
    });
    const confirmed = receiveUpdates(
      local,
      codeMirrorDedupeUpdates(local, updates, "bob"),
    ).state;

    expect(confirmed.doc.toString()).toBe("new");
    expect(sendableUpdates(confirmed)).toEqual([]);
  });

  it("fails closed when a rewrite follows an unconfirmed ordinary edit", () => {
    const initial = EditorState.create({
      doc: "old",
      extensions: [codeMirrorCollaboration(0, "bob")],
    });
    const ordinary = initial.update({
      changes: { from: 0, insert: "draft:" },
    }).state;
    const local = ordinary.update({
      changes: { from: 6, to: 9, insert: "new" },
      effects: codeMirrorRewriteDedupeEffect.of("title:old:new"),
    }).state;
    const foreign: Update[] = [{
      clientID: "alice",
      changes: ChangeSet.of({ from: 0, to: 3, insert: "new" }, 3),
      effects: [codeMirrorRewriteDedupeEffect.of("title:old:new")],
    }];

    expect(() => codeMirrorDedupeUpdates(local, foreign, "bob")).toThrow(
      "followed an unconfirmed local edit",
    );
  });

  it("rejects a non-contiguous operation suffix", () => {
    const snapshot: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 2 },
      baselineHash: "baseline",
      materialized: "abc",
      operations: [],
    };
    expect(() =>
      codeMirrorIntegratedUpdates(snapshot, { epoch: 1, version: 0 })
    ).toThrow("history ends at 0");
  });

  it("requires canonical reinstallation for a retention reset", () => {
    const snapshot: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 10 },
      retainedFrom: { epoch: 1, version: 8 },
      reset: true,
      baselineHash: "baseline",
      materialized: "canonical",
      operations: [],
    };

    expect(() =>
      codeMirrorIntegratedUpdates(snapshot, { epoch: 1, version: 7 })
    ).toThrow("requires a reset");
  });

  it("ignores an already integrated operation prefix", () => {
    const snapshot: OperationFieldSnapshot = {
      branch: "",
      id: "of:editor",
      scopeKey: "",
      path,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 1 },
      baselineHash: "baseline",
      materialized: "abc",
      operations: [{
        opId: "op:already-integrated",
        cursor: { epoch: 1, version: 1 },
        submissionId: "alice-1",
        payload: { updates: [] },
      }],
    };

    expect(
      codeMirrorIntegratedUpdates(snapshot, { epoch: 1, version: 1 }),
    ).toEqual([]);
  });

  it("ignores the unchanged inactive baseline while activation is in flight", async () => {
    const initial = inactiveSnapshot("abc");
    const accepted = acceptedResolution("abc", 1, "X");
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const { controller, view, errors } = controllerHarness({
      initial,
      followup: activeSnapshot("aXbc", accepted),
      subscribe(callback) {
        subscriber = callback;
      },
      apply() {
        subscriber?.(initial);
        return accepted;
      },
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe("aXbc");
    expect(sendableUpdates(view.state)).toHaveLength(0);
  });

  it("confirms the apply response before a released follow-up snapshot", async () => {
    const accepted = acceptedResolution("abc", 1, "X");
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("aXbc"),
      apply: () => accepted,
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe("aXbc");
    expect(sendableUpdates(view.state)).toHaveLength(0);
  });

  it("flushes pending edits before stopping collaboration", async () => {
    const accepted = acceptedResolution("abc", 1, "X");
    const applied = Promise.withResolvers<ApplyOpResolution>();
    let cancellations = 0;
    const { controller, view } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: activeSnapshot("aXbc", accepted),
      apply: () => applied.promise,
      cancel: () => cancellations++,
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    const sending = controller.localDocChanged();
    await Promise.resolve();
    const stopped = controller.stop();
    let settled = false;
    void stopped.finally(() => settled = true);
    await Promise.resolve();
    expect(settled).toBe(false);

    applied.resolve(accepted);
    await Promise.all([sending, stopped]);
    expect(sendableUpdates(view.state)).toHaveLength(0);
    expect(cancellations).toBe(1);
  });

  it("cancels superseded setup before collaboration state is installed", async () => {
    let subscriptions = 0;
    let closes = 0;
    const { controller } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: () => subscriptions++,
      close: () => closes++,
    });

    const starting = controller.start();
    await controller.stop();
    await starting;

    expect(controller.active).toBe(false);
    expect(subscriptions).toBe(0);
    expect(closes).toBeGreaterThanOrEqual(1);
  });

  it("unsubscribes when a remote snapshot fails", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    let cancellations = 0;
    const { controller, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: (callback) => subscriber = callback,
      cancel: () => cancellations++,
    });

    await controller.start();
    subscriber?.({ ...inactiveSnapshot("abc"), materialized: 42 });

    expect(errors).toHaveLength(1);
    expect(cancellations).toBe(1);
  });

  it("reports both sides of a reconciliation error", () => {
    const error = new CodeMirrorReconciliationError(
      "local",
      "canonical",
      { epoch: 1, version: 2 },
      { epoch: 2, version: 0 },
    );

    expect(error.name).toBe("CodeMirrorReconciliationError");
    expect(error.message).toContain("local edits pending");
    expect(error.localValue).toBe("local");
    expect(error.canonicalValue).toBe("canonical");
    expect(error.localCursor).toEqual({ epoch: 1, version: 2 });
    expect(error.canonicalCursor).toEqual({ epoch: 2, version: 0 });
  });

  it("rejects malformed and incompatible operation snapshots", () => {
    const snapshot = activeSnapshot("abc", {
      ...acceptedResolution("abc", 1, ""),
      operations: [],
    });
    snapshot.cursor = { epoch: 1, version: 1 };

    expect(() =>
      codeMirrorIntegratedUpdates(
        { ...snapshot, active: false, cursor: null },
        { epoch: 1, version: 0 },
      )
    ).toThrow("inactive operation field");
    expect(() =>
      codeMirrorIntegratedUpdates(
        { ...snapshot, codec: "other@1" },
        { epoch: 1, version: 0 },
      )
    ).toThrow("expected codemirror-changeset@1");
    expect(() =>
      codeMirrorIntegratedUpdates(snapshot, { epoch: 2, version: 0 })
    ).toThrow("epoch changed");
    expect(
      codeMirrorIntegratedUpdates(snapshot, { epoch: 1, version: 2 }),
    ).toEqual([]);

    const operation = {
      opId: "op:bad",
      cursor: { epoch: 1, version: 1 },
      submissionId: "bad:1",
      payload: null,
    };
    expect(() =>
      codeMirrorIntegratedUpdates(
        { ...snapshot, operations: [operation] },
        { epoch: 1, version: 0 },
      )
    ).toThrow("requires an updates array");
    expect(() =>
      codeMirrorIntegratedUpdates(
        {
          ...snapshot,
          operations: [{
            ...operation,
            payload: { updates: [{ changes: [] }] },
          }],
        },
        { epoch: 1, version: 0 },
      )
    ).toThrow("requires a clientId");
    expect(() =>
      codeMirrorIntegratedUpdates(
        {
          ...snapshot,
          cursor: { epoch: 1, version: 2 },
          operations: [{
            ...operation,
            cursor: { epoch: 1, version: 2 },
            payload: { updates: [] },
          }],
        },
        { epoch: 1, version: 0 },
      )
    ).toThrow("gap before version 2");
  });

  it("rejects startup when the codec or snapshot cannot be installed", async () => {
    const missingCodec = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      codecs: [],
    });
    await expect(missingCodec.controller.start()).rejects.toThrow(
      "does not advertise",
    );

    const nonString = controllerHarness({
      initial: { ...inactiveSnapshot("abc"), materialized: 42 },
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
    });
    await expect(nonString.controller.start()).rejects.toThrow(
      "requires a string field",
    );

    const wrongCodec = controllerHarness({
      initial: {
        ...activeSnapshot("abc", acceptedResolution("abc", 1, "")),
        codec: "other@1",
      },
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
    });
    await expect(wrongCodec.controller.start()).rejects.toThrow(
      "cannot open operation codec",
    );
  });

  it("cancels a subscription that resolves after disposal", async () => {
    const subscribed = Promise.withResolvers<void>();
    const subscription = Promise.withResolvers<() => void>();
    let cancellations = 0;
    const { controller } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: () => subscribed.resolve(),
      subscription: subscription.promise,
    });

    const starting = controller.start();
    await subscribed.promise;
    controller.dispose();
    controller.dispose();
    subscription.resolve(() => cancellations++);
    await starting;

    expect(cancellations).toBe(1);
    await controller.localDocChanged();
    await controller.stop();
  });

  it("updates an inactive baseline and fails on divergent pending edits", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    let cancellations = 0;
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: (callback) => subscriber = callback,
      cancel: () => cancellations++,
    });

    await controller.start();
    subscriber?.(inactiveSnapshot("canonical"));
    expect(view.state.doc.toString()).toBe("canonical");

    view.dispatch({ changes: { from: 0, insert: "local:" } });
    subscriber?.(inactiveSnapshot("other"));
    expect(errors[0]).toBeInstanceOf(CodeMirrorReconciliationError);
    expect(cancellations).toBe(1);
    subscriber?.(inactiveSnapshot("ignored"));
    expect(errors).toHaveLength(1);
  });

  it("reconciles active-to-inactive and epoch changes with pending edits", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const accepted = acceptedResolution("abc", 1, "X");
    const initial = activeSnapshot("aXbc", accepted);
    const first = controllerHarness({
      initial,
      followup: initial,
      apply: () => accepted,
      subscribe: (callback) => subscriber = callback,
    });
    await first.controller.start();
    first.view.dispatch({ changes: { from: 0, insert: "local:" } });
    subscriber?.(inactiveSnapshot("canonical"));
    expect(first.errors[0]).toBeInstanceOf(CodeMirrorReconciliationError);

    const second = controllerHarness({
      initial,
      followup: initial,
      apply: () => accepted,
      subscribe: (callback) => subscriber = callback,
    });
    await second.controller.start();
    second.view.dispatch({ changes: { from: 0, insert: "local:" } });
    subscriber?.({
      ...initial,
      cursor: { epoch: 2, version: 0 },
      materialized: "canonical",
      operations: [],
    });
    expect(second.errors[0]).toBeInstanceOf(CodeMirrorReconciliationError);
  });

  it("adopts the first active cursor delivered to an inactive controller", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const { controller, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: (callback) => subscriber = callback,
    });
    await controller.start();
    const observed: Array<CodeMirrorSynchronizationSnapshot | null> = [];
    controller.observeSynchronization((snapshot) => observed.push(snapshot));
    subscriber?.({
      ...inactiveSnapshot("abc"),
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 0 },
    });

    expect(errors).toEqual([]);
    expect(controller.active).toBe(true);
    expect(observed).toEqual([
      null,
      {
        confirmedCursor: { epoch: 1, version: 0 },
        pendingChanges: [],
        field: {
          space: "did:key:test-space",
          branch: "",
          id: "of:editor",
          scopeKey: "space",
          path: [],
        },
      },
    ]);
  });

  it("starts a clean operation baseline after an inactive ordinary replacement", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const accepted = acceptedResolution(
      "random string",
      "random string".length,
      "!",
    );
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("legacy string"),
      followup: activeSnapshot("random string!", accepted),
      apply: () => accepted,
      subscribe: (callback) => subscriber = callback,
    });
    await controller.start();

    subscriber?.(inactiveSnapshot("random string"));
    expect(view.state.doc.toString()).toBe("random string");
    expect(sendableUpdates(view.state)).toEqual([]);

    view.dispatch({
      changes: {
        from: "random string".length,
        insert: "!",
      },
    });
    await controller.localDocChanged();

    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe("random string!");
    expect(sendableUpdates(view.state)).toEqual([]);
  });

  it("rejects operation-field identity drift within a pinned session", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const initial = activeSnapshot(
      "abc",
      acceptedResolution("abc", 1, ""),
    );
    const { controller, errors } = controllerHarness({
      initial,
      followup: initial,
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: (callback) => subscriber = callback,
    });
    await controller.start();

    subscriber?.({ ...initial, scopeKey: "user:another-participant" });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("field identity changed");
    expect(controller.active).toBe(false);
  });

  it("reinstalls reset and epoch snapshots only without pending edits", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const initialResolution = acceptedResolution("abc", 1, "X");
    const initial = activeSnapshot("aXbc", initialResolution);
    const { controller, view, errors } = controllerHarness({
      initial,
      followup: initial,
      apply: () => initialResolution,
      subscribe: (callback) => subscriber = callback,
    });

    await controller.start();
    subscriber?.({
      ...initial,
      reset: true,
      cursor: { epoch: 1, version: 2 },
      materialized: "reset",
    });
    expect(view.state.doc.toString()).toBe("reset");

    subscriber?.({
      ...initial,
      cursor: { epoch: 2, version: 0 },
      materialized: "epoch-two",
      operations: [],
    });
    expect(view.state.doc.toString()).toBe("epoch-two");

    view.dispatch({ changes: { from: 0, insert: "local:" } });
    subscriber?.({
      ...initial,
      reset: true,
      cursor: { epoch: 2, version: 1 },
      materialized: "canonical",
    });
    expect(errors[0]).toBeInstanceOf(CodeMirrorReconciliationError);
  });

  it("receives integrated updates and detects a materialization mismatch", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const initial = {
      ...inactiveSnapshot("abc"),
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 0 },
    };
    const { controller, view, errors } = controllerHarness({
      initial,
      followup: initial,
      apply: () => acceptedResolution("abc", 1, "X"),
      subscribe: (callback) => subscriber = callback,
    });

    await controller.start();
    const accepted = acceptedResolution("abc", 1, "X");
    subscriber?.({
      ...activeSnapshot("aXbc", accepted),
      operations: accepted.operations,
    });
    expect(view.state.doc.toString()).toBe("aXbc");
    const next = acceptedResolutionAt("aXbc", 1, 2, "Y", "bob:2");
    subscriber?.({
      ...activeSnapshot("wrong", next),
      operations: next.operations,
    });
    expect(errors[0]?.message).toContain("do not reproduce");
  });

  it("fails closed when an apply rejects and refuses to drop pending edits", async () => {
    let cancellations = 0;
    let closes = 0;
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => Promise.reject("apply failed"),
      cancel: () => cancellations++,
      close: () => closes++,
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(errors[0]?.message).toBe("apply failed");
    expect(cancellations).toBe(1);
    await expect(controller.stop()).rejects.toThrow("local edits pending");
    expect(closes).toBe(1);
    expect(controller.active).toBe(false);
  });

  it("fails closed when an apply response advertises another codec", async () => {
    let cancellations = 0;
    const resolution = {
      ...acceptedResolution("abc", 1, "X"),
      codec: "other@1",
    };
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => resolution,
      cancel: () => cancellations++,
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(errors[0]?.message).toContain("received operation codec other@1");
    expect(cancellations).toBe(1);
  });

  it("releases an active controller whose field has no cursor", async () => {
    let releases = 0;
    let cancellations = 0;
    let closes = 0;
    const { controller } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: inactiveSnapshot("abc"),
      apply: () => acceptedResolution("abc", 1, "X"),
      cancel: () => cancellations++,
      close: () => closes++,
      release: () => {
        releases++;
      },
    });

    await controller.start();
    await controller.release();

    expect(releases).toBe(0);
    expect(cancellations).toBe(1);
    expect(closes).toBe(1);
    expect(controller.active).toBe(false);
  });

  it("releases an active field and accepts its inactive notification", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    let releases = 0;
    let cancellations = 0;
    const accepted = acceptedResolution("abc", 1, "X");
    const initial = activeSnapshot("aXbc", accepted);
    const { controller } = controllerHarness({
      initial,
      followup: initial,
      apply: () => accepted,
      subscribe: (callback) => subscriber = callback,
      cancel: () => cancellations++,
      release: () => {
        releases++;
        subscriber?.(inactiveSnapshot("aXbc"));
      },
    });

    await controller.start();
    await controller.release();

    expect(releases).toBe(1);
    expect(cancellations).toBe(1);
    expect(controller.active).toBe(false);
    await expect(controller.release()).rejects.toThrow("is not active");
  });

  it("stops accepting local edits before an active field release settles", async () => {
    const releasing = Promise.withResolvers<void>();
    const releaseStarted = Promise.withResolvers<void>();
    const accepted = acceptedResolution("abc", 1, "X");
    const initial = activeSnapshot("aXbc", accepted);
    const { controller } = controllerHarness({
      initial,
      followup: initial,
      apply: () => accepted,
      release: () => {
        releaseStarted.resolve();
        return releasing.promise;
      },
    });

    await controller.start();
    const released = controller.release();
    await releaseStarted.promise;
    expect(controller.active).toBe(false);
    releasing.resolve();
    await released;
  });

  it("ignores a same-epoch query older than an installed watch update", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const first = acceptedResolution("abc", 1, "X");
    const second = acceptedResolutionAt("aXbc", 1, 2, "Y", "bob:2");
    const firstSnapshot = activeSnapshot("aXbc", first);
    const secondSnapshot = {
      ...activeSnapshot("aXYbc", second),
      operations: second.operations,
    };
    const { controller, view, errors } = controllerHarness({
      initial: firstSnapshot,
      followup: firstSnapshot,
      apply: () => second,
      subscribe: (callback) => subscriber = callback,
    });

    await controller.start();
    subscriber?.(secondSnapshot);
    subscriber?.(firstSnapshot);

    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe("aXYbc");
    expect(controller.active).toBe(true);
  });

  it("rejects a divergent snapshot at the current cursor", async () => {
    let subscriber: ((snapshot: OperationFieldSnapshot) => void) | undefined;
    const accepted = acceptedResolution("abc", 1, "X");
    const initial = activeSnapshot("aXbc", accepted);
    const { controller, errors } = controllerHarness({
      initial,
      followup: initial,
      apply: () => accepted,
      subscribe: (callback) => subscriber = callback,
    });

    await controller.start();
    subscriber?.({ ...initial, materialized: "different" });

    expect(errors[0]?.message).toContain("disagrees at the current");
    expect(controller.active).toBe(false);
  });

  it("prepares an external rewrite by flushing every pending edit", async () => {
    const first = Promise.withResolvers<ApplyOpResolution>();
    const second = Promise.withResolvers<ApplyOpResolution>();
    const firstCalled = Promise.withResolvers<void>();
    const secondCalled = Promise.withResolvers<void>();
    let applyCount = 0;
    const firstResolution = acceptedResolution("abc", 1, "X");
    const secondResolution = acceptedResolutionAt(
      "aXbc",
      1,
      2,
      "Y",
      "alice:2",
    );
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followups: [
        activeSnapshot("aXbc", firstResolution),
        activeSnapshot("aXYbc", secondResolution),
      ],
      apply: () => {
        applyCount++;
        if (applyCount === 1) {
          firstCalled.resolve();
          return first.promise;
        }
        secondCalled.resolve();
        return second.promise;
      },
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    const sending = controller.localDocChanged();
    await firstCalled.promise;
    view.dispatch({ changes: { from: 2, insert: "Y" } });
    const prepared = controller.prepareExternalChange();
    first.resolve(firstResolution);
    await secondCalled.promise;
    second.resolve(secondResolution);
    expect(await prepared).toBe(true);
    await sending;

    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe("aXYbc");
    expect(sendableUpdates(view.state)).toHaveLength(0);
    await controller.stop();
  });

  it("submits edits recorded during an in-flight submission in the next one", async () => {
    // Only `localDocChanged()` drives the controller here. `stop()` and
    // `prepareExternalChange()` ask for a complete drain themselves; what this
    // pins is that ordinary typing during a round trip gets one too.

    const first = Promise.withResolvers<void>();
    const firstCaptured = Promise.withResolvers<void>();
    const applies: ApplyRequest[] = [];
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followups: [
        activeSnapshotAt("abc1", 1),
        activeSnapshotAt("abc1234567", 7),
      ],
      apply: async (request) => {
        applies.push(request);
        if (applies.length === 1) {
          firstCaptured.resolve();
          await first.promise;
        }
        return resolutionFor(request);
      },
    });

    await controller.start();
    view.dispatch({ changes: { from: 3, insert: "1" } });
    const sends = [controller.localDocChanged()];
    await firstCaptured.promise;
    for (const character of "234567") {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: character },
      });
      sends.push(controller.localDocChanged());
    }
    first.resolve();
    await Promise.all(sends);

    expect(errors).toEqual([]);
    expect(
      applies.map((request) => [
        request.base?.version ?? null,
        (request.payload as { updates: unknown[] }).updates.length,
      ]),
    ).toEqual([[null, 1], [1, 6]]);
    expect(view.state.doc.toString()).toBe("abc1234567");
    expect(sendableUpdates(view.state)).toHaveLength(0);
    await controller.stop();
  });

  it("stops only after submitting edits recorded during its own submissions", async () => {
    // A closing controller refuses `localDocChanged()`, so an edit recorded
    // while one of its submissions is in flight has no caller of its own.
    // `stop()` carries it in the next round trip rather than failing.

    const gates = [0, 1, 2].map(() => Promise.withResolvers<void>());
    const captured = [0, 1, 2].map(() => Promise.withResolvers<void>());
    const applies: ApplyRequest[] = [];
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followups: [
        activeSnapshotAt("abcX", 1),
        activeSnapshotAt("abcXY", 2),
        activeSnapshotAt("abcXYZ", 3),
      ],
      apply: async (request) => {
        const index = applies.length;
        applies.push(request);
        captured[index].resolve();
        await gates[index].promise;
        return resolutionFor(request);
      },
    });

    await controller.start();
    view.dispatch({ changes: { from: 3, insert: "X" } });
    const sending = controller.localDocChanged();
    await captured[0].promise;
    const stopped = controller.stop();
    view.dispatch({ changes: { from: 4, insert: "Y" } });
    gates[0].resolve();
    await captured[1].promise;
    view.dispatch({ changes: { from: 5, insert: "Z" } });
    gates[1].resolve();
    // A stop that gives up on the pending edit rejects here instead.
    await Promise.race([captured[2].promise, stopped]);
    gates[2].resolve();
    await Promise.all([sending, stopped]);

    expect(errors).toEqual([]);
    expect(
      applies.map((request) => [
        request.base?.version ?? null,
        (request.payload as { updates: unknown[] }).updates.length,
      ]),
    ).toEqual([[null, 1], [1, 1], [2, 1]]);
    expect(view.state.doc.toString()).toBe("abcXYZ");
    expect(sendableUpdates(view.state)).toHaveLength(0);
  });

  it("rebases edits recorded during a round trip over an operation that intervened", async () => {
    // Bob's insertion at the start of the document lands at Memory between
    // alice's two round trips, so her second submission is integrated after
    // it and comes back rebased.

    const first = Promise.withResolvers<void>();
    const firstCaptured = Promise.withResolvers<void>();
    const applies: ApplyRequest[] = [];
    const bob = {
      opId: "op:bob:1",
      cursor: { epoch: 1, version: 2 },
      submissionId: "bob:1",
      payload: {
        updates: [{
          clientId: "bob",
          changes: ChangeSet.of({ from: 0, insert: "b" }, 4).toJSON(),
        }],
      } as ApplyOpResolution["operations"][number]["payload"],
    };
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followups: [
        activeSnapshotAt("abcX", 1),
        activeSnapshotAt("babcXY", 3),
      ],
      apply: async (request) => {
        applies.push(request);
        if (applies.length === 1) {
          firstCaptured.resolve();
          await first.promise;
          return resolutionFor(request);
        }
        const own = resolutionFor({
          ...request,
          base: { epoch: 1, version: 2 },
        });
        return {
          ...own,
          from: { epoch: 1, version: 1 },
          operations: [bob, ...own.operations],
        };
      },
    });

    await controller.start();
    view.dispatch({ changes: { from: 3, insert: "X" } });
    const sends = [controller.localDocChanged()];
    await firstCaptured.promise;
    view.dispatch({ changes: { from: 4, insert: "Y" } });
    sends.push(controller.localDocChanged());
    first.resolve();
    await Promise.all(sends);

    expect(errors).toEqual([]);
    expect(applies[1]?.base).toEqual({ epoch: 1, version: 1 });
    expect(view.state.doc.toString()).toBe("babcXY");
    expect(sendableUpdates(view.state)).toHaveLength(0);
    expect(controller.synchronizationSnapshot?.confirmedCursor).toEqual({
      epoch: 1,
      version: 3,
    });
    await controller.stop();
  });

  it("fails closed when a round trip confirms none of the submitted edits", async () => {
    // Memory answers the first submission without integrating it. A
    // controller that resubmits instead of failing reaches the second apply,
    // which the harness refuses.

    let applyCount = 0;
    let cancellations = 0;
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: activeSnapshotAt("abc", 0),
      apply: (request) => {
        applyCount++;
        if (applyCount > 1) throw new Error("resubmitted an unconfirmed edit");
        return {
          ...resolutionFor(request),
          to: { epoch: 1, version: 0 },
          operations: [],
        };
      },
      cancel: () => cancellations++,
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(applyCount).toBe(1);
    expect(errors.map((error) => error.message)).toEqual([
      "CodeMirror submission confirmed no local update",
    ]);
    expect(cancellations).toBe(1);
    expect(view.state.doc.toString()).toBe("aXbc");
    expect(sendableUpdates(view.state)).toHaveLength(1);
  });

  it("submits an edit recorded at any microtask offset from a drain's last confirmation", async () => {
    // The drain re-reads its queue after each round trip, and `#flush` clears
    // the in-flight promise a few microtasks later. An edit recorded in
    // between belongs to neither the finished drain nor a new one unless the
    // caller re-reads the queue after waiting. Each offset from the
    // confirmation is one candidate for that window.

    for (let offset = 0; offset < 6; offset++) {
      const applies: ApplyRequest[] = [];
      const { controller, view, errors } = controllerHarness({
        initial: inactiveSnapshot("abc"),
        followups: [
          activeSnapshotAt("abcX", 1),
          activeSnapshotAt("abcXY", 2),
        ],
        apply: (request) => {
          applies.push(request);
          return resolutionFor(request);
        },
      });
      await controller.start();
      let late: Promise<void> | undefined;
      controller.observeSynchronization((snapshot) => {
        if (late !== undefined || snapshot?.confirmedCursor.version !== 1) {
          return;
        }
        late = Promise.resolve().then(async () => {
          for (let hop = 0; hop < offset; hop++) await Promise.resolve();
          view.dispatch({ changes: { from: 4, insert: "Y" } });
          await controller.localDocChanged();
        });
      });
      view.dispatch({ changes: { from: 3, insert: "X" } });
      await controller.localDocChanged();
      await late;

      expect(errors).toEqual([]);
      expect(applies).toHaveLength(2);
      expect(view.state.doc.toString()).toBe("abcXY");
      expect(sendableUpdates(view.state)).toHaveLength(0);
      await controller.stop();
    }
  });

  it("submits an edit once when several waiters wake from the same drain", async () => {
    // Waiters woken by one drain's end each re-read the queue. Only the first
    // may own the next drain; the others must see that drain in flight and
    // wait again, or the same update goes out under two submission ids.

    for (let offset = 0; offset < 6; offset++) {
      const applies: ApplyRequest[] = [];
      const { controller, view, errors } = controllerHarness({
        initial: inactiveSnapshot("abc"),
        followups: [
          activeSnapshotAt("abcX", 1),
          activeSnapshotAt("abcXY", 2),
        ],
        apply: (request) => {
          applies.push(request);
          return resolutionFor(request);
        },
      });
      await controller.start();
      let late: Promise<void> | undefined;
      controller.observeSynchronization((snapshot) => {
        if (late !== undefined || snapshot?.confirmedCursor.version !== 1) {
          return;
        }
        late = Promise.resolve().then(async () => {
          for (let hop = 0; hop < offset; hop++) await Promise.resolve();
          view.dispatch({ changes: { from: 4, insert: "Y" } });
        });
      });
      view.dispatch({ changes: { from: 3, insert: "X" } });
      const sends = [
        controller.localDocChanged(),
        controller.localDocChanged(),
        controller.localDocChanged(),
      ];
      await Promise.all(sends);
      await late;
      await controller.localDocChanged();

      expect(errors).toEqual([]);
      const submitted = applies.flatMap((request) =>
        (request.payload as { updates: unknown[] }).updates
      );
      expect(submitted).toHaveLength(2);
      expect(view.state.doc.toString()).toBe("abcXY");
      expect(sendableUpdates(view.state)).toHaveLength(0);
      await controller.stop();
    }
  });

  it("confirms a rewrite Memory suppressed as a duplicate through the intervening operation", async () => {
    // Bob integrated the same rewrite first, so Memory accepts alice's
    // submission with no operations of its own; the follow-up query carries
    // bob's, and its dedupe id confirms alice's queue head.

    const applies: ApplyRequest[] = [];
    const bobRewrite = {
      opId: "op:bob:2",
      cursor: { epoch: 1, version: 2 },
      submissionId: "bob:2",
      payload: {
        updates: [{
          clientId: "bob",
          changes: ChangeSet.of({ from: 0, to: 3, insert: "new" }, 3).toJSON(),
          dedupeId: "title:old:new",
        }],
      } as ApplyOpResolution["operations"][number]["payload"],
    };
    const { controller, view, errors } = controllerHarness({
      initial: activeSnapshotAt("old", 1),
      followup: { ...activeSnapshotAt("new", 2), operations: [bobRewrite] },
      apply: (request) => {
        applies.push(request);
        return {
          ...resolutionFor(request),
          from: { epoch: 1, version: 2 },
          to: { epoch: 1, version: 2 },
          operations: [],
        };
      },
    });

    await controller.start();
    view.dispatch({
      changes: { from: 0, to: 3, insert: "new" },
      effects: codeMirrorRewriteDedupeEffect.of("title:old:new"),
    });
    await controller.localDocChanged();

    expect(errors).toEqual([]);
    expect(applies).toHaveLength(1);
    expect(view.state.doc.toString()).toBe("new");
    expect(sendableUpdates(view.state)).toHaveLength(0);
    expect(controller.synchronizationSnapshot?.confirmedCursor).toEqual({
      epoch: 1,
      version: 2,
    });
  });

  it("leaves the editor alone once disposed during a round trip", async () => {
    // A superseding controller reinstalls the shared compartment, so a
    // resolution arriving for the disposed one must not be dispatched.

    const applied = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<void>();
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: activeSnapshotAt("aXbc", 1),
      apply: async (request) => {
        captured.resolve();
        await applied.promise;
        return resolutionFor(request);
      },
    });

    await controller.start();
    view.dispatch({ changes: { from: 1, insert: "X" } });
    const sending = controller.localDocChanged();
    await captured.promise;
    controller.dispose();
    const untouched = view.state;
    applied.resolve();
    await sending;

    expect(errors).toEqual([]);
    expect(view.state).toBe(untouched);
  });

  it("isolates synchronization observers from the Memory operation path", async () => {
    const accepted = acceptedResolution("abc", 1, "X");
    const { controller, view, errors } = controllerHarness({
      initial: inactiveSnapshot("abc"),
      followup: activeSnapshot("aXbc", accepted),
      apply: () => accepted,
    });

    await controller.start();
    controller.observeSynchronization(() => {
      throw new Error("presence failed");
    });
    view.dispatch({ changes: { from: 1, insert: "X" } });
    await controller.localDocChanged();

    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe("aXbc");
    expect(sendableUpdates(view.state)).toHaveLength(0);
  });
});

function inactiveSnapshot(materialized: string): OperationFieldSnapshot {
  return {
    branch: "",
    id: "of:editor",
    scopeKey: "space",
    path,
    active: false,
    codec: null,
    cursor: null,
    baselineHash: `baseline:${materialized}`,
    materialized,
    operations: [],
  };
}

function acceptedResolution(
  document: string,
  from: number,
  insert: string,
): ApplyOpResolution {
  const payload = {
    updates: [{
      clientId: "alice",
      changes: ChangeSet.of({ from, insert }, document.length).toJSON(),
    }],
  };
  return {
    operationIndex: 0,
    address: {
      branch: "",
      id: "of:editor",
      scopeKey: "space",
      path,
    },
    codec: "codemirror-changeset@1",
    submissionId: "alice:1",
    from: { epoch: 1, version: 0 },
    to: { epoch: 1, version: 1 },
    operations: [{
      opId: "op:alice-1",
      cursor: { epoch: 1, version: 1 },
      submissionId: "alice:1",
      payload,
    }],
    duplicate: false,
  };
}

function acceptedResolutionAt(
  document: string,
  fromVersion: number,
  from: number,
  insert: string,
  submissionId: string,
): ApplyOpResolution {
  const resolution = acceptedResolution(document, from, insert);
  return {
    ...resolution,
    submissionId,
    from: { epoch: 1, version: fromVersion },
    to: { epoch: 1, version: fromVersion + 1 },
    operations: resolution.operations.map((operation) => ({
      ...operation,
      opId: `op:${submissionId}`,
      cursor: { epoch: 1, version: fromVersion + 1 },
      submissionId,
    })),
  };
}

function activeSnapshot(
  materialized: string,
  resolution: ApplyOpResolution,
): OperationFieldSnapshot {
  return {
    ...resolution.address,
    active: true,
    codec: resolution.codec,
    cursor: resolution.to,
    baselineHash: "baseline:abc",
    materialized,
    operations: [],
  };
}

type ApplyRequest = Parameters<RuntimeClient["applyOperation"]>[1];

function activeSnapshotAt(
  materialized: string,
  version: number,
): OperationFieldSnapshot {
  return {
    branch: "",
    id: "of:editor",
    scopeKey: "space",
    path,
    active: true,
    codec: "codemirror-changeset@1",
    cursor: { epoch: 1, version },
    baselineHash: "baseline:abc",
    materialized,
    operations: [],
  };
}

/**
 * Resolves `request` the way Memory's changeset codec does with nothing
 * intervening: every submitted update becomes one integrated operation at the
 * next version.
 */
function resolutionFor(request: ApplyRequest): ApplyOpResolution {
  const from = request.base ?? { epoch: 1, version: 0 };
  const updates = (request.payload as { updates: unknown[] }).updates;
  const operations = updates.map((update, index) => ({
    opId: `op:${request.submissionId}:${index}`,
    cursor: { epoch: from.epoch, version: from.version + index + 1 },
    submissionId: request.submissionId,
    payload: { updates: [update] } as ApplyOpResolution["operations"][number][
      "payload"
    ],
  }));
  return {
    operationIndex: 0,
    address: { branch: "", id: "of:editor", scopeKey: "space", path },
    codec: "codemirror-changeset@1",
    submissionId: request.submissionId,
    from,
    to: { epoch: from.epoch, version: from.version + updates.length },
    operations,
    duplicate: false,
  };
}

function controllerHarness(options: {
  initial: OperationFieldSnapshot;
  followup?: OperationFieldSnapshot;
  followups?: OperationFieldSnapshot[];
  apply: (
    request: ApplyRequest,
  ) => ApplyOpResolution | Promise<ApplyOpResolution>;
  codecs?: string[];
  subscribe?: (callback: (snapshot: OperationFieldSnapshot) => void) => void;
  subscription?: Promise<() => void>;
  cancel?: () => void;
  release?: () => void | Promise<void>;
  close?: () => void;
}) {
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: typeof options.initial.materialized === "string"
      ? options.initial.materialized
      : "",
    extensions: [compartment.of([])],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(...specs: readonly TransactionSpec[]) {
      state = state.update(...specs).state;
    },
  } as unknown as EditorView;
  let queryCount = 0;
  const followups = options.followups ?? [options.followup ?? options.initial];
  const runtime = {
    operationCodecs: () =>
      Promise.resolve(options.codecs ?? ["codemirror-changeset@1"]),
    queryOperationField: () =>
      Promise.resolve(
        queryCount++ === 0
          ? options.initial
          : followups[Math.min(queryCount - 2, followups.length - 1)],
      ),
    subscribeOperationField: (
      _cell: CellHandle<string>,
      callback: (snapshot: OperationFieldSnapshot) => void,
    ) => {
      options.subscribe?.(callback);
      return options.subscription ??
        Promise.resolve(() => options.cancel?.());
    },
    applyOperation: (_cell: CellHandle<string>, request: ApplyRequest) =>
      Promise.resolve(options.apply(request)),
    releaseOperationField: () => Promise.resolve(options.release?.()),
    closeOperationSession: () => {
      options.close?.();
      return Promise.resolve();
    },
  } as unknown as RuntimeClient;
  const errors: Error[] = [];
  const cell = {
    space: () => "did:key:test-space",
  } as unknown as CellHandle<string>;
  const controller = new CodeMirrorCollaborationController({
    runtime,
    cell,
    view,
    compartment,
    clientId: "alice",
    onError: (error) => errors.push(error),
  });
  return { controller, view, errors };
}

function receiveState(
  state: EditorState,
  snapshot: OperationFieldSnapshot,
  cursor: { epoch: number; version: number },
): EditorState {
  const updates = codeMirrorIntegratedUpdates(snapshot, cursor);
  return receiveUpdates(state, updates).state;
}
