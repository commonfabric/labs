/** Exercises occurrence identity and the computed default-pattern registry. */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  childNodes,
  clickButton,
  findElement,
  hasText,
  propValue,
} from "../test/vnode-helpers.ts";
import Loom from "./main.tsx";
import type { Panel, PublishedDocument } from "./schemas.tsx";

/** Invokes a control on the first rendered occurrence. */
function clickFirstPanel(root: unknown, label: string): void {
  clickButton(findElement(root, "cf-card"), label);
}

export default pattern(() => {
  const loom = Loom({});
  const title = new Writable("Configured Loom");
  const namedLoom = Loom({ title });
  const rename = action(() => title.set("Renamed Loom"));
  const otherPiece = new Writable({ title: "Other target" });
  const piece = new Writable({ title: "Target" });
  const url = new Writable<Panel>({
    kind: "url",
    url: "https://example.com",
    titleOverride: "Reference site",
  });
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
    url.set({
      kind: "url",
      url: "https://example.org/updated",
      titleOverride: "Updated site",
    })
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
  const stageFromUI = action(() => clickButton(loom[UI], "Stage all"));
  const addOtherPiece = action(() => loom.addPiece.send({ piece: otherPiece }));
  const duplicatePiece = action(() =>
    loom.duplicatePanel.send({ panel: loom.panels[1] })
  );
  const focusOther = action(() =>
    loom.setPresentation.send({
      stagedPanels: [...loom.panels],
      focusedPanel: loom.panels[5],
    })
  );
  const removePiece = action(() => loom.removePiece.send({ piece }));
  const removeOtherPiece = action(() =>
    loom.removePiece.send({ piece: otherPiece })
  );
  const selectFromUI = action(() => clickFirstPanel(loom[UI], "Select"));
  const focusFromUI = action(() => clickFirstPanel(loom[UI], "Focus"));
  const clearFocusFromUI = action(() => clickButton(loom[UI], "Clear focus"));
  const clearStageFromUI = action(() => clickButton(loom[UI], "Clear stage"));
  const duplicateFromUI = action(() => clickFirstPanel(loom[UI], "Duplicate"));
  const moveLastFromUI = action(() => clickFirstPanel(loom[UI], "Move last"));
  const moveFirstFromUI = action(() => clickFirstPanel(loom[UI], "Move first"));
  const removeFromUI = action(() => clickFirstPanel(loom[UI], "Remove"));
  const alice = "did:key:z6MkAliceAddsPanelsToTheSharedLoom";
  // DID Core admits empty inner segments and percent-encodings.
  const bob = "did:web:example.com%3A8443::bob";
  const attributed = Loom({});
  const attributedPiece = new Writable({ title: "Attributed target" });
  const attributedUrl = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/attributed",
    addedBy: alice,
  });
  const addAttributedUrl = action(() =>
    attributed.addPanel.send({ panel: attributedUrl })
  );
  const addAttributedPiece = action(() =>
    attributed.addPiece.send({ piece: attributedPiece, addedBy: alice })
  );
  const addAttributedPieceAgain = action(() =>
    attributed.addPiece.send({ piece: attributedPiece, addedBy: bob })
  );
  const duplicateUnattributed = action(() =>
    attributed.duplicatePanel.send({ panel: attributedUrl })
  );
  // Exactly at the 195-character bound.
  const longestAdder = `did:key:z${"6".repeat(186)}`;
  const duplicateAsLongestAdder = action(() =>
    attributed.duplicatePanel.send({
      panel: attributedUrl,
      addedBy: longestAdder,
    })
  );
  const duplicateAsBob = action(() =>
    attributed.duplicatePanel.send({ panel: attributedUrl, addedBy: bob })
  );
  return {
    [TESTS]: [
      { assertion: assert(() => loom.panels.length === 0) },
      {
        assertion: assert(() =>
          namedLoom.title === "Configured Loom" &&
          namedLoom[NAME] === "Configured Loom" &&
          hasText(namedLoom[UI], "Configured Loom")
        ),
      },
      { action: rename },
      { render: namedLoom[UI] },
      {
        assertion: assert(() =>
          namedLoom.title === "Renamed Loom" &&
          namedLoom[NAME] === "Renamed Loom" &&
          hasText(namedLoom[UI], "Renamed Loom")
        ),
      },
      {
        assertion: assert(() => {
          const slots = childNodes(findElement(loom[UI], "cf-toolbar"));
          const start = slots.find((child) =>
            propValue(child, "slot") === "start"
          );
          const end = slots.find((child) => propValue(child, "slot") === "end");
          return hasText(start, "Shared Loom") &&
            hasText(end, "Stage all") && hasText(end, "Clear stage") &&
            hasText(end, "Clear focus");
        }),
      },
      { action: add },
      { assertion: assert(() => loom.panels.length === 1) },
      { assertion: assert(() => loom.pieceRegistry.length === 1) },
      { action: addAgain },
      { assertion: assert(() => loom.panels.length === 1) },
      { action: addUrl },
      { assertion: assert(() => loom.panels.length === 2) },
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
            copy.url === "https://example.org/updated" &&
            copy.titleOverride === "Updated site";
        }),
      },
      { render: loom[UI] },
      { action: stageFromUI },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          loom.presentation.stagedPanels.length === loom.panels.length
        ),
      },
      {
        assertion: assert(() =>
          loom.presentation.stagedPanels[0].equals(loom.panels[0]) &&
          loom.presentation.stagedPanels[4].equals(loom.panels[4])
        ),
      },
      {
        assertion: assert(() =>
          hasText(loom[UI], "Staged for everyone") &&
          !hasText(loom[UI], "Not staged")
        ),
      },
      { action: addOtherPiece },
      { action: duplicatePiece },
      { assertion: assert(() => loom.pieceRegistry.length === 3) },
      { action: focusOther },
      { action: removePiece },
      {
        assertion: assert(() =>
          loom.panels.length === 5 && loom.pieceRegistry.length === 1 &&
          loom.pieceRegistry[0].equals(otherPiece)
        ),
      },
      {
        assertion: assert(() =>
          loom.presentation.stagedPanels.length === 5 &&
          loom.presentation.focusedPanel?.equals(loom.panels[4]) === true
        ),
      },
      { action: removePiece },
      { assertion: assert(() => loom.panels.length === 5) },
      { action: removeOtherPiece },
      {
        assertion: assert(() =>
          loom.panels.length === 4 && loom.pieceRegistry.length === 0 &&
          loom.presentation.stagedPanels.length === 4 &&
          loom.presentation.focusedPanel?.get() === undefined
        ),
      },
      { render: loom[UI] },
      { action: selectFromUI },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          hasText(loom[UI], "Selected in this session") &&
          loom.viewerState.key("selectedPanel").equals(loom.panels[0])
        ),
      },
      { action: focusFromUI },
      { render: loom[UI] },
      { assertion: assert(() => hasText(loom[UI], "Focused for everyone")) },
      { action: clearFocusFromUI },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          !hasText(loom[UI], "Focused for everyone") &&
          loom.presentation.stagedPanels.length === 4
        ),
      },
      { action: clearStageFromUI },
      { assertion: assert(() => loom.presentation.stagedPanels.length === 0) },
      { action: duplicateFromUI },
      { assertion: assert(() => loom.panels.length === 5) },
      { action: moveLastFromUI },
      { assertion: assert(() => loom.panels[4].equals(documentPanel)) },
      { action: moveFirstFromUI },
      { assertion: assert(() => !loom.panels[0].equals(documentPanel)) },
      { action: removeFromUI },
      { assertion: assert(() => loom.panels.length === 4) },
      // Every occurrence above was added without `addedBy`, and none gained one.
      {
        assertion: assert(() =>
          loom.panels.every((panel) => panel.get().addedBy === undefined)
        ),
      },
      { action: addAttributedUrl },
      { action: addAttributedPiece },
      {
        assertion: assert(() =>
          attributed.panels.length === 2 &&
          attributed.panels[0].get().addedBy === alice &&
          attributed.panels[1].get().kind === "piece" &&
          attributed.panels[1].get().addedBy === alice
        ),
      },
      // Registering a piece again changes nothing, its adder included.
      { action: addAttributedPieceAgain },
      {
        assertion: assert(() =>
          attributed.panels.length === 2 &&
          attributed.panels[1].get().addedBy === alice
        ),
      },
      // A duplicate is added by whoever duplicates; it never inherits the source's adder.
      { action: duplicateUnattributed },
      { action: duplicateAsBob },
      {
        assertion: assert(() =>
          attributed.panels.length === 4 &&
          attributed.panels[2].get().addedBy === undefined &&
          attributed.panels[3].get().addedBy === bob &&
          attributed.panels[3].get().kind === "url" &&
          attributedUrl.get().addedBy === alice
        ),
      },
      { action: duplicateAsLongestAdder },
      {
        assertion: assert(() =>
          longestAdder.length === 195 && attributed.panels.length === 5 &&
          attributed.panels[4].get().addedBy === longestAdder
        ),
      },
    ],
  };
});
