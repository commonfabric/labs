/**
 * A menu of donuts shown in a sandboxed iframe, with pictures the pattern
 * ships as files. The guest's document shows the logo through a `cf-asset:`
 * reference, its script builds the menu from each picture's URL, and it draws
 * the favorite from the picture's decoded image. The pattern hands the guest
 * every file in `assets/` with `dataFile.urls()`.
 */

import {
  computed,
  dataFile,
  FS,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import { DEFAULT_STATE, type IframeStateData, MENU } from "./contract.ts";

/** The guest's document. */
const GUEST_HTML = dataFile("./guest.html");

/** The module the guest runs, which `deno bundle` writes from `guest.ts`. */
const GUEST_SCRIPT = dataFile("./guest.js");

/** Every picture in `assets/`, by its file name without the extension. */
const ASSETS = dataFile.urls("./assets");

/** A menu of donuts, one of which may be the favorite. */
export interface DonutMenuOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The menu as text, with the favorite marked. */
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };

  /** Which donut is the favorite, for everyone on the piece. */
  state: IframeStateData;
}

export default pattern<Record<string, never>, DonutMenuOutput>(() => {
  const state = new Writable<IframeStateData>(DEFAULT_STATE);

  const content = computed(() => {
    const { favorite } = state.get();
    return MENU.map((donut) =>
      `- ${donut.name}${donut.id === favorite ? " (favorite)" : ""}`
    ).join("\n");
  });

  return {
    [NAME]: "Donut menu",
    [UI]: (
      <div style={{ width: "100%", height: "100vh" }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
          assets={ASSETS}
          $context={{ state }}
        />
      </div>
    ),
    [FS]: {
      type: "text/markdown",
      frontmatter: { title: "Donut menu" },
      content,
    },
    state,
  };
});
