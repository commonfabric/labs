/**
 * JSX development runtime for @commonfabric/runner
 *
 * This module provides the JSX development runtime implementation compatible with
 * TypeScript's "jsx": "react-jsxdev" configuration.
 *
 * The development runtime includes additional debugging information like source
 * file paths and line numbers, though our current implementation doesn't use these yet.
 *
 * @module jsx-dev-runtime
 */

import type { JSXElement, RenderNode, VNode } from "@commonfabric/api";

import { h } from "./builder/h.ts";

/**
 * Props type for JSX elements in development mode, including children and debug info
 */
export interface JSXDevProps {
  children?: RenderNode | RenderNode[];
  key?: string | number;
  [prop: string]: any;
}

/**
 * Source location information for debugging
 */
export interface Source {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
}

/**
 * Creates a VNode for a JSX element with development-time debugging information.
 *
 * This function is used by the JSX automatic runtime in development mode.
 * It accepts additional parameters for debugging (__source, __self) which can be
 * used to provide better error messages and developer experience.
 *
 * @param type - The element type (string for HTML/SVG, function for components)
 * @param props - Element properties including children
 * @param key - Optional key for list reconciliation
 * @param isStaticChildren - Whether children are static (unused in our implementation)
 * @param __source - Source location information for debugging
 * @param __self - Reference to the component instance (unused in our implementation)
 * @returns A virtual DOM node
 */
export function jsxDEV(
  type: string | ((props: any) => JSXElement),
  props: JSXDevProps | null,
  _key?: string | number,
  _isStaticChildren?: boolean,
  __source?: Source,
  __self?: any,
): JSXElement {
  const { children, ...restProps } = props ?? {};

  // Convert children to array format expected by h()
  const childArray = children === undefined
    ? []
    : Array.isArray(children)
    ? children
    : [children];

  // In the future, we could use __source to provide better error messages
  // or enhance debugging capabilities. For now, we just create the VNode.
  return h(type, restProps, ...childArray);
}

/**
 * Fragment component for grouping elements without adding DOM nodes.
 *
 * Used when you write <></> or <React.Fragment> in JSX.
 * Renders as a "cf-fragment" element in the virtual DOM.
 */
export const Fragment = h.fragment;

// Type exports
export type { RenderNode, VNode };
