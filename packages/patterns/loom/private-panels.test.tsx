/**
 * A viewer's private panels: shown to them where they anchored them, moved and
 * removed by them, and refused when they live in the Loom's own space.
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import { clickButton, countElements } from "../test/vnode-helpers.ts";
import Loom from "./main.tsx";
import type { Panel } from "./schemas.tsx";

/** A URL panel's occurrence, created in a space of its own. */
const PrivateUrl = pattern<{ url: string }, { kind: "url"; url: string }>((
  { url },
) => ({ kind: "url", url }));

/** The URL of `panel`, or `""` for a panel that is not a URL panel. */
const urlOf = (panel: Writable<Panel>): string => {
  const value = panel.get();
  return value.kind === "url" ? value.url : "";
};

interface Held {
  mine?: Writable<Panel>;
}

export default pattern(() => {
  const loom = Loom({});
  const first = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/first",
  });
  const second = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/second",
  });
  const inLoomSpace = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/in-loom-space",
  });
  const outside = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/outside",
  });
  const held = Writable.of<Held>({});
  const addShared = action(() => {
    loom.addPanel.send({ panel: first });
    loom.addPanel.send({ panel: second });
  });
  const addMine = action(() => {
    const mine = PrivateUrl.inSpace()({ url: "https://example.com/mine" });
    held.set({ mine });
    loom.addPrivatePanel.send({ panel: mine, before: second });
  });
  const moveLast = action(() => {
    const mine = held.get().mine;
    if (mine) loom.movePrivatePanel.send({ panel: mine });
  });
  const moveFirst = action(() => {
    const mine = held.get().mine;
    if (mine) loom.movePrivatePanel.send({ panel: mine, before: first });
  });
  const hideFirst = action(() => loom.hidePanel.send({ panel: first }));
  const unhideFirst = action(() => loom.unhidePanel.send({ panel: first }));
  const removeMine = action(() => {
    const mine = held.get().mine;
    if (mine) loom.removePrivatePanel.send({ panel: mine });
  });
  const addInLoomSpace = action(() =>
    loom.addPrivatePanel.send({ panel: inLoomSpace })
  );
  const addBeforeOutside = action(() =>
    loom.addPrivatePanel.send({
      panel: PrivateUrl.inSpace()({ url: "https://example.com/other" }),
      before: outside,
    })
  );
  const moveShared = action(() => loom.movePrivatePanel.send({ panel: first }));
  const addAnother = action(() =>
    loom.addPrivatePanel.send({
      panel: PrivateUrl.inSpace()({ url: "https://example.com/another" }),
    })
  );
  const removeFromUI = action(() =>
    clickButton(loom[UI], "Remove from my view")
  );
  return {
    allowRuntimeErrors: true,
    expectRuntimeErrors: 3,
    allowConsoleErrors: true,
    [TESTS]: [
      { action: addShared },
      { action: addMine },
      // The private panel shows just ahead of its anchor, and the shared list
      // does not hold it.
      {
        assertion: assert(() =>
          loom.panels.length === 2 &&
          loom.privatePanels.get().length === 1 &&
          loom.viewerPanels.length === 3 &&
          urlOf(loom.viewerPanels[0]) === "https://example.com/first" &&
          urlOf(loom.viewerPanels[1]) === "https://example.com/mine" &&
          urlOf(loom.viewerPanels[2]) === "https://example.com/second"
        ),
      },
      { action: moveLast },
      {
        assertion: assert(() =>
          loom.viewerPanels.length === 3 &&
          urlOf(loom.viewerPanels[2]) === "https://example.com/mine"
        ),
      },
      { action: moveFirst },
      {
        assertion: assert(() =>
          loom.viewerPanels.length === 3 &&
          urlOf(loom.viewerPanels[0]) === "https://example.com/mine"
        ),
      },
      // Its anchor hidden, it shows after every shared panel the viewer sees.
      { action: hideFirst },
      {
        assertion: assert(() =>
          loom.viewerPanels.length === 2 &&
          urlOf(loom.viewerPanels[0]) === "https://example.com/second" &&
          urlOf(loom.viewerPanels[1]) === "https://example.com/mine"
        ),
      },
      { action: unhideFirst },
      { action: removeMine },
      {
        assertion: assert(() =>
          loom.privatePanels.get().length === 0 &&
          loom.viewerPanels.length === 2 && loom.panels.length === 2
        ),
      },
      // A panel in the Loom's own space, an anchor outside the Loom, and a
      // move of a panel that is not private are each refused.
      { action: addInLoomSpace },
      { action: addBeforeOutside },
      { action: moveShared },
      {
        assertion: assert(() =>
          loom.privatePanels.get().length === 0 &&
          loom.viewerPanels.length === 2
        ),
      },
      // The root shows a private panel as a card of its own, and its Remove
      // button takes it off the viewer's private panels.
      { action: addAnother },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          loom.privatePanels.get().length === 1 &&
          countElements(loom[UI], "cf-card") === 3
        ),
      },
      { action: removeFromUI },
      { render: loom[UI] },
      {
        assertion: assert(() =>
          loom.privatePanels.get().length === 0 &&
          countElements(loom[UI], "cf-card") === 2
        ),
      },
    ],
  };
});
