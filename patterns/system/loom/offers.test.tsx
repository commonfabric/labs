/**
 * Every action the deck offers is one the root accepts: sending each offered
 * event to the stream it names does what its id says.
 */
import { action, assert, pattern, TESTS, VIEWS, Writable } from "commonfabric";
import Loom from "./main.tsx";
import type { LoomAction, LoomOffers, LoomOutput, Panel } from "./schemas.tsx";

/** The action `id` the offers hold on the Loom, or on the shown panel `at`. */
function offered(
  offers: LoomOffers,
  at: "loom" | number,
  id: string,
): LoomAction {
  const actions = at === "loom" ? offers.loom : offers.shown[at]?.actions;
  const found = actions?.find((one) => one.id === id);
  if (!found) throw new Error(`\`${id}\` is not offered at ${at}`);
  return found;
}

/** The hidden panel offer `at`'s action `id`. */
function offeredHidden(offers: LoomOffers, at: number, id: string): LoomAction {
  const found = offers.hidden[at]?.actions.find((one) => one.id === id);
  if (!found) throw new Error(`\`${id}\` is not offered on hidden ${at}`);
  return found;
}

/**
 * The shown panel `at`'s action `id` that the root accepts only from one
 * principal: here, the one this test acts as, who added it.
 */
function offeredToAdder(
  offers: LoomOffers,
  at: number,
  id: string,
): LoomAction {
  const found = offers.shown[at]?.ifViewerIs?.actions.find((one) =>
    one.id === id
  );
  if (!found) throw new Error(`\`${id}\` is not offered to the adder at ${at}`);
  return found;
}

/** Sends `offer`'s event to the stream it names, as a host does. */
function send(loom: LoomOutput, offer: LoomAction): void {
  const event = offer.event ?? {};
  const panel = event.panel;
  switch (offer.stream) {
    case "setPresentation":
      return loom.setPresentation.send({
        stagedPanels: event.stagedPanels ?? [],
        ...(event.focusedPanel ? { focusedPanel: event.focusedPanel } : {}),
      });
    case "movePanel":
      if (!panel) break;
      return loom.movePanel.send({
        panel,
        ...(event.before ? { before: event.before } : {}),
      });
    case "duplicatePanel":
      if (!panel) break;
      return loom.duplicatePanel.send({
        panel,
        ...(event.as ? { as: event.as } : {}),
      });
    case "hidePanel":
      if (!panel) break;
      return loom.hidePanel.send({ panel });
    case "unhidePanel":
      if (!panel) break;
      return loom.unhidePanel.send({ panel });
    case "removePanel":
      if (!panel) break;
      return loom.removePanel.send({ panel });
  }
  throw new Error(`\`${offer.id}\` names no event this test sends`);
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
  const addFirst = action(() => loom.addPanel.send({ panel: first }));
  const addSecond = action(() => loom.addPanel.send({ panel: second }));
  // An unstaged panel is offered focus; the offer stages it as well.
  const focusSecond = action(() =>
    send(loom, offered(loom[VIEWS].deck.offers, 1, "focus"))
  );
  const moveSecondFirst = action(() =>
    send(loom, offered(loom[VIEWS].deck.offers, 1, "move-first"))
  );
  const stageAll = action(() =>
    send(loom, offered(loom[VIEWS].deck.offers, "loom", "stage-all"))
  );
  const clearFocus = action(() =>
    send(loom, offered(loom[VIEWS].deck.offers, "loom", "clear-focus"))
  );
  const clearStage = action(() =>
    send(loom, offered(loom[VIEWS].deck.offers, "loom", "clear-stage"))
  );
  const moveFirstLast = action(() =>
    send(loom, offered(loom[VIEWS].deck.offers, 0, "move-last"))
  );
  const duplicateLast = action(() =>
    send(loom, offered(loom[VIEWS].deck.offers, 1, "duplicate"))
  );
  const hideFirst = action(() =>
    send(loom, offered(loom[VIEWS].deck.offers, 0, "hide"))
  );
  const showIt = action(() =>
    send(loom, offeredHidden(loom[VIEWS].deck.offers, 0, "show"))
  );
  // The copy records its adder, so its removal is offered to the adder only;
  // the panels linked without one, to anyone who may write.
  const removeCopy = action(() =>
    send(loom, offeredToAdder(loom[VIEWS].deck.offers, 2, "remove"))
  );
  const removeFirst = action(() =>
    send(loom, offered(loom[VIEWS].deck.offers, 0, "remove"))
  );
  return {
    [TESTS]: [
      { action: addFirst },
      { action: addSecond },
      { action: focusSecond },
      {
        assertion: assert(() =>
          loom.presentation.focusedPanel?.equals(second) === true &&
          loom.presentation.stagedPanels.length === 1
        ),
      },
      { action: moveSecondFirst },
      { assertion: assert(() => loom.panels[0].equals(second)) },
      { action: clearFocus },
      {
        assertion: assert(() =>
          !loom[VIEWS].deck.offers.loom.some((one) => one.id === "clear-focus")
        ),
      },
      // Stage all stages every panel, as the root's own button does.
      { action: stageAll },
      { assertion: assert(() => loom.presentation.stagedPanels.length === 2) },
      { action: clearStage },
      { assertion: assert(() => loom.presentation.stagedPanels.length === 0) },
      { action: moveFirstLast },
      { assertion: assert(() => loom.panels[1].equals(second)) },
      { action: duplicateLast },
      { assertion: assert(() => loom.panels.length === 3) },
      { action: hideFirst },
      {
        assertion: assert(() =>
          loom[VIEWS].deck.offers.shown.length === 2 &&
          loom[VIEWS].deck.offers.hidden.length === 1
        ),
      },
      { action: showIt },
      { assertion: assert(() => loom[VIEWS].deck.offers.hidden.length === 0) },
      {
        assertion: assert(() =>
          !loom[VIEWS].deck.offers.shown[2].actions.some((one) =>
            one.id === "remove"
          )
        ),
      },
      { action: removeCopy },
      { assertion: assert(() => loom.panels.length === 2) },
      { action: removeFirst },
      { assertion: assert(() => loom.panels.length === 1) },
    ],
  };
});
