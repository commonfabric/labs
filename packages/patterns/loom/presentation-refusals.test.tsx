/** Refusals leave shared composition and presentation unchanged. */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Loom from "./main.tsx";
import type { Panel } from "./schemas.tsx";

export default pattern(() => {
  const loom = Loom({});
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
  const invalidUrl = action(() => loom.addPanel.send({ panel: invalid }));
  return {
    allowRuntimeErrors: true,
    expectRuntimeErrors: 7,
    allowConsoleErrors: true,
    [TESTS]: [
      { action: addFirst },
      { action: addSecond },
      { action: stage },
      { action: duplicateStage },
      { action: absentStage },
      { action: unstagedFocus },
      { action: absentSource },
      { action: absentAnchor },
      { action: absentMove },
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
