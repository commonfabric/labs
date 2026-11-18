import type {
  HFunction,
  JSXElement,
  RenderNode,
  UiActionProps,
  UiDisclosureProps,
  UiPromptSlotProps,
  VNode,
} from "@commonfabric/api";
import { isPlainObject } from "@commonfabric/js-values/types";

import { asBoundCell, type Cell } from "../cell.ts";
import { KeepAsCell } from "../link-utils.ts";

/**
 * Fragment element name used for JSX fragments.
 */
const FRAGMENT_ELEMENT = "cf-fragment";

const isDeferredLinkContextError = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.startsWith("Cannot create cell link - ");

/**
 * Returns what a `$` prop binds `value`, which is `cell` or a query result read
 * from it, to: the cell's link, or `value` itself while the cell has no link
 * yet.
 */
function bindingTargetLink(cell: Cell<unknown>, value: unknown): unknown {
  try {
    return cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });
  } catch (error) {
    if (isDeferredLinkContextError(error)) return value;
    throw error;
  }
}

/**
 * Returns the fields of `value`, each with the cell it is, when `value` is a
 * record of cells: a plain object with at least one field, every one of which
 * is a cell. Returns `undefined` for anything else.
 */
function cellRecordFields(
  value: unknown,
): [name: string, cell: Cell<unknown>, member: unknown][] | undefined {
  if (!isPlainObject(value)) return undefined;
  const fields: [string, Cell<unknown>, unknown][] = [];
  for (const [name, member] of Object.entries(value)) {
    const cell = asBoundCell(member);
    if (cell === undefined) return undefined;
    fields.push([name, cell, member]);
  }
  return fields.length > 0 ? fields : undefined;
}

/**
 * JSX factory function for creating virtual DOM nodes.
 *
 * A `$` prop binds what it is given, so its value is a cell, or a record of
 * them: a plain object every field of which is a cell, which the component
 * reaches field by field. Anything else is refused, including a record with
 * a field that is not a cell, since the binding would have nothing live to
 * hand over for that field and nothing to write to.
 *
 * @param name - The element name or component function
 * @param props - Element properties
 * @param children - Child elements
 * @returns A virtual DOM node or JSX element (for component functions)
 */
export const h: HFunction = Object.assign(
  function h(
    name: string | ((...args: any[]) => JSXElement),
    props: { [key: string]: any } | null,
    ...children: RenderNode[]
  ): JSXElement {
    // Implementation uses broader types than overloads - assertion needed for
    // TS compatibility.
    if (typeof name === "function") {
      return name({
        ...(props ?? {}),
        children: children.flat(),
      });
    } else {
      props ??= {};
      Object.keys(props).filter((key) => key.startsWith("$")).forEach((key) => {
        const value = props![key];
        if (typeof value !== "object") {
          throw new Error(
            `Bidirectionally bound property ${key} is not reactive\n` +
              "If invoking from within computed(), consider moving the component into a pattern: E.g.\n" +
              "```\n" +
              (key === "$checked"
                ? "const Item = pattern<{ item: Item }>(({item}) => <div><cf-checkbox $checked={item.checked} />{item.title}</div>);"
                : "const Item = pattern<{ item: Item }>(({item}) => <div><cf-input $value={item.value} />{item.title}</div>);") +
              "\n```" +
              "\n" +
              "And then using it like `<Item {item} />`",
          );
        }
        const cell = asBoundCell(value);
        if (cell !== undefined) {
          props![key] = bindingTargetLink(cell, value);
          return;
        }
        const fields = cellRecordFields(value);
        if (fields === undefined) {
          throw new Error(
            `Bidirectionally bound property ${key} is not reactive\n` +
              "Use pattern parameter or create a cell using new Writable()",
          );
        }
        props![key] = Object.fromEntries(
          fields.map(([name, field, member]) => [
            name,
            bindingTargetLink(field, member),
          ]),
        );
      });
      return { type: "vnode", name, props, children: children.flat() };
    }
  },
  {
    fragment({ children }: { children: RenderNode[] }): VNode {
      return h(FRAGMENT_ELEMENT, null, ...children);
    },
  },
) as HFunction;

function toChildArray(
  children: RenderNode | RenderNode[] | undefined,
): RenderNode[] {
  if (children === undefined || children === null) {
    return [];
  }
  return Array.isArray(children) ? children.flat() : [children];
}

function createUiHelper<
  Props extends {
    readonly as?: string;
    readonly children?: RenderNode;
  },
>(
  defaultTag: string,
  dataAttrs: readonly [string, string][],
  helperOnlyProps: readonly string[],
) {
  return (props: Props): JSXElement => {
    const { as, children, ...rest } = props as Props & Record<string, unknown>;
    const attrs: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(rest)) {
      if (!helperOnlyProps.includes(key)) {
        attrs[key] = value;
      }
    }

    for (const [prop, attr] of dataAttrs) {
      const value = (rest as Record<string, unknown>)[prop];
      if (value !== undefined) {
        attrs[attr] = value;
      }
    }

    return h(as ?? defaultTag, attrs, ...toChildArray(children));
  };
}

export const UiAction = createUiHelper(
  "ct-button",
  [["action", "data-ui-action"]],
  ["as", "action"],
) as (props: UiActionProps) => JSXElement;

export const UiPromptSlot = createUiHelper(
  "ct-textarea",
  [
    ["surface", "data-ui-surface"],
    ["role", "data-ui-role"],
  ],
  ["as", "surface", "role"],
) as (props: UiPromptSlotProps) => JSXElement;

export const UiDisclosure = createUiHelper(
  "ct-card",
  [["kind", "data-ui-disclosure-kind"]],
  ["as", "kind"],
) as (props: UiDisclosureProps) => JSXElement;
