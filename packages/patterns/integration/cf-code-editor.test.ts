/**
 * Integration tests for cf-code-editor cursor stability.
 *
 * Tests that the cursor doesn't jump when:
 * 1. Typing normally (Cell echoes back after debounce)
 * 2. Rapid typing with debounce window
 * 3. External Cell updates during typing
 *
 * The critical flow being tested:
 * - User types → editor updates → debounced Cell update (500ms)
 * - Cell echo fires → content compared → if match, skip update → cursor stays
 *
 * Waits are event-driven: editor-state conditions use waitForCondition (an
 * in-page waiter re-evaluated on DOM mutation), and committed cell values are
 * awaited through the result-cell sink. The remaining setTimeout calls
 * construct timing scenarios (an update landing inside the component's
 * wall-clock debounce window, or a settling period after which a canceled
 * write must NOT have fired); they are the scenario, not a wait for a result.
 */
import { debugStr } from "@commonfabric/data-model";
import {
  awaitViewSettled,
  env,
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { ANYONE_USER } from "@commonfabric/memory/acl";
import { ACLManager } from "@commonfabric/runner";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import { waitForRuntimeSynced } from "./cfc-browser-helpers.ts";
import { defer, type Deferred } from "@commonfabric/utils/defer";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

// Debounce delay configured in cf-code-editor (default timingDelay)
const DEBOUNCE_DELAY = 500;
const DEBOUNCE_BUFFER = 100; // Extra time for processing

// In-page predicate for waitForCondition: the editor document text equals
// `expected`. `probe.collect` pierces shadow roots to find the editor host.
const editorContentIs = (probe: ProbeApi, expected: string): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as
    | (Element & { _editorView?: { state: { doc: { toString(): string } } } })
    | undefined;
  return editor?._editorView?.state.doc.toString() === expected;
};

// In-page predicate: the editor host exists and its CodeMirror view is up.
const editorReady = (probe: ProbeApi): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as
    | (Element & { _editorView?: unknown })
    | undefined;
  return editor?._editorView !== undefined;
};

// In-page predicate: the editor's bound cell raw value equals `expected`. A
// pending local edit keeps the editor document from repainting to an external
// write, but the bound cell's own value still catches up on sync, so this is
// how a test confirms the browser actually received an external write whose
// delivery the editor suppressed.
const editorCellRawIs = (probe: ProbeApi, expected: string): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as
    | (Element & { _cellController?: { getCell(): { get(): unknown } | null } })
    | undefined;
  const raw = editor?._cellController?.getCell?.()?.get?.();
  return (raw ?? "") === expected;
};

/**
 * Waits until the piece's `cf-code-editor` has its CodeMirror view up.
 *
 * A failure says whether the custom element was ever defined, which separates
 * a component bundle that never loaded from a view that was never built on a
 * host that did. The wait's own report of the page rides underneath as the
 * cause, and is not rebuilt here: what reaches this point is not always an
 * `Error`, and rendering it would cost that report rather than add to it.
 */
async function waitForEditorReady(page: Page): Promise<void> {
  try {
    await waitForCondition(page, editorReady);
  } catch (cause) {
    const defined = await page.evaluate(
      () => customElements.get("cf-code-editor") !== undefined,
    ).catch(() => undefined);
    if (defined === undefined) throw cause;
    throw new Error(
      `cf-code-editor never became ready; its custom element was ${
        defined ? "defined" : "never defined"
      } on the page.`,
      { cause },
    );
  }
}

/**
 * Opens the piece `pieceId` in the shell and waits until its `cf-code-editor`
 * is up, answering the page it landed on.
 *
 * Every test that drives the page opens it here, which is what makes two
 * things true of each of them: no test depends on another having navigated,
 * and the errors a navigation raises fall inside the test that caused them.
 */
async function openPiece(
  shell: ShellIntegration,
  pieceId: string,
  identity: Identity,
): Promise<Page> {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { spaceName: SPACE_NAME, pieceId },
    identity,
  });
  const page = shell.page();
  await waitForEditorReady(page);
  return page;
}

/** Wait until the editor's document text equals `expected`. */
async function waitForEditorContent(
  page: Page,
  expected: string,
): Promise<void> {
  try {
    await waitForCondition(page, editorContentIs, { args: [expected] });
  } catch (cause) {
    // The editor's document text is the one fact the wait's own report does
    // not carry, and it is worth a message over that report. Where there is no
    // editor to read it from, that report stands on its own.
    const actual = await getEditorContent(page).catch(() => undefined);
    if (actual === undefined) throw cause;
    throw new Error(
      debugStr`Editor content did not become $quote,long${expected}; ` +
        debugStr`last content: $quote,long${actual}`,
      { cause },
    );
  }
}

/**
 * Confirm that an external write already issued to the editor's bound cell does
 * not repaint the editor while a local edit is pending. Waits until the browser
 * has synced the external value into the bound cell, lets any repaint settle,
 * then asserts the document still shows `pending` (the unsettled local edit
 * wins). The caller issues the write first, e.g. `piece.result.set(...)`.
 */
async function expectExternalWriteSuppressed(
  page: Page,
  externalValue: string,
  pending: string,
): Promise<void> {
  await waitForCondition(page, editorCellRawIs, { args: [externalValue] });
  await awaitViewSettled(page);
  assertEquals(
    await getEditorContent(page),
    pending,
    debugStr`External write $quote,long${externalValue} must not repaint the ` +
      `editor while the local edit is pending`,
  );
}

