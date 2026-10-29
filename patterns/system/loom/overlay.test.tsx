/**
 * A hide or a private panel changes only its own principal's view, in every
 * session of theirs.
 */
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

/** A URL panel's occurrence, created in a space of its own. */
const PrivateUrl = pattern<{ url: string }, { kind: "url"; url: string }>((
  { url },
) => ({ kind: "url", url }));

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
  const hideOther = action(() => {
    const first = setup.loom.panels[0];
    setup.loom.hidePanel.send({
      panel: first.equals(panel) ? setup.loom.panels[1] : first,
    });
  });
  return {
    [TESTS]: [
      { action: add },
      { label: "alice-added" },
      { await: "bob-added" },
      {
        assertion: assert(() =>
          setup.loom.panels.length === 2 &&
          setup.loom.viewerPanels.length === 2
        ),
      },
      { action: hideOther },
      {
        assertion: assert(() =>
          setup.loom.viewerPanels.length === 1 &&
          setup.loom.viewerPanels[0].equals(panel) &&
          setup.loom.hiddenPanels.get().length === 1
        ),
      },
      { label: "alice-hid" },
      // Bob's hide of Alice's panel and his private panel change nothing
      // here: her view is the shared list less her own hides, with her own
      // private panels.
      { await: "bob-hid" },
      {
        assertion: assert(() =>
          setup.loom.panels.length === 2 &&
          setup.loom.viewerPanels.length === 1 &&
          setup.loom.viewerPanels[0].equals(panel) &&
          setup.loom.hiddenPanels.get().length === 1
        ),
      },
      { label: "alice-checked" },
      // Unhiding in her second session shows the panel here too.
      { await: "tab2-unhid" },
      {
        assertion: assert(() =>
          setup.loom.viewerPanels.length === 2 &&
          setup.loom.hiddenPanels.get().length === 0
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
  const hideOther = action(() => {
    const first = setup.loom.panels[0];
    setup.loom.hidePanel.send({
      panel: first.equals(panel) ? setup.loom.panels[1] : first,
    });
  });
  const addPrivate = action(() =>
    setup.loom.addPrivatePanel.send({
      panel: PrivateUrl.inSpace()({ url: "https://example.com/bob-private" }),
    })
  );
  return {
    [TESTS]: [
      { action: add },
      { label: "bob-added" },
      { await: "alice-hid" },
      // Alice hid Bob's panel; Bob still sees both, and the shared list
      // still holds both.
      {
        assertion: assert(() =>
          setup.loom.panels.length === 2 &&
          setup.loom.viewerPanels.length === 2
        ),
      },
      { action: hideOther },
      {
        assertion: assert(() =>
          setup.loom.panels.length === 2 &&
          setup.loom.viewerPanels.length === 1 &&
          setup.loom.viewerPanels[0].equals(panel)
        ),
      },
      // Bob's private panel shows to him, after his one shared panel, and
      // reaches neither the shared list nor Alice.
      { action: addPrivate },
      {
        assertion: assert(() =>
          setup.loom.panels.length === 2 &&
          setup.loom.viewerPanels.length === 2 &&
          setup.loom.viewerPanels[0].equals(panel)
        ),
      },
      { label: "bob-hid" },
    ],
  };
});

export const aliceTab2 = pattern<{ setup: Setup }>(({ setup }) => {
  const unhide = action(() =>
    setup.loom.unhidePanel.send({ panel: setup.loom.hiddenPanels.get()[0] })
  );
  return {
    [TESTS]: [
      // Alice's hide follows her into this session: it links the shared
      // occurrence, which this session resolves.
      { await: "alice-hid" },
      {
        assertion: assert(() =>
          setup.loom.viewerPanels.length === 1 &&
          setup.loom.hiddenPanels.get().length === 1 &&
          setup.loom.hiddenPanels.get()[0].equals(setup.loom.panels[0]) !==
            setup.loom.hiddenPanels.get()[0].equals(setup.loom.panels[1])
        ),
      },
      // Alice has checked her view, so the unhide cannot arrive before it.
      { await: "alice-checked" },
      { action: unhide },
      { label: "tab2-unhid" },
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
