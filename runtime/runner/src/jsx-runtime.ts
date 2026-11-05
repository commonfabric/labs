/**
 * JSX automatic runtime for @commonfabric/runner
 *
 * This module provides the JSX runtime implementation compatible with
 * TypeScript's "jsx": "react-jsx" configuration.
 *
 * @module jsx-runtime
 */

import type { JSXElement, RenderNode, VNode } from "@commonfabric/api";

import { h } from "./builder/h.ts";

/**
 * Props type for JSX elements, including children
 */
export interface JSXProps {
  children?: RenderNode | RenderNode[];
  key?: string | number;
  [prop: string]: any;
}

/**
 * Creates a JSX element.
 *
 * This is the core function used by the JSX automatic runtime for creating elements.
 * It handles both HTML/SVG elements (string types) and component functions.
 *
 * @param type - The element type (string for HTML/SVG, function for components)
 * @param props - Element properties including children
 * @param key - Optional key for list reconciliation (currently unused but part of JSX spec)
 * @returns A virtual DOM node or JSX element (for component functions)
 */
export function jsx(
  type: string | ((props: any) => JSXElement),
  props: JSXProps | null,
  _key?: string | number,
): JSXElement {
  const { children, ...restProps } = props ?? {};

  // Convert children to array format expected by h()
  const childArray = children === undefined
    ? []
    : Array.isArray(children)
    ? children
    : [children];

  return h(type, restProps, ...childArray);
}

/**
 * Creates a JSX element with static children.
 *
 * The TypeScript compiler uses this when it can determine that children are static.
 * For our implementation, it's identical to jsx() since we don't optimize for static children.
 *
 * @param type - The element type (string for HTML/SVG, function for components)
 * @param props - Element properties including children
 * @param key - Optional key for list reconciliation
 * @returns A virtual DOM node or JSX element
 */
export const jsxs = jsx;

/**
 * Fragment component for grouping elements without adding DOM nodes.
 *
 * Used when you write <></> or <React.Fragment> in JSX.
 * Renders as a "cf-fragment" element in the virtual DOM.
 */
export const Fragment = h.fragment;

// Type exports
export type { RenderNode, VNode };