describe("cf-code-editor cursor stability", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let pieceSinkCancel: (() => void) | undefined;
  // The piece's committed content value, tracked by the result-cell sink
  // below, and a one-shot waiter the sink resolves when the value reaches a
  // target.
  let latestContent: string | undefined;
  let contentWaiter: { target: string; deferred: Deferred } | undefined;

  // Resolve once the piece's committed content equals `target`. The sink
  // fires with the current value on registration and on every committed
  // change, so a value already at the target resolves immediately; otherwise
  // the sink resolves the waiter when the target lands.
  const awaitCellContent = (target: string): Promise<void> => {
    if (latestContent === target) return Promise.resolve();
    const deferred = defer();
    contentWaiter = { target, deferred };
    return deferred.promise;
  };

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    piece = await cc.create(
      await Deno.readTextFile(
        join(import.meta.dirname!, "..", "examples", "cf-code-editor-cell.tsx"),
      ),
      { start: true },
    );

    // Add permissions for ANYONE
    await new ACLManager(cc.runtime, cc.getSpace()).set(ANYONE_USER, "WRITE");

    // In pull mode, create a sink to keep the piece reactive when inputs
    // change. The sink also drives awaitCellContent: it records the latest
    // committed content and resolves a pending waiter when its target lands.
    const resultCell = cc.getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink((value) => {
      latestContent = (value as { content?: string } | undefined)?.content;
      if (contentWaiter && latestContent === contentWaiter.target) {
        contentWaiter.deferred.resolve();
        contentWaiter = undefined;
      }
    });
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    if (cc) await cc.dispose();
  });

  /**
   * Reset editor state to empty for test isolation: clear the editor without
   * scheduling a cell write, clear the cell, and wait until the editor, the
   * committed cell value, and the page's runtime have all settled at empty.
   */
  async function resetEditorState(page: Page): Promise<void> {
    await clearEditor(page);
    await piece.result.set("", ["content"]);
    await waitForEditorContent(page, "");
    await awaitCellContent("");
    await waitForRuntimeSynced(page);
    await awaitViewSettled(page);
  }

  /**
   * Wait for the cell echo of a just-committed edit to reach the page: the
   * committed value is already at `content`, so once the page's runtime has
   * synced and the view has settled, the subscription delivery (and its
   * potential — incorrect — cursor move) has happened.
   */
  async function awaitEchoDelivered(page: Page): Promise<void> {
    await waitForRuntimeSynced(page);
    await awaitViewSettled(page);
  }

  it("should sync Cell value to editor", async () => {
    const page = await openPiece(shell, piece.id, identity);
    const text = "initial";

    // Clear any initial state first and wait for editor to show empty
    await resetEditorState(page);

    // Set Cell value
    await piece.result.set(text, ["content"]);

    // Wait for editor to reflect it
    await waitForEditorContent(page, text);

    // Clear for next test
    await piece.result.set("", ["content"]);
    await waitForEditorContent(page, "");
  });

  it("should maintain cursor position during normal typing with Cell echo", async () => {
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);

    // Focus the editor
    await focusEditor(page);

    // Verify editor is empty initially
    const initialContent = await getEditorContent(page);
    assertEquals(initialContent, "", "Editor should start empty");

    // Type text using keyboard simulation (NOT piece.result.set)
    const textToType = "Hello World";
    await typeInEditor(page, textToType);

    // Verify cursor position immediately after typing (before debounce)
    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(
      cursorAfterTyping,
      textToType.length,
      "Cursor should be at end after typing",
    );

    // Verify content is in editor
    const contentBeforeDebounce = await getEditorContent(page);
    assertEquals(contentBeforeDebounce, textToType);

    // Wait for debounce to complete and Cell to update
    await awaitCellContent(textToType);

    // Wait for the Cell echo to propagate back to the page.
    await awaitEchoDelivered(page);

    // Critical test: cursor should NOT have jumped after Cell echo
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      textToType.length,
      "Cursor should remain at end after Cell echo (NOT jump to 0)",
    );

    // Content should still be correct
    const finalContent = await getEditorContent(page);
    assertEquals(finalContent, textToType);
  });

  it("should maintain cursor during rapid typing (multiple chars in debounce window)", async () => {
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type several characters rapidly (within debounce window). The short
    // pause between characters constructs the scenario: each keystroke lands
    // inside the debounce window of the previous one and resets its timer.
    const chars = ["A", "B", "C", "D", "E"];
    for (const char of chars) {
      await page.keyboard.type(char);
      await new Promise((r) => setTimeout(r, 50));
    }

    const fullText = chars.join("");

    // Verify cursor is at end immediately
    const cursorBeforeDebounce = await getCursorPosition(page);
    assertEquals(cursorBeforeDebounce, fullText.length);

    // Wait for debounce to complete (only fires ONCE after last character)
    await awaitCellContent(fullText);
    await awaitEchoDelivered(page);

    // Cursor should still be at end, not jumped
    const cursorAfterDebounce = await getCursorPosition(page);
    assertEquals(
      cursorAfterDebounce,
      fullText.length,
      "Cursor should not jump during rapid typing",
    );
  });

  it("should maintain cursor when typing mid-document", async () => {
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    const initialText = "Start End";
    await typeInEditor(page, initialText);

    // Wait for Cell to sync
    await awaitCellContent(initialText);

    // Move cursor to middle (after "Start ")
    const middlePos = 6; // After "Start "
    await setCursorPosition(page, middlePos);

    const cursorAtMiddle = await getCursorPosition(page);
    assertEquals(cursorAtMiddle, middlePos, "Cursor should be at middle");

    // Type in the middle
    await page.keyboard.type("MIDDLE ");

    const expectedText = "Start MIDDLE End";
    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(
      cursorAfterTyping,
      13,
      "Cursor should be after inserted text",
    ); // "Start MIDDLE ".length

    // Wait for debounce
    await awaitCellContent(expectedText);
    await awaitEchoDelivered(page);

    // Cursor should stay where it was after typing
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      13,
      "Cursor should not jump to end or 0 after Cell echo",
    );
  });

  it("should preserve a pending local edit over an external update before it commits", async () => {
    // A locally-edited value that bound state has not yet confirmed wins over
    // deliveries of other values until its write settles (see CellController's
    // pending-local-edit tracking); an external update arriving while the edit
    // is pending must not repaint the editor, and the local edit commits over
    // it.
    //
    // The "blur" strategy commits only on an explicit blur and arms no timer,
    // so the edit stays pending across the external write with nothing that can
    // fire mid-test; the blur at the end flushes it.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await configureTiming(page, { strategy: "blur" });
    await focusEditor(page);

    try {
      // Start typing; the edit stays pending until the blur below.
      await page.keyboard.type("User");
      await waitForEditorContent(page, "User");
      assertEquals(await getCursorPosition(page), 4);

      // An external update lands while the local edit is pending: it must not
      // repaint the editor, and the cursor must not move.
      await piece.result.set("External Update", ["content"]);
      await expectExternalWriteSuppressed(page, "External Update", "User");
      assertEquals(
        await getCursorPosition(page),
        4,
        "Cursor should remain in place while the local edit is pending",
      );

      // Flushing the pending edit commits it over the external value.
      await blurEditor(page);
      await awaitCellContent("User");
      await awaitEchoDelivered(page);
      assertEquals(
        await getEditorContent(page),
        "User",
        "Editor should keep the pending local edit over the external update",
      );
    } finally {
      await cancelPendingEditorEdit(page);
      await configureTiming(page, {
        strategy: "debounce",
        delay: DEBOUNCE_DELAY,
      });
    }
  });

  it("should apply external update when no typing is in progress", async () => {
    // This test verifies that external updates are applied when the user
    // is NOT actively typing (no debounce window active). Also tests
    // cursor clamping when content is shortened.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);

    // Set long content externally (no typing)
    const longContent =
      "This is a very long piece of content that will be shortened";
    await piece.result.set(longContent, ["content"]);
    await waitForEditorContent(page, longContent);

    // Move cursor to end (still no typing)
    await focusEditor(page);
    await setCursorPosition(page, longContent.length);

    const cursorAtEnd = await getCursorPosition(page);
    assertEquals(cursorAtEnd, longContent.length);

    // External update shortens content drastically
    // Since no typing is in progress, this should apply immediately
    const shortContent = "Short";
    await piece.result.set(shortContent, ["content"]);
    await waitForEditorContent(page, shortContent);

    // Cursor should be clamped to new content length
    const cursorAfterShorten = await getCursorPosition(page);
    assert(
      cursorAfterShorten >= 0 && cursorAfterShorten <= shortContent.length,
      `Cursor should be clamped to [0, ${shortContent.length}], got ${cursorAfterShorten}`,
    );
  });

  it("should not apply Cell echo if content matches (own change)", async () => {
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type text
    const text = "Test echo detection";
    await typeInEditor(page, text);

    const cursorBeforeEcho = await getCursorPosition(page);
    assertEquals(cursorBeforeEcho, text.length);

    // Wait for debounce to fire and Cell to update
    await awaitCellContent(text);

    // The Cell echo should be detected and skipped (content match)
    // Cursor should NOT move
    await awaitEchoDelivered(page);

    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      text.length,
      "Cursor should not move when Cell echo is detected (content match)",
    );

    // Now simulate EXTERNAL change with different content
    await piece.result.set("Different content", ["content"]);
    await waitForEditorContent(page, "Different content");
  });

  it("should handle backspace and maintain cursor", async () => {
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type some text
    await typeInEditor(page, "Hello World");
    await awaitCellContent("Hello World");

    // Backspace several times to delete " World". The short pause between
    // keystrokes keeps each one inside the previous one's debounce window.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Backspace");
      await new Promise((r) => setTimeout(r, 50));
    }

    const expectedText = "Hello";
    const cursorAfterBackspace = await getCursorPosition(page);
    assertEquals(cursorAfterBackspace, expectedText.length);

    // Wait for debounce
    await awaitCellContent(expectedText);
    await awaitEchoDelivered(page);

    // Cursor should still be at correct position
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(cursorAfterEcho, expectedText.length);
  });

  //
  // Where the cursor should move
  //

  it("should apply external update and move cursor after editor blur", async () => {
    // This is a NEGATIVE test: cursor SHOULD move when user is not actively editing
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type and wait for sync
    await typeInEditor(page, "Hello World");
    await awaitCellContent("Hello World");

    // Blur the editor - this should allow external updates to apply
    await page.evaluate(`
      (() => {
        const active = document.activeElement;
        if (active && active.blur) active.blur();
      })()
    `);

    // External update with shorter content
    await piece.result.set("Short", ["content"]);
    await waitForEditorContent(page, "Short");

    // Cursor should be clamped to new content length (not stuck at old position)
    const cursor = await getCursorPosition(page);
    assert(
      cursor >= 0 && cursor <= "Short".length,
      `Cursor should be clamped to [0, 5], got ${cursor}`,
    );
  });

  it("should apply external update after debounce window fully expires", async () => {
    // After debounce completes, external updates should apply
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type and wait for debounce to complete
    await typeInEditor(page, "User typed");
    await awaitCellContent("User typed");
    await awaitEchoDelivered(page);

    // Now external update should apply (no pending local edit blocking it)
    await piece.result.set("External update", ["content"]);
    await waitForEditorContent(page, "External update");
  });

  //
  // Rapid operations and edge cases
  //

  it("should handle multiple rapid external updates correctly", async () => {
    // Stress test: rapid Cell updates should all apply correctly
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);

    // Send 5 external updates in quick succession (no user typing)
    for (let i = 0; i < 5; i++) {
      await piece.result.set(`Update ${i}`, ["content"]);
    }

    // Final content should be last update
    await waitForEditorContent(page, "Update 4");

    // Cursor should be valid
    const cursor = await getCursorPosition(page);
    assert(
      cursor >= 0 && cursor <= "Update 4".length,
      `Cursor should be valid, got ${cursor}`,
    );
  });

  it("should handle undo operation and maintain correct state", async () => {
    // Undo triggers updateListener - verify echo detection doesn't cause issues
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type initial text
    await typeInEditor(page, "Hello");
    await awaitCellContent("Hello");

    // Type more text
    await typeInEditor(page, " World");
    await awaitCellContent("Hello World");

    // Undo (Cmd+Z on Mac, Ctrl+Z on others)
    const isMac = await page.evaluate(`navigator.platform.includes('Mac')`);
    if (isMac) {
      await page.keyboard.down("Meta");
      await page.keyboard.press("z");
      await page.keyboard.up("Meta");
    } else {
      await page.keyboard.down("Control");
      await page.keyboard.press("z");
      await page.keyboard.up("Control");
    }
    await awaitViewSettled(page);

    // After undo, editor should show previous state
    const contentAfterUndo = await getEditorContent(page);
    // Note: Undo behavior depends on CodeMirror's history - content may vary
    // The key test is that cursor is valid and no crash occurs
    const cursorAfterUndo = await getCursorPosition(page);
    assert(
      cursorAfterUndo >= 0 && cursorAfterUndo <= contentAfterUndo.length,
      `Cursor should be valid after undo, got ${cursorAfterUndo}`,
    );

    // The undo edit schedules its own debounced write; wait for the committed
    // value to catch up with the editor.
    await awaitCellContent(contentAfterUndo);

    // Verify editor and Cell are in sync
    const finalContent = await getEditorContent(page);
    const cellValue = await piece.result.get(["content"]);
    assertEquals(
      finalContent,
      cellValue,
      "Editor and Cell should be in sync after undo",
    );
  });

  it("should handle text selection (anchor != head) during external update", async () => {
    // Test that selections are preserved/clamped correctly
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);

    // Set initial content externally
    await piece.result.set("Hello World Test", ["content"]);
    await waitForEditorContent(page, "Hello World Test");

    await focusEditor(page);

    // Select "World" (positions 6-11)
    await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
        if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');
        {
          cfEditor._editorView.dispatch({
            selection: { anchor: 6, head: 11 }
          });
        }
      })()
    `);

    // Verify selection
    const selection = (await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
        if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');
        const sel = cfEditor._editorView.state.selection.main;
        return { anchor: sel.anchor, head: sel.head };
      })()
    `)) as { anchor: number; head: number };
    assertEquals(selection.anchor, 6);
    assertEquals(selection.head, 11);

    // External update with shorter content - selection should be clamped
    await piece.result.set("Hi", ["content"]);
    await waitForEditorContent(page, "Hi");

    // Selection should be clamped to new content length
    const clampedSelection = (await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
        if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');
        const sel = cfEditor._editorView.state.selection.main;
        return { anchor: sel.anchor, head: sel.head };
      })()
    `)) as { anchor: number; head: number };

    assert(
      clampedSelection.anchor >= 0 && clampedSelection.anchor <= 2,
      `Anchor should be clamped to [0, 2], got ${clampedSelection.anchor}`,
    );
    assert(
      clampedSelection.head >= 0 && clampedSelection.head <= 2,
      `Head should be clamped to [0, 2], got ${clampedSelection.head}`,
    );
  });

  //
  // Race conditions, timing edges, and awkward updates
  //
  // Awkward covers content the editor must render intact, an update that
  // changes nothing, and an echo that comes back altered.
  //

  it("ADVERSARIAL: Cell update at exact debounce boundary should not corrupt state", async () => {
    // This tests the race condition where a Cell update arrives exactly
    // when the debounce timer fires. Either side may win the race; the
    // invariant is that editor and Cell converge and the cursor stays valid.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type some text
    await page.keyboard.type("Test");

    // Wait for ALMOST the full debounce window (490ms of 500ms), then send
    // the external update at the boundary. The two pauses construct the
    // race; the second lets whichever side lost the race finish.
    await new Promise((r) => setTimeout(r, 490));
    await piece.result.set("External at boundary", ["content"]);
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + DEBOUNCE_BUFFER));

    // After settling, editor and Cell should match
    await waitForRuntimeSynced(page);
    await awaitViewSettled(page);
    const editorContent = await getEditorContent(page);
    const cellContent = await piece.result.get(["content"]);
    assertEquals(
      editorContent,
      cellContent,
      "Editor and Cell should converge after the boundary race",
    );

    // Cursor should be valid
    const cursor = await getCursorPosition(page);
    assert(
      cursor >= 0 && cursor <= editorContent.length,
      `Cursor ${cursor} should be valid for content length ${editorContent.length}`,
    );
  });

  it("ADVERSARIAL: Rapid alternating type-Cell-type-Cell pattern", async () => {
    // Simulates a pathological case: user types, Cell updates, user types again
    // repeatedly. This can expose issues with edit tracking.
    //
    // CORRECT BEHAVIOR: the pending local edit wins over external deliveries
    // for as long as its write has not settled, so the typed characters
    // accumulate and the flushed write commits them over the external values.
    //
    // The "blur" strategy commits only on an explicit blur and arms no timer,
    // so every keystroke's edit stays pending and each external write is
    // delivered into the pending window; the blur at the end flushes the
    // accumulated edit.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await configureTiming(page, { strategy: "blur" });
    await focusEditor(page);

    try {
      // Alternating pattern: type → Cell → type → Cell → type. Each external
      // update lands while the local edit is pending and must not repaint the
      // editor.
      let typed = "";
      for (let i = 0; i < 3; i++) {
        await page.keyboard.type(`${i}`);
        typed += `${i}`;
        await waitForEditorContent(page, typed);

        await piece.result.set(`External-${i}`, ["content"]);
        await expectExternalWriteSuppressed(page, `External-${i}`, typed);
      }

      // Flushing commits the accumulated local edit over the external values.
      await blurEditor(page);
      await awaitCellContent("012");
      await awaitEchoDelivered(page);

      const content = await getEditorContent(page);
      const cursor = await getCursorPosition(page);
      assert(
        cursor >= 0 && cursor <= content.length,
        `Cursor ${cursor} should be valid for content length ${content.length}`,
      );

      const cellValue = await piece.result.get(["content"]) as string;
      assertEquals(
        content,
        cellValue,
        "Editor and Cell should be in sync after settling",
      );

      assertEquals(
        content,
        "012",
        "Pending local edits should win over external updates while unsettled",
      );
    } finally {
      await cancelPendingEditorEdit(page);
      await configureTiming(page, {
        strategy: "debounce",
        delay: DEBOUNCE_DELAY,
      });
    }
  });

  it("keeps one debounced edit over multiple interleaved Cell updates", async () => {
    // User types continuously while external updates bombard the Cell. The
    // pending local edit wins over the bombarding deliveries until it settles,
    // so the typed characters accumulate and commit as one write.
    //
    // The "blur" strategy commits only on an explicit blur and arms no timer,
    // so the edit stays pending for the whole sequence with nothing that can
    // fire mid-test; the blur at the end flushes the accumulated edit.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await configureTiming(page, { strategy: "blur" });
    await focusEditor(page);

    try {
      let typed = "";
      let bombard = 0;
      for (let i = 0; i < 10; i++) {
        const character = String.fromCharCode(65 + i); // A, B, C...
        typed += character;
        await page.keyboard.type(character);
        await waitForEditorContent(page, typed);

        // Bombard the Cell on every other keystroke; each external write lands
        // while the local edit is pending and must not repaint the editor.
        if (i % 2 === 1) {
          await piece.result.set(`Bombard-${bombard}`, ["content"]);
          await expectExternalWriteSuppressed(
            page,
            `Bombard-${bombard}`,
            typed,
          );
          bombard++;
        }
      }

      // Blurring commits the complete local edit after every external update.
      await blurEditor(page);
      await awaitCellContent("ABCDEFGHIJ");
      await awaitEchoDelivered(page);

      // Final state should be consistent
      const content = await getEditorContent(page);
      const cursor = await getCursorPosition(page);
      const cellValue = await piece.result.get(["content"]) as string;

      // Cursor must be valid
      assert(
        cursor >= 0 && cursor <= content.length,
        `Cursor ${cursor} should be valid for content length ${content.length}`,
      );

      // Editor and Cell should be in sync
      assertEquals(
        content,
        cellValue,
        "Editor and Cell should match after the local edit commits",
      );

      assertEquals(
        content,
        "ABCDEFGHIJ",
        "Pending local edit should survive all external updates",
      );
    } finally {
      await cancelPendingEditorEdit(page);
      await configureTiming(page, {
        strategy: "debounce",
        delay: DEBOUNCE_DELAY,
      });
    }
  });

  it("ADVERSARIAL: Empty string Cell update during typing", async () => {
    // Edge case: the Cell is set to empty while the user is typing. When the
    // stored value is already empty (the pending edit has not committed), the
    // write is a no-op that fires no delivery, so typing continues
    // uninterrupted and commits on flush.
    //
    // The invariants: the cursor stays valid (no crash from cursor >
    // content.length) and the editor and Cell end consistent.
    //
    // The "blur" strategy commits only on an explicit blur and arms no timer,
    // so the edit stays pending and the stored value stays empty throughout;
    // the blur at the end flushes the accumulated edit.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await configureTiming(page, { strategy: "blur" });
    await focusEditor(page);

    try {
      await page.keyboard.type("Hello World");
      await waitForEditorContent(page, "Hello World");
      assertEquals(await getCursorPosition(page), 11);

      // The stored value is still empty (the pending edit has not committed),
      // so this clears nothing; the editor keeps the pending edit.
      await piece.result.set("", ["content"]);
      await awaitViewSettled(page);
      assertEquals(
        await getEditorContent(page),
        "Hello World",
        "An empty no-op write must not disturb the pending edit",
      );

      // Continue typing, then flush.
      await page.keyboard.type("More");
      await waitForEditorContent(page, "Hello WorldMore");
      await blurEditor(page);
      await awaitCellContent("Hello WorldMore");
      await awaitEchoDelivered(page);

      const finalContent = await getEditorContent(page);
      const cursor = await getCursorPosition(page);

      // CRITICAL: Cursor must be valid (no crash)
      assert(
        cursor >= 0 && cursor <= finalContent.length,
        `Cursor ${cursor} should be valid for content length ${finalContent.length}`,
      );

      // Editor and Cell should be in sync
      const cellValue = await piece.result.get(["content"]) as string;
      assertEquals(
        finalContent,
        cellValue,
        "Editor and Cell should be in sync",
      );

      // Content should be the user's typing (the external update was a no-op)
      assertEquals(
        finalContent,
        "Hello WorldMore",
        "User's typing should apply when the external update is a no-op",
      );
    } finally {
      await cancelPendingEditorEdit(page);
      await configureTiming(page, {
        strategy: "debounce",
        delay: DEBOUNCE_DELAY,
      });
    }
  });

  it("ADVERSARIAL: Very long content replacement should clamp cursor correctly", async () => {
    // Test: set very long content, position cursor at end, then replace with short content.
    // Cursor should be clamped, not left at an invalid position.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);

    // Set very long content
    const longContent = "A".repeat(1000);
    await piece.result.set(longContent, ["content"]);
    await waitForEditorContent(page, longContent);

    // Position cursor at the very end
    await focusEditor(page);
    await setCursorPosition(page, 1000);

    const cursorAtEnd = await getCursorPosition(page);
    assertEquals(cursorAtEnd, 1000, "Cursor should be at end of long content");

    // Replace with very short content
    await piece.result.set("X", ["content"]);
    await waitForEditorContent(page, "X");

    // Cursor should be clamped to valid range [0, 1]
    const clampedCursor = await getCursorPosition(page);
    assert(
      clampedCursor >= 0 && clampedCursor <= 1,
      `Cursor should be clamped to [0, 1], got ${clampedCursor}`,
    );
  });

  it("ADVERSARIAL: Cell echo with slightly modified content should apply", async () => {
    // Edge case: Cell echoes back content that's ALMOST the same as what
    // was typed but with a small modification (e.g., trailing whitespace trimmed).
    // The content comparison should detect this and apply the update.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type content with trailing spaces
    await page.keyboard.type("Hello   ");

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, 8); // "Hello   " is 8 chars

    // Wait for debounce to send to Cell
    await awaitCellContent("Hello   ");

    // Simulate backend trimming the content
    await piece.result.set("Hello", ["content"]);
    await waitForEditorContent(page, "Hello");

    // Cursor should be clamped to new length
    const finalCursor = await getCursorPosition(page);
    assert(
      finalCursor >= 0 && finalCursor <= 5,
      `Cursor should be clamped to [0, 5], got ${finalCursor}`,
    );
  });

  it("ADVERSARIAL: Typing during blur should not lose content", async () => {
    // Edge case: user types, then blurs before debounce completes.
    // The blur handler should flush any pending content.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type some content
    await page.keyboard.type("Pre-blur content");

    // Immediately blur (before debounce)
    await page.evaluate(`
      (() => {
        const active = document.activeElement;
        if (active && active.blur) active.blur();
      })()
    `);

    // The blur handler flushes the pending content to the Cell.
    await awaitCellContent("Pre-blur content");
  });

  it("ADVERSARIAL: Special characters should not break echo detection", async () => {
    // Test with unicode, emoji, newlines - characters that might affect the
    // content comparison
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // Type content with special characters
    const specialContent = "Hello 世界 🎉\nNew line\ttab";
    await page.keyboard.type(specialContent);

    const cursorAfterTyping = await getCursorPosition(page);
    assertEquals(cursorAfterTyping, specialContent.length);

    // Wait for debounce
    await awaitCellContent(specialContent);
    await awaitEchoDelivered(page);

    // Cursor should not jump
    const cursorAfterEcho = await getCursorPosition(page);
    assertEquals(
      cursorAfterEcho,
      specialContent.length,
      "Cursor should not jump with special characters",
    );
  });

  it("ADVERSARIAL: Repeated identical Cell updates should be no-ops", async () => {
    // Sending the same content repeatedly to Cell should not cause cursor jumps
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);

    // Set initial content
    await piece.result.set("Static content", ["content"]);
    await waitForEditorContent(page, "Static content");

    // Focus and position cursor in the middle
    await focusEditor(page);
    await setCursorPosition(page, 7);

    const initialCursor = await getCursorPosition(page);
    assertEquals(initialCursor, 7);

    // Send same content 10 times in quick succession
    for (let i = 0; i < 10; i++) {
      await piece.result.set("Static content", ["content"]);
    }

    // A re-set to the same value commits no change, so there is no event to
    // await; settle the page and verify nothing moved.
    await waitForRuntimeSynced(page);
    await awaitViewSettled(page);

    // Cursor should not have moved (identical content = no-op)
    const finalCursor = await getCursorPosition(page);
    assertEquals(
      finalCursor,
      7,
      "Cursor should not move when identical content is set",
    );
  });

  it("ADVERSARIAL: Typing exactly at debounce expiry should commit correctly", async () => {
    // Type, wait until the first debounce commits, then type again.
    // Both inputs should be committed.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);
    await focusEditor(page);

    // First typing burst
    await page.keyboard.type("First");

    // Wait for debounce to complete
    await awaitCellContent("First");

    // Immediately type more
    await page.keyboard.type("Second");

    const cursorAfterSecond = await getCursorPosition(page);
    assertEquals(cursorAfterSecond, 11); // "FirstSecond"

    // Wait for second debounce
    await awaitCellContent("FirstSecond");
    await awaitEchoDelivered(page);

    // Cursor should still be correct
    const finalCursor = await getCursorPosition(page);
    assertEquals(finalCursor, 11);
  });

  it("ADVERSARIAL: Rapid focus/blur cycles during typing should not corrupt content", async () => {
    // Focus, type, blur, focus, type - rapidly cycling while typing
    // Should maintain content integrity. Each blur flushes the pending edit.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);

    // Focus and type first part, blur to flush
    await focusEditor(page);
    await page.keyboard.type("AAA");
    await page.evaluate(`document.body.click()`);
    await awaitCellContent("AAA");

    // Focus and type second part, blur to flush
    await focusEditor(page);
    await page.keyboard.type("BBB");
    await page.evaluate(`document.body.click()`);
    await awaitCellContent("AAABBB");

    // Focus and type third part, let the debounce commit it
    await focusEditor(page);
    await page.keyboard.type("CCC");
    await awaitCellContent("AAABBBCCC");

    // All typed content should be preserved
    const content = await getEditorContent(page);
    assertEquals(
      content,
      "AAABBBCCC",
      "All typed content should be preserved after focus/blur cycles",
    );
  });

  it("ADVERSARIAL: External update between blur and debounce should apply correctly", async () => {
    // Type, blur (triggers immediate commit), then send external update
    // External update should apply since user is no longer typing
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);

    // Focus and type
    await focusEditor(page);
    await page.keyboard.type("UserContent");

    // Blur by explicitly calling blur() on the CodeMirror contentDOM
    await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
        if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');
        {
          cfEditor._editorView.contentDOM.blur();
        }
      })()
    `);

    // The blur flushes the typed content to the Cell.
    await awaitCellContent("UserContent");

    // Now send external update - should apply since no typing is in progress
    await piece.result.set("ExternalAfterBlur", ["content"]);
    await waitForEditorContent(page, "ExternalAfterBlur");
  });

  it("ADVERSARIAL: Value property change to different Cell during typing", async () => {
    // This test verifies that switching to a different Cell mid-typing
    // properly cancels pending updates and resets state.
    // Note: We can't easily create a second Cell in this test harness,
    // but we can verify the value property change path works.
    const page = await openPiece(shell, piece.id, identity);

    await resetEditorState(page);

    // Focus and type
    await focusEditor(page);
    await page.keyboard.type("TypingContent");

    // Simulate value property change by calling the path that updated() takes
    await page.evaluate(`
      (() => {
        function findCfCodeEditor(root) {
          if (!root) return null;
          const editor = root.querySelector?.('cf-code-editor');
          if (editor) return editor;
          const allElements = root.querySelectorAll?.('*') || [];
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = findCfCodeEditor(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const cfEditor = findCfCodeEditor(document);
        if (cfEditor) {
          // Simulate the reset that happens on value property change
          cfEditor._cellController.cancel();
        }
      })()
    `);

    // Wait out the debounce window: the canceled write must NOT fire, and a
    // negative can only be observed by letting the window in which it would
    // have fired elapse.
    await new Promise((r) => setTimeout(r, DEBOUNCE_DELAY + DEBOUNCE_BUFFER));

    const cellValue = await piece.result.get(["content"]);
    assertEquals(
      cellValue,
      "",
      "Pending debounced write should be canceled on value change",
    );

    // External update should still apply after cancellation
    await piece.result.set("AfterValueChange", ["content"]);
    await waitForEditorContent(page, "AfterValueChange");
  });
});

