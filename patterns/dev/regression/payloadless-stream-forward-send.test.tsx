/**
 * An action that sends to a payloadless stream reaches the handler bound
 * behind it when the stream arrives through an enclosing pattern's result,
 * from a pattern the enclosing one instantiates at session scope.
 *
 * `Stream<void>` is declared `asCell: ["stream", "opaque"]`: a stream whose
 * payload is opaque. The action's send resolves the link it holds through
 * the shelf's result to the drawer's stream, and the documents along that
 * link are written by the shelf's graph. So the action's event preflight
 * brings those writers up to date, as it does for an input the action reads.
 * Only an input whose outermost `asCell` entry is `opaque` is one the action
 * hands on without reading.
 *
 * Run: deno task cf test patterns/dev/regression/payloadless-stream-forward-send.test.tsx
 */
import {
  action,
  assert,
  handler,
  pattern,
  type Stream,
  TESTS,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface DrawerOutput {
  openKey: string;
  close: Stream<void>;
  [UI]: VNode;
}

const closeDrawer = handler<void, { openKey: Writable<string> }>(
  (_event, { openKey }) => openKey.set(""),
);

/** Binds a payloadless handler, draws it as a button, and exposes it. */
const Drawer = pattern<Record<string, never>, DrawerOutput>(() => {
  const openKey = new Writable<string>("first");
  const close = closeDrawer({ openKey });
  return {
    openKey,
    close,
    [UI]: <cf-button onClick={close}>Close</cf-button>,
  };
});

/** Encloses a drawer and exposes its stream as its own. */
const Shelf = pattern<Record<string, never>, DrawerOutput>(() => {
  const drawer = Drawer.asScope("session")({});
  return {
    openKey: drawer.openKey,
    close: drawer.close,
    [UI]: <div>{drawer}</div>,
  };
});

export default pattern(() => {
  const shelf = Shelf({});

  return {
    [TESTS]: [
      { assertion: assert(() => shelf.openKey === "first") },
      { action: action(() => shelf.close.send()) },
      { assertion: assert(() => shelf.openKey === "") },
    ],
  };
});
