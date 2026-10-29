import { renderInProcess } from "@commonfabric/html/in-process";
import { MockDoc } from "@commonfabric/html/mock-doc";
import { type Cell, type Runtime, UI } from "@commonfabric/runner";
import { uiSchema } from "@commonfabric/runner/schemas";
import { getLogger } from "@commonfabric/utils/logger";

import { loadPieces, resolveAddressedPieceConfig } from "./piece.ts";
import type { PieceConfig, PieceResolutionDeps } from "./piece.ts";

const logger = getLogger("piece-render", { level: "info", enabled: false });

export interface RenderOptions {
  watch?: boolean;
  onUpdate?: (html: string) => void;
  start?: boolean;
}

/**
 * Render a VDOM cell to HTML.
 *
 * The reconciler and the DOM applicator both run here, in the CLI's own
 * process, against a mock document. That is the same pair a browser uses, so
 * the tree serialized below is the tree a browser would show.
 *
 * Without `onUpdate`, this renders once and returns the HTML. With it, the
 * render stays mounted, `onUpdate` receives the HTML on every settled change,
 * and the return value is the function that unmounts.
 *
 * @param vdomCell - The cell holding the tree to render
 * @param settle - Resolves when the tree is ready to be read
 * @param onUpdate - Receives the HTML after each settled change
 */
export function renderVDomToHtml(
  vdomCell: Cell<unknown>,
  settle: () => Promise<void>,
  onUpdate?: (html: string) => void,
): Promise<string> | (() => void) {
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  const { document, renderOptions } = mock;

  const container = document.getElementById("root");
  if (!container) {
    throw new Error("Could not find root container");
  }

  // In watch mode `report` takes over once the render exists; until then
  // applied batches need no announcement.
  let report = () => {};
  const render = renderInProcess(container, vdomCell, {
    document,
    setProp: renderOptions.setProp,
    onError: (error) => {
      logger.info("piece-render", () => `render error: ${error.message}`);
    },
    onApplied: () => report(),
  });

  // Apply everything the reconciler produced, then read the tree.
  const flushAndRead = (): string => {
    render.flush();
    return container.innerHTML;
  };

  if (!onUpdate) {
    // Render once and unmount.
    return (async () => {
      try {
        await settle();
        return flushAndRead();
      } finally {
        render.cancel();
      }
    })();
  }

  // Several batches can make up one update, and further batches can land while
  // a read is still waiting for the runtime. Reading once per settle reports
  // each settled tree exactly once. `reading` is cleared in the same
  // synchronous stretch as the read, so no batch lands unreported between the
  // two, and on the failure path as well, so one failed settle costs one report
  // rather than every report after it.
  let reading = false;
  let cancelled = false;
  let updateCount = 0;
  report = () => {
    if (reading || cancelled) return;
    reading = true;
    settle().then(() => {
      let html: string;
      try {
        html = flushAndRead();
      } finally {
        reading = false;
      }
      updateCount++;
      logger.info("piece-render", () => `[Update ${updateCount}] UI changed`);
      onUpdate(html);
    }, (error: unknown) => {
      reading = false;
      logger.info("piece-render", () => `watch settle failed: ${error}`);
    }).catch((error: unknown) => {
      logger.info("piece-render", () => `watch read failed: ${error}`);
    });
  };
  // Unmounting emits its own operations; the caller asked to stop, so those
  // do not become one last report.
  return () => {
    cancelled = true;
    render.cancel();
  };
}

/**
 * Helper for `renderPiece()`, which waits until all of these hold at once:
 * `runtime` has nothing left to compute, storage has nothing outstanding, and
 * no commit the runtime issued is pending.
 *
 * What ends a commit's pending state depends on where the commit went. One
 * sent directly to the store is pending until the store confirms or refuses
 * it. One sealed instead, into a serving runtime's wave or into a client's
 * speculation overlay under server execution, is pending only until the seal
 * accepts it, and what becomes of it afterwards is not waited for.
 *
 * Builtin I/O in flight, such as a fetch or a language-model call, is not
 * waited for either.
 */
async function idleWithNothingPending(runtime: Runtime): Promise<void> {
  const { scheduler, storageManager } = runtime;
  // A settled commit can re-run its readers and a settled load can re-arm a
  // computation, so neither wait is final until both hold at once.
  do {
    await scheduler.idleWithPendingCommits();
    await storageManager.synced();
  } while (!scheduler.isIdleWithPendingCommits());
}

/**
 * Helper for `renderPiece()`, which waits until `runtime` has nothing left to
 * compute and no storage work outstanding that a computation is waiting for.
 *
 * A commit may still be pending when it resolves, and so may builtin I/O such
 * as a fetch or a language-model call, so a tree read after it can still
 * change.
 */
async function idleWithNothingLoading(runtime: Runtime): Promise<void> {
  const storage = runtime.storageManager;
  if (
    storage.pendingCrossSpacePromiseCount === undefined ||
    storage.crossSpaceSettled === undefined
  ) {
    // The wait below asks storage how much work is registered with its settle
    // barrier, and waits for that work alone. A storage manager that offers
    // neither gets the wider wait, which takes the barrier in.
    await idleWithNothingPending(runtime);
    return;
  }
  await runtime.idle();
  // The scheduler's idle does not cover work registered with the storage
  // manager's settle barrier (`trackUntilSettled()`), and that work re-arms a
  // computation once it settles: a resumed list waits there for its result
  // container, and builds no row until it has it. The re-armed computation can
  // register more, so we repeat until an idle leaves nothing registered.
  while (storage.pendingCrossSpacePromiseCount() > 0) {
    await storage.crossSpaceSettled();
    await runtime.idle();
  }
}

/**
 * Resolves a piece reference and renders the piece's UI to HTML.
 *
 * Without `options.watch`, returns the HTML of the tree the runtime settles to
 * once the piece has loaded and computed and no commit that produced is
 * pending, so a caller may exit on the result without abandoning a commit in
 * flight. With `options.watch`, the render stays mounted, `options.onUpdate`
 * receives the HTML each time the runtime goes idle with nothing loading, and
 * the return value is the function that unmounts.
 *
 * Neither mode waits for builtin I/O in flight, such as a fetch or a
 * language-model call.
 *
 * @throws Error if the piece has no UI.
 */
export async function renderPiece(
  config: PieceConfig,
  options: RenderOptions = {},
  deps: Pick<PieceResolutionDeps, "loadPieces"> = {},
): Promise<string | (() => void)> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolveAddressedPieceConfig(pieces, config);
  const piece = await pieces.get(
    resolvedConfig.piece,
    options.start ?? true,
    undefined,
    resolvedConfig.pieceScope,
  );
  const cell = piece.getCell().asSchema(uiSchema) as Cell<
    Record<string, unknown>
  >;

  // Check if piece has UI
  if (!cell.get()?.[UI]) {
    throw new Error(`Piece ${config.piece} has no UI`);
  }

  const { runtime } = pieces;
  if (options.watch) {
    return renderVDomToHtml(
      cell.key(UI),
      () => idleWithNothingLoading(runtime),
      (html) => options.onUpdate?.(html),
    );
  }
  // The one-shot wait takes in the runtime's pending commits, because the
  // result is what a caller exits on, and a commit in flight when its
  // connection closes may never be applied. A watch stays connected, and
  // reports whatever a later commit result changes.
  return renderVDomToHtml(cell.key(UI), () => idleWithNothingPending(runtime));
}
