/** Verifies rendered panel variants, safe embeds, and live document notes. */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import { findElement, hasText, propValue } from "../test/vnode-helpers.ts";
import { PanelView } from "./main.tsx";
import type { Panel, PublishedDocument } from "./schemas.tsx";

export default pattern(() => {
  const piece = new Writable({ title: "Linked target" });
  const content = new Writable<PublishedDocument>({
    source: { kind: "page-excerpt", title: "Excerpt", body: "Original body" },
    notes: "Initial notes",
  });
  const panel = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/page",
    titleOverride: "External page",
  });
  const view = PanelView({ panel });
  const unavailableContent = new Writable<PublishedDocument>();
  const showUnavailable = action(() =>
    panel.set({ kind: "document", content: unavailableContent })
  );
  const restoreDocument = action(() =>
    unavailableContent.set({
      source: {
        kind: "page-excerpt",
        title: "Available again",
        body: "Recovered",
      },
      notes: "Recovered notes",
    })
  );
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
  const showPiece = action(() =>
    panel.set({ kind: "piece", piece, titleOverride: "Piece title" })
  );
  const showDocument = action(() => panel.set({ kind: "document", content }));
  const editNotes = action(() =>
    content.key("notes").set("Collaborative edit")
  );
  const refresh = action(() =>
    content.key("source").set({
      kind: "page-excerpt",
      title: "Refreshed excerpt",
      body: "Updated body",
    })
  );
  const showPerson = action(() =>
    content.key("source").set({
      kind: "person-card",
      name: "Ada",
      photo: "https://example.com/ada.png",
      channels: [
        { kind: "email", value: "Email", label: "Work" },
        { kind: "chat", value: "Chat" },
      ],
    })
  );
  const editPersonNotes = action(() =>
    content.key("notes").set("Person note edit")
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
      { action: showPiece },
      { render: view[UI] },
      {
        assertion: assert(() =>
          hasText(view[UI], "Piece title") &&
          findElement(view[UI], "cf-cell-link") !== undefined &&
          findElement(view[UI], "cf-render") !== undefined
        ),
      },
      { action: showDocument },
      { render: view[UI] },
      { assertion: assert(() => hasText(view[UI], "Original body")) },
      { action: editNotes },
      {
        assertion: assert(() =>
          propValue(findElement(view[UI], "cf-textarea"), "$value") ===
            "Collaborative edit"
        ),
      },
      { action: refresh },
      { render: view[UI] },
      {
        assertion: assert(() =>
          hasText(view[UI], "Updated body") &&
          content.get().notes === "Collaborative edit"
        ),
      },
      { action: showPerson },
      { render: view[UI] },
      {
        assertion: assert(() =>
          hasText(view[UI], "Ada") && hasText(view[UI], "Work: Email") &&
          hasText(view[UI], "chat: Chat") &&
          propValue(findElement(view[UI], "img"), "src") ===
            "https://example.com/ada.png"
        ),
      },
      { action: editPersonNotes },
      {
        assertion: assert(() =>
          propValue(findElement(view[UI], "cf-textarea"), "$value") ===
            "Person note edit"
        ),
      },
      { action: showUnavailable },
      { render: view[UI] },
      {
        assertion: assert(() =>
          hasText(view[UI], "This document is unavailable") &&
          findElement(view[UI], "cf-textarea") === undefined
        ),
      },
      { action: restoreDocument },
      { render: view[UI] },
      {
        assertion: assert(() =>
          hasText(view[UI], "Recovered") &&
          propValue(findElement(view[UI], "cf-textarea"), "$value") ===
            "Recovered notes"
        ),
      },
    ],
  };
});
