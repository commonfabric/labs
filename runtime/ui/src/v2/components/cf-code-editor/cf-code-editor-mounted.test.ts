/**
 * The editor mounted in a document, with the CodeMirror view it builds: what
 * its properties configure, and what it does with the keys, pastes, clicks and
 * edits that reach that view.
 */

// First, so that the document it installs is there when Lit loads.
import { mount, settle, window } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { completionStatus } from "@codemirror/autocomplete";
import { indentUnit, language } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { NAME } from "@commonfabric/runner/shared";
import {
  CellHandle,
  type CellRef,
  CODEMIRROR_CHANGESET_CODEC,
  isCellHandle,
  type PresenceEvent,
  type PresenceRecord,
  type PresenceRoomHandle,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import {
  createMockCellHandle,
  pushRefusal,
  pushUpdate,
  refuseReads,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import type { MentionRefMap } from "../../core/mention-refs.ts";
import type { MentionableArray } from "../../core/mentionable.ts";
import { defaultTheme } from "../theme-context.ts";
import { CFCodeEditor, MimeType } from "./index.ts";
import type { CodeMirrorCollaborationController } from "./codemirror-collaboration.ts";
import { codeMirrorPresenceState } from "./codemirror-presence.ts";
import { setHighlightAnchorsEffect } from "./features/highlights.ts";

const SPACE = "did:key:z6MkpXpeKbhbddoVvxQndKtnNZmGfpSbXXmVw88bswFy2hHh";
const HASH = "V2tROHl4KsExx5M0fYnkQaOryFwjVUkqXIlcdMWz7SQ";
const KEY = "a3f9zz";

/** An editor with `properties` set, mounted and rendered. */
async function mountEditor(
  properties: Partial<CFCodeEditor> = {},
  { caretAtEnd = false } = {},
): Promise<{ element: CFCodeEditor; view: EditorView }> {
  // Immediate, so that a write the editor makes is sent before the case
  // reads it, and leaves no debounce timer behind.
  const element = Object.assign(
    new CFCodeEditor(),
    { timingStrategy: "immediate" },
    properties,
  );
  await mount(element);
  const view = element.editorView!;
  if (caretAtEnd) {
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  }
  return { element, view };
}

/** The CSS of every style module the editor has installed. */
function css(view: EditorView): string {
  return view.state.facet(EditorView.styleModule)
    .map((module) => module.getRules())
    .join("\n");
}

/** The detail of every `type` event `target` fires from now on. */
function recorded<T = unknown>(target: EventTarget, type: string): T[] {
  const details: T[] = [];
  target.addEventListener(
    type,
    (event) => details.push((event as CustomEvent<T>).detail),
  );
  return details;
}

/** Resolves with the detail of the next `type` event `target` fires. */
function next<T = unknown>(target: EventTarget, type: string): Promise<T> {
  return new Promise((resolve) =>
    target.addEventListener(
      type,
      (event) => resolve((event as CustomEvent<T>).detail),
      { once: true },
    )
  );
}

/** Resolves once `handle` holds a value `holds` accepts. */
function until<T>(
  handle: CellHandle<T>,
  holds: (value: T | undefined) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = handle.subscribe((value) => {
      if (!holds(value)) return;
      queueMicrotask(() => unsubscribe());
      resolve();
    }, { onRefused: () => {} });
  });
}

/** Presses `key` in `view`, as a keyboard does, and returns the event. */
function press(
  view: EditorView,
  key: string,
  modifiers: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

/** Pastes `text` and `files` into `view`, and returns the event. */
function paste(
  view: EditorView,
  { text, files = [] }: { text?: string; files?: File[] },
): ClipboardEvent {
  const clipboardData = new window.DataTransfer();
  if (text !== undefined) clipboardData.setData("text/plain", text);
  for (const file of files) {
    clipboardData.items.add(
      file as unknown as InstanceType<typeof window.File>,
    );
  }
  const event = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: clipboardData as unknown as DataTransfer,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

/** An image file named `name`, as the document's own `File` makes one. */
function image(name: string): File {
  return new window.File(["png"], name, {
    type: "image/png",
  }) as unknown as File;
}

/**
 * `handle`, which binding it under the editor's schema hands back as it is,
 * so that an update pushed to it reaches the subscription the binding opens.
 */
function bound<T>(handle: CellHandle<T>): CellHandle<T> {
  Object.defineProperty(handle, "asSchema", { value: () => handle });
  return handle;
}

/** A universe row standing for the piece `of:<id>`, named `name`. */
function row(id: string, name: string) {
  return {
    [NAME]: name,
    title: name,
    piece: { "$link": { id: `of:${id}`, path: [] } },
  };
}

/** A universe of `rows`, under the id `of:universe`. */
function universe(...rows: unknown[]): CellHandle<MentionableArray> {
  return createMockCellHandle(rows, {
    id: "of:universe" as CellRef["id"],
  }) as unknown as CellHandle<MentionableArray>;
}

/** A piece named `name`, under the id `of:<id>`. */
function piece(id: string, name: string): CellHandle<Record<string, unknown>> {
  return createMockCellHandle<Record<string, unknown>>(
    { [NAME]: name, title: name },
    { id: `of:${id}` as CellRef["id"] },
  );
}

/** A reference map pointing each key at its destination. */
function referenceMap(
  destinations: Record<string, CellHandle<unknown>> = {},
): CellHandle<MentionRefMap> {
  return bound(
    createMockCellHandle(
      Object.fromEntries(
        Object.entries(destinations).map(([key, destination]) => [
          key,
          { destination, modifiedTitle: false },
        ]),
      ),
    ) as unknown as CellHandle<MentionRefMap>,
  );
}

/** The id of `entry`, a mentioned list's entry, which is a cell. */
function cellId(entry: unknown): string {
  assert(isCellHandle(entry), "a mentioned list's entry is a cell");
  return entry.id();
}

/** The values written to `handle`'s network at `path` under `id`. */
function writesAt<T>(
  handle: CellHandle<T>,
  id: string,
  path: string[],
): unknown[] {
  return writesSent(handle)
    .filter((write) =>
      write.cell?.id === id &&
      JSON.stringify(write.cell.path) === JSON.stringify(path)
    )
    .map((write) => write.value);
}

/**
 * A pattern for creating and finding pieces, in the space `SPACE`, whose
 * runtime does what `runtime` says.
 */
function pattern(runtime: Partial<RuntimeClient>): CellHandle<string> {
  return {
    get: () => "{}",
    space: () => SPACE,
    runtime: () => ({ signal: new AbortController().signal, ...runtime }),
  } as unknown as CellHandle<string>;
}

/** A piece handle as `createPiece()` returns one, for `cell`. */
function created(cell: CellHandle<unknown>) {
  return {
    id: () => cell.id(),
    cell: () => cell,
  } as unknown as Awaited<ReturnType<RuntimeClient["createPiece"]>>;
}

/** Replaces `console[method]` until `restore()`, recording each call. */
function captureConsole(method: "error" | "warn") {
  const calls: unknown[][] = [];
  const called = Promise.withResolvers<void>();
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    calls.push(args);
    called.resolve();
  };
  return {
    calls,
    called: called.promise,
    restore: () => (console[method] = original),
  };
}

/**
 * Resolves once the microtasks queued so far, and those they queue, have run:
 * what a case waits on to see that something did not happen.
 */
async function settled(): Promise<void> {
  const time = new FakeTime();
  try {
    await time.runMicrotasks();
  } finally {
    time.restore();
  }
}

/**
 * Answers each `resolveAsCell()` that `answer` answers, until `restore()`,
 * and leaves the rest to the mock network, which `resolve` asks. A test holds
 * a resolution open with it, fails one, or resolves a piece to a handle it
 * holds itself, none of which the mock network does.
 */
function resolving(
  answer: (
    handle: CellHandle<unknown>,
    resolve: () => Promise<CellHandle<unknown>>,
  ) => Promise<CellHandle<unknown>> | undefined,
): { restore(): void } {
  const original = Object.getOwnPropertyDescriptor(
    CellHandle.prototype,
    "resolveAsCell",
  )!;
  Object.defineProperty(CellHandle.prototype, "resolveAsCell", {
    configurable: true,
    writable: true,
    value: function (this: CellHandle<unknown>) {
      return answer(this, () => original.value.call(this)) ??
        original.value.call(this);
    },
  });
  return {
    restore: () =>
      Object.defineProperty(CellHandle.prototype, "resolveAsCell", original),
  };
}

/**
 * Starts releasing `element`'s collaboration, which a stand-in controller
 * holds, and returns what settles the release.
 */
function releasing(element: CFCodeEditor): PromiseWithResolvers<void> {
  const release = Promise.withResolvers<void>();
  element.accessForTestingOnly.collaboration = {
    active: true,
    release: () => release.promise,
    stop: () => Promise.resolve(),
  } as unknown as CodeMirrorCollaborationController;
  void element.releaseCollaboration();
  return release;
}

/** Whether `handle` addresses a universe row's `piece`. */
function isRowPiece(handle: CellHandle<unknown>): boolean {
  return handle.ref().path.at(-1) === "piece";
}

/**
 * Records every subscription opened through a handle, until `restore()`:
 * the handle, which a test pushes to, and whether it has been closed.
 */
function tappingSubscriptions() {
  const opened: { handle: CellHandle<unknown>; closed: boolean }[] = [];
  const original = Object.getOwnPropertyDescriptor(
    CellHandle.prototype,
    "subscribe",
  )!;
  Object.defineProperty(CellHandle.prototype, "subscribe", {
    configurable: true,
    writable: true,
    value: function (this: CellHandle<unknown>, ...args: unknown[]) {
      const subscription = { handle: this, closed: false };
      opened.push(subscription);
      const unsubscribe: () => void = original.value.apply(this, args);
      return () => {
        subscription.closed = true;
        unsubscribe();
      };
    },
  });
  return {
    /** The subscriptions opened on `path` of the cell `id`. */
    of: (id: string, path: string[]) =>
      opened.filter(({ handle }) =>
        handle.id() === id &&
        JSON.stringify(handle.ref().path) === JSON.stringify(path)
      ),
    restore: () =>
      Object.defineProperty(CellHandle.prototype, "subscribe", original),
  };
}

/**
 * Resolves with the completion status `view` settles on once a query it
 * starts after this call has been answered.
 */
function completionSettles(view: EditorView): Promise<string | null> {
  let pending = false;
  return new Promise((resolve) =>
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          const status = completionStatus(update.state);
          if (status === "pending") pending = true;
          else if (pending) resolve(status);
        }),
      ),
    })
  );
}

