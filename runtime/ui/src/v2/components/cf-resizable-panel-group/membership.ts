/**
 * @fileoverview Which cf-resizable-panel-group a panel or handle belongs to.
 *
 * A cf-resizable-panel or cf-resizable-handle is a member of the nearest
 * cf-resizable-panel-group above it, whatever elements stand between them,
 * such as the `display: contents` wrapper a renderer puts around an array of
 * children. A group nested in a panel is the nearest group of the panels and
 * handles inside it, so each group has exactly its own members and none of a
 * nested group's.
 *
 * A member tells its group when it joins, when its sizes or visibility
 * change, and when it leaves; the group never searches its subtree for them.
 * The one search is a group's own, when it connects, for members that
 * connected before the group's element was upgraded and so had no group to
 * tell.
 */

/** The element name of a panel group. */
export const PANEL_GROUP_TAG = "cf-resizable-panel-group";

/** What a panel group hears from its members, and tells them. */
export interface PanelGroupMembers {
  /** The direction the panels lie in now. */
  readonly orientation: "horizontal" | "vertical";
  /** `member` joined the group. */
  memberJoined(member: HTMLElement): void;
  /** `member` left the group; it may already be out of the document. */
  memberLeft(member: HTMLElement): void;
  /** A panel's minimum, default or maximum size changed. */
  panelSizesChanged(panel: HTMLElement): void;
  /** A panel's `hideWhenStacked` changed. */
  panelShownChanged(panel: HTMLElement): void;
  /** A handle asked, from the keyboard, to move by `delta` points. */
  handleAdjusted(handle: HTMLElement, delta: number): void;
}

/** The group each member has joined. */
const groups = new WeakMap<HTMLElement, PanelGroupMembers>();

/** Whether `element` is an instance of the class defined for its name, which
 * runs its lifecycle callbacks. */
export function isUpgraded(element: Element): boolean {
  return customElements.get(element.localName)?.prototype.isPrototypeOf(
    element,
  ) ?? false;
}

/** The nearest panel group element above `member`, upgraded or not. */
export function owningGroupElement(member: Element): Element | null {
  return member.parentElement?.closest(PANEL_GROUP_TAG) ?? null;
}

function isPanelGroup(
  element: Element | null,
): element is Element & PanelGroupMembers {
  return typeof (element as Partial<PanelGroupMembers> | null)
    ?.memberJoined === "function";
}

/** Joins `member` to `group`, leaving any group it was in. */
export function adopt(member: HTMLElement, group: PanelGroupMembers): void {
  const current = groups.get(member);
  if (current === group) return;
  if (current) leaveGroup(member);
  groups.set(member, group);
  group.memberJoined(member);
}

/** Joins `member` to its nearest group, once that group is upgraded; a group
 * upgraded later adopts it then. */
export function joinGroup(member: HTMLElement): void {
  const group = owningGroupElement(member);
  if (isPanelGroup(group)) adopt(member, group);
}

/** Takes `member` out of the group it joined, if any. */
export function leaveGroup(member: HTMLElement): void {
  const group = groups.get(member);
  if (!group) return;
  groups.delete(member);
  group.memberLeft(member);
}

/** The group `member` has joined, if any. */
export function groupOf(member: HTMLElement): PanelGroupMembers | undefined {
  return groups.get(member);
}
