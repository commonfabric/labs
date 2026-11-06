/** Exercises occurrence identity and the computed default-pattern registry. */
import {
  action,
  assert,
  currentPrincipal,
  NAME,
  pattern,
  principalOf,
  TESTS,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import {
  clickButton,
  countElements,
  findElement,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import Loom from "./main.tsx";
import {
  menuLabels,
  panelSections,
  runLoomAction,
  runPanelAction,
  runShowHidden,
} from "./menu-test-fixture.ts";
import type { Panel, PublishedDocument } from "./schemas.tsx";

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
  const stageFromUI = action(() =>
    runLoomAction(loom[VIEWS].menu, "Stage all for everyone")
  );
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
  const focusFromUI = action(() =>
    runPanelAction(loom[VIEWS].menu, 0, "Focus for everyone")
  );
  const clearFocusFromUI = action(() =>
    runLoomAction(loom[VIEWS].menu, "Clear focus")
  );
  const clearStageFromUI = action(() =>
    runLoomAction(loom[VIEWS].menu, "Clear stage")
  );
  const duplicateFromUI = action(() =>
    runPanelAction(loom[VIEWS].menu, 0, "Duplicate")
  );
  const moveLastFromUI = action(() =>
    runPanelAction(loom[VIEWS].menu, 0, "Move last")
  );
  const moveFirstFromUI = action(() =>
    runPanelAction(loom[VIEWS].menu, 4, "Move first")
  );
  const removeFromUI = action(() =>
    runPanelAction(loom[VIEWS].menu, 0, "Remove")
  );
  const hideFromUI = action(() =>
    runPanelAction(loom[VIEWS].menu, 0, "Hide for me")
  );
  const showFromUI = action(() => runShowHidden(loom[VIEWS].menu));
  // A Loom with one piece shows that piece alone, with no frame or title.
  const lone = Loom({});
  const lonePiece = new Writable({ title: "Lone target" });
  const addLone = action(() => lone.addPiece.send({ piece: lonePiece }));
  const retitleLone = action(() =>
    lone.retitlePanel.send({
      panel: lone.panels[0],
      titleOverride: "Retitled lone panel",
    })
  );
  const hideLone = action(() =>
    runPanelAction(lone[VIEWS].menu, 0, "Hide for me")
  );
  const showLoneFromPage = action(() =>
    clickButton(lone[UI], "Show them again")
  );
  const secondUrl = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/second",
  });
  const addSecondToLone = action(() =>
    lone.addPanel.send({ panel: secondUrl })
  );
  const me = new Writable("");
  const recordMe = action(() => me.set(currentPrincipal() ?? ""));
  // DID Core admits empty inner segments and percent-encodings.
  const claimedAdder = "did:web:example.com%3A8443::alice";
  const attributed = Loom({});
  const attributedPiece = new Writable({ title: "Attributed target" });
  // An occurrence a caller made, whose `addedBy` claims someone else. The
  // label entry its writer's run mints there names that writer.
  const claimedUrl = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/attributed",
    addedBy: claimedAdder,
  });
  const addClaimedUrl = action(() =>
    attributed.addPanel.send({ panel: claimedUrl })
  );
  const addAttributedPiece = action(() =>
    attributed.addPiece.send({ piece: attributedPiece })
  );
  const addAttributedPieceAgain = action(() =>
    attributed.addPiece.send({ piece: attributedPiece })
  );
  const duplicateClaimed = action(() =>
    attributed.duplicatePanel.send({ panel: claimedUrl })
  );
  return {
    [TESTS]: [
      { assertion: assert(() => loom.panels.length === 0) },
      {
        assertion: assert(() =>
          namedLoom.title === "Configured Loom" &&
          namedLoom[NAME] === "Configured Loom"
        ),
      },
      { action: rename },
      { render: namedLoom[UI] },
      {
        assertion: assert(() =>
          namedLoom.title === "Renamed Loom" &&
          namedLoom[NAME] === "Renamed Loom"
        ),
      },
      // The page carries no controls and no title of its own: the title is
      // the Loom's name, for a host to show, and an empty Loom offers nothing
      // to arrange.
      {
        assertion: assert(() =>
          countElements(loom[UI], "cf-button") === 0 &&
          countElements(loom[UI], "cf-toolbar") === 0 &&
          !hasText(loom[UI], "Shared Loom") &&
          loom[VIEWS].menu.sections.length === 0
        ),
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
          countElements(loom[UI], "cf-button") === 0 &&
          countElements(loom[UI], "cf-cell-link") === 0 &&
          !menuLabels(loom[VIEWS].menu).includes("Stage all for everyone")
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
      // Each action names what it does, and each panel's section its panel.
      {
        assertion: assert(() =>
          panelSections(loom[VIEWS].menu)[0].panel?.equals(loom.panels[0]) ===
            true &&
          panelSections(loom[VIEWS].menu)[0].actions.some((entry) =>
            entry.id === "hide" && entry.label === "Hide for me"
          )
        ),
      },
      { action: focusFromUI },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          hasText(loom[UI], "Focused for everyone") &&
          loom.presentation.focusedPanel?.equals(loom.panels[0]) === true &&
          menuLabels(loom[VIEWS].menu).includes("Clear focus")
        ),
      },
      { action: clearFocusFromUI },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          !hasText(loom[UI], "Focused for everyone") &&
          loom.presentation.stagedPanels.length === 4
        ),
      },
      { action: clearStageFromUI },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          loom.presentation.stagedPanels.length === 0 &&
          !hasText(loom[UI], "Staged for everyone") &&
          !menuLabels(loom[VIEWS].menu).includes("Clear stage")
        ),
      },
      { action: duplicateFromUI },
      { assertion: assert(() => loom.panels.length === 5) },
      { action: moveLastFromUI },
      { assertion: assert(() => loom.panels[4].equals(documentPanel)) },
      // The first panel is offered no Move first, and the last no Move last.
      {
        assertion: assert(() => {
          const sections = panelSections(loom[VIEWS].menu);
          const labels = (place: number) =>
            sections[place].actions.map((entry) => entry.label);
          return !labels(0).includes("Move first") &&
            labels(0).includes("Move last") &&
            !labels(4).includes("Move last") &&
            labels(4).includes("Move first");
        }),
      },
      { action: moveFirstFromUI },
      { assertion: assert(() => loom.panels[0].equals(documentPanel)) },
      { action: removeFromUI },
      { assertion: assert(() => loom.panels.length === 4) },
      // Hiding a panel from the UI takes it out of this viewer's cards and
      // list, and out of nobody's `panels`; Show puts it back.
      { action: hideFromUI },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          loom.panels.length === 4 && loom.viewerPanels.length === 3 &&
          countElements(loom[UI], "cf-card") === 3 &&
          !hasText(loom[UI], "Hidden") &&
          loom[VIEWS].menu.sections.some((section) =>
            section.heading === "Hidden for you"
          )
        ),
      },
      { action: showFromUI },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          loom.viewerPanels.length === 4 &&
          countElements(loom[UI], "cf-card") === 4 &&
          !loom[VIEWS].menu.sections.some((section) =>
            section.heading === "Hidden for you"
          )
        ),
      },
      // Each occurrence the root created records the principal its event
      // acted for; the occurrences a caller made and linked record none.
      { action: recordMe },
      {
        assertion: assert(() =>
          me.get() !== "" &&
          loom.panels.every((panel) =>
            panel.equals(url) || panel.equals(documentPanel)
              ? panel.get().addedBy === undefined
              : panel.get().addedBy === me.get()
          )
        ),
      },
      { action: addClaimedUrl },
      { action: addAttributedPiece },
      {
        assertion: assert(() =>
          attributed.panels.length === 2 &&
          attributed.panels[0].get().addedBy === claimedAdder &&
          principalOf(attributed.panels[0].key("addedBy"), "authored-by") ===
            me.get() &&
          attributed.panels[1].get().kind === "piece" &&
          attributed.panels[1].get().addedBy === me.get() &&
          principalOf(attributed.panels[1].key("addedBy"), "authored-by") ===
            me.get()
        ),
      },
      // Registering a piece again changes nothing.
      { action: addAttributedPieceAgain },
      { assertion: assert(() => attributed.panels.length === 2) },
      // A duplicate is added by whoever duplicates; it never inherits the
      // source's adder.
      { action: duplicateClaimed },
      {
        assertion: assert(() =>
          attributed.panels.length === 3 &&
          attributed.panels[2].get().kind === "url" &&
          attributed.panels[2].get().addedBy === me.get() &&
          claimedUrl.get().addedBy === claimedAdder
        ),
      },
      { action: addLone },
      { action: retitleLone },
      { render: lone[UI] },
      // One piece is shown alone: no card, no title above it, no controls.
      // Its actions are the Loom's own, in the one unheaded section.
      {
        assertion: assert(() =>
          countElements(lone[UI], "cf-render") === 1 &&
          countElements(lone[UI], "cf-card") === 0 &&
          countElements(lone[UI], "cf-button") === 0 &&
          countElements(lone[UI], "cf-cell-link") === 0 &&
          !hasText(lone[UI], "Retitled lone panel") &&
          lone[VIEWS].menu.sections.length === 1 &&
          lone[VIEWS].menu.sections[0].heading === undefined &&
          menuLabels(lone[VIEWS].menu).includes("Hide for me") &&
          menuLabels(lone[VIEWS].menu).includes("Stage all for everyone") &&
          !menuLabels(lone[VIEWS].menu).includes("Move first")
        ),
      },
      // Hiding the only panel leaves a page that says how to get it back,
      // for a host that draws no menu; it is the page's only control.
      { action: hideLone },
      { render: lone[UI] },
      {
        assertion: assert(() =>
          lone.viewerPanels.length === 0 &&
          hasText(lone[UI], "You've hidden every panel") &&
          countElements(lone[UI], "cf-button") === 1
        ),
      },
      { action: showLoneFromPage },
      { render: lone[UI] },
      {
        assertion: assert(() =>
          lone.viewerPanels.length === 1 &&
          !hasText(lone[UI], "You've hidden every panel") &&
          countElements(lone[UI], "cf-button") === 0
        ),
      },
      // A second panel puts each in a card, the piece under its title, and
      // gives each a section of its own.
      { action: addSecondToLone },
      { render: lone[UI] },
      {
        assertion: assert(() =>
          countElements(lone[UI], "cf-card") === 2 &&
          hasText(findElement(lone[UI], "cf-card"), "Retitled lone panel") &&
          panelSections(lone[VIEWS].menu).length === 2 &&
          panelSections(lone[VIEWS].menu)[0].heading ===
            "Retitled lone panel"
        ),
      },
    ],
  };
});
