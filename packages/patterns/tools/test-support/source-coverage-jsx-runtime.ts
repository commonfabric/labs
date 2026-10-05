export type VNode = {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
};

export const Fragment = Symbol("Fragment");

function normalizeChildren(props: Record<string, unknown>): unknown[] {
  const children = props.children;
  if (children === undefined) return [];
  return Array.isArray(children) ? children : [children];
}

export function jsx(
  type: string | ((props: Record<string, unknown>) => unknown),
  props: Record<string, unknown> | null,
): unknown {
  const nextProps = props ?? {};
  if (typeof type === "function") {
    return type(nextProps);
  }
  return { type, props: nextProps, children: normalizeChildren(nextProps) };
}

export const jsxs = jsx;
