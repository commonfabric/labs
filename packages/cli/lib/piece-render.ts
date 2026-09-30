import { renderInProcess } from "@commonfabric/html/in-process";
import { MockDoc } from "@commonfabric/html/mock-doc";
import { type Cell, UI } from "@commonfabric/runner";
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
 * @param idle - Resolves when the runtime has finished computing
 * @param onUpdate - Receives the HTML after each settled change
 */
export function renderVDomToHtml(
  vdomCell: Cell<unknown>,
  idle: () => Promise<void>,
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
        await idle();
        return flushAndRead();
      } finally {
        render.cancel();
      }
    })();
  }

  // Several batches can make up one update, and further batches can land while
  // a read is still waiting for the runtime. Reading once per quiet runtime
  // reports each settled tree exactly once. `reading` is cleared in the same
  // synchronous stretch as the read, so no batch lands unreported between the
  // two, and on the failure path as well, so one failed settle costs one report
  // rather than every report after it.
  let reading = false;
  let cancelled = false;
  let updateCount = 0;
  report = () => {
    if (reading || cancelled) return;
    reading = true;
    idle().then(() => {
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
 * Resolves a piece reference and renders the piece's UI to HTML.
 * Supports both static and reactive rendering with --watch mode.
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

  return renderVDomToHtml(
    cell.key(UI),
    () => pieces.runtime.idle(),
    options.watch ? (html) => options.onUpdate?.(html) : undefined,
  );
}
