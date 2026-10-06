import { render, type RenderOptions } from "@commonfabric/html/client";
import {
  type CellHandle,
  NAME,
  type VNode,
} from "@commonfabric/runtime-client";

import "../components/cf-chip/index.ts";

/** A chip naming a cell, and the teardown of the render that shows its name. */
export interface NameChip {
  /** The `cf-chip` element, not yet added to the DOM. */
  chip: HTMLElement;

  /** Stops the render of the cell's `[NAME]`. */
  cleanup: () => void;
}

/**
 * Builds a chip naming `cell`: its `[NAME]`, then the short form of its id.
 * The name is a render of its own, mounted from the cell's reference as a
 * piece's view is, so the viewer's render policy decides what of it shows,
 * and the chip reads nothing through the handle. A cell with no `[NAME]`
 * shows only the short id.
 *
 * Throws when the cell's connection is gone, before anything is mounted.
 */
export function createNameChip(
  cell: CellHandle,
  options: RenderOptions = {},
): NameChip {
  const named = cell.asSchema<Record<string, VNode>>({
    type: "object",
    properties: { [NAME]: { type: "string" } },
  }).key(NAME);
  const chip = Object.assign(document.createElement("cf-chip"), {
    color: "primary",
  });
  const name = document.createElement("span");
  const handle = document.createElement("span");
  handle.textContent = ` #${cell.id().slice(-6)}`;
  chip.appendChild(name);
  chip.appendChild(handle);
  return { chip, cleanup: render(name, named, options) };
}
