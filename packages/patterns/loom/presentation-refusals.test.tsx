/** Refusals leave shared composition, presentation and participants unchanged. */
import {
  action,
  assert,
  type Confidential,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import Loom from "./main.tsx";
import type { Panel, ParticipantRoster } from "./schemas.tsx";

type TestProfile = Confidential<
  { name?: string; avatar?: string },
  readonly ["loom-test-profile"]
>;

export default pattern(() => {
  const participants = Writable.of<ParticipantRoster>({});
  const loom = Loom({ participants });
  const member = Writable.of<TestProfile>({ name: "Member" });
  const stranger = Writable.of<TestProfile>({ name: "Stranger" });
  const join = action(() => loom.addParticipant.send({ profile: member }));
  // The roster is written only by `addParticipant`, whoever holds its cell.
  const directWrite = action(() => participants.key("items").set([stranger]));
  const first = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/a",
  });
  const second = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/b",
  });
  const absent = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/missing",
  });
  const invalid = new Writable<Panel>({
    kind: "url",
    url: "javascript:alert(1)",
  });
  const addFirst = action(() => loom.addPanel.send({ panel: first }));
  const addSecond = action(() => loom.addPanel.send({ panel: second }));
  const stage = action(() =>
    loom.setPresentation.send({ stagedPanels: [first], focusedPanel: first })
  );
  const duplicateStage = action(() =>
    loom.setPresentation.send({ stagedPanels: [first, first] })
  );
  const absentStage = action(() =>
    loom.setPresentation.send({ stagedPanels: [absent] })
  );
  const unstagedFocus = action(() =>
    loom.setPresentation.send({ stagedPanels: [first], focusedPanel: second })
  );
  const absentSource = action(() =>
    loom.duplicatePanel.send({ panel: absent })
  );
  const absentAnchor = action(() =>
    loom.duplicatePanel.send({ panel: first, before: absent })
  );
  const absentMove = action(() =>
    loom.movePanel.send({ panel: first, before: absent })
  );
  const absentMoveSource = action(() => loom.movePanel.send({ panel: absent }));
  const invalidUrl = action(() => loom.addPanel.send({ panel: invalid }));
  return {
    allowRuntimeErrors: true,
    expectRuntimeErrors: 8,
    allowConsoleErrors: true,
    // The refused direct roster write is reported as a CFC policy warning.
    allowConsoleWarnings: true,
    [TESTS]: [
      { action: join },
      { action: directWrite },
      // A replacing write would also leave one entry; only its identity
      // tells a refused write from an accepted one.
      {
        assertion: assert(() =>
          loom.participants.length === 1 && loom.participants[0].equals(member)
        ),
      },
      { action: addFirst },
      { action: addSecond },
      { action: stage },
      { action: duplicateStage },
      { action: absentStage },
      { action: unstagedFocus },
      { action: absentSource },
      { action: absentAnchor },
      { action: absentMove },
      { action: absentMoveSource },
      { action: invalidUrl },
      { assertion: assert(() => loom.panels.length === 2) },
      { assertion: assert(() => loom.panels[0].equals(first)) },
      { assertion: assert(() => loom.presentation.stagedPanels.length === 1) },
      {
        assertion: assert(() =>
          loom.presentation.focusedPanel?.equals(first) === true
        ),
      },
    ],
  };
});