describe("cf-code-editor backlink title sync", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let sinkCancel: (() => void) | undefined;
  // The piece's committed content value, tracked by the result-cell sink below,
  // and a one-shot waiter the sink resolves when the value reaches a target.
  let latestContent: string | undefined;
  let contentWaiter: { target: string; deferred: Deferred } | undefined;

  // Resolve once the committed content equals `target`. A browser-side value-
  // cell write reaches this controller asynchronously, so read the value
  // through this waiter rather than a bare get(), which can still return the
  // pre-write value.
  const awaitCellContent = (target: string): Promise<void> => {
    if (latestContent === target) return Promise.resolve();
    const deferred = defer();
    contentWaiter = { target, deferred };
    return deferred.promise;
  };

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    piece = await cc.create(
      await Deno.readTextFile(
        join(import.meta.dirname!, "..", "examples", "cf-code-editor-cell.tsx"),
      ),
      { start: true },
    );

    await new ACLManager(cc.runtime, cc.getSpace()).set(ANYONE_USER, "WRITE");

    // Keep the piece reactive (pull mode) and track its committed content, so a
    // browser-side write to the value cell is observed here.
    const resultCell = cc.getResult(piece.getCell());
    sinkCancel = resultCell.sink((value) => {
      latestContent = (value as { content?: string } | undefined)?.content;
      if (contentWaiter && latestContent === contentWaiter.target) {
        contentWaiter.deferred.resolve();
        contentWaiter = undefined;
      }
    });
  });

  afterAll(async () => {
    sinkCancel?.();
    if (cc) await cc.dispose();
  });

  //
  // How the remote rename is delivered
  //
  // The linked piece's real title is not synced to the editor's runtime in
  // these tests: the editor's mentionable projection carries only NAME, so a
  // cross-document linked piece's title only reaches the editor inside the full
  // default-app. The remote rename is instead delivered by invoking the
  // editor's own _handleExternalTitleChange with a stand-in piece cell whose
  // title and NAME are the renamed values, exactly what a real title
  // subscription would call.
  //

  it("preserves a remote title change over a pending local edit", async () => {
    const page = await openPiece(shell, piece.id, identity);
    const pieceId = "backlink-pending-edit-piece";
    const pill = `[[📝 Target (${pieceId})]]`;
    const renamedPill = `[[📝 New Target (${pieceId})]]`;

    // The "blur" strategy commits only on an explicit blur and arms no timer,
    // so the typed edit stays pending until the test flushes it.
    await configureTiming(page, { strategy: "blur" });

    await piece.result.set(pill, ["content"]);
    await waitForEditorContent(page, pill);

    // Begin a local edit: append a character after the pill. Its Cell write
    // stays pending until blur — nothing commits yet.
    await focusEditor(page);
    await setCursorPosition(page, pill.length);
    await page.keyboard.type("X");
    await waitForEditorContent(page, `${pill}X`);

    // The linked piece is renamed while the local edit is pending.
    assert(
      await invokeExternalTitleChange(
        page,
        pieceId,
        "New Target",
        "📝 New Target",
      ),
      "editor did not expose _handleExternalTitleChange",
    );

    // Flush any pending write by blurring, then let it reach storage.
    await blurEditor(page);
    await waitForRuntimeSynced(page);
    await awaitViewSettled(page);

    // The editor and the committed cell converge on one value. Wait for the
    // committed cell to catch up to the editor's document, then assert that
    // value carries BOTH the remote title change and the pending local edit.
    // The rewrite must merge with the pending edit; otherwise the flushed
    // keystroke buffer commits last and reverts the title to `📝 Target`.
    const editorContent = await getEditorContent(page);
    await awaitCellContent(editorContent);
    assertEquals(
      editorContent,
      `${renamedPill}X`,
      "Flushed edit overwrote the remote title change with a stale buffer",
    );
  });

  it("persists a remote title change under the blur strategy without user interaction", async () => {
    const page = await openPiece(shell, piece.id, identity);
    const pieceId = "backlink-blur-piece";
    const pill = `[[📝 Target (${pieceId})]]`;
    const renamedPill = `[[📝 New Target (${pieceId})]]`;

    // Under the blur strategy a user edit commits only on blur. A remote title
    // change is not user input: it must persist even though the editor is never
    // focused or blurred in this test.
    await configureTiming(page, { strategy: "blur" });

    await piece.result.set(pill, ["content"]);
    await waitForEditorContent(page, pill);

    // Deliver the remote rename with no focus, typing, or blur.
    assert(
      await invokeExternalTitleChange(
        page,
        pieceId,
        "New Target",
        "📝 New Target",
      ),
      "editor did not expose _handleExternalTitleChange",
    );
    await waitForRuntimeSynced(page);

    // The rewrite must reach the committed cell on its own. Without the flush it
    // would sit in controller state awaiting a focus/blur cycle that never
    // comes, and this wait would never resolve.
    await awaitCellContent(renamedPill);
    const editorContent = await getEditorContent(page);
    assertEquals(
      editorContent,
      renamedPill,
      "Editor should show the renamed pill under the blur strategy",
    );
  });
});

