import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  autocompletion,
  type Completion,
  CompletionContext,
  type CompletionResult,
  completionStatus,
} from "@codemirror/autocomplete";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { NAME } from "@commonfabric/runner/shared";
import { type CellHandle, type CellRef } from "@commonfabric/runtime-client";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import type { MentionRefMap } from "../../core/mention-refs.ts";
import type { Mentionable, MentionableArray } from "../../core/mentionable.ts";
import {
  mentionRefField,
  refShortNameField,
  refShortNames,
  setKnownRefKeys,
} from "./features/mention-refs.ts";
import { CFCodeEditor, MimeType } from "./index.ts";

describe("CFCodeEditor", () => {
  it("should create element instance", () => {
    const element = new CFCodeEditor();
    expect(element).toBeInstanceOf(CFCodeEditor);
  });

  it("should have default properties", () => {
    const element = new CFCodeEditor();
    expect(element.value).toBe("");
    expect(element.language).toBe(MimeType.markdown);
    expect(element.disabled).toBe(false);
    expect(element.readonly).toBe(false);
    expect(element.placeholder).toBe("");
    expect(element.timingStrategy).toBe("debounce");
    expect(element.timingDelay).toBe(500);
    expect(element.autofocus).toBe(false);
    expect(element.cursorPosition).toBe("start");
    expect(element.collaborative).toBe(false);
    // No reference map, so mentions are minted as wiki-links.
    expect(element.references).toBe(null);
    // No extra hosts; a pasted page URL is judged against this document's own.
    expect(element.fabricHosts).toEqual([]);
  });

  it("should have MimeType constants", () => {
    expect(MimeType.javascript).toBe("text/javascript");
    expect(MimeType.typescript).toBe("text/x.typescript");
    expect(MimeType.markdown).toBe("text/markdown");
    expect(MimeType.json).toBe("application/json");
    expect(MimeType.css).toBe("text/css");
    expect(MimeType.html).toBe("text/html");
    expect(MimeType.jsx).toBe("text/x.jsx");
  });

  it("should allow setting properties", () => {
    const element = new CFCodeEditor();
    element.value = "const x = 42;";
    element.language = MimeType.javascript;
    element.readonly = true;
    element.timingStrategy = "immediate";
    element.timingDelay = 100;

    expect(element.value).toBe("const x = 42;");
    expect(element.language).toBe(MimeType.javascript);
    expect(element.readonly).toBe(true);
    expect(element.timingStrategy).toBe("immediate");
    expect(element.timingDelay).toBe(100);
  });

  it("should allow setting autofocus and cursorPosition", () => {
    const element = new CFCodeEditor();
    element.autofocus = true;
    element.cursorPosition = "end";

    expect(element.autofocus).toBe(true);
    expect(element.cursorPosition).toBe("end");
  });

  it("should focus the editor when autofocus becomes true", () => {
    const element = new CFCodeEditor();
    let focused = false;
    (element as any)._editorView = {
      focus: () => {
        focused = true;
      },
    };

    element.autofocus = true;
    (element as any).updated(new Map([["autofocus", false]]));

    expect(focused).toBe(true);
  });
});

