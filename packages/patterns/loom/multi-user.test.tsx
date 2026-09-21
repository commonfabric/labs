/** Independent sessions compose one shared collection through concurrent actions. */
import {
  action,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { clickButton, hasText } from "../test/vnode-helpers.ts";
import Loom from "./main.tsx";
import type { LoomOutput, Panel } from "./schemas.tsx";

interface Setup {
  loom: LoomOutput;
}
export const setup = pattern(() => ({ loom: Loom({}) }));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const panel = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/alice",
  });
  const add = action(() => setup.loom.addPanel.send({ panel }));
  const select = action(() =>
    setup.loom.viewerState.set({ selectedPanel: panel })
  );
  const stage = action(() => clickButton(setup.loom[UI], "Stage all"));
  return {
    [TESTS]: [
      { action: add },
      { action: select },
      { label: "alice-added" },
      { await: "bob-added" },
      { assertion: assert(() => setup.loom.panels.length === 2) },
      {
        assertion: assert(() =>
          setup.loom.viewerState.key("selectedPanel").equals(panel)
        ),
      },
      { render: setup.loom[UI] },
      { action: stage },
      { label: "alice-staged" },
      { render: setup.loom[UI] },
      {
        assertion: assert(() =>
          hasText(setup.loom[UI], "Staged for everyone") &&
          !hasText(setup.loom[UI], "Not staged")
        ),
      },
      {
        assertion: assert(() =>
          setup.loom.presentation.stagedPanels.length === 2
        ),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const panel = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/bob",
  });
  const add = action(() => setup.loom.addPanel.send({ panel }));
  const select = action(() =>
    setup.loom.viewerState.set({ selectedPanel: panel })
  );
  return {
    [TESTS]: [
      { action: add },
      { action: select },
      { label: "bob-added" },
      { await: "alice-added" },
      { assertion: assert(() => setup.loom.panels.length === 2) },
      {
        assertion: assert(() =>
          setup.loom.viewerState.key("selectedPanel").equals(panel)
        ),
      },
      { await: "alice-staged" },
      {
        assertion: assert(() =>
          setup.loom.presentation.stagedPanels.length === 2
        ),
      },
    ],
  };
});

export const aliceTab2 = pattern<{ setup: Setup }>(({ setup }) => {
  const panel = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/second-tab",
  });
  const select = action(() =>
    setup.loom.viewerState.set({ selectedPanel: panel })
  );
  return {
    [TESTS]: [
      { action: select },
      { await: "alice-added" },
      { await: "bob-added" },
      {
        assertion: assert(() =>
          setup.loom.viewerState.key("selectedPanel").equals(panel)
        ),
      },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    aliceTab2: { pattern: aliceTab2, user: "alice" },
  },
});
