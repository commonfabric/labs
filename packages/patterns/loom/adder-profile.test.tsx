/**
 * A panel links the profile its adder acted under, which is a profile of the
 * adder's own, and nothing else writes it.
 */
import {
  action,
  type AddIntegrity,
  assert,
  handler,
  pattern,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";
import { clickButton, findElement } from "../test/vnode-helpers.ts";
import Loom from "./main.tsx";
import type { Panel } from "./schemas.tsx";

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "LoomTestProfileSurface";
const PROFILE_ACTION = "LoomTestWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

/**
 * A person's own profile, labeled with the principal who wrote it, which only
 * `writeOwnProfile` writes, from its reviewed surface.
 */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    { name?: string; avatar?: string },
    typeof writeOwnProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeOwnProfile` is bound to. */
interface ProfileWriteState {
  /** The profile to write. */
  profile: Writable<OwnProfile>;

  /** The name to write into it. */
  name: string;
}

/** Writes the acting person's own profile, under `name`. */
const writeOwnProfile = handler<unknown, ProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name });
});

/** A profile labeled with integrity only, which names no principal. */
type UnclaimedProfile = AddIntegrity<
  { name?: string; avatar?: string },
  readonly ["loom-test-profile"]
>;

/** The address a URL panel shows, or `undefined` for another kind. */
const urlOf = (panel: Panel): string | undefined =>
  panel.kind === "url" ? panel.url : undefined;

export default pattern(() => {
  // Two profiles of the person running the test, and one that names nobody.
  const member = Writable.of<OwnProfile>();
  const other = Writable.of<OwnProfile>();
  const unclaimed = Writable.of<UnclaimedProfile>({ name: "Nobody" });
  const writeMember = writeOwnProfile({ profile: member, name: "Member" });
  const writeOther = writeOwnProfile({ profile: other, name: "Other" });
  const alice = "did:key:z6MkAliceAddsPanelsToTheSharedLoom";

  const loom = Loom({});
  // A second Loom, into which an occurrence of the first may be linked.
  const elsewhere = Loom({});
  // A third, which admits an occurrence that names its adder by claim.
  const claimedLoom = Loom({});
  const piece = new Writable({ title: "Target" });
  const url = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/acting-profile",
  });

  const addPieceAsMember = action(() =>
    loom.addPiece.send({ piece, as: member })
  );
  // An occurrence that names its adder by claim is copied under `as` like any
  // other; the copy records the profile and no claim.
  const claimed = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/claimed-adder",
    addedBy: alice,
  });
  const addClaimedAsMember = action(() =>
    claimedLoom.addPanel.send({ panel: claimed, as: member })
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
  const duplicateWithoutProfile = action(() =>
    loom.duplicatePanel.send({ panel: linked })
  );
  // Writes that do not go through the root's handlers: one gives an
  // occurrence that records no profile a profile, one replaces a recorded
  // profile.
  const forgeOnUnprofiled = action(() =>
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
  // A profile that names nobody is no one's to add under, through any of the
  // streams, including where the event would otherwise change nothing.
  const unclaimedPiece = new Writable({ title: "Unclaimed target" });
  const addPieceAsUnclaimed = action(() =>
    loom.addPiece.send({ piece: unclaimedPiece, as: unclaimed })
  );
  const addUrlAsUnclaimed = action(() =>
    loom.addPanel.send({ panel: url, as: unclaimed })
  );
  const addPresentAsUnclaimed = action(() =>
    loom.addPanel.send({ panel: loom.panels[0], as: unclaimed })
  );
  const duplicateAsUnclaimed = action(() =>
    loom.duplicatePanel.send({ panel: loom.panels[0], as: unclaimed })
  );
  const claimUnclaimed = action(() =>
    loom.viewerState.key("actingProfile").set(unclaimed)
  );

  return {
    // Each refused write is reported as a CFC policy warning, and each
    // refused event as a runtime error.
    allowConsoleWarnings: true,
    allowRuntimeErrors: true,
    expectRuntimeErrors: 7,
    [TESTS]: [
      { action: writeMember, event: {}, trustedUi: profileGesture },
      { action: writeOther, event: {}, trustedUi: profileGesture },
      { action: addPieceAsMember },
      {
        assertion: assert(() =>
          loom.panels.length === 1 &&
          loom.panels[0].key("addedByProfile").equals(member) &&
          loom.panels[0].get().addedBy === undefined
        ),
      },
      { action: addClaimedAsMember },
      {
        assertion: assert(() =>
          claimedLoom.panels.length === 1 &&
          !claimedLoom.panels[0].equals(claimed) &&
          claimedLoom.panels[0].key("addedByProfile").equals(member) &&
          claimedLoom.panels[0].get().addedBy === undefined &&
          claimed.get().addedByProfile === undefined &&
          claimed.get().addedBy === alice
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
      { action: duplicateWithoutProfile },
      {
        assertion: assert(() =>
          loom.panels.length === 5 &&
          loom.panels[3].key("addedByProfile").equals(other) &&
          loom.panels[4].get().addedByProfile === undefined &&
          linked.get().addedByProfile === undefined
        ),
      },
      { action: forgeOnUnprofiled },
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
      { action: addPieceAsUnclaimed },
      { action: addUrlAsUnclaimed },
      { action: addPresentAsUnclaimed },
      { action: duplicateAsUnclaimed },
      { action: claimUnclaimed },
      { render: loom[UI] },
      { action: duplicateFromUI },
      {
        assertion: assert(() =>
          loom.panels.length === 3 && loom.pieceRegistry.length === 0 &&
          !loom.panels.some((panel) =>
            panel.get().addedByProfile !== undefined &&
            panel.key("addedByProfile").equals(unclaimed)
          )
        ),
      },
    ],
  };
});
