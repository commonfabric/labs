/**
 * A move of a private panel ahead of a private panel the viewer has since
 * removed is refused, and leaves the viewer's panels where they were.
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Loom from "./main.tsx";
import type { Panel } from "./schemas.tsx";

/** A URL panel's occurrence, created in a space of its own. */
const PrivateUrl = pattern<{ url: string }, { kind: "url"; url: string }>((
  { url },
) => ({ kind: "url", url }));

/**
 * The URL of `panel`, or `""` for a panel that is not a URL panel or whose
 * occurrence, in a space of its own, has not been read yet.
 */
const urlOf = (panel: Writable<Panel>): string => {
  const value: Panel | undefined = panel.get();
  return value?.kind === "url" ? value.url : "";
};

interface Held {
  alpha?: Writable<Panel>;
  beta?: Writable<Panel>;
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
  const held = Writable.of<Held>({});
  const addShared = action(() => {
    loom.addPanel.send({ panel: first });
    loom.addPanel.send({ panel: second });
  });
  const addPrivate = action(() => {
    const alpha = PrivateUrl.inSpace()({ url: "https://example.com/alpha" });
    const beta = PrivateUrl.inSpace()({ url: "https://example.com/beta" });
    held.set({ alpha, beta });
    loom.addPrivatePanel.send({ panel: alpha, before: second });
    loom.addPrivatePanel.send({ panel: beta, before: second });
  });
  const removeBeta = action(() => {
    const beta = held.get().beta;
    if (beta) loom.removePrivatePanel.send({ panel: beta });
  });
  const moveAlphaBeforeBeta = action(() => {
    const { alpha, beta } = held.get();
    if (alpha && beta) {
      loom.movePrivatePanel.send({ panel: alpha, before: beta });
    }
  });
  const moveAlphaBeforeFirst = action(() => {
    const alpha = held.get().alpha;
    if (alpha) loom.movePrivatePanel.send({ panel: alpha, before: first });
  });
  return {
    allowRuntimeErrors: true,
    expectRuntimeErrors: 1,
    allowConsoleErrors: true,
    [TESTS]: [
      { action: addShared },
      { action: addPrivate },
      { action: removeBeta },
      {
        assertion: assert(() =>
          loom.privatePanels.get().length === 1 &&
          loom.viewerPanels.length === 3 &&
          urlOf(loom.viewerPanels[0]) === "https://example.com/first" &&
          urlOf(loom.viewerPanels[1]) === "https://example.com/alpha" &&
          urlOf(loom.viewerPanels[2]) === "https://example.com/second"
        ),
      },
      // The removed panel is no anchor: the move is refused and nothing
      // moves.
      { action: moveAlphaBeforeBeta },
      {
        assertion: assert(() =>
          loom.privatePanels.get().length === 1 &&
          loom.privatePanels.get()[0].before?.equals(second) === true &&
          loom.viewerPanels.length === 3 &&
          urlOf(loom.viewerPanels[1]) === "https://example.com/alpha" &&
          urlOf(loom.viewerPanels[2]) === "https://example.com/second"
        ),
      },
      // An anchor still in the Loom is taken.
      { action: moveAlphaBeforeFirst },
      {
        assertion: assert(() =>
          loom.privatePanels.get().length === 1 &&
          loom.privatePanels.get()[0].before?.equals(first) === true &&
          loom.viewerPanels.length === 3 &&
          urlOf(loom.viewerPanels[0]) === "https://example.com/alpha" &&
          urlOf(loom.viewerPanels[1]) === "https://example.com/first"
        ),
      },
    ],
  };
});
