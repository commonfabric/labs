export const PENDING_RENDER_ATTRIBUTE = "data-cf-pending";

interface AttributeElement extends Node {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface PendingAttributeSnapshot {
  readonly inert: string | null;
  readonly ariaBusy: string | null;
}

const pendingAttributeSnapshots = new WeakMap<
  AttributeElement,
  PendingAttributeSnapshot
>();

function isAttributeElement(node: Node | null): node is AttributeElement {
  return node !== null &&
    typeof (node as Partial<AttributeElement>).setAttribute === "function" &&
    typeof (node as Partial<AttributeElement>).getAttribute === "function" &&
    typeof (node as Partial<AttributeElement>).removeAttribute === "function";
}

function restoreAttribute(
  node: AttributeElement,
  name: string,
  value: string | null,
): void {
  if (value === null) {
    node.removeAttribute(name);
  } else {
    node.setAttribute(name, value);
  }
}

/**
 * Apply an authored update to an attribute temporarily owned by pending UI.
 *
 * While pending, `inert` and `aria-busy` must keep their safety values in the
 * live DOM. The authored value is nevertheless allowed to change and becomes
 * the value restored when pending ends.
 */
export function applyPendingRenderAuthoredAttributeUpdate(
  node: Node | null,
  name: string,
  update: () => void,
): void {
  if (
    !isAttributeElement(node) ||
    (name !== "inert" && name !== "aria-busy")
  ) {
    update();
    return;
  }

  const snapshot = pendingAttributeSnapshots.get(node);
  if (!snapshot) {
    update();
    return;
  }

  restoreAttribute(node, "inert", snapshot.inert);
  restoreAttribute(node, "aria-busy", snapshot.ariaBusy);
  try {
    update();
  } finally {
    pendingAttributeSnapshots.set(node, {
      inert: node.getAttribute("inert") ?? null,
      ariaBusy: node.getAttribute("aria-busy") ?? null,
    });
    node.setAttribute("inert", "");
    node.setAttribute("aria-busy", "true");
  }
}

/**
 * Mark retained content as stale while its replacement is pending.
 *
 * `inert` blocks pointer and focus interaction. `aria-busy` tells assistive
 * technology that the retained subtree is not the current result.
 */
export function setPendingRenderState(
  node: Node | null,
  pending: boolean,
): void {
  if (!isAttributeElement(node)) return;

  if (pending) {
    if (!pendingAttributeSnapshots.has(node)) {
      pendingAttributeSnapshots.set(node, {
        inert: node.getAttribute("inert") ?? null,
        ariaBusy: node.getAttribute("aria-busy") ?? null,
      });
    }
    node.setAttribute(PENDING_RENDER_ATTRIBUTE, "true");
    node.setAttribute("inert", "");
    node.setAttribute("aria-busy", "true");
  } else {
    node.removeAttribute(PENDING_RENDER_ATTRIBUTE);
    const snapshot = pendingAttributeSnapshots.get(node);
    if (snapshot) {
      restoreAttribute(node, "inert", snapshot.inert);
      restoreAttribute(node, "aria-busy", snapshot.ariaBusy);
      pendingAttributeSnapshots.delete(node);
    }
  }
}