/**
 * Get current cursor position in the cf-code-editor
 */
async function getCursorPosition(page: Page): Promise<number> {
  const result = await page.evaluate(`
    (() => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
      if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');

      return cfEditor._editorView.state.selection.main.head;
    })()
  `);
  return result as number;
}

/**
 * Answers the cf-code-editor's current document text.
 *
 * @throws If the page carries no editor, or its CodeMirror view is not up. An
 *   absent editor and an empty document are different states, and this
 *   distinguishes them.
 */
async function getEditorContent(page: Page): Promise<string> {
  const result = await page.evaluate(`
    (() => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
      if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');

      return cfEditor._editorView.state.doc.toString();
    })()
  `);
  return result as string;
}

/**
 * Focus the CodeMirror editor by clicking on the content area
 */
async function focusEditor(page: Page): Promise<void> {
  await page.evaluate(`
    (() => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
      if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');
      {
        cfEditor._editorView.focus();
      }
    })()
  `);
}

/** Abandon the editor's pending local edit and scheduled write. */
async function cancelPendingEditorEdit(page: Page): Promise<void> {
  await page.evaluate(`
    (() => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor) throw new Error('cf-code-editor not found');
      cfEditor._cellController.cancel();
    })()
  `);
}

/**
 * Blur the CodeMirror editor, flushing any pending debounced Cell write.
 */
