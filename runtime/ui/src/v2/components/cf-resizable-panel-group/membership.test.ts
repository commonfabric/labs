// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFResizablePanel } from "../cf-resizable-panel/index.ts";
import {
  adopt,
  groupOf,
  isUpgraded,
  leaveGroup,
  type PanelGroupMembers,
} from "./membership.ts";

/** A group that records which members join and leave it. */
function recordingGroup(log: string[], name: string): PanelGroupMembers {
  return {
    orientation: "horizontal",
    memberJoined: () => log.push(`${name} joined`),
    memberLeft: () => log.push(`${name} left`),
    panelSizesChanged: () => {},
    panelShownChanged: () => {},
    handleAdjusted: () => {},
  };
}

describe("membership", () => {
  afterEach(() => document.body.replaceChildren());

  it("adopts a member into a group once, however often it is adopted there", async () => {
    const panel = await mount(new CFResizablePanel());
    const log: string[] = [];
    const group = recordingGroup(log, "a");
    adopt(panel, group);
    adopt(panel, group);
    expect(log).toEqual(["a joined"]);
    expect(groupOf(panel)).toBe(group);
  });

  it("takes a member out of its group before adopting it into another", async () => {
    const panel = await mount(new CFResizablePanel());
    const log: string[] = [];
    const a = recordingGroup(log, "a");
    const b = recordingGroup(log, "b");
    adopt(panel, a);
    adopt(panel, b);
    expect(log).toEqual(["a joined", "a left", "b joined"]);
    expect(groupOf(panel)).toBe(b);
    leaveGroup(panel);
    expect(groupOf(panel)).toBe(undefined);
  });

  it("tells an upgraded element from one whose name has no class", () => {
    expect(isUpgraded(new CFResizablePanel())).toBe(true);
    expect(isUpgraded(document.createElement("x-never-defined"))).toBe(false);
  });
});
