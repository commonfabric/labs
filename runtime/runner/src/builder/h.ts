import {
  type HFunction,
  type JSXElement,
  type RenderNode,
  type UiActionProps,
  type UiDisclosureProps,
  type UiPromptSlotProps,
  type VNode,
} from "@commonfabric/api";

import { isCell } from "../cell.ts";
import { KeepAsCell } from "../link-utils.ts";
import { getCellOrThrow, isCellResult } from "../query-result-proxy.ts";

/**
 * Fragment element name used for JSX fragments.
 */
const FRAGMENT_ELEMENT = "cf-fragment";

type LinkableCell = {
  getAsLink(options?: unknown): unknown;
};

const isDeferredLinkContextError = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.startsWith("Cannot create cell link - ");

function bindingTargetLink(value: unknown): unknown {
  if (isCell(value)) {
    try {
      return (value as unknown as LinkableCell).getAsLink({
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      });
    } catch (error) {
      if (isDeferredLinkContextError(error)) return value;
      throw error;
    }
  }
  if (isCellResult(value)) {
    try {
      return (getCellOrThrow(value) as unknown as LinkableCell).getAsLink({
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      });
    } catch (error) {
      if (isDeferredLinkContextError(error)) return value;
      throw error;
    }
  }
  return value;
}

/**
 * JSX factory function for creating virtual DOM nodes.
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
        } else if (!isCell(value) && !isCellResult(value)) {
          throw new Error(
            `Bidirectionally bound property ${key} is not reactive\n` +
              "Use pattern parameter or create a cell using new Writable()",
          );
        }
        props![key] = bindingTargetLink(value);
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
