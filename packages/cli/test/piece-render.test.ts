/**
 * `cf piece render` turns a piece's UI into HTML by running the reconciler and
 * the DOM applicator in the CLI's own process, against a mock document.
 *
 * The trees here are shaped the way the renderer's schema delivers one: props
 * and children arrive as cells rather than as plain values. A renderer that
 * cannot follow those cells produces a bare tag with nothing inside it.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { assignSlug, pieceId, setSlugLink } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, createBuilder, Runtime, UI } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { parsePieceOptions } from "../commands/piece.ts";
import { renderPiece, renderVDomToHtml } from "../lib/piece-render.ts";
import type { PieceConfig } from "../lib/piece.ts";

const signer = await Identity.fromPassphrase("cli piece render test");
const space = signer.did();

function makeRuntime(): Runtime {
  return new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: StorageManager.emulate({ as: signer }),
  });
}

/** Commit `value` into a fresh cell and hand back the cell. */
async function cellHolding(
  runtime: Runtime,
  name: string,
  value: unknown,
): Promise<Cell<unknown>> {
  const tx = runtime.edit();
  const cell = runtime.getCell<unknown>(space, name, undefined, tx);
  cell.set(value);
  await tx.commit();
  return cell;
}

async function setCell(
  runtime: Runtime,
  cell: Cell<unknown>,
  value: unknown,
): Promise<void> {
  const tx = runtime.edit();
  cell.withTx(tx).set(value);
  await tx.commit();
}

const vnode = (name: string, props: unknown, children: unknown[]) => ({
  type: "vnode",
  name,
  props,
  children,
});

