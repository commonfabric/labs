// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CellReadRefusedError } from "@commonfabric/runtime-client";

import type { XBodyView } from "../src/views/BodyView.ts";
import { installBrowserGlobals } from "./browser-globals.ts";
import { templateMarkup } from "./lit-template-markup.ts";

/** What a sidebar read of the stand-in piece does on each of its two reads. */
interface SidebarReads {
  /** The value the piece holds before a sync, or an error the read throws. */
  readonly before: unknown;

  /** The value the piece holds once synced. */
  readonly after?: unknown;
}

/**
 * A stand-in for a piece the shell opened, whose result document answers the
 * sidebar read as `reads` says, and which records the schemas it was read
 * with and whether it was synced.
 */
function pieceWith(reads: SidebarReads) {
  const log: string[] = [];
  let synced = false;
  const sidebarHandle = { sidebar: "handle" };
  const typed = {
    get() {
      const value = synced ? reads.after : reads.before;
      if (value instanceof Error) throw value;
      return value;
    },
    sync() {
      log.push("sync");
      synced = true;
      return Promise.resolve();
    },
    key(key: string) {
      log.push(`key ${key}`);
      return { asSchema: () => sidebarHandle };
    },
  };
  const cell = {
    ref: () => ({ path: [] }),
    asSchema: () => typed,
  };
  return {
    log,
    sidebarHandle,
    piece: { id: () => "of:piece", cell: () => cell } as never,
  };
}

describe("XBodyView", () => {
  let restore: () => void;
  let BodyView: typeof XBodyView;

  beforeEach(async () => {
    restore = installBrowserGlobals("http://localhost:8000/body-view");
    ({ XBodyView: BodyView } = await import("../src/views/BodyView.ts"));
  });

  afterEach(() => restore());

  describe("instance members", () => {
    describe("render()", () => {
      it("shows the sidebar a piece holds, read without a sync when the piece is loaded", async () => {
        const view = new BodyView();
        const { piece, log, sidebarHandle } = pieceWith({
          before: { sidebarUI: { type: "vnode" } },
        });
        view.activePattern = piece;
        const task = view.accessForTestingOnly.subPages;
        task.run();
        await task.taskComplete;

        expect(task.value?.sidebarUI).toBe(sidebarHandle);
        expect(log).toEqual(["key sidebarUI"]);
        expect(templateMarkup(view.render())).toContain(
          '<cf-render slot="sidebar"',
        );
      });

      it("syncs a piece not yet loaded before reading its sidebar", async () => {
        const view = new BodyView();
        const { piece, log, sidebarHandle } = pieceWith({
          before: undefined,
          after: { sidebarUI: { type: "vnode" } },
        });
        view.activePattern = piece;
        const task = view.accessForTestingOnly.subPages;
        task.run();
        await task.taskComplete;

        expect(task.value?.sidebarUI).toBe(sidebarHandle);
        expect(log).toEqual(["sync", "key sidebarUI"]);
      });

      it("shows no sidebar for a piece that holds nothing once synced", async () => {
        const view = new BodyView();
        const { piece, log } = pieceWith({ before: undefined });
        view.activePattern = piece;
        const task = view.accessForTestingOnly.subPages;
        task.run();
        await task.taskComplete;

        expect(task.value?.sidebarUI).toBeUndefined();
        expect(log).toEqual(["sync"]);
        expect(templateMarkup(view.render())).not.toContain('slot="sidebar"');
      });

      it("shows no sidebar for a piece that holds none", async () => {
        const view = new BodyView();
        const { piece, log } = pieceWith({ before: { title: "no sidebar" } });
        view.activePattern = piece;
        const task = view.accessForTestingOnly.subPages;
        task.run();
        await task.taskComplete;

        expect(task.value?.sidebarUI).toBeUndefined();
        expect(log).toEqual([]);
      });

      it("shows no sidebar where the display ceiling refuses the read", async () => {
        const view = new BodyView();
        const { piece } = pieceWith({
          before: new CellReadRefusedError({ refusedBy: "display-ceiling" }),
        });
        view.activePattern = piece;
        const task = view.accessForTestingOnly.subPages;
        task.run();
        await task.taskComplete;

        expect(task.value?.sidebarUI).toBeUndefined();
        expect(templateMarkup(view.render())).not.toContain('slot="sidebar"');
      });

      it("fails the sidebar read on an error other than a refusal", async () => {
        const view = new BodyView();
        const failure = new Error("the document would not decode");
        const { piece } = pieceWith({ before: failure });
        view.activePattern = piece;
        const task = view.accessForTestingOnly.subPages;
        task.run();
        await task.taskComplete.catch(() => {});

        expect(task.error).toBe(failure);
        expect(templateMarkup(view.render())).not.toContain('slot="sidebar"');
      });

      it("reads no sidebar while embedded, whatever the piece holds", async () => {
        const view = new BodyView();
        const { piece, log } = pieceWith({
          before: { sidebarUI: { type: "vnode" } },
        });
        view.activePattern = piece;
        view.embedded = true;
        const task = view.accessForTestingOnly.subPages;
        task.run();
        await task.taskComplete;

        expect(task.value?.sidebarUI).toBeUndefined();
        expect(log).toEqual([]);
        const markup = templateMarkup(view.render());
        expect(markup).toContain('class="content embedded"');
        expect(markup).not.toContain('slot="sidebar"');
      });

      it("shows the message of a load error that is a plain object", () => {
        const view = new BodyView();
        view.loadError = {
          kind: "piece",
          error: { message: "  the pattern failed to compile  " },
        };

        const markup = templateMarkup(view.render());
        expect(markup).toContain("We could not load this piece");
        expect(markup).toContain("<code>the pattern failed to compile</code>");
        expect(markup).not.toContain("No additional error details");
      });
    });
  });
});
