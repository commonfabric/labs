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
  const addUrlAsMember = action(() =>
    loom.addPanel.send({ panel: url, as: member })
  );
  // An occurrence that already records a profile names whoever added it
  // first, so admitting it again, here or to another Loom, would attribute the
  // new admission to them.
  const readmitElsewhereAsOther = action(() =>
    elsewhere.addPanel.send({ panel: url, as: other })
  );
  const readmitElsewhere = action(() =>
    elsewhere.addPanel.send({ panel: url })
  );
  const removeUrl = action(() => loom.removePanel.send({ panel: url }));
  const readmitAsOther = action(() =>
    loom.addPanel.send({ panel: url, as: other })
  );
  const duplicateAsOther = action(() =>
    loom.duplicatePanel.send({ panel: url, as: other })
  );
  const duplicateUnattributed = action(() =>
    loom.duplicatePanel.send({ panel: url })
  );
  // Writes that do not go through the root's handlers: one gives an
  // unattributed occurrence a profile, one replaces a recorded profile.
  const forgeOnUnattributed = action(() =>
    loom.panels[3].key("addedByProfile").set(member)
  );
  const forgeOverRecorded = action(() =>
    loom.panels[0].key("addedByProfile").set(other)
  );
  // The other structural actions still write occurrences that carry a
  // profile.
  const moveUrlLast = action(() => loom.movePanel.send({ panel: url }));
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
      { assertion: assert(() => loom.panels.length === 1) },
      { action: addUrlAsMember },
      {
        assertion: assert(() =>
          loom.panels.length === 2 && loom.panels[1].equals(url) &&
          url.key("addedByProfile").equals(member)
        ),
      },
      { action: readmitElsewhereAsOther },
      { action: readmitElsewhere },
      {
        assertion: assert(() =>
          elsewhere.panels.length === 0 &&
          url.key("addedByProfile").equals(member)
        ),
      },
      // A copy is added by whoever duplicates it.
      { action: duplicateAsOther },
      { action: duplicateUnattributed },
      {
        assertion: assert(() =>
          loom.panels.length === 4 &&
          loom.panels[2].key("addedByProfile").equals(other) &&
          loom.panels[3].get().addedByProfile === undefined &&
          url.key("addedByProfile").equals(member)
        ),
      },
      { action: forgeOnUnattributed },
      { action: forgeOverRecorded },
      {
        assertion: assert(() =>
          loom.panels[3].get().addedByProfile === undefined &&
          loom.panels[0].key("addedByProfile").equals(member)
        ),
      },
      // The root's own Duplicate button acts under the session's profile.
      { action: claimMember },
      { render: loom[UI] },
      { action: duplicateFromUI },
      {
        assertion: assert(() =>
          loom.panels.length === 5 &&
          loom.panels[0].get().kind === "piece" &&
          loom.panels[4].get().kind === "piece" &&
          loom.panels[4].key("addedByProfile").equals(member)
        ),
      },
      { action: moveUrlLast },
      { action: stageAll },
      {
        assertion: assert(() =>
          loom.panels[4].equals(url) &&
          loom.presentation.stagedPanels.length === 5 &&
          loom.presentation.focusedPanel?.equals(loom.panels[0]) === true
        ),
      },
      { action: removeFirst },
      {
        assertion: assert(() =>
          loom.panels.length === 4 &&
          loom.presentation.stagedPanels.length === 4 &&
          loom.presentation.focusedPanel?.get() === undefined
        ),
      },
      { action: unregister },
      {
        assertion: assert(() =>
          loom.panels.length === 3 && loom.pieceRegistry.length === 0
        ),
      },
      { action: removeUrl },
      { action: readmitAsOther },
      {
        assertion: assert(() =>
          loom.panels.length === 2 &&
          !loom.panels.some((panel) => panel.equals(url)) &&
          url.key("addedByProfile").equals(member)
        ),
      },
    ],
  };
});