async function blurEditor(page: Page): Promise<void> {
  await page.evaluate(`
    (() => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
      if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');
      {
        cfEditor._editorView.contentDOM.blur();
      }
    })()
  `);
}

/**
 * Set the editor's input-timing strategy (and optional delay) at runtime.
 */
async function configureTiming(
  page: Page,
  options: { strategy: string; delay?: number },
): Promise<void> {
  await page.evaluate(`
    ((options) => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
      if (!cfEditor._cellController) {
        throw new Error('cf-code-editor has no cell controller');
      }
      {
        cfEditor._cellController.updateTimingOptions(options);
      }
    })(${JSON.stringify(options)})
  `);
}

/**
 * Invoke the editor's remote-title-change handler with a stand-in piece cell:
 * key('title') returns the raw title and any other key (the NAME symbol)
 * returns the display name, exactly what a real piece-title subscription
 * delivers. Returns false if the handler is not exposed.
 */
async function invokeExternalTitleChange(
  page: Page,
  pieceId: string,
  title: string,
  name: string,
): Promise<boolean> {
  return await page.evaluate(`
    ((id, title, name) => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const ed = findCfCodeEditor(document);
      if (!ed || typeof ed._handleExternalTitleChange !== 'function') return false;
      const renamed = {
        key: (k) => ({ get: () => k === 'title' ? title : name }),
      };
      ed._handleExternalTitleChange(id, renamed);
      return true;
    })(${JSON.stringify(pieceId)}, ${JSON.stringify(title)}, ${
    JSON.stringify(name)
  })
  `) as boolean;
}

