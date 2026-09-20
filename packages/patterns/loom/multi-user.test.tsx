/** Independent sessions compose one shared collection through concurrent actions. */
import {
  action,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
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
