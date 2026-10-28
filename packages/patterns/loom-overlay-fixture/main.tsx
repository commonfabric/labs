// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * A Loom beside the access-list changes its space's owner makes: fixture for
 * `integration/loom-overlay-multi-runtime.test.ts`. It lives outside
 * `integration/` because the Loom root it composes is checked by `cfcheck`, in
 * the environment patterns compile under, and not by `deno task check`.
 */

import {
  Default,
  type DID,
  grantSpaceAccess,
  handler,
  NAME,
  pattern,
  revokeSpaceAccess,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import Loom from "../loom/main.tsx";
import type { Panel, PanelAdmission } from "../loom/schemas.tsx";

interface MemberEvent {
  principal: DID;
}

const grant = handler<MemberEvent, { members: Writable<DID[]> }>(
  (event, { members }) => {
    grantSpaceAccess(members, event.principal, "WRITE");
    members.addUnique(event.principal);
  },
);

const revoke = handler<MemberEvent, { members: Writable<DID[]> }>(
  (event, { members }) => {
    revokeSpaceAccess(members, event.principal);
    members.removeByValue(event.principal);
  },
);

interface OverlayInput {
  members: Writable<Default<DID[], []>>;
}

interface OverlayOutput {
  [NAME]: string;
  [UI]: VNode;
  panels: Writable<Panel>[];
  viewerPanels: Writable<Panel>[];
  addPanel: Stream<PanelAdmission>;
  hidePanel: Stream<{ panel: Writable<Panel> }>;

  /** Grants `principal` WRITE in the Loom's space, as a trusted gesture. */
  grant: Stream<MemberEvent>;

  /** Revokes `principal`'s access to the Loom's space, as a trusted gesture. */
  revoke: Stream<MemberEvent>;
}

export default pattern<OverlayInput, OverlayOutput>(({ members }) => {
  const loom = Loom({});
  return {
    [NAME]: "Loom overlay fixture",
    [UI]: <div />,
    panels: loom.panels,
    viewerPanels: loom.viewerPanels,
    addPanel: loom.addPanel,
    hidePanel: loom.hidePanel,
    grant: grant({ members }),
    revoke: revoke({ members }),
  };
});
