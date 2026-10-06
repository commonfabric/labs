/**
 * Each occurrence the root creates without a profile names, as its adder, the
 * principal its event acted for: the participant who sent the event, or the
 * one a pattern's own `send()` acted for. Nothing in the event chooses it.
 */
import {
  action,
  assert,
  type AuthoredByCurrentUser,
  currentPrincipal,
  handler,
  multiUserTest,
  pattern,
  principalOf,
  type Stream,
  TESTS,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import Loom from "./main.tsx";
import type { LoomOutput, Panel, PanelAdmission } from "./schemas.tsx";

interface Setup {
  loom: LoomOutput;
  // A second Loom, into which occurrences of the first are linked.
  elsewhere: LoomOutput;
  // An occurrence with no adder, whose title another participant may write.
  unattributed: Writable<Panel>;
}

export const setup = pattern(() => ({
  loom: Loom({}),
  elsewhere: Loom({}),
  unattributed: new Writable<Panel>({
    kind: "url",
    url: "https://example.com/title-only-attribution",
  }),
}));

/** The occurrence in `panels` that registers `piece`, if there is one. */
function panelOf(
  panels: readonly Writable<Panel>[],
  piece: Writable<unknown>,
): Writable<Panel> | undefined {
  return panels.find((panel) => {
    const value = panel.get();
    return value.kind === "piece" && value.piece.equals(piece);
  });
}

/** Whether the root recorded `principal` as `panel`'s adder, and attested it. */
function attestedTo(
  panel: Writable<Panel> | undefined,
  principal: string,
): boolean {
  return panel !== undefined && principal !== "" &&
    panel.get().addedBy === principal &&
    principalOf(panel.key("addedBy"), "authored-by") === principal;
}

/** A panel title whose writer is independent of the panel's adder. */
interface AuthoredTitle {
  /** Title attributed to the participant editing it. */
  titleOverride?: AuthoredByCurrentUser<
    WriteAuthorizedBy<string, typeof retitle>
  >;
}

/** Records a participant's title on an existing panel. */
const retitle = handler<
  { panel: Writable<AuthoredTitle> },
  Record<string, never>
>(({ panel }) => {
  panel.key("titleOverride").set("Bob's title");
});

/** Registers `piece` from a handler of the participant's own pattern. */
const register = handler<
  void,
  { addPiece: Stream<PanelAdmission>; piece: Writable<unknown> }
>((_, { addPiece, piece }) => {
  addPiece.send({ piece });
});

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const me = new Writable("");
  const piece = new Writable({ title: "Alice's target" });
  const claimedPiece = new Writable({ title: "Claimed target" });
  const recordMe = action(() => me.set(currentPrincipal() ?? ""));
  const add = action(() => setup.loom.addPiece.send({ piece }));
  // An event that names an adder is admitted as the `{ piece }` it carries.
  const addClaiming = action(() => {
    const event = {
      piece: claimedPiece,
      addedBy: "did:key:z6MkSomeoneElseClaimsThisPanel",
    };
    setup.loom.addPiece.send(event);
  });
  // A write that does not go through the root's handlers cannot replace the
  // adder the root recorded.
  const overwriteAdder = action(() => {
    panelOf(setup.loom.panels, piece)?.key("addedBy").set(
      "did:key:z6MkSomeoneElseOverwritesTheAdder",
    );
  });
  // Alice links her own occurrence into the other Loom.
  const linkOwnElsewhere = action(() => {
    const own = panelOf(setup.loom.panels, piece);
    if (own) setup.elsewhere.addPanel.send({ panel: own });
  });
  const linkUnattributed = action(() =>
    setup.elsewhere.addPanel.send({ panel: setup.unattributed })
  );
  return {
    // The refused write is reported as a CFC policy warning.
    allowConsoleWarnings: true,
    [TESTS]: [
      { action: recordMe },
      { action: add },
      { action: addClaiming },
      {
        assertion: assert(() =>
          attestedTo(panelOf(setup.loom.panels, piece), me.get()) &&
          attestedTo(panelOf(setup.loom.panels, claimedPiece), me.get())
        ),
      },
      { action: overwriteAdder },
      {
        assertion: assert(() =>
          attestedTo(panelOf(setup.loom.panels, piece), me.get())
        ),
      },
      { label: "alice-added" },
      { await: "bob-linked" },
      { action: linkOwnElsewhere },
      {
        assertion: assert(() =>
          setup.elsewhere.panels.length === 1 &&
          attestedTo(setup.elsewhere.panels[0], me.get())
        ),
      },
      { action: linkUnattributed },
      {
        assertion: assert(() =>
          setup.elsewhere.panels.length === 2 &&
          setup.elsewhere.panels[1].equals(setup.unattributed) &&
          setup.unattributed.get().addedBy === undefined
        ),
      },
      { label: "alice-linked" },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const me = new Writable("");
  const piece = new Writable({ title: "Bob's target" });
  const recordMe = action(() => me.set(currentPrincipal() ?? ""));
  const registerPiece = register({ addPiece: setup.loom.addPiece, piece });
  const retitlePanel = retitle({});
  const retitleUnattributed = action(() =>
    retitlePanel.send({ panel: setup.unattributed })
  );
  const retitleAlices = action(() => {
    const theirs = setup.loom.panels.find((panel) => {
      const value = panel.get();
      return value.addedBy !== undefined && value.addedBy !== me.get();
    });
    if (theirs) retitlePanel.send({ panel: theirs });
  });
  // An occurrence whose attested adder is someone else is not linked: the
  // link would attribute Bob's admission to Alice.
  const linkAlicesElsewhere = action(() => {
    const theirs = setup.loom.panels.find((panel) => {
      const value = panel.get();
      return value.kind === "piece" && value.addedBy !== undefined &&
        value.addedBy !== me.get();
    });
    if (theirs) setup.elsewhere.addPanel.send({ panel: theirs });
  });
  return {
    // The refused link is reported as a runtime error.
    allowRuntimeErrors: true,
    expectRuntimeErrors: 2,
    [TESTS]: [
      { action: recordMe },
      { action: registerPiece },
      {
        assertion: assert(() =>
          attestedTo(panelOf(setup.loom.panels, piece), me.get())
        ),
      },
      { await: "alice-added" },
      {
        assertion: assert(() =>
          setup.loom.panels.length === 3 &&
          setup.loom.panels.every((panel) =>
            panel.get().addedBy !== undefined &&
            principalOf(panel.key("addedBy"), "authored-by") ===
              panel.get().addedBy
          ) &&
          setup.loom.panels.filter((panel) => panel.get().addedBy === me.get())
              .length === 1
        ),
      },
      { action: linkAlicesElsewhere },
      { assertion: assert(() => setup.elsewhere.panels.length === 0) },
      { action: retitleAlices },
      {
        assertion: assert(() => {
          const theirs = setup.loom.panels.find((panel) => {
            const value = panel.get();
            return value.addedBy !== undefined && value.addedBy !== me.get();
          });
          return theirs !== undefined &&
            principalOf(theirs.key("addedBy"), "authored-by") ===
              theirs.get().addedBy &&
            principalOf(theirs.key("titleOverride"), "authored-by") ===
              me.get();
        }),
      },
      // Editing a title leaves the original adder in charge of linking the
      // occurrence. Alice still links it after Bob's second refused attempt.
      { action: linkAlicesElsewhere },
      { assertion: assert(() => setup.elsewhere.panels.length === 0) },
      { action: retitleUnattributed },
      {
        assertion: assert(() =>
          setup.unattributed.get().addedBy === undefined &&
          principalOf(
              setup.unattributed.key("titleOverride"),
              "authored-by",
            ) === me.get()
        ),
      },
      { label: "bob-linked" },
      { await: "alice-linked" },
      { assertion: assert(() => setup.elsewhere.panels.length === 2) },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