describe("CFCodeEditor backlink disposal handling", () => {
  // createBacklinkFromPattern issues an IPC createPiece during a [[mention]]
  // gesture. On a disposal race (logout, runtime swap) that rejects with the
  // standard AbortError; the catch must treat it as cancellation, not log it.
  // Exercised against a minimal `this` so no CodeMirror/DOM is constructed.

  function captureConsoleError(): { calls: unknown[][]; restore(): void } {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    return { calls, restore: () => (console.error = original) };
  }

  function editorThis(aborted: boolean): Record<string, unknown> {
    return {
      // The ambient @consume runtime is cleared on logout; the guard must read
      // the pattern's own runtime instead, so leave this undefined.
      runtime: undefined,
      pattern: {
        runtime: () => ({
          signal: { aborted },
          createPiece: () =>
            Promise.reject(new DOMException("aborted", "AbortError")),
        }),
        get: () => "{}",
        space: () => "did:key:mock",
      },
      _editorView: undefined,
      emit: () => {},
    };
  }

  function createBacklink(fakeThis: Record<string, unknown>): Promise<void> {
    const handler = (CFCodeEditor.prototype as unknown as {
      createBacklinkFromPattern(
        this: unknown,
        text: string,
        navigate: boolean,
      ): Promise<void>;
    }).createBacklinkFromPattern;
    return handler.call(fakeThis, "a note", true);
  }

  it("logs a backlink-create failure while the runtime is alive", async () => {
    const spy = captureConsoleError();
    try {
      await createBacklink(editorThis(false));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(1);
  });

  it("suppresses backlink-create logging when the runtime is disposed", async () => {
    const spy = captureConsoleError();
    try {
      await createBacklink(editorThis(true));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(0);
  });
});

describe("CFCodeEditor reference-map housekeeping", () => {
  // The map lives beside the document and has to stay in step with it. Both
  // behaviors below are about NOT losing something: a key another editor
  // minted, and a deletion still sitting in the debounce. Exercised against a
  // minimal `this`, so no CodeMirror or DOM is constructed.

  const KEY = "a3f9zz";
  const OTHER = "b7k2m1";

  function editorThis(doc: string, map: Record<string, unknown>) {
    const deleted: string[] = [];
    let flushed = 0;
    return {
      deleted,
      flushes: () => flushed,
      self: {
        _editorView: { state: { doc: { toString: () => doc } } },
        references: {
          get: () => map,
          key: (k: string) => ({
            set: (v: unknown) => {
              if (v === undefined) deleted.push(k);
            },
          }),
        },
        _refKeysAtLoad: new Set<string>(),
        _cellController: { flush: () => flushed++ },
        _refMap() {
          return map;
        },
      } as Record<string, unknown>,
    };
  }

  function call(name: string, self: unknown, ...args: unknown[]): unknown {
    const fn = (CFCodeEditor.prototype as unknown as Record<
      string,
      (this: unknown, ...a: unknown[]) => unknown
    >)[name];
    return fn.call(self, ...args);
  }

  describe("_takenRefKeys()", () => {
    it("returns the map's keys and the document's together", () => {
      // A key pasted into the text is spoken for even before the map has it,
      // and minting over it would point two mentions at one entry.

      const { self } = editorThis(`[A][${OTHER}]`, { [KEY]: {} });
      expect(call("_takenRefKeys", self)).toEqual(new Set([KEY, OTHER]));
    });
  });

  describe("_collectUnreferencedRefEntries()", () => {
    it("removes an entry whose token has left the document", () => {
      const t = editorThis("no tokens left", { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.deleted).toEqual([KEY]);
    });

    it("keeps a key it never saw at load", () => {
      // Another editor added it while this one was open; this editor has no
      // reason to believe it was ever in its document.

      const t = editorThis("no tokens left", { [KEY]: {} });
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.deleted).toEqual([]);
    });

    it("keeps every entry while the token is still there", () => {
      const t = editorThis(`[A][${KEY}]`, { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.deleted).toEqual([]);
    });

    it("collects nothing against a document that has not loaded", () => {
      // An empty document names nothing, which is not the same as a document
      // that names nothing — reading it as the latter empties the map.

      const t = editorThis("", { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.deleted).toEqual([]);
    });

    it("flushes the pending document write before removing anything", () => {
      // The deletion that made the entry collectable is still in the
      // debounce; losing it after the entry is gone leaves a token with no
      // destination in the durable document.

      const t = editorThis("no tokens left", { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.flushes()).toBe(1);
    });

    it("does not flush when there is nothing to collect", () => {
      const t = editorThis(`[A][${KEY}]`, { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.flushes()).toBe(0);
    });
  });
});

describe("CFCodeEditor pasted-mention decision", () => {
  // `_handleUrlPaste` decides whether a pasted URL becomes a mention, and it
  // prevents the browser's own paste when it does. Anything it declines has to
  // fall through UNPREVENTED, or the clipboard content goes nowhere — the
  // failure this pins. Exercised against a minimal `this`, so no CodeMirror or
  // DOM is constructed.

  const HASH = "V2tROHl4KsExx5M0fYnkQaOryFwjVUkqXIlcdMWz7SQ";
  const SPACE = "did:key:z6MkpXpeKbhbddoVvxQndKtnNZmGfpSbXXmVw88bswFy2hHh";

  // Built on the prototype so `_refMode` — a getter — and `_fabricHosts()`
  // resolve; the insertion itself needs a runtime, so an own property shadows
  // it. The decision under test needs neither.
  function pasteThis(): Record<string, unknown> {
    const own = (value: unknown) => ({ value, writable: true });
    // Defined rather than assigned: assigning would run Lit's reactive
    // property setters, which need instance state this object does not have.
    // Own data properties also shadow those accessors for the rest of the test.
    return Object.create(CFCodeEditor.prototype, {
      // Its presence is what selects reference mode.
      references: own({ get: () => ({}) }),
      pattern: own({ space: () => "did:key:mock" }),
      fabricHosts: own(["fabric.example"]),
      _editorView: own(undefined),
      _insertPastedMention: own(() => {}),
    });
  }

  function paste(
    fakeThis: Record<string, unknown>,
    text: string,
  ): { handled: boolean; prevented: boolean } {
    let prevented = false;
    const event = {
      clipboardData: { getData: () => text },
      preventDefault: () => (prevented = true),
    };
    const handled = (fakeThis as unknown as {
      _handleUrlPaste(event: unknown, view: unknown): boolean;
    })._handleUrlPaste(event, undefined);
    return { handled, prevented };
  }

  it("takes over a paste of a URL naming a piece", () => {
    const result = paste(pasteThis(), `/of:fid1:${HASH}`);
    expect(result.handled).toBe(true);
    expect(result.prevented).toBe(true);
  });

  it("leaves argument and scoped references as text without preventing the paste", () => {
    for (const suffix of ["#argument", "@user", "@session"]) {
      expect(paste(pasteThis(), `//${SPACE}/of:fid1:${HASH}${suffix}`)).toEqual(
        { handled: false, prevented: false },
      );
    }
    expect(paste(pasteThis(), `//${SPACE}/of:fid1:${HASH}@space`).handled).toBe(
      true,
    );
  });

  it("takes over a paste of a page URL on a configured host", () => {
    const result = paste(
      pasteThis(),
      `https://fabric.example/${SPACE}/of:fid1:${HASH}`,
    );
    expect(result.handled).toBe(true);
  });

  it("leaves an ordinary web page to the browser, unprevented", () => {
    const result = paste(pasteThis(), "https://example.com/blog/post");
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });

  it("leaves a slug URL to the browser, unprevented", () => {
    // A slug addresses a redirect document, which needs a read before it can
    // name a piece. Preventing the paste and then declining swallowed it.
    // The space is a DID on purpose: a named space is refused one check
    // earlier, so this would not reach the branch under test.

    const result = paste(
      pasteThis(),
      `https://fabric.example/${SPACE}/my-note`,
    );
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });

  it("leaves a URL naming its space by name to the browser, unprevented", () => {
    const result = paste(
      pasteThis(),
      `https://fabric.example/work/of:fid1:${HASH}`,
    );
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });

  it("leaves pasted prose alone", () => {
    const result = paste(pasteThis(), "some words and a space");
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });

  it("leaves every paste alone without a reference map", () => {
    const fakeThis = pasteThis();
    fakeThis.references = null;
    const result = paste(fakeThis, `/of:fid1:${HASH}`);
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });
});

describe("CFCodeEditor mention-piece resolution", () => {
  // The private resolution surface under test. `piece`-bearing entries are
  // index rows standing for their piece; entries without one ARE the piece.
  // A row's piece is stored as a LINK, and its value crosses the client
  // boundary as an empty object — so the fixtures store raw `$link`
  // sigils, and the mock network's resolveAsCell follows them, exactly as
  // the runtime does. Nothing here reaches a piece through a value.
  type ResolutionInternals = {
    mentionable: CellHandle<MentionableArray> | null;
    mentioned?: CellHandle<MentionableArray>;
    pattern: CellHandle<string>;
    _editorView: EditorView | undefined;
    _resolvePieceIds(): Promise<void>;
    _resolvedPieceCells: Map<number, CellHandle<Mentionable>>;
    _completionAwaitingResolution: boolean;
    _getPieceId(index: number): string;
    findPieceById(id: string): CellHandle<Mentionable> | null;
    getFilteredMentionable(query: string): Array<[unknown, number]>;
    _completeBacklinkQuery(view: EditorView, text: string): void;
    createBacklinkCompletionSource(): (
      context: CompletionContext,
    ) => CompletionResult | null;
    willUpdate(changedProperties: Map<string, unknown>): void;
  };

  const internals = (element: CFCodeEditor): ResolutionInternals =>
    element as unknown as ResolutionInternals;

  const pieceLink = {
    "$link": { id: "of:target-piece", path: [] },
  };

  /** Creates the stateful part of an `EditorView` used by completion. */
  function createBacklinkView(
    source: (context: CompletionContext) => CompletionResult | null,
    doc: string,
    hasFocus = true,
  ) {
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [autocompletion({ override: [source] })],
    });
    return {
      state,
      hasFocus,
      dispatch(spec: TransactionSpec) {
        this.state = this.state.update(spec).state;
      },
    };
  }

  it("resolves a piece-bearing entry to its piece", async () => {
    const element = internals(new CFCodeEditor());
    const target = createMockCellHandle(
      { title: "Target" },
      { id: "of:target-piece" } as Partial<CellRef>,
    );
    element.mentionable = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;

    await element._resolvePieceIds();

    const resolved = element._resolvedPieceCells.get(0);
    expect(resolved?.id()).toBe(target.id());
  });

  it("resolves an entry without a piece to the entry itself", async () => {
    const element = internals(new CFCodeEditor());
    const list = createMockCellHandle([{ [NAME]: "Direct" }]);
    element.mentionable = list as unknown as CellHandle<MentionableArray>;

    await element._resolvePieceIds();

    const resolved = element._resolvedPieceCells.get(0);
    expect(resolved?.id()).toBe(list.key(0).id());
  });

  it("withholds an index row until its piece resolves", async () => {
    // Before resolution a row has no usable identity — its sub-cell names
    // the row, and no id beats a wrong one — so the completion surfaces
    // exclude it and its id is empty. Resolution restores all three.
    const element = internals(new CFCodeEditor());
    const target = createMockCellHandle(
      { title: "Target" },
      { id: "of:target-piece" } as Partial<CellRef>,
    );
    element.mentionable = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;

    expect(element.getFilteredMentionable("")).toEqual([]);
    expect(element._getPieceId(0)).toBe("");

    await element._resolvePieceIds();

    expect(element.getFilteredMentionable("").length).toBe(1);
    const found = element.findPieceById(element._getPieceId(0));
    expect(found?.id()).toBe(target.id());
  });

  it("defers `$mentioned` reconciliation until index rows resolve", async () => {
    const element = internals(new CFCodeEditor());
    const list = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]);
    const release = Promise.withResolvers<void>();
    const realKey = list.key.bind(list);
    list.key = ((key: PropertyKey) => {
      const row = realKey(key as never);
      if (String(key) === "0") {
        const realRowKey = row.key.bind(row);
        row.key = ((rowKey: PropertyKey) => {
          const destination = realRowKey(rowKey as never);
          if (String(rowKey) === "piece") {
            const realResolve = destination.resolveAsCell.bind(destination);
            destination.resolveAsCell = (async () => {
              await release.promise;
              return await realResolve();
            }) as typeof destination.resolveAsCell;
          }
          return destination;
        }) as unknown as typeof row.key;
      }
      return row;
    }) as typeof list.key;
    Object.defineProperty(list, "asSchema", { value: () => list });

    const mentioned = createMockCellHandle<MentionableArray>([], {
      id: "of:mentioned" as CellRef["id"],
    });
    let writes = 0;
    let written: MentionableArray | undefined;
    const realSet = mentioned.set.bind(mentioned);
    Object.defineProperty(mentioned, "set", {
      value: (value: MentionableArray) => {
        writes++;
        written = value;
        return realSet(value);
      },
    });
    element.mentionable = list as unknown as CellHandle<MentionableArray>;
    element.mentioned = mentioned;
    Object.defineProperty(element, "getValue", {
      value: () => "[[Row (target-piece)]]",
    });
    const resolutions: Promise<void>[] = [];
    const resolvePieceIds = element._resolvePieceIds.bind(element);
    Object.defineProperty(element, "_resolvePieceIds", {
      value: () => {
        const resolution = resolvePieceIds();
        resolutions.push(resolution);
        return resolution;
      },
    });

    element.willUpdate(new Map([["mentionable", null]]));
    expect(writes).toBe(0);

    release.resolve();
    await Promise.all(resolutions);

    expect(writes).toBe(1);
    expect((written?.[0] as unknown as CellHandle<Mentionable>).id()).toBe(
      "of:target-piece",
    );
  });

  it("does not create a piece for an exact unresolved index row", async () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle([
      { [NAME]: "Existing Topic", title: "Existing Topic", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;
    element.pattern = createMockCellHandle("pattern");
    let creations = 0;
    Object.defineProperty(element, "createBacklinkFromPattern", {
      value: () => {
        creations++;
        return Promise.resolve();
      },
    });
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[Existing Topic");
    element._editorView = view as unknown as EditorView;

    element._completeBacklinkQuery(
      view as unknown as EditorView,
      "Existing Topic",
    );

    expect(creations).toBe(0);
    expect(view.state.doc.toString()).toBe("[[Existing Topic");
    expect(element._completionAwaitingResolution).toBe(true);
    await element._resolvePieceIds();
  });

  it("creates a piece when no exact row is present", () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle<MentionableArray>([]);
    element.pattern = createMockCellHandle("pattern");
    let creation: [string, boolean] | undefined;
    Object.defineProperty(element, "createBacklinkFromPattern", {
      value: (text: string, navigate: boolean) => {
        creation = [text, navigate];
        return Promise.resolve();
      },
    });
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[New Topic");

    element._completeBacklinkQuery(
      view as unknown as EditorView,
      "New Topic",
    );

    expect(creation).toEqual(["New Topic", false]);
    expect(view.state.doc.toString()).toBe("[[New Topic]]");
  });

  it("creates a piece when an unresolved row is not an exact match", () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle([
      { [NAME]: "Existing Topic", title: "Existing Topic", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;
    element.pattern = createMockCellHandle("pattern");
    let creation: [string, boolean] | undefined;
    Object.defineProperty(element, "createBacklinkFromPattern", {
      value: (text: string, navigate: boolean) => {
        creation = [text, navigate];
        return Promise.resolve();
      },
    });
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[Top");

    element._completeBacklinkQuery(
      view as unknown as EditorView,
      "Top",
    );

    expect(creation).toEqual(["Top", false]);
    expect(view.state.doc.toString()).toBe("[[Top]]");
  });

  it("restarts a matching backlink completion after resolution", async () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[Ro");
    element._editorView = view as unknown as EditorView;

    const initial = source(new CompletionContext(view.state, 4, true));
    expect(initial?.options).toEqual([]);
    expect(completionStatus(view.state)).toBe(null);

    await element._resolvePieceIds();

    expect(completionStatus(view.state)).toBe("pending");
    const refreshed = source(new CompletionContext(view.state, 4, true));
    expect(refreshed?.options.length).toBe(1);
  });

  it("does not restart a backlink completion after focus leaves", async () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[Ro", false);
    element._editorView = view as unknown as EditorView;

    const initial = source(new CompletionContext(view.state, 4, true));
    expect(initial?.options).toEqual([]);

    await element._resolvePieceIds();

    expect(completionStatus(view.state)).toBe(null);
  });

  it("keeps the newer resolution when an older pass finishes late", async () => {
    // The mentionable HANDLE stays identical when its contents change, so an
    // older pass that resolves slowly can finish after a newer one. The
    // slow pass is gated open only once the fast pass has published; what
    // the caches hold at the end decides the race. Plain entries, so the
    // gate can ride the sub-cell the pass resolves.
    const element = internals(new CFCodeEditor());
    const list = createMockCellHandle([{ [NAME]: "Slow" }], {
      id: "of:race-list" as CellRef["id"],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = true;
    const realKey = list.key.bind(list);
    list.key = ((k: PropertyKey) => {
      const child = realKey(k as never);
      if (armed && String(k) === "0") {
        const realResolve = child.resolveAsCell.bind(child);
        child.resolveAsCell = (async () => {
          await gate;
          return await realResolve();
        }) as typeof child.resolveAsCell;
      }
      return child;
    }) as typeof list.key;

    element.mentionable = list as unknown as CellHandle<MentionableArray>;
    const older = element._resolvePieceIds();

    armed = false;
    list.set([{ [NAME]: "Fast" }]);
    await element._resolvePieceIds();
    const fastId = element._resolvedPieceCells.get(0)?.id();
    expect(fastId).toBeDefined();

    release();
    await older;
    expect(element._resolvedPieceCells.get(0)?.id()).toBe(fastId);
  });
});

describe("CFCodeEditor short-name completion", () => {
  // The `#42` trigger over a universe whose rows carry their collection's
  // name for each member. A row's piece is stored as a LINK, as the
  // resolution block above explains, so the fixtures hold raw `$link` sigils
  // and the mock network follows them exactly as the runtime does.
  //
  // The cases over a blank or absent name guard THIS component's handling of
  // one, not any collection's choice to show its names: a collection that
  // numbers its members and shows none of the numbers hands rows whose name is
  // the empty string, and a universe listing pieces that publish none hands
  // entries with no name at all. A collection that starts showing its numbers
  // again leaves those cases green by construction. What reds them is this
  // component finding a name where there is none — reading the display name
  // when the collection's name is blank, which is what the `42 apples`
  // fixtures are shaped to catch.

  type ShortNameInternals = {
    mentionable: CellHandle<MentionableArray> | null;
    references?: CellHandle<MentionRefMap> | null;
    _editorView: EditorView | undefined;
    _resolvePieceIds(): Promise<void>;
    getFilteredMentionable(query: string): Array<[unknown, number]>;
    createShortNameCompletionSource(): (
      context: CompletionContext,
    ) => CompletionResult | null;
    createBacklinkCompletionSource(): (
      context: CompletionContext,
    ) => CompletionResult | null;
  };

  const link = (id: string) => ({ "$link": { id, path: [] } });

  const REF_KEY = "a3f9zz";

  const UNIVERSE = [
    {
      [NAME]: "First item",
      title: "First item",
      shortName: "1",
      piece: link("of:aa1"),
    },
    {
      [NAME]: "Second item",
      title: "Second item",
      shortName: "42",
      piece: link("of:zz9"),
    },
    {
      [NAME]: "Third item",
      title: "Third item",
      shortName: "43",
      piece: link("of:bb3"),
    },
    // No name of its own, and a display name that a `#42` query would match
    // were the query asked of anything but `shortName`.
    { [NAME]: "42 apples", title: "42 apples", piece: link("of:none") },
  ];

  /** A view stub carrying the mention state the editor reads. */
  function createView(
    source: (context: CompletionContext) => CompletionResult | null,
    doc: string,
  ) {
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        autocompletion({ override: [source] }),
        mentionRefField,
        refShortNameField,
      ],
    });
    return {
      state,
      hasFocus: true,
      dispatch(spec: TransactionSpec) {
        this.state = this.state.update(spec).state;
      },
    };
  }

  /**
   * The same universe with every name blanked, which is what a collection that
   * numbers its members and shows none of the numbers hands its editors: a row
   * is a copy, and a copy of an absent name is the empty string.
   */
  const BLANKED = UNIVERSE.map((entry) => ({ ...entry, shortName: "" }));

  /**
   * A universe that is the pieces themselves rather than copies of them —
   * what an editor reads before its collection's derived universe is wired
   * onto it. An entry carries no `piece`, so the entry IS the piece, and
   * `shortName` here is what that piece publishes for itself.
   *
   * The display name opens with the digits a query types, as the fourth row of
   * `UNIVERSE` does, so that an entry publishing no name is offered only if
   * this component asks the query of something other than `shortName`.
   */
  const direct = (shortName?: string) => [
    {
      [NAME]: "42 apples",
      title: "42 apples",
      ...(shortName === undefined ? {} : { shortName }),
    },
  ];

  /** An editor bound to `rows`, with every row's piece resolved. */
  async function editorOver(
    doc: string,
    references?: CellHandle<MentionRefMap>,
    rows: unknown[] = UNIVERSE,
  ) {
    const element = new CFCodeEditor() as unknown as ShortNameInternals;
    element.mentionable = createMockCellHandle(
      rows,
    ) as unknown as CellHandle<MentionableArray>;
    if (references) {
      // Defined rather than assigned, so Lit's reactive property setter does
      // not run against an element with no editor behind it.
      Object.defineProperty(element, "references", {
        value: references,
        writable: true,
      });
    }
    await element._resolvePieceIds();

    const source = element.createShortNameCompletionSource();
    const view = createView(source, doc);
    element._editorView = view as unknown as EditorView;
    return { element, source, view };
  }

  it("offers every row whose name begins with the typed digits", async () => {
    const { source, view } = await editorOver("see #4");
    const result = source(new CompletionContext(view.state, 6, true));
    expect(result?.options.map((option) => option.label)).toEqual([
      "#42",
      "#43",
    ]);
    expect(result?.from).toBe(4);
  });

  it("offers no row carrying no name of its own", async () => {
    const { source, view } = await editorOver("see #42");
    const result = source(new CompletionContext(view.state, 7, true));
    expect(result?.options.map((option) => option.detail)).toEqual([
      "Second item",
    ]);
  });

  it("offers no row whose name the query does not begin", async () => {
    const { source, view } = await editorOver("see #9");
    expect(source(new CompletionContext(view.state, 6, true))?.options)
      .toEqual([]);
  });

  it("offers no row where every row's name is blank", async () => {
    const { source, view } = await editorOver("see #4", undefined, BLANKED);
    expect(source(new CompletionContext(view.state, 6, true))?.options)
      .toEqual([]);
  });

  it("offers a piece the universe lists directly by the name it publishes", async () => {
    // The control for the case below, and the state it pins: where the
    // universe is the pieces themselves, the name a piece publishes is the one
    // this query offers.
    const { source, view } = await editorOver(
      "see #4",
      undefined,
      direct("42"),
    );
    expect(
      source(new CompletionContext(view.state, 6, true))?.options.map((
        option,
      ) => option.label),
    ).toEqual(["#42"]);
  });

  it("offers no piece the universe lists directly where it publishes no name", async () => {
    const { source, view } = await editorOver("see #4", undefined, direct());
    expect(source(new CompletionContext(view.state, 6, true))?.options)
      .toEqual([]);
  });

  it("returns null for a sigil opening a backlink query", async () => {
    // `[[#4` is the backlink gesture, which owns the brackets around it: this
    // source replaces neither, so completing here would nest a mention inside
    // them.
    const { source, view } = await editorOver("[[#4");
    expect(source(new CompletionContext(view.state, 4, true))).toBeNull();
  });

  it("returns null for a sigil further inside an unclosed backlink query", async () => {
    // The whole `[[…` gesture belongs to the backlink source, not just the
    // two characters at its head: `[[note #4` is still inside it.
    const { source, view } = await editorOver("[[note #4");
    expect(source(new CompletionContext(view.state, 9, true))).toBeNull();
  });

  it("offers a short-name query once a `]` has closed the brackets", async () => {
    // The guard asks whether the query is still open, so text that is no
    // longer a backlink query does not suppress the sigil for the rest of
    // the line.
    const { source, view } = await editorOver("[[a]] then #4");
    expect(source(new CompletionContext(view.state, 13, true))?.options)
      .toHaveLength(2);
  });

  it("applies over the range the callback is given, not the one captured", async () => {
    // A transaction between offering the option and applying it maps the
    // query's position; an insertion that used the captured `from` would
    // replace text the query no longer covers.
    const { source, view } = await editorOver("see #42");
    const result = source(new CompletionContext(view.state, 7, true))!;
    view.dispatch({ changes: { from: 0, to: 0, insert: ">> " } });

    const [option] = result.options;
    (option.apply as (
      view: EditorView,
      completion: Completion,
      from: number,
      to: number,
    ) => void)(view as unknown as EditorView, option, 7, 10);

    expect(view.state.doc.toString()).toBe(">> see [[Second item (zz9)]]");
  });

  it("returns null for a sigil typed inside an existing mention's label", async () => {
    // A label is ordinary editable text, so a sigil can land in one; inserting
    // there would put a token inside a token.
    const { source, view } = await editorOver(`[My #42Note][${REF_KEY}]`);
    view.dispatch({ effects: setKnownRefKeys.of([REF_KEY]) });
    expect(source(new CompletionContext(view.state, 7, true))).toBeNull();
  });

  it("returns null where the sigil sits inside a word", async () => {
    const { source, view } = await editorOver("issue#4");
    expect(source(new CompletionContext(view.state, 7, true))).toBeNull();
  });

  it("inserts a reference-form mention naming the row's piece", async () => {
    const references = createMockCellHandle<MentionRefMap>({});
    const { source, view } = await editorOver("see #42", references);
    const result = source(new CompletionContext(view.state, 7, true))!;
    const [option] = result.options;

    (option.apply as (
      view: EditorView,
      completion: Completion,
      from: number,
      to: number,
    ) => void)(view as unknown as EditorView, option, result.from, 7);

    expect(view.state.doc.toString()).toMatch(
      /^see \[Second item\]\[[0-9a-z]{6}\]$/,
    );
    const entries = Object.entries(references.get() ?? {});
    expect(entries).toHaveLength(1);
    const [key, entry] = entries[0];
    expect(view.state.doc.toString()).toBe(`see [Second item][${key}]`);
    // The mock network stores what the write serialized to, which is the cell
    // the row's `piece` link named — the item, not the row that listed it.
    expect((entry.destination as { id: string }).id).toBe("of:zz9");
    expect(entry.modifiedTitle).toBe(false);
  });

  it("inserts a wiki-link mention without a reference map", async () => {
    const { source, view } = await editorOver("see #42");
    const result = source(new CompletionContext(view.state, 7, true))!;
    const [option] = result.options;

    (option.apply as (
      view: EditorView,
      completion: Completion,
      from: number,
      to: number,
    ) => void)(view as unknown as EditorView, option, result.from, 7);

    // The id, not the short name: the fixture's `of:zz9` resolves to an
    // embed id nothing else in the row spells, so an insertion that reached
    // for `shortName` instead could not pass this.
    expect(view.state.doc.toString()).toBe("see [[Second item (zz9)]]");
  });

  it("restarts a short-name completion once the withheld row resolves", async () => {
    // A row is withheld until its piece resolves, so the query that asked for
    // it saw nothing. Without a reopen the user is left typing at a list that
    // will never fill.
    const element = new CFCodeEditor() as unknown as ShortNameInternals;
    element.mentionable = createMockCellHandle(
      UNIVERSE,
    ) as unknown as CellHandle<MentionableArray>;
    const source = element.createShortNameCompletionSource();
    const view = createView(source, "see #42");
    element._editorView = view as unknown as EditorView;

    expect(source(new CompletionContext(view.state, 7, true))?.options)
      .toEqual([]);
    expect(completionStatus(view.state)).toBe(null);

    await element._resolvePieceIds();

    expect(completionStatus(view.state)).toBe("pending");
  });

  it("restarts a backlink completion the row matched only by short name", async () => {
    // The same signal from the other trigger: `[[43` offers a row on its
    // number, so a row withheld for that reason owes the same reopen. The
    // query is one NO display name contains, so what reopens the completion
    // can only be the short name.
    const element = new CFCodeEditor() as unknown as ShortNameInternals;
    element.mentionable = createMockCellHandle(
      UNIVERSE,
    ) as unknown as CellHandle<MentionableArray>;
    const source = element.createBacklinkCompletionSource();
    const view = createView(source, "[[43");
    element._editorView = view as unknown as EditorView;

    expect(source(new CompletionContext(view.state, 4, true))?.options)
      .toEqual([]);
    expect(completionStatus(view.state)).toBe(null);

    await element._resolvePieceIds();

    expect(completionStatus(view.state)).toBe("pending");
  });

  it("mentions the row that was picked after the universe reorders", async () => {
    // The option carries the row's identity, not its position: a universe
    // that recomputes between the dropdown opening and the pick would
    // otherwise make the same index name a different member.
    const references = createMockCellHandle<MentionRefMap>({});
    const { element, source, view } = await editorOver("see #42", references);
    const result = source(new CompletionContext(view.state, 7, true))!;
    const [option] = result.options;

    element.mentionable = createMockCellHandle(
      [...UNIVERSE].reverse(),
    ) as unknown as CellHandle<MentionableArray>;
    await element._resolvePieceIds();

    (option.apply as (
      view: EditorView,
      completion: Completion,
      from: number,
      to: number,
    ) => void)(view as unknown as EditorView, option, result.from, 7);

    const [[, entry]] = Object.entries(references.get() ?? {});
    expect((entry.destination as { id: string }).id).toBe("of:zz9");
  });

  it("inserts a wiki-link the parser reads back for a name holding a bracket", async () => {
    // `]` closes the token, so a name carrying one would mint a wiki-link no
    // parse recognizes — unstyled, unprotected, and absent from `$mentioned`.
    const element = new CFCodeEditor() as unknown as ShortNameInternals;
    element.mentionable = createMockCellHandle([
      {
        [NAME]: "Bracket ] name",
        title: "Bracket ] name",
        shortName: "7",
        piece: link("of:br7"),
      },
    ]) as unknown as CellHandle<MentionableArray>;
    await element._resolvePieceIds();

    const source = element.createShortNameCompletionSource();
    const view = createView(source, "see #7");
    element._editorView = view as unknown as EditorView;
    const result = source(new CompletionContext(view.state, 6, true))!;
    const [option] = result.options;

    (option.apply as (
      view: EditorView,
      completion: Completion,
      from: number,
      to: number,
    ) => void)(view as unknown as EditorView, option, result.from, 6);

    expect(view.state.doc.toString()).toBe("see [[Bracket ) name (br7)]]");
  });

  it("offers a row by its collection name from the backlink query too", async () => {
    const { element } = await editorOver("");
    expect(element.getFilteredMentionable("43")).toHaveLength(1);
    expect(element.getFilteredMentionable("9")).toEqual([]);
  });
});

describe("CFCodeEditor mention short names", () => {
  // What a pill shows beside a mention's label, as the editor announces it to
  // the view: the name of the universe row standing for the mention's
  // destination, found through the piece id the resolution pass records. The
  // destination subscriptions are the component's own over the mock network,
  // and every destination publishes a `shortName` of its own, so an editor
  // reading the destination instead announces a different name, or one where
  // none belongs.
  //
  // The two cases over a name that is not there — a row carrying the empty
  // name, and a universe listing a piece that publishes none — guard THIS
  // component's handling of one, the way the completion block above does. A
  // collection that starts showing its numbers again leaves them green; what
  // reds them is a pill taking a blank name as a name, or taking the
  // destination's name when the row carries none.

  type PillInternals = {
    mentionable: CellHandle<MentionableArray> | null;
    _editorView: EditorView | undefined;
    _resolvePieceIds(): Promise<void>;
    _setupRefDestinationSubscriptions(): void;
    willUpdate(changedProperties: Map<string, unknown>): void;
  };

  const KEY = "a3f9zz";
  const OTHER_KEY = "b7k2m1";

  /**
   * Where a cell sits, beyond its document id. Both helpers below default to
   * the mock's own space and the document root, so a case that says nothing
   * about either gets a row and a destination on one cell.
   */
  interface At {
    space?: string;
    path?: string[];
  }

  /** A universe row standing for the piece `id`, which it calls `shortName`. */
  function row(
    id: string,
    name: string,
    shortName: string,
    { space, path = [] }: At = {},
  ) {
    return {
      [NAME]: name,
      title: name,
      shortName,
      piece: {
        "$link": { id, path, ...(space === undefined ? {} : { space }) },
      },
    };
  }

  /** A destination piece called `name`, which calls itself `shortName`. */
  function destination(
    id: string,
    name: string,
    shortName: string,
    { space, path = [] }: At = {},
  ): CellHandle<Record<string, unknown>> {
    return createMockCellHandle<Record<string, unknown>>(
      { [NAME]: name, shortName },
      {
        id,
        path,
        ...(space === undefined ? {} : { space }),
      } as Partial<CellRef>,
    );
  }

  /**
   * An editor over `doc`, whose reference map points each key at its
   * destination and whose universe holds `rows`. Each label in `doc` is its
   * destination's name, so no subscription rewrites the document.
   */
  function editorOver(
    doc: string,
    destinations: Record<string, CellHandle<Record<string, unknown>>>,
    rows: unknown[],
  ) {
    const element = new CFCodeEditor() as unknown as PillInternals;
    const universe = createMockCellHandle(rows, {
      id: "of:universe" as CellRef["id"],
    });
    // Binding a universe rebinds it under the editor's schema, which copies
    // the handle. Handing back this one keeps a `set()` here reaching the
    // subscription the binding opens.
    Object.defineProperty(universe, "asSchema", { value: () => universe });
    element.mentionable = universe as unknown as CellHandle<MentionableArray>;
    // Defined rather than assigned, so Lit's reactive property setter does
    // not run against an element with no editor behind it.
    Object.defineProperty(element, "references", {
      value: createMockCellHandle(
        Object.fromEntries(
          Object.entries(destinations).map(([key, cell]) => [
            key,
            { destination: cell, modifiedTitle: false },
          ]),
        ),
      ),
      writable: true,
    });

    const view = {
      state: EditorState.create({
        doc,
        extensions: [mentionRefField, refShortNameField],
      }),
      dispatch(spec: TransactionSpec) {
        this.state = this.state.update(spec).state;
      },
    };
    view.dispatch({ effects: setKnownRefKeys.of(Object.keys(destinations)) });
    element._editorView = view as unknown as EditorView;
    return { element, universe, view };
  }

  /**
   * Resolves once the editor's pending short-name publication has run. That
   * publication is a microtask queued before this one, so it runs first.
   */
  function publication(): Promise<void> {
    return new Promise((resolve) => queueMicrotask(resolve));
  }

  /**
   * Binds `element`'s universe as a property change does, and returns the
   * resolution passes that binding starts, which later changes to the
   * universe add to.
   */
  function bindUniverse(element: PillInternals): Promise<void>[] {
    const passes: Promise<void>[] = [];
    const resolvePieceIds = element._resolvePieceIds.bind(element);
    Object.defineProperty(element, "_resolvePieceIds", {
      value: () => {
        const pass = resolvePieceIds();
        passes.push(pass);
        return pass;
      },
    });
    element.willUpdate(new Map([["mentionable", null]]));
    return passes;
  }

  it("announces the name its universe row carries, not the one its destination publishes", async () => {
    const { element, view } = editorOver(
      `See [Second item][${KEY}].`,
      { [KEY]: destination("of:item-42", "Second item", "7") },
      [row("of:item-42", "Second item", "42")],
    );

    await element._resolvePieceIds();
    element._setupRefDestinationSubscriptions();
    await publication();

    expect(refShortNames(view.state)).toEqual({ [KEY]: "42" });
  });

  it("announces no name for a destination no universe row stands for, whatever it publishes", async () => {
    // The other mention's destination is one the universe lists, and one
    // publication decides both names. Its name arriving is what says this
    // absence was decided rather than not yet reached.

    const { element, view } = editorOver(
      `See [Second item][${KEY}] and [Third item][${OTHER_KEY}].`,
      {
        [KEY]: destination("of:item-42", "Second item", "42"),
        [OTHER_KEY]: destination("of:item-43", "Third item", "43"),
      },
      [row("of:item-43", "Third item", "43")],
    );

    await element._resolvePieceIds();
    element._setupRefDestinationSubscriptions();
    await publication();

    expect(refShortNames(view.state)).toEqual({ [OTHER_KEY]: "43" });
  });

  it("announces no name where the row standing for the destination carries a blank one", async () => {
    // A universe whose collection numbers its members and shows none of the
    // numbers carries the empty name on every row. The other mention's row
    // carries a name and one publication decides both, so this absence is
    // decided rather than not yet reached — and its destination publishes a
    // name, so a pill reading the destination would show one here.

    const { element, view } = editorOver(
      `See [Second item][${KEY}] and [Third item][${OTHER_KEY}].`,
      {
        [KEY]: destination("of:item-42", "Second item", "42"),
        [OTHER_KEY]: destination("of:item-43", "Third item", "43"),
      },
      [
        row("of:item-42", "Second item", ""),
        row("of:item-43", "Third item", "43"),
      ],
    );

    await element._resolvePieceIds();
    element._setupRefDestinationSubscriptions();
    await publication();

    expect(refShortNames(view.state)).toEqual({ [OTHER_KEY]: "43" });
  });

  describe("a universe that lists the pieces themselves", () => {
    // What an editor reads before its collection's derived universe is wired
    // onto it. An entry carries no `piece`, so the entry IS the piece, and the
    // name a pill can show is the one that piece publishes.

    /**
     * The names announced over a universe holding one piece, which publishes
     * `shortName` when it is given one, and is the destination of the
     * document's one mention.
     */
    async function namesUnderDirect(shortName?: string) {
      const { element, view } = editorOver(
        `See [Second item][${KEY}].`,
        {
          [KEY]: destination("of:universe", "Second item", shortName ?? "", {
            path: ["0"],
          }),
        },
        [{
          [NAME]: "Second item",
          title: "Second item",
          ...(shortName === undefined ? {} : { shortName }),
        }],
      );

      await element._resolvePieceIds();
      element._setupRefDestinationSubscriptions();
      await publication();

      return refShortNames(view.state);
    }

    it("announces the name the listed piece publishes", async () => {
      expect(await namesUnderDirect("42")).toEqual({ [KEY]: "42" });
    });

    it("announces no name where the listed piece publishes none", async () => {
      expect(await namesUnderDirect()).toEqual({});
    });
  });

  describe("a row sharing the destination's document id", () => {
    // A document id holds in every space that stores the document, and a
    // path names a cell within one, so an id alone does not say which cell a
    // row stands for. Each case here puts a row and a destination on cells
    // that agree on the id and differ in one other part of their identity:
    // the row names a DIFFERENT cell, so its name belongs to no mention
    // here. The second mention pins the moment, as above — its name arriving
    // is what says the absence was decided rather than not yet reached.

    async function namesUnder(
      rowAt: { space?: string; path?: string[] },
      destinationAt: { space?: string; path?: string[] },
    ) {
      const { element, view } = editorOver(
        `See [Second item][${KEY}] and [Third item][${OTHER_KEY}].`,
        {
          [KEY]: destination("of:item-42", "Second item", "7", destinationAt),
          [OTHER_KEY]: destination("of:item-43", "Third item", "43"),
        },
        [
          row("of:item-42", "Second item", "42", rowAt),
          row("of:item-43", "Third item", "43"),
        ],
      );

      await element._resolvePieceIds();
      element._setupRefDestinationSubscriptions();
      await publication();

      return refShortNames(view.state);
    }

    it("announces no name where the row's cell is in another space", async () => {
      expect(
        await namesUnder(
          { space: "did:key:boardA" },
          { space: "did:key:boardB" },
        ),
      ).toEqual({ [OTHER_KEY]: "43" });
    });

    it("announces no name where the row's cell is at another path", async () => {
      expect(await namesUnder({ path: ["other"] }, { path: [] })).toEqual({
        [OTHER_KEY]: "43",
      });
    });

    it("announces the row's name where the whole identity agrees", async () => {
      // The control: the same fixture with the two cells brought onto one
      // identity does produce the name, so the absences above are the
      // difference in identity and not the fixture failing to resolve.
      expect(
        await namesUnder(
          { space: "did:key:boardA" },
          { space: "did:key:boardA" },
        ),
      ).toEqual({ [KEY]: "42", [OTHER_KEY]: "43" });
    });
  });

  describe("after the universe changes", () => {
    // Each case starts from a name its destination publishes as well as its
    // row carrying it, so the name showing could have come from either. What
    // the change does to it is what says which one the pill reads.

    /**
     * An editor whose one mention names `of:item-42`, bound to a universe
     * whose row for it carries `42`, once that name is announced.
     */
    async function announcing42() {
      const fixture = editorOver(
        `See [Second item][${KEY}].`,
        { [KEY]: destination("of:item-42", "Second item", "42") },
        [row("of:item-42", "Second item", "42")],
      );
      // Subscribed before the universe resolves, so the name can only arrive
      // with the resolution pass.
      fixture.element._setupRefDestinationSubscriptions();
      const passes = bindUniverse(fixture.element);
      await Promise.all(passes);
      await publication();
      expect(refShortNames(fixture.view.state)).toEqual({ [KEY]: "42" });
      return { ...fixture, passes };
    }

    it("announces the row's new name once the universe renames the member", async () => {
      const { universe, view, passes } = await announcing42();

      universe.set([row("of:item-42", "Second item", "43")]);
      await Promise.all(passes);
      await publication();

      expect(refShortNames(view.state)).toEqual({ [KEY]: "43" });
    });

    it("announces no name once no row stands for the destination", async () => {
      const { universe, view, passes } = await announcing42();

      universe.set([row("of:item-43", "Third item", "43")]);
      await Promise.all(passes);
      await publication();

      expect(refShortNames(view.state)).toEqual({});
    });

    it("announces no name once the universe is unbound", async () => {
      const { element, view } = await announcing42();

      element.mentionable = null;
      element.willUpdate(new Map([["mentionable", null]]));
      await publication();

      expect(refShortNames(view.state)).toEqual({});
    });
  });
});
