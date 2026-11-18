/**
 * A `{ press }` test step: a click on a control a pattern renders, made the way
 * a browser makes it. The step's view is rendered through the same reconciler
 * and DOM applicator a browser uses, into a mock document, and the click is
 * dispatched on the rendered control. The applicator's listener reports it, and
 * the reconciler hands it to the handler it bound there, so the event reaches
 * the control's stream from this runtime, with the gesture provenance the
 * control's rendered markers give it.
 *
 * That is what lets a test press a control whose handler exists only in the
 * view, such as one bound per row of a list, whatever runs the test's actions:
 * the control is found in this runtime's rendering, as a person finds it on
 * the page.
 */

import { renderInProcess } from "@commonfabric/html/in-process";
import { MockDoc } from "@commonfabric/html/mock-doc";
import type { Cell } from "@commonfabric/runner";

/** A modifier key a `{ press }` step can hold down during its click. */
export type PressModifier = "alt" | "ctrl" | "meta" | "shift";

/** The modifier keys a press step names, each with the event flag it sets. */
const MODIFIER_FLAGS: Readonly<Record<PressModifier, string>> = {
  alt: "altKey",
  ctrl: "ctrlKey",
  meta: "metaKey",
  shift: "shiftKey",
};

const isPressModifier = (value: unknown): value is PressModifier =>
  typeof value === "string" && Object.hasOwn(MODIFIER_FLAGS, value);

/** Which rendered control a `{ press }` step presses, and how. */
export interface PressTarget {
  /** The text the control shows, trimmed. */
  control: string;

  /**
   * Text an element around the control shows, for a view showing the
   * control's text more than once, such as a row of a list: the control
   * pressed is the one whose nearest enclosing element showing this text
   * holds no other control showing `control`.
   */
  within?: string;

  /**
   * The keys held down during the click, such as `["meta"]` for a Cmd-click
   * on a Mac. The click sets the event's `altKey`, `ctrlKey`, `metaKey` and
   * `shiftKey` from it, each false when its key is not named.
   */
  modifiers?: PressModifier[];
}

/**
 * The control a step names, from the step's `control` and `within`, and the
 * keys its `modifiers` hold.
 *
 * @throws If `control` is not a string, `within` is neither absent nor a
 *   string, or `modifiers` is neither absent nor a list of modifier names,
 *   naming the step by its index.
 */
export function pressTargetOf(
  step: { control?: unknown; within?: unknown; modifiers?: unknown },
  index: number,
): PressTarget {
  if (typeof step.control !== "string") {
    throw new Error(
      `Test step at index ${index} presses a control but names none in ` +
        "`control`",
    );
  }
  if (step.within !== undefined && typeof step.within !== "string") {
    throw new Error(
      `Test step at index ${index} has a \`within\` that is not a string`,
    );
  }
  const modifiers = step.modifiers;
  if (
    modifiers !== undefined &&
    !(Array.isArray(modifiers) && modifiers.every(isPressModifier))
  ) {
    throw new Error(
      `Test step at index ${index} has \`modifiers\` that are not a list of ` +
        `${Object.keys(MODIFIER_FLAGS).map((key) => `"${key}"`).join(", ")}`,
    );
  }
  return {
    control: step.control,
    ...(step.within === undefined ? {} : { within: step.within }),
    ...(modifiers === undefined ? {} : { modifiers: [...modifiers] }),
  };
}

/** A node of the mock document, as far as finding a control needs. */
interface RenderedNode {
  type?: string;
  data?: string;
  parent?: RenderedNode | null;
  children?: RenderedNode[];
  dispatchEvent?: (event: unknown) => void;
}

/** The text `node` shows: every text node beneath it, in order. */
const textOf = (node: RenderedNode): string =>
  node.type === "text"
    ? node.data ?? ""
    : (node.children ?? []).map(textOf).join("");

/** The elements beneath `root`, in document order. */
const elementsUnder = (root: RenderedNode): RenderedNode[] =>
  (root.children ?? []).flatMap((child) =>
    child.type === "tag" ? [child, ...elementsUnder(child)] : []
  );

/** `node` and the elements above it, from `node` up. */
const pathFrom = (node: RenderedNode): RenderedNode[] => {
  const path: RenderedNode[] = [];
  for (let at: RenderedNode | null | undefined = node; at; at = at.parent) {
    path.push(at);
  }
  return path;
};

/**
 * The one control under `root` that `target` names. A control is an element
 * whose text, trimmed, is `target.control`, and which holds no element of its
 * own whose text is that.
 *
 * @throws If no control, or more than one, answers to `target`.
 */
export function findPressTarget(
  root: RenderedNode,
  target: PressTarget,
): RenderedNode {
  const shows = (node: RenderedNode): boolean =>
    textOf(node).trim() === target.control;
  const controls = elementsUnder(root).filter((node) =>
    shows(node) && !elementsUnder(node).some(shows)
  );
  const within = target.within;
  const found = within === undefined ? controls : controls.filter(
    (control) => {
      const around = pathFrom(control).slice(1).find((node) =>
        textOf(node).includes(within)
      );
      return around !== undefined &&
        controls.filter((other) => pathFrom(other).includes(around))
            .length === 1;
    },
  );
  if (found.length !== 1) {
    const where = within === undefined ? "" : ` within "${within}"`;
    throw new Error(
      `A press step found ${found.length} controls showing ` +
        `"${target.control}"${where}; it presses exactly one.`,
    );
  }
  return found[0];
}

/**
 * Renders `vdomCell` as a browser does, waits for `settle`, and clicks the
 * control `target` names, so that its handler receives the click as a
 * person's.
 *
 * @throws If the view fails to render, or `target` names no single control.
 */
export async function pressRenderedControl(
  vdomCell: Cell<unknown>,
  target: PressTarget,
  settle: () => Promise<void>,
): Promise<void> {
  const { document, renderOptions } = new MockDoc(
    "<!DOCTYPE html><html><body></body></html>",
  );
  const container = document.createElement("div");
  const errors: Error[] = [];
  const failIfErrored = (what: string) => {
    if (errors.length > 0) {
      throw new Error(`A press step's ${what} failed: ${errors[0].message}`, {
        cause: errors[0],
      });
    }
  };
  const render = renderInProcess(container, vdomCell, {
    document,
    setProp: renderOptions.setProp,
    onError: (error) => errors.push(error),
    dispatchEvents: true,
  });
  try {
    await settle();
    render.flush();
    failIfErrored("view");
    const control = findPressTarget(
      container as unknown as RenderedNode,
      target,
    );
    // The click a person makes: trusted, aimed at the control, holding the
    // keys the step names, and seen by every node on its way up, as it
    // bubbles there.
    const path = pathFrom(control);
    const held = new Set(target.modifiers);
    const click = {
      type: "click",
      isTrusted: true,
      target: control,
      composedPath: () => path,
      ...Object.fromEntries(
        Object.entries(MODIFIER_FLAGS).map(([key, flag]) => [
          flag,
          held.has(key as PressModifier),
        ]),
      ),
    };
    for (const node of path) node.dispatchEvent?.(click);
    // A handler that throws on the click is reported here, as a render error.
    failIfErrored("click");
  } finally {
    render.cancel();
  }
}
