/** Verifies isolated external embeds and safe fallback links from rendered UI. */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import { findElement, hasText, propValue } from "../test/vnode-helpers.ts";
import { PanelView } from "./main.tsx";
import type { Panel } from "./schemas.tsx";

export default pattern(() => {
  const panel = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/page",
    titleOverride: "External page",
  });
  const view = PanelView({ panel });
  const credentials = action(() =>
    panel.set({ kind: "url", url: "https://alice:secret@example.com/" })
  );
  const malformed = action(() =>
    panel.set({ kind: "url", url: "https://[broken/" })
  );
  const script = action(() =>
    panel.set({ kind: "url", url: "javascript:alert(1)" })
  );
  const http = action(() =>
    panel.set({ kind: "url", url: "http://example.org/" })
  );
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          propValue(findElement(view[UI], "iframe"), "src") ===
            "https://example.com/page"
        ),
      },
      {
        assertion: assert(() =>
          propValue(findElement(view[UI], "iframe"), "sandbox") ===
            "allow-scripts allow-forms allow-popups"
        ),
      },
      {
        assertion: assert(() =>
          propValue(findElement(view[UI], "iframe"), "referrerPolicy") ===
            "no-referrer"
        ),
      },
      {
        assertion: assert(() =>
          propValue(findElement(view[UI], "iframe"), "title") ===
            "External page"
        ),
      },
      {
        assertion: assert(() =>
          findElement(view[UI], "cf-iframe") === undefined
        ),
      },
      {
        assertion: assert(() =>
          propValue(findElement(view[UI], "a"), "href") ===
            "https://example.com/page" &&
          propValue(findElement(view[UI], "a"), "target") === "_blank" &&
          propValue(findElement(view[UI], "a"), "rel") ===
            "noopener noreferrer" &&
          hasText(view[UI], "Open in new tab")
        ),
      },
      { action: credentials },
      {
        assertion: assert(() =>
          findElement(view[UI], "iframe") === undefined &&
          findElement(view[UI], "a") === undefined
        ),
      },
      { action: malformed },
      {
        assertion: assert(() =>
          findElement(view[UI], "iframe") === undefined &&
          findElement(view[UI], "a") === undefined
        ),
      },
      { action: script },
      {
        assertion: assert(() =>
          findElement(view[UI], "iframe") === undefined &&
          findElement(view[UI], "a") === undefined
        ),
      },
      { action: http },
      {
        assertion: assert(() =>
          propValue(findElement(view[UI], "iframe"), "src") ===
            "http://example.org/" &&
          propValue(findElement(view[UI], "a"), "href") ===
            "http://example.org/"
        ),
      },
    ],
  };
});
