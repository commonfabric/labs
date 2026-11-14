import { UI } from "commonfabric";

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

export const readValue = (value: unknown): unknown => {
  if (!isRecord(value) || typeof value.get !== "function") {
    return value;
  }
  return (value.get as () => unknown)();
};

export const propsOf = (
  node: unknown,
): Record<PropertyKey, unknown> | undefined => {
  const value = readValue(node);
  if (!isRecord(value)) return undefined;
  const props = readValue(value.props);
  return isRecord(props) ? props : undefined;
};

export const propValue = (node: unknown, prop: string): unknown => {
  const props = propsOf(node);
  return props ? readValue(props[prop]) : undefined;
};

const childrenArray = (children: unknown): unknown[] => {
  const value = readValue(children);
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || typeof value === "boolean"
    ? []
    : [value];
};

export const childNodes = (node: unknown): unknown[] => {
  const value = readValue(node);
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const ui = value[UI];
  return [
    ...(ui === undefined || ui === value ? [] : [ui]),
    ...childrenArray(value.children),
  ];
};

export const textContent = (node: unknown): string => {
  const value = readValue(node);
  if (value === undefined || value === null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textContent).join("");
  }
  if (!isRecord(value)) return "";
  return childNodes(value).map(textContent).join("");
};

export const hasText = (node: unknown, expected: string): boolean =>
  textContent(node).includes(expected);

export const hasExactText = (node: unknown, expected: string): boolean =>
  textContent(node).trim() === expected;

/** Whether the text under `root` carries every string in `present` and none
 * in `absent`, read in one walk of the tree. */
export const viewShows = (
  root: unknown,
  present: readonly string[],
  absent: readonly string[] = [],
): boolean => {
  const text = textContent(root);
  return present.every((part) => text.includes(part)) &&
    absent.every((part) => !text.includes(part));
};

export const findNode = (
  root: unknown,
  predicate: (node: unknown) => boolean,
): unknown | undefined => {
  const value = readValue(root);
  if (predicate(value)) return value;
  return childNodes(value)
    .map((child) => findNode(child, predicate))
    .find((child) => child !== undefined);
};

/** How many elements named `name` sit under `root`, counting nested ones. */
export const countElements = (root: unknown, name: string): number => {
  const value = readValue(root);
  const self = isElement(value, name) ? 1 : 0;
  return childNodes(value).reduce<number>(
    (sum, child) => sum + countElements(child, name),
    self,
  );
};

export const findNodeByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined =>
  findNode(root, (node) => {
    const props = propsOf(node);
    return props !== undefined && readValue(props[prop]) === expected;
  });

export const findNodeById = (
  root: unknown,
  id: string,
): unknown | undefined => findNodeByProp(root, "id", id);

export const findNodeByText = (
  root: unknown,
  expected: string,
): unknown | undefined => findNode(root, (node) => hasText(node, expected));

/** Whether `node` is an element with the tag name `name`. */
export const isElement = (node: unknown, name: string): boolean => {
  const value = readValue(node);
  return isRecord(value) && readValue(value.name) === name;
};

/** One resolved entry of a node's `style` prop, or `undefined` without one. */
export const styleOf = (node: unknown, key: string): unknown => {
  const style = propValue(node, "style");
  return isRecord(style) ? readValue(style[key]) : undefined;
};

/**
 * Writes `value` through the cell a node binds under `prop` (`$value`,
 * `$checked`, `$selectedIndex`, …), as the control does when a person edits
 * it. Throws when the node binds no cell there.
 */
export const setBound = (
  node: unknown,
  prop: string,
  value: unknown,
  what = "the node",
): void => {
  if (node === undefined) throw new Error(`setBound: ${what} was not found`);
  const bound = propsOf(node)?.[prop];
  if (!isRecord(bound) || typeof bound.set !== "function") {
    throw new Error(`setBound: ${what} binds no ${prop}`);
  }
  (bound.set as (value: unknown) => void)(value);
};

export const findElement = (
  root: unknown,
  name: string,
): unknown | undefined => findNode(root, (node) => isElement(node, name));

export const findElementByText = (
  root: unknown,
  name: string,
  expected: string,
): unknown | undefined =>
  findNode(root, (node) => isElement(node, name) && hasText(node, expected));

export const findElementByExactText = (
  root: unknown,
  name: string,
  expected: string,
): unknown | undefined =>
  findNode(
    root,
    (node) => isElement(node, name) && hasExactText(node, expected),
  );

/** Whether `node` is a clickable control whose whole text is `label`. */
export const isButton = (label: string) => (node: unknown): boolean =>
  propsOf(node)?.onClick !== undefined && hasExactText(node, label);

/** The innermost node `accept` admits: the row itself rather than every
 * container that also carries the row's text. */
export const innermostNode = (
  node: unknown,
  accept: (node: unknown) => boolean,
): unknown => {
  for (const child of childNodes(node)) {
    const hit = innermostNode(child, accept);
    if (hit !== undefined) return hit;
  }
  return accept(node) ? node : undefined;
};

/** Fires the event handler a node binds under `prop` (`onClick`,
 * `oncf-submit`, …), sending it `event`. A handler bound only in JSX is
 * reached through the rendered tree. Throws when there is no node or it binds
 * nothing under `prop`, so a mistyped label fails the test rather than
 * passing as a control that did nothing. */
export const fireEvent = (
  node: unknown,
  prop: string,
  event: unknown,
  what = "the node",
): void => {
  if (node === undefined) throw new Error(`fireEvent: ${what} was not found`);
  const handler = propsOf(node)?.[prop];
  if (!isRecord(handler) || typeof handler.send !== "function") {
    throw new Error(`fireEvent: ${what} has no ${prop} to fire`);
  }
  (handler.send as (event: unknown) => void)(event);
};

/** Fires a node's `onClick` the way a click does, with an empty event. */
export const fireClick = (node: unknown, what = "the node"): void =>
  fireEvent(node, "onClick", {}, what);

/** Clicks the one button labelled `label` under `root`. */
export const clickButton = (root: unknown, label: string): void =>
  fireClick(findNode(root, isButton(label)), `a button labelled "${label}"`);

/** Clicks the button labelled `label` in the row whose text carries
 * `rowText`: the innermost node holding both the text and such a button. */
export const clickInRow = (
  root: unknown,
  rowText: string,
  label: string,
): void => {
  const row = innermostNode(
    root,
    (node) =>
      hasText(node, rowText) && findNode(node, isButton(label)) !== undefined,
  );
  fireClick(
    findNode(row, isButton(label)),
    `a button labelled "${label}" in the row "${rowText}"`,
  );
};

/** Sends `message` from the first `cf-message-input` under `root`, firing its
 * `oncf-send` with the message in the event's `detail` as the component does
 * when a person submits it. */
export const sendMessage = (
  root: unknown,
  message: string,
  what = "the message input",
): void =>
  fireEvent(
    findElement(root, "cf-message-input"),
    "oncf-send",
    { detail: { message } },
    what,
  );
