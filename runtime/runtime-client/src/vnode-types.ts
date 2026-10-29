/**
 * These are our render types from `api` for use alongside `RuntimeClient`,
 * replacing instances of `Cell` with `CellHandle` for `Props`, `VNode`,
 * and `RenderNode`.
 */

import { UI } from "@commonfabric/runner/shared";
import { CellHandle } from "./cell-handle.ts";

export type Props = {
  [key: string]:
    | string
    | number
    | boolean
    | object
    | Array<any>
    | null
    | undefined
    | CellHandle<any>;
};

export type RenderNode =
  | InnerRenderNode
  | CellHandle<InnerRenderNode>
  | Array<RenderNode>;

export type InnerRenderNode =
  | VNode
  | string
  | number
  | boolean
  | undefined;

export type VNode = {
  type: "vnode";
  name: string;
  props: Props | undefined;
  children?: RenderNode | undefined;
  [UI]?: VNode;
};