/**
 * Type text into the editor using keyboard simulation
 * This properly triggers the typing flow with debounce
 */
async function typeInEditor(page: Page, text: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.type(text);
}

/**
 * Set cursor position in the editor
 */
async function setCursorPosition(page: Page, position: number): Promise<void> {
  await page.evaluate(`
    ((pos) => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
      if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');
      {
        cfEditor._editorView.dispatch({
          selection: { anchor: pos, head: pos }
        });
      }
    })(${position})
  `);
}

/**
 * Clear the editor content.
 * Uses the Cell sync annotation to prevent updateListener from scheduling
 * Cell writes.
 */
async function clearEditor(page: Page): Promise<void> {
  await page.evaluate(`
    (() => {
      function findCfCodeEditor(root) {
        if (!root) return null;
        const editor = root.querySelector?.('cf-code-editor');
        if (editor) return editor;
        const allElements = root.querySelectorAll?.('*') || [];
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = findCfCodeEditor(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const cfEditor = findCfCodeEditor(document);
      if (!cfEditor) throw new Error('no cf-code-editor at ' + document.URL);
      if (!cfEditor._editorView) throw new Error('cf-code-editor has no view');
      {
        const view = cfEditor._editorView;
        // Clear editor content using the Cell sync annotation to prevent
        // updateListener from scheduling Cell writes.
        const annotation = cfEditor.constructor._cellSyncAnnotation;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "" },
          selection: { anchor: 0, head: 0 },
          annotations: annotation ? annotation.of(true) : undefined
        });
      }
    })()
  `);
}
