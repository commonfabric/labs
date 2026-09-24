/** A panel links the profile its adder acted under, and nothing else writes it. */
import {
  action,
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { clickButton, findElement } from "../test/vnode-helpers.ts";
import Loom from "./main.tsx";
import type { Panel } from "./schemas.tsx";

// Labeled with integrity only, as a Fabric profile is: its fields carry the
// owner's `represents-principal`, and no confidentiality.
type TestProfile = AddIntegrity<
  { name?: string; avatar?: string },
  readonly ["loom-test-profile"]
>;

/** The address a URL panel shows, or `undefined` for another kind. */
const urlOf = (panel: Panel): string | undefined =>
  panel.kind === "url" ? panel.url : undefined;

export default pattern(() => {
  const member = Writable.of<TestProfile>({ name: "Member" });
  const other = Writable.of<TestProfile>({ name: "Other" });
  const alice = "did:key:z6MkAliceAddsPanelsToTheSharedLoom";

  const loom = Loom({});
  // A second Loom, into which an occurrence of the first may be linked.
  const elsewhere = Loom({});
  const piece = new Writable({ title: "Target" });
  const refusedPiece = new Writable({ title: "Refused target" });
  const url = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/acting-profile",
  });

  const addPieceAsMember = action(() =>
    loom.addPiece.send({ piece, as: member })
  );
  const addPieceNamingBoth = action(() =>
    loom.addPiece.send({ piece: refusedPiece, as: member, addedBy: alice })
  );
  // `addPanel` takes `addedBy` from the occurrence, never from its event.
  const addUrlNamingAdder = action(() =>
    loom.addPanel.send({ panel: url, addedBy: alice })
  );
  // An occurrence that names its adder by DID takes no profile besides.
  const claimed = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/claimed-adder",
    addedBy: alice,
  });
  const addClaimedAsMember = action(() =>
    loom.addPanel.send({ panel: claimed, as: member })
  );
  // `as` admits a new occurrence copied from the one passed, and records the
  // profile only there: the document the caller passed stays as it was.
  const addUrlAsMember = action(() =>
    loom.addPanel.send({ panel: url, as: member })
  );
  // Without `as`, the occurrence passed is linked itself.
  const linked = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/linked",
  });
  const addLinked = action(() => loom.addPanel.send({ panel: linked }));
  // Another Loom admits an occurrence this one holds unattributed. Its adder
  // is recorded on that Loom's own copy, never on the occurrence this Loom
  // shows.
  const admitLinkedElsewhereAsOther = action(() =>
    elsewhere.addPanel.send({ panel: linked, as: other })
  );
  // An occurrence that records a profile names whoever added it then, so it is
  // not linked again without `as`; with `as` it is copied like any other.
  const linkProfiledElsewhere = action(() =>
    elsewhere.addPanel.send({ panel: loom.panels[1] })
  );
  const copyProfiledElsewhereAsOther = action(() =>
    elsewhere.addPanel.send({ panel: loom.panels[1], as: other })
  );
  const duplicateAsOther = action(() =>
    loom.duplicatePanel.send({ panel: linked, as: other })
  );
  const duplicateUnattributed = action(() =>
    loom.duplicatePanel.send({ panel: linked })
  );
  // Writes that do not go through the root's handlers: one gives an
  // unattributed occurrence a profile, one replaces a recorded profile.
  const forgeOnUnattributed = action(() =>
    loom.panels[4].key("addedByProfile").set(member)
  );
  const forgeOverRecorded = action(() =>
    loom.panels[0].key("addedByProfile").set(other)
  );
  // The other structural actions still write occurrences that carry a
  // profile.
  const moveLinkedLast = action(() => loom.movePanel.send({ panel: linked }));
  const stageAll = action(() =>
    loom.setPresentation.send({
      stagedPanels: [...loom.panels],
      focusedPanel: loom.panels[0],
    })
  );
  const removeFirst = action(() =>
    loom.removePanel.send({ panel: loom.panels[0] })
  );
  const unregister = action(() => loom.removePiece.send({ piece }));
  // A removed occurrence that records a profile is not linked back; its adder
  // adds a new occurrence instead. The two events are delivered in order.
  const removeAndRelinkProfiled = action(() => {
    const panel = loom.panels[0];
    loom.removePanel.send({ panel });
    loom.addPanel.send({ panel });
  });
  // A panel that records a profile keeps it through a write of one field, but
  // a write of the whole panel, even one that keeps the same profile, is not
  // `admitPanel`'s and is refused.
  const renameWhole = action(() => {
    const panel = loom.panels[0];
    panel.set({ ...panel.get(), titleOverride: "Renamed whole" });
  });
  const renameField = action(() =>
    loom.panels[0].key("titleOverride").set("Renamed field")
  );
  const claimMember = action(() =>
    loom.viewerState.key("actingProfile").set(member)
  );
  const duplicateFromUI = action(() =>
    clickButton(findElement(loom[UI], "cf-card"), "Duplicate")
  );

  return {
    // Each refused write is reported as a CFC policy warning, and each
    // refused event as a runtime error.
    allowConsoleWarnings: true,
    allowRuntimeErrors: true,
    expectRuntimeErrors: 5,
    [TESTS]: [
      { action: addPieceAsMember },
      {
        assertion: assert(() =>
          loom.panels.length === 1 &&
          loom.panels[0].key("addedByProfile").equals(member) &&
          loom.panels[0].get().addedBy === undefined
        ),
      },
      { action: addPieceNamingBoth },
      { action: addUrlNamingAdder },
      { action: addClaimedAsMember },
      {
        assertion: assert(() =>
          loom.panels.length === 1 &&
          claimed.get().addedByProfile === undefined
        ),
      },
      { action: addUrlAsMember },
      {
        assertion: assert(() =>
          loom.panels.length === 2 && !loom.panels[1].equals(url) &&
          urlOf(loom.panels[1].get()) === urlOf(url.get()) &&
          loom.panels[1].key("addedByProfile").equals(member) &&
          url.get().addedByProfile === undefined
        ),
      },
      { action: addLinked },
      {
        assertion: assert(() =>
          loom.panels.length === 3 && loom.panels[2].equals(linked) &&
          linked.get().addedByProfile === undefined
        ),
      },
      { action: admitLinkedElsewhereAsOther },
      {
        assertion: assert(() =>
          elsewhere.panels.length === 1 &&
          !elsewhere.panels[0].equals(linked) &&
          elsewhere.panels[0].key("addedByProfile").equals(other) &&
          linked.get().addedByProfile === undefined &&
          loom.panels[2].equals(linked)
        ),
      },
      { action: linkProfiledElsewhere },
      { action: copyProfiledElsewhereAsOther },
      {
        assertion: assert(() =>
          elsewhere.panels.length === 2 &&
          !elsewhere.panels[1].equals(loom.panels[1]) &&
          elsewhere.panels[1].key("addedByProfile").equals(other) &&
          loom.panels[1].key("addedByProfile").equals(member)
        ),
      },
      // A copy is added by whoever duplicates it.
      { action: duplicateAsOther },
      { action: duplicateUnattributed },
      {
        assertion: assert(() =>
          loom.panels.length === 5 &&
          loom.panels[3].key("addedByProfile").equals(other) &&
          loom.panels[4].get().addedByProfile === undefined &&
          linked.get().addedByProfile === undefined
        ),
      },
      { action: forgeOnUnattributed },
      { action: forgeOverRecorded },
      {
        assertion: assert(() =>
          loom.panels[4].get().addedByProfile === undefined &&
          loom.panels[0].key("addedByProfile").equals(member)
        ),
      },
      // The root's own Duplicate button acts under the session's profile.
      { action: claimMember },
      { render: loom[UI] },
      { action: duplicateFromUI },
      {
        assertion: assert(() =>
          loom.panels.length === 6 &&
          loom.panels[0].get().kind === "piece" &&
          loom.panels[5].get().kind === "piece" &&
          loom.panels[5].key("addedByProfile").equals(member)
        ),
      },
      { action: moveLinkedLast },
      { action: stageAll },
      {
        assertion: assert(() =>
          loom.panels[5].equals(linked) &&
          loom.presentation.stagedPanels.length === 6 &&
          loom.presentation.focusedPanel?.equals(loom.panels[0]) === true
        ),
      },
      { action: removeFirst },
      {
        assertion: assert(() =>
          loom.panels.length === 5 &&
          loom.presentation.stagedPanels.length === 5 &&
          loom.presentation.focusedPanel?.get() === undefined
        ),
      },
      { action: unregister },
      {
        assertion: assert(() =>
          loom.panels.length === 4 && loom.pieceRegistry.length === 0
        ),
      },
      { action: removeAndRelinkProfiled },
      {
        assertion: assert(() =>
          loom.panels.length === 3 &&
          !loom.panels.some((panel) =>
            panel.get().addedByProfile !== undefined &&
            panel.key("addedByProfile").equals(member)
          )
        ),
      },
      { action: renameWhole },
      {
        assertion: assert(() =>
          loom.panels[0].get().titleOverride === undefined &&
          loom.panels[0].key("addedByProfile").equals(other)
        ),
      },
      { action: renameField },
      {
        assertion: assert(() =>
          loom.panels[0].get().titleOverride === "Renamed field" &&
          loom.panels[0].key("addedByProfile").equals(other)
        ),
      },
    ],
  };
});
