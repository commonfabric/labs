/** Exercises mounted editor handoffs with independently delivered Cell reads. */

import { expect } from "@std/expect";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type ApplyOpResolution,
  CODEMIRROR_CHANGESET_CODEC,
  type OperationFieldSnapshot,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFCodeEditor } from "./index.ts";

Deno.test("a failed collaboration startup keeps displaying Cell updates read-only", async () => {
  const cell = createMockCellHandle("initial", { schema: { type: "string" } });
  const querying = Promise.withResolvers<void>();
  const queried = Promise.withResolvers<OperationFieldSnapshot>();
  const runtime = {
    operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
    queryOperationField: () => {
      querying.resolve();
      return queried.promise;
    },
    closeOperationSession: () => Promise.resolve(),
  };
  Object.defineProperties(cell, {
    runtime: { value: () => runtime },
    resolveAsCell: { value: () => Promise.resolve(cell) },
  });
  const editor = new CFCodeEditor();
  editor.value = cell;
  const failed = Promise.withResolvers<Error>();
  editor.addEventListener("cf-error", (event) => {
    failed.resolve((event as CustomEvent<{ error: Error }>).detail.error);
  });
  document.body.append(editor);
  try {
    await editor.updateComplete;
    const view = editor.editorView;
    if (view === undefined) throw new Error("The editor view is missing.");
    editor.collaborative = true;
    await editor.updateComplete;
    await querying.promise;
    pushUpdate(cell, "while connecting");
    queried.reject(new Error("The initial collaboration query failed."));
    expect((await failed.promise).message).toBe(
      "The initial collaboration query failed.",
    );
    expect(view.state.doc.toString()).toBe("while connecting");

    pushUpdate(cell, "after failure");
    expect(view.state.doc.toString()).toBe("after failure");
    editor.readonly = true;
    await editor.updateComplete;
    editor.readonly = false;
    await editor.updateComplete;
    expect(view.state.readOnly).toBe(true);
    expect(writesSent(cell)).toEqual([]);
  } finally {
    editor.remove();
  }
});

for (
  const [outcome, name] of [
    [
      "confirmed",
      "disabling collaboration keeps the confirmed edit while the Cell catches up",
    ],
    [
      "advanced",
      "disabling collaboration adopts a Cell value newer than its confirmed edit",
    ],
    [
      "failed",
      "disabling collaboration stays read-only when the Cell refresh fails",
    ],
    [
      "rebound",
      "a late collaboration refresh preserves a newly bound document",
    ],
  ] as const
) {
  Deno.test(name, async () => {
    const cell = createMockCellHandle("toggle", { schema: { type: "string" } });
    const ref = cell.ref();
    const address = {
      branch: "",
      id: ref.id,
      scopeKey: "",
      path: ref.path as OperationFieldSnapshot["path"],
    };
    const queried = Promise.withResolvers<OperationFieldSnapshot>();
    const applying = Promise.withResolvers<
      Parameters<RuntimeClient["applyOperation"]>[1]
    >();
    const applied = Promise.withResolvers<ApplyOpResolution>();
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<string>();
    const refreshed = read.promise.then((value) => {
      pushUpdate(cell, value);
      return value;
    });
    const runtime = {
      operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
      queryOperationField: (_cell: unknown, cursor: unknown) =>
        cursor === undefined ? queried.promise : Promise.resolve({
          ...address,
          active: true,
          codec: CODEMIRROR_CHANGESET_CODEC,
          cursor: { epoch: 1, version: 1 },
          baselineHash: "baseline",
          materialized: "toggle!",
          operations: [],
        }),
      subscribeOperationField: () => Promise.resolve(() => {}),
      applyOperation: (
        _cell: unknown,
        request: Parameters<RuntimeClient["applyOperation"]>[1],
      ) => {
        applying.resolve(request);
        return applied.promise;
      },
      closeOperationSession: () => Promise.resolve(),
    };
    Object.defineProperties(cell, {
      runtime: { value: () => runtime },
      resolveAsCell: { value: () => Promise.resolve(cell) },
      // The operation acknowledgment and the ordinary Cell delivery are
      // separate channels. Only a fresh read brings this handle up to date.
      pull: {
        value: () => {
          reading.resolve();
          return refreshed;
        },
      },
    });

    const editor = new CFCodeEditor();
    editor.value = cell;
    const errors: unknown[] = [];
    const failed = Promise.withResolvers<never>();
    editor.addEventListener("cf-error", (event) => {
      errors.push((event as CustomEvent).detail);
      failed.reject((event as CustomEvent<{ error: Error }>).detail.error);
    });
    document.body.append(editor);
    try {
      await editor.updateComplete;
      const view = editor.editorView;
      expect(view).toBeDefined();
      if (view === undefined) throw new Error("The editor view is missing.");
      const ready = nextEditableState(view);
      editor.collaborative = true;
      await editor.updateComplete;
      queried.resolve({
        ...address,
        active: false,
        codec: null,
        cursor: null,
        baselineHash: "baseline",
        materialized: "toggle",
        operations: [],
      });
      await Promise.race([ready, failed.promise]);

      view.dispatch({ changes: { from: 6, insert: "!" } });
      const request = await Promise.race([applying.promise, failed.promise]);
      editor.collaborative = false;
      await editor.updateComplete;
      expect(view.state.readOnly).toBe(true);
      const stopped = nextEditableState(view);
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
      await Promise.race([
        reading.promise,
        stopped.then(() => {
          throw new Error(
            "The editor became editable before refreshing its Cell.",
          );
        }),
        failed.promise,
      ]);

      // A stale ordinary delivery must leave the confirmed operation text alone
      // throughout the handoff, including after the controller has stopped.
      pushUpdate(cell, "earlier text");
      editor.readonly = true;
      await editor.updateComplete;
      editor.readonly = false;
      await editor.updateComplete;
      expect(view.state.readOnly).toBe(true);
      expect(view.state.doc.toString()).toBe("toggle!");

      if (outcome === "failed") {
        read.reject(new Error("The Cell refresh failed."));
        await expect(failed.promise).rejects.toThrow(
          "The Cell refresh failed.",
        );
        expect(view.state.readOnly).toBe(true);
        expect(view.state.doc.toString()).toBe("toggle!");
        expect(writesSent(cell)).toEqual([]);
        return;
      }
      if (outcome === "rebound") {
        editor.value = "another document";
        await editor.updateComplete;
        await Promise.race([stopped, failed.promise]);
        read.resolve("toggle!");
        await refreshed;
        expect(view.state.doc.toString()).toBe("another document");
        expect(errors).toEqual([]);
        expect(writesSent(cell)).toEqual([]);
        return;
      }
      const expected = outcome === "advanced" ? "toggle!REMOTE" : "toggle!";
      read.resolve(expected);
      await Promise.race([stopped, failed.promise]);

      expect(view.state.doc.toString()).toBe(expected);
      expect(errors).toEqual([]);
      expect(writesSent(cell)).toEqual([]);
    } finally {
      editor.remove();
    }
  });
}

/** Resolves on the next transition into an editable CodeMirror state. */
function nextEditableState(view: EditorView): Promise<void> {
  const editable = Promise.withResolvers<void>();
  view.dispatch({
    effects: StateEffect.appendConfig.of(EditorView.updateListener.of(
      (update) => {
        if (
          update.startState.facet(EditorState.readOnly) &&
          !update.state.facet(EditorState.readOnly)
        ) editable.resolve();
      },
    )),
  });
  return editable.promise;
}
