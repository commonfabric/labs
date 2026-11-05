/**
 * Reads a Loom's `[VIEWS].menu` as a host's menu does, so a test can find and
 * run an action by the label a person would tap.
 */
import type { LoomMenu, LoomMenuSection } from "./schemas.tsx";

/** The heading of the section that offers to show hidden panels again. */
const HIDDEN = "Hidden for you";

/**
 * The menu's sections about one shown panel each, in the order the panels are
 * shown. A Loom showing one panel has none: its actions are the Loom's own.
 */
export function panelSections(menu: LoomMenu): LoomMenuSection[] {
  return menu.sections.filter((section) =>
    section.heading !== undefined && section.heading !== HIDDEN
  );
}

/** The labels of every action the menu offers, section by section. */
export function menuLabels(menu: LoomMenu): string[] {
  return menu.sections.flatMap((section) =>
    section.actions.map((action) => action.label)
  );
}

/** The action labeled `label` in `section`; throws when it offers none. */
function actionIn(section: LoomMenuSection | undefined, label: string) {
  const action = section?.actions.find((entry) => entry.label === label);
  if (action === undefined) {
    throw new Error(`The menu offers no "${label}" here`);
  }
  return action.run;
}

/** Runs the Loom's own action labeled `label`: its first, unheaded section. */
export function runLoomAction(menu: LoomMenu, label: string): void {
  actionIn(
    menu.sections.find((section) => section.heading === undefined),
    label,
  ).send();
}

/**
 * Runs `label` on the `place`th shown panel, counting from 0. A Loom showing
 * one panel offers that panel's actions as its own.
 */
export function runPanelAction(
  menu: LoomMenu,
  place: number,
  label: string,
): void {
  const sections = panelSections(menu);
  actionIn(
    sections.length === 0 && place === 0
      ? menu.sections.find((section) => section.heading === undefined)
      : sections[place],
    label,
  ).send();
}

/** Runs the first action offering to show a hidden panel again. */
export function runShowHidden(menu: LoomMenu): void {
  const section = menu.sections.find((entry) => entry.heading === HIDDEN);
  const action = section?.actions[0];
  if (action === undefined) throw new Error("The menu shows nothing hidden");
  action.run.send();
}