describe("piece-render", () => {
  describe("renderVDomToHtml()", () => {
    describe("one-shot render", () => {
      it("serializes nested elements, props and text", async () => {
        const runtime = makeRuntime();
        try {
          const vdom = await cellHolding(
            runtime,
            "static-greeting",
            vnode("div", { id: "hello" }, [
              vnode("p", { class: "line" }, ["Hello world!"]),
              vnode("span", {}, ["and again"]),
            ]),
          );

          const html = await renderVDomToHtml(vdom, () => runtime.idle());

          expect(html).toBe(
            '<div id="hello"><p class="line">Hello world!</p>' +
              "<span>and again</span></div>",
          );
        } finally {
          await runtime.dispose();
        }
      });

      it("follows a cell in child position", async () => {
        const runtime = makeRuntime();
        try {
          const label = await cellHolding(
            runtime,
            "static-label",
            "from a cell",
          );
          const vdom = await cellHolding(
            runtime,
            "static-labeled",
            vnode("div", {}, [label]),
          );

          const html = await renderVDomToHtml(vdom, () => runtime.idle());

          expect(html).toBe("<div>from a cell</div>");
        } finally {
          await runtime.dispose();
        }
      });

      it("converts a style object into a `style` attribute", async () => {
        const runtime = makeRuntime();
        try {
          const vdom = await cellHolding(
            runtime,
            "static-styled",
            vnode(
              "div",
              { style: { backgroundColor: "red", marginTop: 10 } },
              [],
            ),
          );

          const html = await renderVDomToHtml(vdom, () => runtime.idle());

          expect(html).toBe(
            '<div style="background-color: red; margin-top: 10px"></div>',
          );
        } finally {
          await runtime.dispose();
        }
      });

      it("returns the empty string for an empty tree", async () => {
        const runtime = makeRuntime();
        try {
          const vdom = await cellHolding(runtime, "static-empty", undefined);

          const html = await renderVDomToHtml(vdom, () => runtime.idle());

          expect(html).toBe("");
        } finally {
          await runtime.dispose();
        }
      });
    });

    describe("watch mode", () => {
      it("returns a cancel function rather than HTML", async () => {
        const runtime = makeRuntime();
        try {
          const vdom = await cellHolding(
            runtime,
            "watch-shape",
            vnode("div", {}, ["x"]),
          );
          const seen = defer<string>();
          const result = renderVDomToHtml(
            vdom,
            () => runtime.idle(),
            (html) => seen.resolve(html),
          );

          expect(typeof result).toBe("function");
          expect(await seen.promise).toBe("<div>x</div>");
          (result as () => void)();
        } finally {
          await runtime.dispose();
        }
      });

      it("reports the settled tree, then reports each change", async () => {
        const runtime = makeRuntime();
        let cancel: (() => void) | undefined;
        try {
          const label = await cellHolding(runtime, "watch-label", "first");
          const vdom = await cellHolding(
            runtime,
            "watch-root",
            vnode("div", {}, [label]),
          );

          const updates: string[] = [];
          let next = defer<string>();
          cancel = renderVDomToHtml(vdom, () => runtime.idle(), (html) => {
            updates.push(html);
            next.resolve(html);
          }) as () => void;

          expect(await next.promise).toBe("<div>first</div>");

          next = defer<string>();
          await setCell(runtime, label, "second");
          expect(await next.promise).toBe("<div>second</div>");

          // Each settled tree is reported once, not once per operation batch.
          expect(updates).toEqual(["<div>first</div>", "<div>second</div>"]);
        } finally {
          cancel?.();
          await runtime.dispose();
        }
      });

      it("stops reporting once cancelled", async () => {
        const runtime = makeRuntime();
        try {
          const label = await cellHolding(runtime, "cancel-label", "before");
          const vdom = await cellHolding(
            runtime,
            "cancel-root",
            vnode("div", {}, [label]),
          );

          const updates: string[] = [];
          const first = defer<string>();
          const cancel = renderVDomToHtml(
            vdom,
            () => runtime.idle(),
            (html) => {
              updates.push(html);
              first.resolve(html);
            },
          ) as () => void;

          await first.promise;
          cancel();

          await setCell(runtime, label, "after");
          await runtime.idle();

          // Unmounting emits its own operations; they must not become one last
          // report of the now-empty tree.
          expect(updates).toEqual(["<div>before</div>"]);
        } finally {
          await runtime.dispose();
        }
      });

      it("keeps reporting after a settle fails", async () => {
        const runtime = makeRuntime();
        let cancel: (() => void) | undefined;
        try {
          const label = await cellHolding(runtime, "failing-label", "one");
          const vdom = await cellHolding(
            runtime,
            "failing-root",
            vnode("div", {}, [label]),
          );

          // The first settle rejects; the render must not latch shut on it.
          let failNext = true;
          const idle = () => {
            if (failNext) {
              failNext = false;
              return Promise.reject(new Error("settle failed"));
            }
            return runtime.idle();
          };

          const updates: string[] = [];
          const next = defer<string>();
          cancel = renderVDomToHtml(vdom, idle, (html) => {
            updates.push(html);
            next.resolve(html);
          }) as () => void;

          await setCell(runtime, label, "two");
          expect(await next.promise).toBe("<div>two</div>");
          expect(updates).toEqual(["<div>two</div>"]);
        } finally {
          cancel?.();
          await runtime.dispose();
        }
      });
    });
  });

  describe("renderPiece()", () => {
    const config: PieceConfig = {
      apiUrl: "http://localhost:8000",
      space,
      identity: "/nonexistent/keyfile",
      piece: "fid1:render-piece",
    };

    /** A controller over `cell`, collecting the arguments of every `get`. */
    function stubController(
      runtime: Runtime,
      cell: Cell<unknown>,
      gets: unknown[][] = [],
    ): PiecesController {
      return {
        runtime,
        get: (...args: unknown[]) => {
          gets.push(args);
          return Promise.resolve({ getCell: () => cell });
        },
      } as unknown as PiecesController;
    }

    it("returns the piece's UI as HTML", async () => {
      const runtime = makeRuntime();
      try {
        const cell = await cellHolding(runtime, "render-piece-ui", {
          [UI]: vnode("div", { id: "hello" }, [vnode("p", {}, ["Hi"])]),
        });

        const html = await renderPiece(config, {}, {
          loadPieces: () => Promise.resolve(stubController(runtime, cell)),
        });

        expect(html).toBe('<div id="hello"><p>Hi</p></div>');
      } finally {
        await runtime.dispose();
      }
    });

    it("throws naming a piece that publishes no UI", async () => {
      const runtime = makeRuntime();
      try {
        const cell = await cellHolding(runtime, "render-piece-bare", {
          title: "Notes",
        });

        await expect(
          renderPiece(config, {}, {
            loadPieces: () => Promise.resolve(stubController(runtime, cell)),
          }),
        ).rejects.toThrow(`Piece ${config.piece} has no UI`);
      } finally {
        await runtime.dispose();
      }
    });

    it("starts the piece unless `start` says otherwise", async () => {
      // Computed state is only fresh while the pattern runs, so a render
      // starts the piece by default and reads stored state when told not to.

      const runtime = makeRuntime();
      try {
        const cell = await cellHolding(runtime, "render-piece-start", {
          [UI]: vnode("div", {}, []),
        });
        const gets: unknown[][] = [];
        const deps = {
          loadPieces: () =>
            Promise.resolve(stubController(runtime, cell, gets)),
        };

        await renderPiece(config, {}, deps);
        await renderPiece(config, { start: false }, deps);

        expect(gets.map((args) => args[1])).toEqual([true, false]);
      } finally {
        await runtime.dispose();
      }
    });

    describe("stored references", () => {
      let runtime: Runtime;
      let pieces: PiecesController;
      let target: Cell<unknown>;

      beforeEach(async () => {
        runtime = makeRuntime();
        pieces = new PiecesController({ as: signer, space }, runtime);
        await pieces.synced();
        const { commonfabric } = createBuilder();
        const pattern = commonfabric.pattern<{ title: string }>((
          { title },
        ) => ({
          [UI]: vnode("p", {}, [title]),
        }));
        target = await pieces.runPersistent(
          pattern,
          { title: "Slug target" },
          "render-slug-target",
        );
        await assignSlug(pieces, target, "greeting");
      });

      afterEach(async () => {
        await runtime.dispose();
      });

      it("returns the same HTML through a slug as through the piece id", async () => {
        const deps = { loadPieces: () => Promise.resolve(pieces) };
        const byId = await renderPiece(
          { ...config, piece: pieceId(target)! },
          {},
          deps,
        );
        expect(byId).toBe("<p>Slug target</p>");

        const bySlug = await renderPiece(
          parsePieceOptions({ ...config, cell: "/greeting" }),
          {},
          deps,
        );
        expect(bySlug).toBe(byId);
      });

      it("returns the UI of the member selected through a collection slug", async () => {
        const collection = await cellHolding(runtime, "render-collection", {
          selected: target,
        });
        await setSlugLink(pieces, "greetings", collection);

        const html = await renderPiece(
          parsePieceOptions({ ...config, cell: "/greetings/selected" }),
          { start: false },
          { loadPieces: () => Promise.resolve(pieces) },
        );

        expect(html).toBe("<p>Slug target</p>");
      });

      it("throws when a slug reference names a path inside the piece", async () => {
        await expect(renderPiece(
          parsePieceOptions({ ...config, cell: "/greeting/title" }),
          {},
          { loadPieces: () => Promise.resolve(pieces) },
        )).rejects.toThrow(
          'embeds a path ("title") but this command takes a piece id only',
        );
      });
    });
  });
});
