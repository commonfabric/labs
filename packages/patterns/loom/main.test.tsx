/** Exercises occurrence identity and the computed default-pattern registry. */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Loom from "./main.tsx";
import type { Panel, PublishedDocument } from "./schemas.tsx";

export default pattern(() => {
  const loom = Loom({});
  const piece = new Writable({ title: "Target" });
  const url = new Writable<Panel>({ kind: "url", url: "https://example.com" });
  const content = new Writable<PublishedDocument>({
    source: { kind: "page-excerpt", title: "Source", body: "First" },
    notes: "Guest notes",
  });
  const documentPanel = new Writable<Panel>();
  const addDocument = action(() => {
    documentPanel.set({ kind: "document", content });
    loom.addPanel.send({ panel: documentPanel, before: url });
  });
  const updateSource = action(() =>
    content.key("source").set({
      kind: "page-excerpt",
      title: "Source",
      body: "Refreshed",
    })
  );
  const stage = action(() =>
    loom.setPresentation.send({
      stagedPanels: [loom.panels[0], loom.panels[1]],
      focusedPanel: loom.panels[0],
    })
  );
  const clearFocus = action(() =>
    loom.setPresentation.send({ stagedPanels: [loom.panels[0]] })
  );
  const move = action(() =>
    loom.movePanel.send({ panel: url, before: loom.panels[0] })
  );
  const changeUrl = action(() =>
    url.set({ kind: "url", url: "https://example.org/updated" })
  );
  const removeUrl = action(() => loom.removePanel.send({ panel: url }));
  const add = action(() => loom.addPiece.send({ piece }));
  const addAgain = action(() => loom.addPiece.send({ piece }));
  const addUrl = action(() => loom.addPanel.send({ panel: url }));
  const duplicate = action(() =>
    loom.duplicatePanel.send({ panel: loom.panels[0] })
  );
  const remove = action(() => loom.removePanel.send({ panel: loom.panels[0] }));
  const duplicateDocument = action(() =>
    loom.duplicatePanel.send({ panel: documentPanel })
  );
  const duplicateUrl = action(() => loom.duplicatePanel.send({ panel: url }));
  return {
    [TESTS]: [
      { assertion: assert(() => loom.panels.length === 0) },
      { action: add },
      { assertion: assert(() => loom.panels.length === 1) },
      { assertion: assert(() => loom.pieceRegistry.length === 1) },
      { action: addAgain },
      { assertion: assert(() => loom.panels.length === 1) },
      { action: addUrl },
      { assertion: assert(() => loom.panels.length === 2) },
      { assertion: assert(() => loom.pieceRegistry.length === 1) },
      { action: duplicate },
      { assertion: assert(() => loom.panels.length === 3) },
      { assertion: assert(() => loom.pieceRegistry.length === 2) },
      {
        assertion: assert(() =>
          loom.pieceRegistry[0].equals(loom.pieceRegistry[1])
        ),
      },
      { assertion: assert(() => !loom.panels[0].equals(loom.panels[2])) },
      { action: stage },
      { assertion: assert(() => loom.presentation.stagedPanels.length === 2) },
      {
        assertion: assert(() =>
          loom.presentation.focusedPanel?.equals(loom.panels[0]) === true
        ),
      },
      { action: clearFocus },
      {
        assertion: assert(() =>
          loom.presentation.focusedPanel?.get() === undefined
        ),
      },
      { action: remove },
      { assertion: assert(() => loom.panels.length === 2) },
      { assertion: assert(() => loom.pieceRegistry.length === 1) },
      { assertion: assert(() => loom.presentation.stagedPanels.length === 0) },
      { action: addDocument },
      { assertion: assert(() => loom.panels.length === 3) },
      { assertion: assert(() => loom.panels[0].equals(documentPanel)) },
      { assertion: assert(() => loom.pieceRegistry.length === 1) },
      { action: move },
      { assertion: assert(() => loom.panels[0].equals(url)) },
      { action: changeUrl },
      { assertion: assert(() => loom.panels[0].equals(url)) },
      { action: updateSource },
      { assertion: assert(() => loom.panels[1].equals(documentPanel)) },
      { assertion: assert(() => content.get().notes === "Guest notes") },
      { action: removeUrl },
      { assertion: assert(() => loom.panels.length === 2) },
      { assertion: assert(() => content.get().source.kind === "page-excerpt") },
      { action: duplicateDocument },
      { assertion: assert(() => loom.panels.length === 3) },
      { assertion: assert(() => !loom.panels[0].equals(loom.panels[2])) },
      {
        assertion: assert(() => {
          const copy = loom.panels[2].get();
          return copy.kind === "document" && copy.content.equals(content);
        }),
      },
      { action: addUrl },
      { action: duplicateUrl },
      { assertion: assert(() => loom.panels.length === 5) },
      { assertion: assert(() => !loom.panels[3].equals(loom.panels[4])) },
      {
        assertion: assert(() => {
          const copy = loom.panels[4].get();
          return copy.kind === "url" &&
            copy.url === "https://example.org/updated";
        }),
      },
    ],
  };
});
