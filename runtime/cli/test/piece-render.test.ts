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
import {
  type Cell,
  createBuilder,
  Runtime,
  type RuntimeProgram,
  UI,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
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
  await tx.commit().settled;
  return cell;
}

async function setCell(
  runtime: Runtime,
  cell: Cell<unknown>,
  value: unknown,
): Promise<void> {
  const tx = runtime.edit();
  cell.withTx(tx).set(value);
  await tx.commit().settled;
}

const vnode = (name: string, props: unknown, children: unknown[]) => ({
  type: "vnode",
  name,
  props,
  children,
});

/** A piece whose whole UI is one mapped list. */
const LIST_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { pattern, UI } from "commonfabric";',
      "",
      "interface Input { items: string[]; }",
      "",
      "export default pattern<Input>(({ items }) => ({",
      "  [UI]: <ul>{items.map((item) => <li>{item}</li>)}</ul>,",
      "}));",
    ].join("\n"),
  }],
};

/** The rows `LIST_PROGRAM` renders for the items the tests give it. */
const LIST_ROWS = "<li>first</li><li>second</li><li>third</li>";

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

      it("returns the same HTML from the runtime that wrote a tree and from one that loaded it", async () => {
        // The writer holds the `style` object's keys in the order its write
        // listed them, and the reader holds them in the order the store's
        // encoding leaves them in.

        const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const writerStorage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const readerStorage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const writer = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: writerStorage,
        });
        const reader = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: readerStorage,
        });
        try {
          const written = await cellHolding(
            writer,
            "style-order",
            vnode("div", {
              style: { display: "none", gap: "0.25rem", alignItems: "center" },
            }, ["picker"]),
          );
          const fromWriter = await renderVDomToHtml(
            written,
            () => writer.idle(),
          );

          const loaded = reader.getCell<unknown>(space, "style-order");
          await loaded.sync();
          const fromReader = await renderVDomToHtml(
            loaded,
            () => reader.idle(),
          );

          const html =
            '<div style="align-items: center; display: none; gap: 0.25rem">' +
            "picker</div>";
          expect(fromWriter).toBe(html);
          expect(fromReader).toBe(html);
        } finally {
          await writer.dispose();
          await reader.dispose();
          await writerStorage.close();
          await readerStorage.close();
          await server.close();
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

    describe("a piece whose list no runtime has built", () => {
      // The piece is set up and never started, so the store holds its
      // argument and its pattern and nothing a list coordinator writes. The
      // runtime that renders it resumes the piece over a connection of its
      // own, where the coordinator's first reconcile finds no result container
      // and waits for the container's load before it builds a row.
      //
      // Whether that load completes before the scheduler goes idle is a matter
      // of timing. `SlowLoadStorage` fixes the order to the one a slow store
      // produces, in which the scheduler has run all it can before any load
      // the render started completes.

      /** Whether a load requested now is held until the scheduler is idle. */
      let holdingLoads: boolean;

      /** How many loads have been held. */
      let heldLoads: number;

      let server: ReturnType<typeof newLoopbackServer>;
      let storage: EmulatedStorageManager;
      let runtime: Runtime;
      let piece: string;

      /**
       * Storage that completes a load requested while `holdingLoads` is set
       * only once the scheduler is idle.
       */
      class SlowLoadStorage extends EmulatedStorageManager {
        /** @inheritDoc */
        override async syncCell<T>(
          cell: Cell<T>,
          options?: Parameters<EmulatedStorageManager["syncCell"]>[1],
        ): Promise<Cell<T>> {
          const hold = holdingLoads;
          const loaded = await super.syncCell(cell, options);
          if (hold) {
            heldLoads++;
            await runtime.idle();
          }
          return loaded;
        }
      }

      /**
       * A controller over `runtime` that starts holding loads once it has
       * handed a piece over, which is where the render's own loads begin. The
       * render is handed `exposed` as the controller's runtime.
       */
      function controllerHoldingLoads(
        exposed: Runtime = runtime,
      ): PiecesController {
        const pieces = new PiecesController({ as: signer, space }, runtime);
        return {
          runtime: exposed,
          get: async (...args: Parameters<PiecesController["get"]>) => {
            const got = await pieces.get(...args);
            holdingLoads = true;
            return got;
          },
        } as unknown as PiecesController;
      }

      /**
       * `runtime` behind a storage manager that offers `synced()` and neither
       * a count of its outstanding work nor a wait for that work alone.
       */
      function runtimeWithoutStorageProbes(): Runtime {
        return {
          scheduler: runtime.scheduler,
          idle: () => runtime.idle(),
          storageManager: { synced: () => storage.synced() },
        } as unknown as Runtime;
      }

      beforeEach(async () => {
        holdingLoads = false;
        heldLoads = 0;
        server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const writerStorage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const writer = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: writerStorage,
        });
        try {
          const tx = writer.edit();
          const pattern = await writer.patternManager.compilePattern(
            LIST_PROGRAM,
            { space, tx },
          );
          const result = writer.getCell<unknown>(
            space,
            "render-unbuilt-list",
            undefined,
            tx,
          );
          await writer.setup(
            tx,
            pattern,
            { items: ["first", "second", "third"] },
            result,
          );
          writer.prepareTxForCommit(tx);
          expect((await tx.commit().settled).error).toBeUndefined();
          await writer.patternManager.flushCompileCacheWrites();
          piece = pieceId(result)!;
        } finally {
          await writer.dispose({ closeStorage: false });
          await writerStorage.close();
        }

        storage = SlowLoadStorage.connectTo(server, { as: signer });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
        });
      });

      afterEach(async () => {
        await runtime.dispose({ closeStorage: false });
        await storage.close();
        await server.close();
      });

      it("returns the list's rows when its loads complete after the scheduler goes idle", async () => {
        const html = await renderPiece({ ...config, piece }, {}, {
          loadPieces: () => Promise.resolve(controllerHoldingLoads()),
        });

        expect(html).toContain(LIST_ROWS);
        // The order was the slow one only if the render started a load.
        expect(heldLoads).toBeGreaterThan(0);
      });

      it("leaves no commit pending when it returns", async () => {
        const pieces = new PiecesController({ as: signer, space }, runtime);

        await renderPiece({ ...config, piece }, {}, {
          loadPieces: () => Promise.resolve(pieces),
        });

        expect(storage.hasPendingCommits()).toBe(false);
      });

      it("reports the list's rows in its first watch report", async () => {
        const first = Promise.withResolvers<string>();

        const cancel = await renderPiece(
          { ...config, piece },
          { watch: true, onUpdate: (html) => first.resolve(html) },
          { loadPieces: () => Promise.resolve(controllerHoldingLoads()) },
        ) as () => void;
        try {
          expect(await first.promise).toContain(LIST_ROWS);
          // The order was the slow one only if the render started a load.
          expect(heldLoads).toBeGreaterThan(0);
        } finally {
          cancel();
        }
      });

      it("reports the list's rows first when storage offers no count of its outstanding work", async () => {
        const first = Promise.withResolvers<string>();

        const cancel = await renderPiece(
          { ...config, piece },
          { watch: true, onUpdate: (html) => first.resolve(html) },
          {
            loadPieces: () =>
              Promise.resolve(
                controllerHoldingLoads(runtimeWithoutStorageProbes()),
              ),
          },
        ) as () => void;
        try {
          expect(await first.promise).toContain(LIST_ROWS);
          // The order was the slow one only if the render started a load.
          expect(heldLoads).toBeGreaterThan(0);
        } finally {
          cancel();
        }
      });
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