describe("CFCodeEditor", () => {
  afterEach(async () => {
    // happy-dom keeps the document's focus on a removed editor's content,
    // where the editor's own focus timer then fails to read it, so focus
    // leaves first.
    for (
      const editor of document.querySelectorAll<CFCodeEditor>("cf-code-editor")
    ) {
      editor.editorView?.contentDOM.blur();
    }
    document.body.replaceChildren();
    await settle();
  });

  describe("configuration", () => {
    it("shows the bound text, with the caret at the start", async () => {
      const { view } = await mountEditor({ value: "hello" });
      expect(view.state.doc.toString()).toBe("hello");
      expect(view.state.selection.main.head).toBe(0);
    });

    it("shows the placeholder over an empty document, and none when it has none", async () => {
      const { element } = await mountEditor({ placeholder: "Write here" });
      expect(
        element.shadowRoot!.querySelector(".cm-placeholder")?.textContent,
      ).toBe("Write here");

      const plain = await mountEditor();
      expect(plain.element.shadowRoot!.querySelector(".cm-placeholder"))
        .toBeNull();
    });

    it("parses the language its MIME type names, and Markdown for one it does not know", async () => {
      const { element, view } = await mountEditor({
        language: MimeType.javascript,
      });
      expect(view.state.facet(language)?.name).toBe("javascript");

      element.language = MimeType.json;
      await element.updateComplete;
      expect(view.state.facet(language)?.name).toBe("json");

      element.language = "text/x-unknown" as MimeType;
      await element.updateComplete;
      expect(view.state.facet(language)?.name).toBe("markdown");
    });

    it("is read-only while `readonly` is set, and editable once it is cleared", async () => {
      const { element, view } = await mountEditor({ readonly: true });
      expect(view.state.readOnly).toBe(true);

      element.readonly = false;
      await element.updateComplete;
      expect(view.state.readOnly).toBe(false);
    });

    it("wraps lines while `wordWrap` is set, and not once it is cleared", async () => {
      const { element, view } = await mountEditor();
      expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);

      element.wordWrap = false;
      await element.updateComplete;
      expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(
        false,
      );
    });

    it("hides the gutters unless `lineNumbers` is set", async () => {
      const { element, view } = await mountEditor({ value: "a\nb" });
      const hidden = /\.cm-gutters \{display: none;\}/;
      expect(css(view)).toMatch(hidden);

      element.lineNumbers = true;
      await element.updateComplete;
      expect(css(view)).not.toMatch(hidden);
      expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();

      element.lineNumbers = false;
      await element.updateComplete;
      expect(css(view)).toMatch(hidden);
    });

    it("indents by `tabSize` spaces", async () => {
      const { element, view } = await mountEditor({ tabSize: 4 });
      expect(view.state.tabSize).toBe(4);
      expect(view.state.facet(indentUnit)).toBe("    ");

      element.tabSize = 3;
      await element.updateComplete;
      expect(view.state.tabSize).toBe(3);
      expect(view.state.facet(indentUnit)).toBe("   ");
    });

    it("indents on Tab while `tabIndent` is set, and leaves Tab alone once it is cleared", async () => {
      const { element, view } = await mountEditor({ value: "x" });
      press(view, "Tab");
      expect(view.state.doc.toString()).toBe("  x");

      element.tabIndent = false;
      await element.updateComplete;
      press(view, "Tab");
      expect(view.state.doc.toString()).toBe("  x");
    });

    it("limits the line width to `maxLineWidth`, a number counting characters", async () => {
      const { element, view } = await mountEditor({ maxLineWidth: 80 });
      const maxWidth = () =>
        [...css(view).matchAll(/\.cm-content \{max-width: ([^;]+);\}/g)]
          .map((match) => match[1]);
      expect(maxWidth()).toEqual(["80ch"]);

      element.maxLineWidth = "50rem";
      await element.updateComplete;
      expect(maxWidth()).toEqual(["50rem"]);

      element.maxLineWidth = 0;
      await element.updateComplete;
      expect(maxWidth()).toEqual([]);
    });

    it("lays out prose in a measure without the code gutters, and code with them", async () => {
      const { element, view } = await mountEditor({
        mode: "prose",
        lineNumbers: true,
      });
      const proseMeasure = /max-width: var\(--cf-code-editor-prose-max-width/;
      expect(view.dom.querySelector(".cm-gutters")).toBeNull();
      expect(css(view)).toMatch(proseMeasure);

      element.mode = "code";
      await element.updateComplete;
      expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();
      expect(css(view)).not.toMatch(proseMeasure);
    });

    it("leaves the prose measure to `maxLineWidth` where it is set", async () => {
      const { view } = await mountEditor({ mode: "prose", maxLineWidth: 60 });
      expect(css(view)).not.toMatch(/--cf-code-editor-prose-max-width/);
      expect(css(view)).toMatch(/max-width: 60ch/);
    });

    it("paints oneDark when `theme` is dark, and follows the ambient scheme otherwise", async () => {
      const { element, view } = await mountEditor({ theme: "dark" });
      expect(view.state.facet(EditorView.darkTheme)).toBe(true);

      element.theme = "light";
      await element.updateComplete;
      expect(view.state.facet(EditorView.darkTheme)).toBe(false);

      element.ambientTheme = { ...defaultTheme, colorScheme: "dark" };
      await element.updateComplete;
      expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    });

    it("reads a numeric `maxlinewidth` attribute as a number, and any other as a length", async () => {
      const { element, view } = await mountEditor();

      element.setAttribute("maxlinewidth", "72");
      await element.updateComplete;
      expect(element.maxLineWidth).toBe(72);
      expect(css(view)).toMatch(/max-width: 72ch/);

      element.setAttribute("maxlinewidth", "40em");
      await element.updateComplete;
      expect(element.maxLineWidth).toBe("40em");

      element.removeAttribute("maxlinewidth");
      await element.updateComplete;
      expect(element.maxLineWidth).toBeUndefined();
    });

    it("exposes the view's current state", async () => {
      const { element, view } = await mountEditor({ value: "x" });
      view.dispatch({ changes: { from: 1, insert: "y" } });
      expect(element.editorState).toBe(view.state);
      expect(element.editorState!.doc.toString()).toBe("xy");
    });
  });

  describe("content", () => {
    it("writes what is typed to the bound cell, and fires `cf-change`", async () => {
      const cell = createMockCellHandle("hello");
      const { element, view } = await mountEditor({ value: cell });
      const changes = recorded(element, "cf-change");

      view.dispatch({ changes: { from: 5, insert: "!" } });

      expect(writesAt(cell, cell.id(), [])).toEqual(["hello!"]);
      expect(changes).toContainEqual({
        value: "hello!",
        oldValue: "hello",
        language: MimeType.markdown,
      });
    });

    it("shows a new value of the cell, keeping the caret inside it, and writes nothing back", async () => {
      const cell = bound(createMockCellHandle("hello world"));
      const { view } = await mountEditor({ value: cell }, { caretAtEnd: true });

      pushUpdate(cell, "hi");

      expect(view.state.doc.toString()).toBe("hi");
      expect(view.state.selection.main.head).toBe(2);
      expect(writesSent(cell)).toEqual([]);
    });

    it("writes under the blur strategy when focus leaves, and not before", async () => {
      const cell = createMockCellHandle("a");
      const { element, view } = await mountEditor({
        value: cell,
        timingStrategy: "blur",
      });
      const focuses = recorded(element, "cf-focus");
      const blurs = recorded(element, "cf-blur");

      element.focus();
      view.dispatch({ changes: { from: 1, insert: "b" } });
      expect(writesSent(cell)).toEqual([]);
      expect(focuses).toHaveLength(1);

      view.contentDOM.blur();
      expect(blurs).toHaveLength(1);
      expect(writesAt(cell, cell.id(), [])).toEqual(["ab"]);
    });
  });

  describe("keyboard", () => {
    it("moves past a backlink on Enter inside it, without a newline", async () => {
      const { view } = await mountEditor({ value: "a [[Foo (id1)]] b" });
      view.dispatch({ selection: { anchor: 5 } });

      press(view, "Enter");

      expect(view.state.doc.toString()).toBe("a [[Foo (id1)]] b");
      expect(view.state.selection.main.head).toBe(15);
    });

    it("moves past a reference on Enter inside it, without a newline", async () => {
      const { view } = await mountEditor({
        value: `see [Foo][${KEY}] end`,
        references: referenceMap({ [KEY]: piece("foo", "Foo") }),
      });
      view.dispatch({ selection: { anchor: 6 } });

      press(view, "Enter");

      expect(view.state.doc.toString()).toBe(`see [Foo][${KEY}] end`);
      expect(view.state.selection.main.head).toBe(17);
    });

    it("breaks the line on Enter outside a mention, and after a blank query", async () => {
      const { view } = await mountEditor({ value: "ab" }, { caretAtEnd: true });
      press(view, "Enter");
      expect(view.state.doc.toString()).toBe("ab\n");

      view.dispatch({ changes: { from: 3, insert: "[[  " } });
      view.dispatch({ selection: { anchor: 7 } });
      press(view, "Enter");
      expect(view.state.doc.toString()).toBe("ab\n[[  \n");
    });

    it("keeps the browser's save from Mod-s, and leaves a plain s to the editor", async () => {
      const { view } = await mountEditor({ value: "x" });
      expect(press(view, "s", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe("x");
      expect(press(view, "s").defaultPrevented).toBe(false);
    });

    describe("Enter after `[[`", () => {
      // A query that names a row exactly completes to that row; one that
      // names nothing creates a piece for it, from the pattern.

      it("completes an exact match to a wiki-link naming its piece", async () => {
        const { element, view } = await mountEditor({
          value: "see [[existing]]",
          mentionable: universe(row("existing-id", "Existing")),
        });
        await element.accessForTestingOnly.resolvePieceIds();
        view.dispatch({ selection: { anchor: 14 } });

        press(view, "Enter");

        expect(view.state.doc.toString()).toBe(
          "see [[Existing (existing-id)]]",
        );
        expect(view.state.selection.main.head).toBe(30);
      });

      it("completes an exact match to a reference naming its piece, given a map", async () => {
        const references = referenceMap();
        const { element, view } = await mountEditor({
          value: "see [[Existing",
          mentionable: universe(row("existing-id", "Existing")),
          references,
        }, { caretAtEnd: true });
        await element.accessForTestingOnly.resolvePieceIds();

        press(view, "Enter");

        const [key, entry] = Object.entries(references.get()!)[0];
        expect(view.state.doc.toString()).toBe(`see [Existing][${key}]`);
        expect((entry.destination as unknown as { id: string }).id).toBe(
          "of:existing-id",
        );
      });

      it("creates a piece for a query naming nothing, and links it", async () => {
        const titles: unknown[] = [];
        const { element, view } = await mountEditor({
          value: "see [[New",
          pattern: pattern({
            createPiece: ((_program: unknown, space: unknown, inputs: {
              title: string;
            }) => {
              titles.push([space, inputs.title]);
              return Promise.resolve(created(piece("new-id", "New")));
            }) as RuntimeClient["createPiece"],
          }),
        }, { caretAtEnd: true });
        const creation = next<{ text: string; navigate: boolean }>(
          element,
          "backlink-create",
        );

        press(view, "Enter");
        // The brackets close at once, before the piece exists.
        expect(view.state.doc.toString()).toBe("see [[New]]");

        const detail = await creation;
        expect(titles).toEqual([[SPACE, "New"]]);
        expect(detail.text).toBe("New");
        expect(detail.navigate).toBe(false);
        expect(view.state.doc.toString()).toBe("see [[New (of:new-id)]]");
        expect(view.state.selection.main.head).toBe(23);
      });

      it("steps over brackets already closed when creating a piece", async () => {
        const { element, view } = await mountEditor({
          value: "[[New]]",
          pattern: pattern({
            createPiece: (() =>
              Promise.resolve(
                created(piece("new-id", "New")),
              )) as RuntimeClient["createPiece"],
          }),
        });
        const creation = next(element, "backlink-create");
        view.dispatch({ selection: { anchor: 5 } });

        press(view, "Enter");
        expect(view.state.selection.main.head).toBe(7);

        await creation;
        expect(view.state.doc.toString()).toBe("[[New (of:new-id)]]");
      });

      for (
        const [how, runtime, program] of [
          ["holds no program", {}, ""],
          ["creates no piece", {
            createPiece: (() =>
              Promise.resolve(undefined)) as unknown as RuntimeClient[
                "createPiece"
              ],
          }, "{}"],
        ] as const
      ) {
        it(`reports a failed create, and links nothing, where the pattern ${how}`, async () => {
          const { element, view } = await mountEditor({
            value: "[[New",
            pattern: Object.assign(pattern(runtime), { get: () => program }),
          }, { caretAtEnd: true });
          const creations = recorded(element, "backlink-create");
          const errors = captureConsole("error");
          try {
            press(view, "Enter");
            await errors.called;
          } finally {
            errors.restore();
          }

          expect(errors.calls).toHaveLength(1);
          expect(creations).toEqual([]);
          expect(view.state.doc.toString()).toBe("[[New]]");
        });
      }

      it("creates nothing, and leaves the query, without a pattern", async () => {
        const { element, view } = await mountEditor({
          value: "[[New",
        }, { caretAtEnd: true });
        const creations = recorded(element, "backlink-create");

        press(view, "Enter");

        expect(view.state.doc.toString()).toBe("[[New");
        expect(creations).toEqual([]);
      });

      describe("given a reference map", () => {
        it("references the piece it creates for a query naming nothing", async () => {
          const references = referenceMap();
          const { element, view } = await mountEditor({
            value: "[[New",
            references,
            pattern: pattern({
              createPiece: (() =>
                Promise.resolve(
                  created(piece("new-id", "New")),
                )) as RuntimeClient["createPiece"],
            }),
          }, { caretAtEnd: true });
          const creation = next<{ pieceId: string }>(
            element,
            "backlink-create",
          );

          press(view, "Enter");
          const token = view.state.doc.toString();
          expect(token).toMatch(/^\[New\]\[[0-9a-z]{6}\]$/);

          expect((await creation).pieceId).toBe("of:new-id");
          const key = token.slice(6, -1);
          const entry = references.get()![key];
          expect((entry.destination as unknown as { id: string }).id).toBe(
            "of:new-id",
          );
        });

        it("writes no entry for a token removed while the piece was created", async () => {
          const references = referenceMap();
          const piecePromise = Promise.withResolvers<
            Awaited<ReturnType<RuntimeClient["createPiece"]>>
          >();
          const { element, view } = await mountEditor({
            value: "[[New",
            references,
            pattern: pattern({
              createPiece: (() =>
                piecePromise.promise) as RuntimeClient["createPiece"],
            }),
          }, { caretAtEnd: true });
          const creation = next(element, "backlink-create");

          press(view, "Enter");
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: "gone" },
          });
          piecePromise.resolve(created(piece("new-id", "New")));
          await creation;

          // The host still hears of the piece, which exists either way.
          expect(references.get()).toEqual({});
        });

        it("unwinds the token to its label when the create fails", async () => {
          const references = referenceMap();
          const { view } = await mountEditor({
            value: "[[New",
            references,
            pattern: pattern({
              createPiece: (() =>
                Promise.reject(
                  new Error("no piece"),
                )) as RuntimeClient["createPiece"],
            }),
          }, { caretAtEnd: true });
          const errors = captureConsole("error");
          try {
            press(view, "Enter");
            await errors.called;
          } finally {
            errors.restore();
          }

          expect(view.state.doc.toString()).toBe("New");
          expect(references.get()).toEqual({});
        });
      });
    });
  });

  describe("picking a completion after `[[`", () => {
    // The completion opens off the editor's own timers; the case waits on
    // the update that shows it, then presses the first option in the list.

    /** Resolves once `view` shows an active completion. */
    function completionOpens(view: EditorView): Promise<void> {
      return new Promise<void>((resolve) =>
        view.dispatch({
          effects: StateEffect.appendConfig.of(
            EditorView.updateListener.of((update) => {
              if (completionStatus(update.state) === "active") resolve();
            }),
          ),
        })
      );
    }

    async function pickFirst(
      view: EditorView,
      typed: string,
      caret = typed.length,
    ): Promise<void> {
      const opened = completionOpens(view);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: typed },
        selection: { anchor: caret },
        userEvent: "input.type",
      });
      await opened;
      view.dom.querySelector(".cm-tooltip-autocomplete li")!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    }

    it("opens the completion for a change that leaves the caret in a query, typed or not", async () => {
      const { element, view } = await mountEditor({
        mentionable: universe(row("existing-id", "Existing")),
      });
      await element.accessForTestingOnly.resolvePieceIds();
      const opened = completionOpens(view);

      // Not typed, so only the editor's own listener opens the completion.
      view.dispatch({
        changes: { from: 0, insert: "see [[Exi" },
        selection: { anchor: 9 },
      });
      await opened;

      expect(
        view.dom.querySelector(".cm-tooltip-autocomplete li")?.textContent,
      ).toContain("Existing");
    });

    it("completes the picked row to a wiki-link, over brackets already closed", async () => {
      const { element, view } = await mountEditor({
        mentionable: universe(row("existing-id", "Existing")),
      });
      await element.accessForTestingOnly.resolvePieceIds();

      await pickFirst(view, "see [[Exi]]", 9);

      expect(view.state.doc.toString()).toBe(
        "see [[Existing (existing-id)]]",
      );
    });

    it("completes the picked row to a reference, given a map", async () => {
      const references = referenceMap();
      const { element, view } = await mountEditor({
        mentionable: universe(row("existing-id", "Existing")),
        references,
      });
      await element.accessForTestingOnly.resolvePieceIds();

      await pickFirst(view, "see [[Exi");

      const [key, entry] = Object.entries(references.get()!)[0];
      expect(view.state.doc.toString()).toBe(`see [Existing][${key}]`);
      expect((entry.destination as unknown as { id: string }).id).toBe(
        "of:existing-id",
      );
    });
  });

  describe("paste", () => {
    it("stores a pasted image and links it where the selection was", async () => {
      const cell = createMockCellHandle("see ");
      const uploads: unknown[] = [];
      Object.assign(cell.runtime(), {
        uploadBlob: (request: { name: string }) => {
          uploads.push(request.name);
          return Promise.resolve({ id: "blob-1", url: "/blobs/1" });
        },
      });
      const { element, view } = await mountEditor({
        value: cell,
      }, { caretAtEnd: true });
      const pasted = next<{ files: { url: string }[] }>(
        element,
        "cf-file-paste",
      );

      const event = paste(view, { files: [image("a[1].png")] });
      expect(event.defaultPrevented).toBe(true);

      expect((await pasted).files.map((file) => file.url)).toEqual([
        "/blobs/1",
      ]);
      expect(uploads).toEqual(["a[1].png"]);
      expect(view.state.doc.toString()).toBe("see ![a\\[1\\].png](/blobs/1)");
    });

    it("reports a pasted image it has no runtime to store", async () => {
      const { element, view } = await mountEditor({ value: "x" });
      const errors = recorded<{ message: string }>(element, "cf-error");

      paste(view, { files: [image("a.png")] });

      expect(errors.map((error) => error.message)).toEqual([
        "Runtime is not available for pasted image storage",
      ]);
      expect(view.state.doc.toString()).toBe("x");
    });

    it("reports a pasted image it has no space to store in", async () => {
      const { element, view } = await mountEditor({ value: "x" });
      element.runtime = {} as RuntimeClient;
      const errors = recorded<{ message: string }>(element, "cf-error");

      paste(view, { files: [image("a.png")] });

      expect(errors.map((error) => error.message)).toEqual([
        "Space is not available for pasted image storage",
      ]);
    });

    it("reports a pasted image whose upload fails, and inserts nothing", async () => {
      const cell = createMockCellHandle("x");
      Object.assign(cell.runtime(), {
        uploadBlob: () => Promise.reject(new Error("offline")),
      });
      const { element, view } = await mountEditor({ value: cell });
      const failed = next<{ message: string }>(element, "cf-error");

      paste(view, { files: [image("a.png")] });

      expect((await failed).message).toBe("Failed to store pasted image");
      expect(view.state.doc.toString()).toBe("x");
    });

    it("inserts nothing for an image whose upload returns after the content is refused", async () => {
      const cell = bound(createMockCellHandle("x"));
      const upload = Promise.withResolvers<{ id: string; url: string }>();
      Object.assign(cell.runtime(), { uploadBlob: () => upload.promise });
      const { element, view } = await mountEditor({ value: cell });
      const pastes = recorded(element, "cf-file-paste");

      paste(view, { files: [image("a.png")] });
      pushRefusal(cell);
      upload.resolve({ id: "blob-1", url: "/blobs/1" });
      await settled();

      expect(pastes).toEqual([]);
      expect(view.state.doc.toString()).not.toContain("/blobs/1");
    });

    it("leaves a paste to the editor while it is read-only", async () => {
      const { element, view } = await mountEditor({
        value: "x",
        readonly: true,
      });
      const errors = recorded(element, "cf-error");

      paste(view, { files: [image("a.png")] });

      // Taking the paste over would have reported the missing runtime.
      expect(errors).toEqual([]);
      expect(view.state.doc.toString()).toBe("x");
    });

    describe("a URL naming a piece, given a reference map", () => {
      const url = `//${SPACE}/of:fid1:${HASH}`;

      it("mentions the piece and names it in the map", async () => {
        const references = referenceMap();
        const asked: unknown[] = [];
        const destination = piece("pasted", "Pasted note");
        const { view } = await mountEditor({
          value: "",
          references,
          pattern: pattern({
            getCell: ((space: string, id: string) => {
              asked.push([space, id]);
              return Promise.resolve(destination);
            }) as unknown as RuntimeClient["getCell"],
          }),
        });

        const event = paste(view, { text: url });
        expect(event.defaultPrevented).toBe(true);
        const token = view.state.doc.toString();
        expect(token).toMatch(/^\[[^\]]+\]\[[0-9a-z]{6}\]$/);
        const key = token.slice(-7, -1);

        await until(references, (map) => map?.[key] !== undefined);
        expect(asked).toEqual([[SPACE, `of:fid1:${HASH}`]]);
        expect(
          (references.get()![key].destination as unknown as { id: string }).id,
        ).toBe("of:pasted");
      });

      for (
        const [how, getCell] of [
          ["cannot be read", () => Promise.reject(new Error("unreadable"))],
          ["does not exist", () => Promise.resolve(undefined)],
        ] as const
      ) {
        it(`unwinds the token to the pasted text when the cell ${how}`, async () => {
          const references = referenceMap();
          const { view } = await mountEditor({
            value: "",
            references,
            pattern: pattern({
              getCell: getCell as unknown as RuntimeClient["getCell"],
            }),
          });
          const errors = captureConsole("error");
          try {
            paste(view, { text: url });
            await errors.called;
          } finally {
            errors.restore();
          }

          expect(view.state.doc.toString()).toBe(url);
          expect(references.get()).toEqual({});
        });
      }

      it("unwinds a token whose cell was read while the map was refused, once the map is admitted", async () => {
        const references = referenceMap();
        const read = Promise.withResolvers<unknown>();
        const { view } = await mountEditor({
          value: "",
          references,
          pattern: pattern({
            getCell: (() =>
              read.promise) as unknown as RuntimeClient["getCell"],
          }),
        });

        paste(view, { text: url });
        const token = view.state.doc.toString();
        pushRefusal(references);
        read.resolve(piece("pasted", "Pasted note"));
        await settled();
        // While the map is refused the token stays, with no entry.
        expect(view.state.doc.toString()).toBe(token);

        pushUpdate(references, {});
        await settled();

        expect(view.state.doc.toString()).toBe(url);
        expect(references.get()).toEqual({});
      });

      it("unwinds nothing while the map is refused again before the editor catches up", async () => {
        const references = referenceMap();
        const read = Promise.withResolvers<unknown>();
        const { view } = await mountEditor({
          value: "",
          references,
          pattern: pattern({
            getCell: (() =>
              read.promise) as unknown as RuntimeClient["getCell"],
          }),
        });
        paste(view, { text: url });
        const token = view.state.doc.toString();
        pushRefusal(references);
        read.resolve(piece("pasted", "Pasted note"));
        await settled();

        // Admitted and refused again in one turn, before the catching up the
        // admission queued has run.
        pushUpdate(references, {});
        pushRefusal(references);
        await settled();
        expect(view.state.doc.toString()).toBe(token);

        pushUpdate(references, {});
        await settled();
        expect(view.state.doc.toString()).toBe(url);
      });

      it("names nothing in the map for a token removed while the cell was read", async () => {
        const references = referenceMap();
        const read = Promise.withResolvers<unknown>();
        const { view } = await mountEditor({
          value: "",
          references,
          pattern: pattern({
            getCell: (() =>
              read.promise) as unknown as RuntimeClient["getCell"],
          }),
        });

        paste(view, { text: url });
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "gone" },
        });
        read.resolve(piece("pasted", "Pasted note"));
        await settled();

        expect(references.get()).toEqual({});
      });
    });
  });

  describe("pill clicks", () => {
    // happy-dom lays nothing out, so the view is told where the press landed
    // as the browser's layout would tell it. The navigation runs off a timer,
    // which the fake clock runs.

    function pressOn(
      view: EditorView,
      selector: string,
      pos: number | null,
    ): void {
      Object.defineProperty(view, "posAtCoords", {
        value: () => pos,
        configurable: true,
      });
      const target = view.contentDOM.querySelector(selector) ??
        view.contentDOM;
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
    }

    async function clicked(
      element: CFCodeEditor,
      press: () => void,
    ): Promise<unknown[]> {
      const clicks = recorded(element, "backlink-click");
      const time = new FakeTime();
      try {
        press();
        time.tick(0);
        await time.runMicrotasks();
        return clicks;
      } finally {
        time.restore();
      }
    }

    it("navigates to the piece a backlink pill names", async () => {
      const target = piece("foo-id", "Foo");
      const { element, view } = await mountEditor({
        value: "see [[Foo (foo-id)]]",
        pattern: pattern({
          getCell: ((_space: string, id: string) =>
            Promise.resolve(
              id === "foo-id" ? target : null,
            )) as unknown as RuntimeClient["getCell"],
        }),
      });

      const clicks = await clicked(
        element,
        () => pressOn(view, ".cm-backlink-pill", 7),
      );

      expect(clicks).toEqual([
        { id: "foo-id", text: "Foo (foo-id)", piece: target.toSigilLink() },
      ]);
    });

    it("navigates nowhere from a press outside the pill's name", async () => {
      const { element, view } = await mountEditor({
        value: "see [[Foo (foo-id)]] [[pending]]",
        pattern: pattern({
          getCell: (() =>
            Promise.resolve(
              piece("foo-id", "Foo"),
            )) as unknown as RuntimeClient["getCell"],
        }),
      });

      const clicks = await clicked(
        element,
        () => pressOn(view, ".cm-backlink-pill", 25),
      );

      expect(clicks).toEqual([]);
    });

    it("navigates nowhere from a press the layout places nowhere", async () => {
      const { element, view } = await mountEditor({
        value: `see [[Foo (foo-id)]] [Bar][${KEY}]`,
        references: referenceMap({ [KEY]: piece("bar-id", "Bar") }),
        pattern: pattern({}),
      });

      const backlink = await clicked(
        element,
        () => pressOn(view, ".cm-backlink-pill", null),
      );
      const reference = await clicked(
        element,
        () => pressOn(view, ".cm-mention-ref-pill", null),
      );

      expect([...backlink, ...reference]).toEqual([]);
    });

    it("navigates to the destination a reference pill names", async () => {
      const destination = piece("foo-id", "Foo");
      const { element, view } = await mountEditor({
        value: `see [Foo][${KEY}]`,
        references: referenceMap({ [KEY]: destination }),
      });

      const clicks = await clicked(
        element,
        () => pressOn(view, ".cm-mention-ref-pill", 6),
      );

      // The link carries the schema the reference map reads its destination
      // under, so only the cell it names is compared.
      const { id, space, path } = destination.ref();
      expect(clicks).toEqual([{
        id: KEY,
        text: "Foo",
        piece: {
          "/": { "link@1": expect.objectContaining({ id, space, path }) },
        },
      }]);
    });

    it("navigates nowhere from a reference pill pressed outside its label", async () => {
      const { element, view } = await mountEditor({
        value: `see [Foo][${KEY}]`,
        references: referenceMap({ [KEY]: piece("foo-id", "Foo") }),
      });

      const clicks = await clicked(
        element,
        () => pressOn(view, ".cm-mention-ref-pill", 1),
      );

      expect(clicks).toEqual([]);
    });

    it("leaves a press on ordinary text to the editor", async () => {
      const { element, view } = await mountEditor({ value: "plain text" });

      const clicks = await clicked(element, () => pressOn(view, "x", 2));

      // The editor's own handling places the caret, which a press the pill
      // handler took would leave where it was.
      expect(view.state.selection.main.head).not.toBe(0);
      expect(clicks).toEqual([]);
    });
  });

  describe("renaming a backlink", () => {
    it("writes the new name to the piece's title, without its emoji", async () => {
      const mentionable = universe(row("old-id", "Old"));
      const { element, view } = await mountEditor({
        value: "[[Old (old-id)]]",
        mentionable,
      });
      await element.accessForTestingOnly.resolvePieceIds();
      const renames = recorded<{ oldName: string; newName: string }>(
        element,
        "backlink-name-changed",
      );

      view.dispatch({ changes: { from: 2, to: 5, insert: "📝 Newer" } });

      expect(writesAt(mentionable, "of:old-id", ["title"])).toEqual([
        "Newer",
      ]);
      expect(renames.map(({ oldName, newName }) => [oldName, newName]))
        .toEqual([["Old", "📝 Newer"]]);
    });

    it("writes nothing for a backlink naming no listed piece, and warns", async () => {
      const mentionable = universe(row("other-id", "Other"));
      const { element, view } = await mountEditor({
        value: "[[Old (old-id)]]",
        mentionable,
      });
      await element.accessForTestingOnly.resolvePieceIds();
      const renames = recorded(element, "backlink-name-changed");
      const warnings = captureConsole("warn");
      try {
        view.dispatch({ changes: { from: 2, to: 5, insert: "New" } });
      } finally {
        warnings.restore();
      }

      expect(warnings.calls).toHaveLength(1);
      expect(writesAt(mentionable, "of:old-id", ["title"])).toEqual([]);
      expect(renames).toEqual([]);
    });
  });

  describe("editing a reference's label", () => {
    it("marks a label edited away from its destination's name, and clears the mark once it agrees again", async () => {
      const references = referenceMap({ [KEY]: bound(piece("foo-id", "Foo")) });
      const { element, view } = await mountEditor({
        value: `see [Foo][${KEY}]`,
        references,
      });
      const edits = recorded<{ label: string; modifiedTitle: boolean }>(
        element,
        "mention-ref-label-changed",
      );

      view.dispatch({ changes: { from: 8, insert: "d" } });
      await until(references, (map) => map?.[KEY].modifiedTitle === true);

      view.dispatch({ changes: { from: 8, to: 9 } });
      await until(references, (map) => map?.[KEY].modifiedTitle === false);

      expect(edits.map(({ label, modifiedTitle }) => [label, modifiedTitle]))
        .toEqual([["Food", true], ["Foo", false]]);
    });

    it("reports each further edit of a label already marked, writing the mark once", async () => {
      const references = referenceMap({ [KEY]: bound(piece("foo-id", "Foo")) });
      const { element, view } = await mountEditor({
        value: `see [Foo][${KEY}]`,
        references,
      });
      const edits = recorded<{ label: string }>(
        element,
        "mention-ref-label-changed",
      );

      view.dispatch({ changes: { from: 8, insert: "d" } });
      view.dispatch({ changes: { from: 9, insert: "s" } });

      expect(edits.map(({ label }) => label)).toEqual(["Food", "Foods"]);
      expect(writesAt(references, references.id(), [KEY, "modifiedTitle"]))
        .toEqual([true]);
    });
  });

  describe("a reference whose destination is renamed", () => {
    it("relabels the reference after its destination's new name", async () => {
      const destination = bound(piece("foo-id", "Foo"));
      const { element, view } = await mountEditor({
        value: `see [Foo][${KEY}]`,
        references: referenceMap({ [KEY]: destination }),
      });
      const relabeled = next(element, "cf-change");

      pushUpdate(destination, { [NAME]: "Bar", title: "Bar" });
      await relabeled;

      expect(view.state.doc.toString()).toBe(`see [Bar][${KEY}]`);
    });

    it("follows a key repointed at another piece, and no longer the first", async () => {
      const first = bound(piece("foo-id", "Foo"));
      const second = bound(piece("bar-id", "Bar"));
      const references = referenceMap({ [KEY]: first });
      const { element, view } = await mountEditor({
        value: `see [Foo][${KEY}]`,
        references,
      });
      const relabeled = next(element, "cf-change");

      pushUpdate(references, {
        [KEY]: { destination: second, modifiedTitle: false },
      } as unknown as MentionRefMap);
      await relabeled;
      expect(view.state.doc.toString()).toBe(`see [Bar][${KEY}]`);

      pushUpdate(first, { [NAME]: "Foo renamed", title: "Foo renamed" });
      await settled();
      expect(view.state.doc.toString()).toBe(`see [Bar][${KEY}]`);
    });

    it("keeps a label the person has claimed", async () => {
      const destination = bound(piece("foo-id", "Foo"));
      const references = referenceMap({ [KEY]: destination });
      pushUpdate(references, {
        [KEY]: { destination, modifiedTitle: true },
      } as unknown as MentionRefMap);
      const { view } = await mountEditor({
        value: `see [Mine][${KEY}]`,
        references,
      });

      pushUpdate(destination, { [NAME]: "Bar", title: "Bar" });
      await settled();

      expect(view.state.doc.toString()).toBe(`see [Mine][${KEY}]`);
    });
  });

  describe("collaboration setup", () => {
    /** A cell whose resolution answers with `resolution`. */
    function resolvingTo(resolution: Promise<unknown>): CellHandle<string> {
      const cell = createMockCellHandle("abc");
      Object.defineProperty(cell, "resolveAsCell", {
        value: () => resolution,
      });
      return cell;
    }

    it("reports a bound cell it cannot resolve", async () => {
      const element = Object.assign(new CFCodeEditor(), {
        value: resolvingTo(Promise.reject(new Error("unresolvable"))),
        collaborative: true,
      });
      const failed = next<{ message: string }>(element, "cf-error");
      await mount(element);

      expect((await failed).message).toBe("unresolvable");
    });

    for (const outcome of ["fails", "succeeds"] as const) {
      it(`abandons a setup whose resolution ${outcome} after collaboration is turned off`, async () => {
        const deferred = Promise.withResolvers<unknown>();
        const element = Object.assign(new CFCodeEditor(), {
          value: resolvingTo(deferred.promise),
          collaborative: true,
        });
        const errors = recorded(element, "cf-error");
        await mount(element);

        element.collaborative = false;
        await element.updateComplete;
        // Carried on, the setup would report the failure, or start a
        // controller, which asks the resolved cell's runtime for its codecs.
        const resolved = createMockCellHandle("abc");
        const asked: unknown[] = [];
        Object.assign(resolved.runtime(), {
          operationCodecs: () => {
            asked.push("codecs");
            return Promise.reject(new Error("no codecs"));
          },
        });
        if (outcome === "fails") deferred.reject(new Error("late"));
        else deferred.resolve(resolved);
        await settled();

        expect(errors).toEqual([]);
        expect(asked).toEqual([]);
      });
    }
  });

  describe("autofocus", () => {
    /** Gives `element` the size layout would, so it counts as visible. */
    function laidOut(element: CFCodeEditor): void {
      Object.defineProperty(element, "getBoundingClientRect", {
        value: () => ({ width: 200, height: 40 }),
      });
    }

    it("focuses the editor at the next frame once it is laid out", async () => {
      const element = Object.assign(new CFCodeEditor(), { autofocus: true });
      laidOut(element);
      await mount(element);

      await settle();

      expect(element.editorView!.hasFocus).toBe(true);
    });

    it("focuses nothing while `autofocus` is unset", async () => {
      const element = new CFCodeEditor();
      laidOut(element);
      await mount(element);

      await settle();

      expect(element.editorView!.hasFocus).toBe(false);
    });

    it("focuses nothing once `autofocus` is cleared before the frame", async () => {
      const element = Object.assign(new CFCodeEditor(), { autofocus: true });
      laidOut(element);
      await mount(element);

      element.autofocus = false;
      await element.updateComplete;
      await settle();

      expect(element.editorView!.hasFocus).toBe(false);
    });

    describe("an editor not yet laid out", () => {
      // happy-dom's observers never fire, so these stand in for the
      // browser's, recording what each is told to call.

      type Callback = (entries: { isIntersecting: boolean }[]) => void;

      /** An observer as the stand-in records it. */
      type Observer = {
        kind: "intersection" | "resize";
        callback: Callback;
        targets: unknown[];
        disconnected: boolean;
      };

      /**
       * Installs the stand-ins until `restore()`, and returns the observer of
       * `kind` watching `target`, which the editor's view does not: it
       * observes elements of its own.
       */
      function observing() {
        const observers: Observer[] = [];
        const original = {
          IntersectionObserver: globalThis.IntersectionObserver,
          ResizeObserver: globalThis.ResizeObserver,
        };
        const standIn = (kind: Observer["kind"]) =>
          class {
            #observer: Observer;
            constructor(callback: Callback) {
              this.#observer = {
                kind,
                callback,
                targets: [],
                disconnected: false,
              };
              observers.push(this.#observer);
            }
            observe(target: unknown) {
              this.#observer.targets.push(target);
            }
            unobserve() {}
            disconnect() {
              this.#observer.disconnected = true;
            }
          };
        Object.assign(globalThis, {
          IntersectionObserver: standIn("intersection"),
          ResizeObserver: standIn("resize"),
        });
        return {
          of: (kind: Observer["kind"], target: unknown): Observer =>
            observers.find((observer) =>
              observer.kind === kind && observer.targets.includes(target)
            )!,
          restore: () => Object.assign(globalThis, original),
        };
      }

      it("focuses the editor once it is resized into view, and not before", async () => {
        const observers = observing();
        try {
          const element = Object.assign(new CFCodeEditor(), {
            autofocus: true,
          });
          await mount(element);
          await settle();
          expect(element.editorView!.hasFocus).toBe(false);
          const resize = observers.of("resize", element);

          // A resize that leaves it without a size changes nothing.
          resize.callback([]);
          await settle();
          expect(element.editorView!.hasFocus).toBe(false);

          laidOut(element);
          resize.callback([]);
          await settle();
          expect(element.editorView!.hasFocus).toBe(true);
          expect(resize.disconnected).toBe(true);
        } finally {
          observers.restore();
        }
      });

      it("focuses the editor once it scrolls into view, and not before", async () => {
        const observers = observing();
        try {
          const element = Object.assign(new CFCodeEditor(), {
            autofocus: true,
          });
          await mount(element);
          await settle();
          const intersection = observers.of("intersection", element);

          laidOut(element);
          intersection.callback([{ isIntersecting: false }]);
          await settle();
          expect(element.editorView!.hasFocus).toBe(false);

          intersection.callback([{ isIntersecting: true }]);
          await settle();
          expect(element.editorView!.hasFocus).toBe(true);
          expect(intersection.disconnected).toBe(true);
        } finally {
          observers.restore();
        }
      });

      it("stops watching once the editor is removed", async () => {
        const observers = observing();
        try {
          const element = Object.assign(new CFCodeEditor(), {
            autofocus: true,
          });
          await mount(element);
          await settle();
          const resize = observers.of("resize", element);
          expect(resize.disconnected).toBe(false);

          element.remove();

          expect(resize.disconnected).toBe(true);
          expect(observers.of("intersection", element).disconnected).toBe(
            true,
          );
        } finally {
          observers.restore();
        }
      });
    });
  });

  describe("the mentioned list", () => {
    /** An editor whose one mention names a listed piece, resolved. */
    async function mentioning(mentioned: CellHandle<MentionableArray>) {
      const { element, view } = await mountEditor({
        value: "see [[Existing (existing-id)]]",
        mentionable: universe(row("existing-id", "Existing")),
        mentioned,
      });
      await element.accessForTestingOnly.resolvePieceIds();
      return { element, view };
    }

    /** The ids each write to `mentioned` named, write by write. */
    function writtenIds(mentioned: CellHandle<MentionableArray>): string[][] {
      return writesAt(mentioned, mentioned.id(), []).map((value) =>
        (value as { id: string }[]).map((entry) => entry.id)
      );
    }

    it("holds the editor read-only while the list is refused, and rewrites it once admitted", async () => {
      const mentioned = bound(
        createMockCellHandle<MentionableArray>([], {
          id: "of:mentioned" as CellRef["id"],
        }),
      );
      const { view } = await mentioning(mentioned);
      expect(writtenIds(mentioned)).toEqual([["of:existing-id"]]);

      pushRefusal(mentioned);
      expect(view.state.readOnly).toBe(true);

      // The list arrives without the mention, which the editor puts back.
      pushUpdate(mentioned, []);
      expect(view.state.readOnly).toBe(false);
      expect(
        mentioned.get()!.map(cellId),
      ).toEqual(["of:existing-id"]);
    });

    it("stops hearing a list it is no longer bound to", async () => {
      const first = bound(
        createMockCellHandle<MentionableArray>([], {
          id: "of:first" as CellRef["id"],
        }),
      );
      const { element, view } = await mentioning(first);

      element.mentioned = bound(
        createMockCellHandle<MentionableArray>([], {
          id: "of:second" as CellRef["id"],
        }),
      );
      await element.updateComplete;
      pushRefusal(first);

      expect(view.state.readOnly).toBe(false);
    });
  });

  describe("asking for a read", () => {
    it("holds the editor read-only, and reports nothing, when the worker refuses the read it asked for", async () => {
      const mentionable = bound(createMockCellHandle<MentionableArray>());
      refuseReads(mentionable);
      const errors = captureConsole("error");
      try {
        const { view } = await mountEditor({ value: "x", mentionable });
        await settled();

        expect(view.state.readOnly).toBe(true);
        expect(errors.calls).toEqual([]);
      } finally {
        errors.restore();
      }
    });
  });

  describe("completion that offers nothing", () => {
    // Each case types as a person does, so the editor's sources are asked,
    // and waits for the query to be answered.

    async function settlesAfterTyping(
      view: EditorView,
      text: string,
      at = view.state.doc.length,
    ): Promise<string | null> {
      const settles = completionSettles(view);
      view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        userEvent: "input.type",
      });
      return await settles;
    }

    it("closes for typing outside any query", async () => {
      const { view } = await mountEditor({
        mentionable: universe(row("existing-id", "Existing")),
      });
      expect(await settlesAfterTyping(view, "plain")).toBeNull();
    });

    it("closes while the caret sits in a complete backlink's name", async () => {
      const { element, view } = await mountEditor({
        value: "[[Exi (existing-id)]]",
        mentionable: universe(row("existing-id", "Existing")),
      });
      await element.accessForTestingOnly.resolvePieceIds();
      expect(await settlesAfterTyping(view, "s", 5)).toBeNull();
    });

    for (
      const [what, mentionable] of [
        ["no universe", () => null],
        ["an empty universe", () => universe()],
      ] as const
    ) {
      it(`closes after \`[[\` and after \`#\` with ${what}`, async () => {
        const { view } = await mountEditor({ mentionable: mentionable() });
        expect(await settlesAfterTyping(view, "[[Exi")).toBeNull();
        expect(await settlesAfterTyping(view, "\n#4")).toBeNull();
      });
    }
  });

  describe("a universe whose rows have not resolved", () => {
    /** Holds every row's resolution until `release()`. */
    function holdingRows() {
      const held = Promise.withResolvers<void>();
      const interception = resolving((handle, resolve) =>
        isRowPiece(handle) ? held.promise.then(resolve) : undefined
      );
      return {
        release: () => held.resolve(),
        restore: () => interception.restore(),
      };
    }

    /** A focused editor whose universe's one row is still resolving. */
    async function focusedOverHeldRow(typed: string) {
      const { element, view } = await mountEditor({
        mentionable: universe({
          ...row("row-id", "Row"),
          shortName: "42",
        }),
      });
      // Focused as far as the editor can tell. A real focus would leave the
      // view's focus timer to read happy-dom's focus after the case ends,
      // which fails once another case holds focus in another editor.
      Object.defineProperty(view, "hasFocus", { get: () => true });
      const settles = completionSettles(view);
      view.dispatch({
        changes: { from: 0, insert: typed },
        selection: { anchor: typed.length },
        userEvent: "input.type",
      });
      // The row is withheld until it resolves, so nothing is offered yet.
      expect(await settles).toBeNull();
      return { element, view };
    }

    it("reopens the completion once the row resolves", async () => {
      const rows = holdingRows();
      try {
        const { view } = await focusedOverHeldRow("[[Ro");
        rows.release();
        await settled();
        expect(completionStatus(view.state)).not.toBeNull();
      } finally {
        rows.restore();
      }
    });

    it("leaves the completion closed once Escape has dismissed it", async () => {
      const rows = holdingRows();
      try {
        const { view } = await focusedOverHeldRow("[[Ro");
        press(view, "Escape");
        rows.release();
        await settled();
        expect(completionStatus(view.state)).toBeNull();
      } finally {
        rows.restore();
      }
    });

    it("leaves the completion closed once the caret has left a `#` query", async () => {
      const rows = holdingRows();
      try {
        const { view } = await focusedOverHeldRow("#4");
        view.dispatch({
          changes: { from: 2, insert: " later" },
          selection: { anchor: 8 },
        });
        rows.release();
        await settled();
        expect(completionStatus(view.state)).toBeNull();
      } finally {
        rows.restore();
      }
    });

    it("completes an entry that has not resolved to a wiki-link naming it, given a map", async () => {
      // An entry that IS its piece is offered before it resolves, and a
      // reference can store only a resolved cell.
      const interception = resolving((handle) =>
        handle.ref().path.length === 1 ? new Promise(() => {}) : undefined
      );
      try {
        const references = referenceMap();
        const { view } = await mountEditor({
          value: "[[Direct",
          mentionable: universe({ [NAME]: "Direct", title: "Direct" }),
          references,
        }, { caretAtEnd: true });

        press(view, "Enter");

        expect(view.state.doc.toString()).toBe("[[Direct (universe)]]");
        expect(references.get()).toEqual({});
      } finally {
        interception.restore();
      }
    });

    it("creates no piece for a row whose piece cannot be resolved", async () => {
      const interception = resolving((handle) =>
        isRowPiece(handle)
          ? Promise.reject(new Error("unresolvable"))
          : undefined
      );
      try {
        let creations = 0;
        const { view } = await mountEditor({
          value: "[[Row",
          mentionable: universe(row("row-id", "Row")),
          pattern: pattern({
            createPiece: (() => {
              creations++;
              return Promise.resolve(created(piece("new-id", "Row")));
            }) as RuntimeClient["createPiece"],
          }),
        }, { caretAtEnd: true });
        await settled();

        press(view, "Enter");
        await settled();

        expect(creations).toBe(0);
        expect(view.state.doc.toString()).toBe("[[Row");
      } finally {
        interception.restore();
      }
    });
  });

  describe("creating a piece for a mention", () => {
    it("links nothing where the person changed the mention while the piece was created", async () => {
      const creation = Promise.withResolvers<
        Awaited<ReturnType<RuntimeClient["createPiece"]>>
      >();
      const { element, view } = await mountEditor({
        value: "[[New",
        pattern: pattern({
          createPiece: (() => creation.promise) as RuntimeClient["createPiece"],
        }),
      }, { caretAtEnd: true });
      const announced = next(element, "backlink-create");

      press(view, "Enter");
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "other" },
      });
      creation.resolve(created(piece("new-id", "New")));
      await announced;

      expect(view.state.doc.toString()).toBe("other");
    });

    it("leaves the token, and reports nothing, for a create cancelled by the runtime's disposal", async () => {
      const { view } = await mountEditor({
        value: "[[New",
        references: referenceMap(),
        pattern: Object.assign(pattern({}), {
          runtime: () => ({
            signal: AbortSignal.abort(),
            createPiece: () => Promise.reject(new Error("disposed")),
          }),
        }),
      }, { caretAtEnd: true });
      const errors = captureConsole("error");
      try {
        press(view, "Enter");
        await settled();
      } finally {
        errors.restore();
      }

      expect(errors.calls).toEqual([]);
      expect(view.state.doc.toString()).toMatch(/^\[New\]\[[0-9a-z]{6}\]$/);
    });

    it("unwinds nothing where the person removed the token before the create failed", async () => {
      const creation = Promise.withResolvers<never>();
      const { view } = await mountEditor({
        value: "[[New",
        references: referenceMap(),
        pattern: pattern({
          createPiece: (() => creation.promise) as RuntimeClient["createPiece"],
        }),
      }, { caretAtEnd: true });
      const errors = captureConsole("error");
      try {
        press(view, "Enter");
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "gone" },
        });
        creation.reject(new Error("no piece"));
        await errors.called;
      } finally {
        errors.restore();
      }

      expect(view.state.doc.toString()).toBe("gone");
    });
  });

  describe("the mentioned list's contents", () => {
    /** The ids `mentioned` holds now. */
    function ids(mentioned: CellHandle<MentionableArray>): string[] {
      return mentioned.get()!.map(cellId);
    }

    it("passes over an empty slot in the universe and in the list", async () => {
      const mentioned = bound(
        createMockCellHandle(
          [null] as unknown as MentionableArray,
          { id: "of:mentioned" as CellRef["id"] },
        ),
      );
      const { element } = await mountEditor({
        value: "see [[Existing (existing-id)]]",
        mentionable: universe(null, row("existing-id", "Existing")),
        mentioned,
      });
      await element.accessForTestingOnly.resolvePieceIds();

      expect(ids(mentioned)).toEqual(["of:existing-id"]);
    });

    it("lists a piece the document mentions twice once", async () => {
      const mentioned = bound(
        createMockCellHandle<MentionableArray>([], {
          id: "of:mentioned" as CellRef["id"],
        }),
      );
      const { element } = await mountEditor({
        value: "[[Existing (existing-id)]] and [[Existing (existing-id)]]",
        mentionable: universe(row("existing-id", "Existing")),
        mentioned,
      });
      await element.accessForTestingOnly.resolvePieceIds();

      expect(ids(mentioned)).toEqual(["of:existing-id"]);
    });

    it("lists nothing for mentions no universe can resolve", async () => {
      const mentioned = bound(
        createMockCellHandle(
          [piece("stale", "Stale")] as unknown as MentionableArray,
          { id: "of:mentioned" as CellRef["id"] },
        ),
      );
      await mountEditor({
        value: "see [[Existing (existing-id)]]",
        mentioned,
      });

      expect(ids(mentioned)).toEqual([]);
    });

    it("lists each referenced destination once, and none for a key naming no cell", async () => {
      const destination = bound(piece("foo-id", "Foo"));
      const mentioned = bound(
        createMockCellHandle<MentionableArray>([], {
          id: "of:mentioned" as CellRef["id"],
        }),
      );
      const references = bound(
        createMockCellHandle({
          [KEY]: { destination, modifiedTitle: false },
          b7k2m1: { modifiedTitle: false },
        }) as unknown as CellHandle<MentionRefMap>,
      );
      await mountEditor({
        value: `[Foo][${KEY}] [Foo][${KEY}] [Bar][b7k2m1]`,
        references,
        mentioned,
      });

      expect(ids(mentioned)).toEqual(["of:foo-id"]);
    });

    it("writes the list once for edits that leave its mentions as they were", async () => {
      const mentioned = bound(
        createMockCellHandle<MentionableArray>([], {
          id: "of:mentioned" as CellRef["id"],
        }),
      );
      const { view } = await mountEditor({
        value: `see [Foo][${KEY}]`,
        references: referenceMap({ [KEY]: bound(piece("foo-id", "Foo")) }),
        mentioned,
      }, { caretAtEnd: true });
      view.dispatch({ changes: { from: 0, insert: "I " } });
      await settled();
      const written = writesAt(mentioned, mentioned.id(), []).length;

      view.dispatch({ changes: { from: 0, insert: "So " } });
      view.dispatch({ changes: { from: 0, insert: "And " } });
      await settled();

      expect(written).toBeGreaterThan(0);
      expect(writesAt(mentioned, mentioned.id(), []).length).toBe(written);
    });
  });

  describe("a backlink whose piece is renamed elsewhere", () => {
    // The universe's row resolves to a piece handle the case holds, so the
    // case can rename the piece and deliver the title subscription the
    // editor opens on it.

    type Renaming = {
      element: CFCodeEditor;
      view: EditorView;
      pieceCell: CellHandle<Record<string, unknown>>;
      /** The editor's subscription to the piece's title. */
      title: { handle: CellHandle<unknown>; closed: boolean };
      /** Renames the piece, and delivers its new title. */
      rename(value: Record<string, unknown>): void;
    };

    /**
     * Runs `body` against an editor over `[[Old (old-id)]]` whose universe
     * resolves its row to a piece called "Old".
     */
    async function renaming(
      properties: Partial<CFCodeEditor>,
      body: (renaming: Renaming) => Promise<void> | void,
    ): Promise<void> {
      const pieceCell = bound(
        createMockCellHandle<Record<string, unknown>>(
          { [NAME]: "Old", title: "Old" },
          { id: "of:old-id" as CellRef["id"] },
        ),
      );
      const interception = resolving((handle) =>
        isRowPiece(handle) ? Promise.resolve(pieceCell) : undefined
      );
      const subscriptions = tappingSubscriptions();
      try {
        const { element, view } = await mountEditor({
          value: "[[Old (old-id)]]",
          mentionable: universe(row("old-id", "Old")),
          ...properties,
        });
        await element.accessForTestingOnly.resolvePieceIds();
        // The editor follows a backlink's piece from the first edit after
        // the piece resolves.
        view.dispatch({
          changes: { from: view.state.doc.length, insert: " " },
        });
        await settled();
        const [title] = subscriptions.of("of:old-id", ["title"]);
        await body({
          element,
          view,
          pieceCell,
          title,
          rename: (value) => {
            pushUpdate(pieceCell, value);
            pushUpdate(title.handle, value.title);
          },
        });
      } finally {
        subscriptions.restore();
        interception.restore();
      }
    }

    it("relabels the backlink with the piece's new name", async () => {
      await renaming({}, async ({ view, rename }) => {
        rename({ [NAME]: "📝 New", title: "New" });
        await settled();
        expect(view.state.doc.toString()).toBe("[[📝 New (old-id)]] ");
      });
    });

    it("relabels nothing for a piece renamed without a display name", async () => {
      await renaming({}, async ({ view, rename }) => {
        rename({ title: "New" });
        await settled();
        expect(view.state.doc.toString()).toBe("[[Old (old-id)]] ");
      });
    });

    it("relabels nothing once the content no longer holds the backlink", async () => {
      const content = bound(createMockCellHandle("[[Old (old-id)]]"));
      await renaming({ value: content }, async ({ view, rename }) => {
        pushUpdate(content, "plain");
        rename({ [NAME]: "📝 New", title: "New" });
        await settled();
        expect(view.state.doc.toString()).toBe("plain");
      });
    });

    it("relabels nothing, and writes nothing, while a read is refused, and relabels once it is admitted", async () => {
      const content = bound(createMockCellHandle("[[Old (old-id)]]"));
      const mentioned = bound(
        createMockCellHandle<MentionableArray>([], {
          id: "of:mentioned" as CellRef["id"],
        }),
      );
      await renaming(
        { value: content, mentioned },
        async ({ view, rename }) => {
          pushRefusal(mentioned);
          const written = writesAt(content, content.id(), []).length;
          rename({ [NAME]: "📝 New", title: "New" });
          await settled();
          expect(view.state.doc.toString()).toBe("[[Old (old-id)]] ");
          expect(writesAt(content, content.id(), []).length).toBe(written);

          pushUpdate(mentioned, []);
          await settled();
          expect(view.state.doc.toString()).toBe("[[📝 New (old-id)]] ");
        },
      );
    });

    it("keeps the backlink as written when catching up on a piece whose title is refused", async () => {
      const mentioned = bound(
        createMockCellHandle<MentionableArray>([], {
          id: "of:mentioned" as CellRef["id"],
        }),
      );
      await renaming(
        { mentioned },
        async ({ view, pieceCell, title }) => {
          pushRefusal(title.handle);
          pushUpdate(pieceCell, { [NAME]: "📝 New", title: "New" });
          pushRefusal(mentioned);
          pushUpdate(mentioned, []);
          await settled();
          expect(view.state.doc.toString()).toBe("[[Old (old-id)]] ");
        },
      );
    });

    it("stops following the piece once its backlink leaves the document", async () => {
      await renaming({}, ({ view, title }) => {
        expect(title.closed).toBe(false);
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "gone" },
        });
        expect(title.closed).toBe(true);
      });
    });

    describe("under collaboration", () => {
      // A stand-in controller, as one that has started would answer.

      function controller(
        answers: { active: boolean; prepared?: Promise<boolean> },
      ) {
        let changes = 0;
        const stand = {
          active: answers.active,
          prepareExternalChange: () =>
            answers.prepared ?? Promise.resolve(true),
          localDocChanged: () => {
            changes++;
            return Promise.resolve();
          },
          stop: () => Promise.resolve(),
        };
        return {
          controller: stand as unknown as CodeMirrorCollaborationController,
          changes: () => changes,
        };
      }

      it("submits the relabel through a ready collaboration", async () => {
        await renaming({}, async ({ element, view, rename }) => {
          const collaboration = controller({ active: true });
          element.accessForTestingOnly.collaboration = collaboration.controller;
          rename({ [NAME]: "📝 New", title: "New" });
          await settled();
          expect(view.state.doc.toString()).toBe("[[📝 New (old-id)]] ");
          expect(collaboration.changes()).toBe(1);
        });
      });

      it("relabels nothing through a collaboration that cannot confirm its edits first, as one that has ended cannot", async () => {
        await renaming({}, async ({ element, view, rename }) => {
          const collaboration = controller({
            active: false,
            prepared: Promise.resolve(false),
          });
          element.accessForTestingOnly.collaboration = collaboration.controller;
          rename({ [NAME]: "📝 New", title: "New" });
          await settled();
          expect(view.state.doc.toString()).toBe("[[Old (old-id)]] ");
          expect(collaboration.changes()).toBe(0);
        });
      });

      it("relabels nothing once the collaboration is replaced while it confirms its edits", async () => {
        await renaming({}, async ({ element, view, rename }) => {
          const prepared = Promise.withResolvers<boolean>();
          const collaboration = controller({
            active: true,
            prepared: prepared.promise,
          });
          element.accessForTestingOnly.collaboration = collaboration.controller;
          rename({ [NAME]: "📝 New", title: "New" });
          element.accessForTestingOnly.collaboration = undefined;
          prepared.resolve(true);
          await settled();
          expect(view.state.doc.toString()).toBe("[[Old (old-id)]] ");
        });
      });

      it("relabels nothing in an editor removed while a release settled", async () => {
        await renaming({}, async ({ element, rename }) => {
          const release = releasing(element);
          const changes = recorded(element, "cf-change");
          rename({ [NAME]: "📝 New", title: "New" });
          element.remove();
          release.resolve();
          await settled();
          expect(changes).toEqual([]);
        });
      });
    });
  });

  describe("a reference whose destination is renamed elsewhere", () => {
    async function referencing(
      body: (
        context: {
          element: CFCodeEditor;
          view: EditorView;
          destination: CellHandle<Record<string, unknown>>;
        },
      ) => Promise<void>,
    ): Promise<void> {
      const destination = bound(piece("foo-id", "Foo"));
      const { element, view } = await mountEditor({
        value: `see [Foo][${KEY}]`,
        references: referenceMap({ [KEY]: destination }),
      });
      await settled();
      await body({ element, view, destination });
    }

    it("keeps the label for a destination that delivers no name, or whose read is refused", async () => {
      await referencing(async ({ view, destination }) => {
        pushUpdate(destination, { title: "Untitled" });
        await settled();
        pushRefusal(destination);
        await settled();
        expect(view.state.doc.toString()).toBe(`see [Foo][${KEY}]`);
      });
    });

    it("relabels once a release in progress settles", async () => {
      await referencing(async ({ element, view, destination }) => {
        const release = releasing(element);
        pushUpdate(destination, { [NAME]: "Bar", title: "Bar" });
        await settled();
        expect(view.state.doc.toString()).toBe(`see [Foo][${KEY}]`);

        release.resolve();
        await settled();
        expect(element.accessForTestingOnly.collaboration).toBeUndefined();
        expect(view.state.doc.toString()).toBe(`see [Bar][${KEY}]`);
      });
    });

    it("relabels nothing in an editor removed while a release settled", async () => {
      await referencing(async ({ element, destination }) => {
        const release = releasing(element);
        const changes = recorded(element, "cf-change");
        pushUpdate(destination, { [NAME]: "Bar", title: "Bar" });
        await settled();
        element.remove();
        release.resolve();
        await settled();
        expect(changes).toEqual([]);
      });
    });

    it("relabels nothing through a collaboration that cannot confirm its edits first, as one that has ended cannot", async () => {
      await referencing(async ({ element, view, destination }) => {
        element.accessForTestingOnly.collaboration = {
          active: false,
          prepareExternalChange: () => Promise.resolve(false),
          stop: () => Promise.resolve(),
        } as unknown as CodeMirrorCollaborationController;
        pushUpdate(destination, { [NAME]: "Bar", title: "Bar" });
        await settled();
        expect(view.state.doc.toString()).toBe(`see [Foo][${KEY}]`);
      });
    });

    it("relabels nothing once the collaboration is replaced while it confirms its edits", async () => {
      await referencing(async ({ element, view, destination }) => {
        const prepared = Promise.withResolvers<boolean>();
        element.accessForTestingOnly.collaboration = {
          active: true,
          prepareExternalChange: () => prepared.promise,
          stop: () => Promise.resolve(),
        } as unknown as CodeMirrorCollaborationController;
        pushUpdate(destination, { [NAME]: "Bar", title: "Bar" });
        await settled();
        element.accessForTestingOnly.collaboration = undefined;
        prepared.resolve(true);
        await settled();
        expect(view.state.doc.toString()).toBe(`see [Foo][${KEY}]`);
      });
    });

    it("shows the short name of the first row standing for the destination", async () => {
      const shortNamed = (shortName: string) => ({
        ...row("foo-id", `Foo ${shortName}`),
        shortName,
      });
      const { element, view } = await mountEditor({
        value: `see [Foo][${KEY}]`,
        mentionable: universe(shortNamed("1"), shortNamed("2")),
        references: referenceMap({ [KEY]: bound(piece("foo-id", "Foo")) }),
      });
      await element.accessForTestingOnly.resolvePieceIds();
      await settled();

      expect(
        view.contentDOM.querySelector(".cm-mention-ref-pill")
          ?.getAttribute("data-short-name"),
      ).toBe("1");
    });

    it("reports no edit of a label whose key the map holds no entry for", async () => {
      // A mention deleted has its entry collected, which leaves the key in
      // the map with nothing behind it; an undo then brings the token back.
      const { element, view } = await mountEditor({
        value: `see [Foo][${KEY}] end`,
        references: bound(
          createMockCellHandle({ [KEY]: undefined }) as unknown as CellHandle<
            MentionRefMap
          >,
        ),
      });
      const edits = recorded(element, "mention-ref-label-changed");

      view.dispatch({ changes: { from: 8, insert: "d" } });

      expect(view.contentDOM.querySelector(".cm-mention-ref-pill")).not
        .toBeNull();
      expect(edits).toEqual([]);
    });

    it("navigates nowhere from a pill whose key names no cell", async () => {
      const { element, view } = await mountEditor({
        value: `see [Bar][${KEY}]`,
        references: bound(
          createMockCellHandle({
            [KEY]: { modifiedTitle: false },
          }) as unknown as CellHandle<MentionRefMap>,
        ),
      });
      const clicks = recorded(element, "backlink-click");
      Object.defineProperty(view, "posAtCoords", { value: () => 6 });
      const time = new FakeTime();
      try {
        view.contentDOM.querySelector(".cm-mention-ref-pill")!.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );
        time.tick(0);
      } finally {
        time.restore();
      }

      expect(clicks).toEqual([]);
    });
  });

  describe("presence", () => {
    // A collaboration stand-in at a confirmed version, whose cell's runtime
    // joins rooms this records, stands in for one Memory has started.

    const SELF = "participant:self";

    class Room implements PresenceRoomHandle {
      readonly participantId = SELF;
      readonly room = "derived";
      readonly participants: PresenceRecord[] = [];
      readonly #listeners = new Set<(event: PresenceEvent) => void>();
      setName(): void {}
      setFacet(): void {}
      clearFacet(): void {}
      setFocused(): void {}
      subscribe(listener: (event: PresenceEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      }
      leave(): Promise<void> {
        return Promise.resolve();
      }
      emit(event: PresenceEvent): void {
        for (const listener of [...this.#listeners]) listener(event);
      }
    }

    function caret(participantId: string): PresenceRecord {
      return {
        participantId,
        revision: 1,
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

    /**
     * An editor joined, as "Ada", to the room `join` answers, and the
     * participants it draws.
     */
    async function present(join: () => Promise<PresenceRoomHandle>) {
      const cell = createMockCellHandle("abc");
      Object.assign(cell.runtime(), { joinPresenceRoom: join });
      const element = Object.assign(new CFCodeEditor(), {
        value: "abc",
        collaborative: true,
      });
      // Without a cell to collaborate on, the editor's own setup reports
      // that, and leaves the stand-in to answer for the collaboration.
      element.addEventListener("cf-error", () => {});
      await mount(element);
      element.accessForTestingOnly.collaboration = {
        active: true,
        cell,
        synchronizationSnapshot: {
          confirmedCursor: { epoch: 2, version: 4 },
          pendingChanges: [],
          field: {
            space: "did:key:mock",
            branch: "main",
            id: "of:mock-cell",
            scopeKey: "space",
            path: [],
          },
          anchors: {},
        },
        stop: () => Promise.resolve(),
      } as unknown as CodeMirrorCollaborationController;
      const errors = recorded<{ category: string }>(
        element,
        "cf-presence-error",
      );
      element.participantName = "Ada";
      await element.updateComplete;
      await settled();
      const view = element.editorView!;
      return {
        element,
        errors,
        participants: () => [
          ...(codeMirrorPresenceState(view.state)?.participants.keys() ?? []),
        ],
      };
    }

    it("draws a peer's caret, and not its own record echoed back", async () => {
      const room = new Room();
      const { participants } = await present(() => Promise.resolve(room));

      room.emit({ kind: "upsert", participant: caret(SELF) });
      expect(participants()).toEqual([]);

      room.emit({ kind: "upsert", participant: caret("peer:1") });
      expect(participants()).toEqual(["peer:1"]);
    });

    it("removes a peer that leaves, and ignores its own leaving", async () => {
      const room = new Room();
      const { participants } = await present(() => Promise.resolve(room));
      room.emit({ kind: "upsert", participant: caret("peer:1") });

      room.emit({ kind: "remove", participantId: SELF });
      expect(participants()).toEqual(["peer:1"]);

      room.emit({ kind: "remove", participantId: "peer:1" });
      expect(participants()).toEqual([]);
    });

    it("reports nothing for a join that fails after the room was left", async () => {
      const first = Promise.withResolvers<PresenceRoomHandle>();
      let joins = 0;
      const { element, errors } = await present(() =>
        joins++ === 0 ? first.promise : Promise.resolve(new Room())
      );

      element.presenceRoom = "abcdefghijklmnopqrstuv";
      await element.updateComplete;
      first.reject(new Error("socket closed"));
      await settled();

      expect(joins).toBe(2);
      expect(errors).toEqual([]);
    });
  });

  describe("collaboration handing over", () => {
    // A stand-in for the controller already running, which the editor
    // stops before the next setup takes over.

    function running(stop: Promise<void>) {
      return {
        active: true,
        stop: () => stop,
        dispose: () => {},
      } as unknown as CodeMirrorCollaborationController;
    }

    it("refreshes the content once for two setups waiting on one stop", async () => {
      const content = bound(createMockCellHandle("abc"));
      let pulls = 0;
      Object.defineProperty(content, "pull", {
        value: () => {
          pulls++;
          return Promise.resolve("abc");
        },
      });
      const { element } = await mountEditor({ value: content });
      await settled();
      pulls = 0;
      const stop = Promise.withResolvers<void>();
      element.accessForTestingOnly.collaboration = running(stop.promise);

      element.collaborative = true;
      await element.updateComplete;
      element.collaborative = false;
      await element.updateComplete;
      stop.resolve();
      await settled();

      expect(pulls).toBe(1);
    });

    it("reports a failed stop once for two setups waiting on it", async () => {
      const { element } = await mountEditor({ value: "abc" });
      const errors = recorded<{ message: string }>(element, "cf-error");
      const stop = Promise.withResolvers<void>();
      element.accessForTestingOnly.collaboration = running(stop.promise);

      element.collaborative = true;
      await element.updateComplete;
      element.collaborative = false;
      await element.updateComplete;
      stop.reject(new Error("pending edit"));
      await settled();

      expect(errors.map((error) => error.message)).toEqual(["pending edit"]);
    });

    it("keeps the editor read-only for a newer setup while an older one refreshes", async () => {
      const first = bound(createMockCellHandle("abc"));
      const second = bound(
        createMockCellHandle("abc", { id: "of:second" as CellRef["id"] }),
      );
      const refreshed = Promise.withResolvers<string>();
      Object.defineProperty(second, "pull", { value: () => refreshed.promise });
      // The newer setup resolves the cell to collaborate on, which never
      // answers, so it stays read-only as setup does.
      let resolutions = 0;
      Object.defineProperty(second, "resolveAsCell", {
        value: () => {
          resolutions++;
          return new Promise(() => {});
        },
      });
      const { element, view } = await mountEditor({ value: first });
      element.accessForTestingOnly.collaboration = running(Promise.resolve());

      element.value = second;
      await element.updateComplete;
      await settled();
      element.collaborative = true;
      await element.updateComplete;
      await settled();
      refreshed.resolve("abc");
      await settled();

      // Carried on, the older setup would set up collaboration as well.
      expect(resolutions).toBe(1);
      expect(view.state.readOnly).toBe(true);
    });
  });

  describe("a controller superseded while it runs", () => {
    /** A field Memory holds no collaborative edit for, holding `text`. */
    const inactive = (text = "abc") => ({
      branch: "",
      id: "of:mock-cell",
      scopeKey: "",
      path: [],
      active: false,
      codec: null,
      cursor: null,
      baselineHash: "baseline",
      materialized: text,
      anchors: {},
      operations: [],
    });

    /**
     * A collaborative editor over a cell whose runtime answers as
     * `runtime` does, and the events it fires.
     */
    async function collaborating(runtime: Record<string, unknown>) {
      const cell = createMockCellHandle("abc");
      Object.assign(cell.runtime(), {
        closeOperationSession: () => Promise.resolve(),
        ...runtime,
      });
      const element = Object.assign(new CFCodeEditor(), {
        value: cell,
        collaborative: true,
        timingStrategy: "immediate",
      });
      const events: string[] = [];
      for (const type of ["cf-error", "cf-collaboration-reconcile"]) {
        element.addEventListener(type, () => events.push(type));
      }
      await mount(element);
      await settled();
      return { element, events };
    }

    it("reports nothing for a start that fails after collaboration is turned off", async () => {
      const codecs = Promise.withResolvers<string[]>();
      const { element, events } = await collaborating({
        operationCodecs: () => codecs.promise,
      });

      element.collaborative = false;
      await element.updateComplete;
      await settled();
      codecs.reject(new Error("no codecs"));
      await settled();

      expect(events).toEqual([]);
      expect(element.editorView!.state.readOnly).toBe(false);
    });

    it("reports nothing for a controller that fails while a newer setup stops it", async () => {
      let deliver: ((snapshot: unknown) => void) | undefined;
      const { element, events } = await collaborating({
        operationCodecs: () => Promise.resolve([CODEMIRROR_CHANGESET_CODEC]),
        queryOperationField: () => Promise.resolve(inactive()),
        subscribeOperationField: (
          _cell: unknown,
          callback: (snapshot: unknown) => void,
        ) => {
          deliver = callback;
          return Promise.resolve(() => {});
        },
        // The edit below stays unconfirmed, which keeps the stop waiting.
        applyOperation: () => new Promise(() => {}),
      });
      const view = element.editorView!;
      view.dispatch({ changes: { from: 3, insert: "!" } });

      element.collaborative = false;
      await element.updateComplete;
      // Memory's text no longer agrees with the unconfirmed edit, which
      // fails the controller.
      deliver!({ ...inactive("canonical"), baselineHash: "rewritten" });
      await settled();

      expect(events).toEqual([]);
    });
  });

  describe("other paths", () => {
    it("reports a click on a highlight", async () => {
      const { element, view } = await mountEditor({
        value: "hello world",
        highlights: [{ id: "h1", fromAnchor: "a", toAnchor: "b" }],
      });
      view.dispatch({ effects: setHighlightAnchorsEffect.of({ a: 0, b: 5 }) });
      // happy-dom lays nothing out, so the view is told where the click
      // landed as the browser's layout would tell it.
      Object.defineProperties(view, {
        posAndSideAtCoords: { value: () => ({ pos: 2, assoc: 1 }) },
        lineBlockAt: { value: () => ({ top: 0, bottom: 20 }) },
        documentTop: { get: () => 0 },
        coordsForChar: {
          value: () => ({ left: 0, right: 100, top: 0, bottom: 20 }),
        },
      });
      const clicks = recorded(element, "cf-highlight-click");

      view.contentDOM.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          clientX: 5,
          clientY: 5,
        }),
      );

      expect(clicks).toEqual([{ id: "h1" }]);
    });

    it("uploads no further image once the content is refused", async () => {
      const cell = bound(createMockCellHandle("x"));
      const upload = Promise.withResolvers<{ id: string; url: string }>();
      let uploads = 0;
      Object.assign(cell.runtime(), {
        uploadBlob: () => {
          uploads++;
          return upload.promise;
        },
      });
      const { element, view } = await mountEditor({ value: cell });
      const pastes = recorded(element, "cf-file-paste");

      paste(view, { files: [image("a.png"), image("b.png")] });
      pushRefusal(cell);
      upload.resolve({ id: "blob-1", url: "/blobs/1" });
      await settled();

      expect(uploads).toBe(1);
      expect(pastes).toEqual([]);
    });

    it("leaves the token, and reports nothing, for a pasted URL whose read the runtime's disposal cancels", async () => {
      const url = `//${SPACE}/of:fid1:${HASH}`;
      const { view } = await mountEditor({
        value: "",
        references: referenceMap(),
        pattern: Object.assign(pattern({}), {
          runtime: () => ({
            signal: AbortSignal.abort(),
            getCell: () => Promise.reject(new Error("disposed")),
          }),
        }),
      });
      const errors = captureConsole("error");
      try {
        paste(view, { text: url });
        await settled();
      } finally {
        errors.restore();
      }

      expect(errors.calls).toEqual([]);
      expect(view.state.doc.toString()).not.toBe(url);
    });

    it("focuses nothing, and fails nothing, when `autofocus` is set on a removed editor", async () => {
      // Given the size layout would give it, the editor passes the visibility
      // check, so its having no view is all that stands between the attempt
      // and a focus call. A failing attempt throws in the frame `settle()`
      // runs, which fails the case.

      const { element } = await mountEditor();
      Object.defineProperty(element, "getBoundingClientRect", {
        value: () => ({ width: 200, height: 40 }),
      });
      element.remove();

      element.autofocus = true;
      await element.updateComplete;
      await settle();
    });
  });

  describe("removal", () => {
    it("destroys the editor, and stops following the bound cell", async () => {
      const cell = bound(createMockCellHandle("hello"));
      const { element, view } = await mountEditor({ value: cell });

      element.remove();
      pushUpdate(cell, "changed");

      expect(element.editorView).toBeUndefined();
      expect(view.state.doc.toString()).toBe("hello");
      expect(element.shadowRoot!.querySelector(".cm-editor")).toBeNull();
    });
  });
});
