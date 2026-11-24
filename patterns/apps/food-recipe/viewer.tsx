/**
 * Cooking View — a recipe laid out for the stove: ingredients, then each step
 * group with when it happens, how long it takes, how long it can wait and what
 * the oven needs, and a checkbox on every step. Checking a group checks all its
 * steps; a group is done when all its steps are.
 *
 * `food-recipe.tsx` opens it with the recipe's own cells, so edits to the
 * recipe show here. Progress is kept per step as "groupId#index" in the
 * `done` cell the recipe passes in, so it survives a reload; "Start over" clears it. The
 * recipe editor remaps it when it moves or deletes a step.
 *
 * Ported from jkomoros/community-patterns (`food-recipe-viewer.tsx`). The
 * original copied the recipe when the view was opened and stored group
 * completion separately from step completion; a group's completion is now
 * derived from its steps, so the two cannot disagree.
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  type PerSpace,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { Ingredient, StepGroup } from "./schemas.tsx";
import { formatTiming, ingredientLine } from "./recipe-logic.ts";

export const stepKey = (groupId: string, index: number): string =>
  `${groupId}#${index}`;

interface StepView {
  key: string;
  number: string;
  text: string;
  done: boolean;
}

interface GroupView {
  id: string;
  name: string;
  details: string;
  done: boolean;
  steps: StepView[];
}

/** Each group as the view shows it, with progress from `done`. */
export const groupViews = (
  groups: readonly StepGroup[],
  done: readonly string[],
): GroupView[] => {
  const checked = new Set(done);
  return groups.map((group) => {
    const steps = group.steps.map((step, i) => ({
      key: stepKey(group.id, i),
      number: `${i + 1}.`,
      text: step.description,
      done: checked.has(stepKey(group.id, i)),
    }));
    const details = [
      `⏱️ ${formatTiming(group)}`,
      group.duration ? `📏 ${group.duration} min` : "",
      group.maxWaitMinutes === undefined || group.maxWaitMinutes === null
        ? ""
        : group.maxWaitMinutes === 0
        ? "⏳ move straight on"
        : `⏳ can wait ${group.maxWaitMinutes} min`,
      group.oven
        ? `🔥 ${group.oven.temperature}°F for ${group.oven.duration} min`
        : "",
    ].filter(Boolean).join("  ·  ");
    return {
      id: group.id,
      name: group.name || "Untitled group",
      details,
      done: steps.length > 0 && steps.every((s) => s.done),
      steps,
    };
  });
};

/** `done` with the step toggled. */
export const withStepToggled = (
  done: readonly string[],
  key: string,
): string[] =>
  done.includes(key) ? done.filter((k) => k !== key) : [...done, key];

/** `done` with every step of `group` checked, or all cleared if they were. */
export const withGroupToggled = (
  done: readonly string[],
  group: StepGroup,
): string[] => {
  const keys = group.steps.map((_, i) => stepKey(group.id, i));
  const allDone = keys.length > 0 && keys.every((k) => done.includes(k));
  const rest = done.filter((k) => !keys.includes(k));
  return allDone ? rest : [...rest, ...keys];
};

// Progress names a step by its place in its group, so the recipe editor
// moves the checkmarks with the steps when it reorders or deletes them.

/** `done` after step `step` of `groupId` swapped places with `step + delta`,
 * as `moved` does; unchanged when either is outside `stepCount`. */
export const progressAfterMove = (
  done: readonly string[],
  groupId: string,
  step: number,
  delta: number,
  stepCount: number,
): string[] => {
  const target = step + delta;
  if (step < 0 || step >= stepCount || target < 0 || target >= stepCount) {
    return [...done];
  }
  const from = stepKey(groupId, step);
  const to = stepKey(groupId, target);
  return done.map((k) => k === from ? to : k === to ? from : k);
};

/** `done` after step `step` of `groupId` was deleted: its mark goes and the
 * marks of later steps move up one. */
export const progressAfterRemove = (
  done: readonly string[],
  groupId: string,
  step: number,
): string[] => {
  const prefix = `${groupId}#`;
  return done.flatMap((k) => {
    if (!k.startsWith(prefix)) return [k];
    const i = Number(k.slice(prefix.length));
    if (i === step) return [];
    return [i > step ? stepKey(groupId, i - 1) : k];
  });
};

/** `done` without any mark on group `groupId`. */
export const progressWithoutGroup = (
  done: readonly string[],
  groupId: string,
): string[] => done.filter((k) => !k.startsWith(`${groupId}#`));

interface ViewerInput {
  recipeName?: string | Default<"">;
  servings?: number | Default<4>;
  ingredients?: Ingredient[] | Default<[]>;
  stepGroups?: StepGroup[] | Default<[]>;
  /** Checked steps, "groupId#index". */
  done?: PerSpace<Writable<string[] | Default<[]>>>;
}

export interface ViewerOutput {
  [NAME]: string;
  [UI]: VNode;
  done: string[];
  /** Steps checked, out of all steps. */
  stepsDone: number;
  stepsTotal: number;
  toggleStep: Stream<{ key: string }>;
  toggleGroup: Stream<{ groupId: string }>;
  reset: Stream<void>;
}

const styles = {
  heading: { margin: "0", fontSize: "20px" },
  sub: { margin: "4px 0", fontSize: "14px", color: "#666" },
  section: { margin: "0 0 8px 0", fontSize: "16px" },
  ingredient: {
    padding: "6px 0",
    fontSize: "14px",
    borderBottom: "1px solid #f0f0f0",
  },
  groupHeader: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    paddingBottom: "8px",
    borderBottom: "2px solid #e5e7eb",
  },
  groupName: { margin: "0 0 4px 0", fontSize: "16px", fontWeight: "600" },
  details: { fontSize: "13px", color: "#666" },
  step: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    padding: "8px 0",
    borderBottom: "1px solid #f0f0f0",
  },
  number: { fontWeight: "bold", color: "#999", minWidth: "24px" },
  empty: { margin: "8px 0", fontSize: "14px", color: "#999" },
} as const;

const Viewer = pattern<ViewerInput, ViewerOutput>(
  ({ recipeName, servings, ingredients, stepGroups, done }) => {
    const displayName = computed(() => recipeName.trim() || "Untitled Recipe");
    const groups = computed(() => groupViews(stepGroups, done.get()));
    const stepsTotal = computed(() =>
      stepGroups.reduce((n, g) => n + g.steps.length, 0)
    );
    const stepsDone = computed(() =>
      groups.reduce((n, g) => n + g.steps.filter((s) => s.done).length, 0)
    );
    const progress = computed(() =>
      `Cooking for ${servings} · ${stepsDone} of ${stepsTotal} steps done`
    );
    const ingredientLines = computed(() => ingredients.map(ingredientLine));
    const noIngredients = computed(() => ingredients.length === 0);
    const noGroups = computed(() => stepGroups.length === 0);

    const toggleStep = action(({ key }: { key: string }) => {
      done.set(withStepToggled(done.get(), key));
    });
    const toggleGroup = action(({ groupId }: { groupId: string }) => {
      const group = stepGroups.find((g) => g.id === groupId);
      if (group) done.set(withGroupToggled(done.get(), group));
    });
    const reset = action(() => done.set([]));

    return {
      [NAME]: computed(() => `👨‍🍳 ${displayName} · Cooking`),
      [UI]: (
        <cf-screen>
          <cf-vstack gap="2" style="padding: 12px; max-width: 800px;">
            <cf-hstack justify="between" align="center">
              <h1 style={styles.heading}>👨‍🍳 {displayName}</h1>
              <cf-button variant="secondary" onClick={reset}>
                Start over
              </cf-button>
            </cf-hstack>
            <p style={styles.sub}>{progress}</p>

            <cf-card>
              <h3 style={styles.section}>Ingredients</h3>
              {noIngredients
                ? <p style={styles.empty}>No ingredients</p>
                : null}
              {ingredientLines.map((line) => (
                <div style={styles.ingredient}>{line}</div>
              ))}
            </cf-card>

            {noGroups
              ? (
                <cf-card>
                  <p style={styles.empty}>No steps in this recipe</p>
                </cf-card>
              )
              : null}
            {groups.map((group) => (
              <cf-card>
                <div style={styles.groupHeader}>
                  <cf-checkbox
                    checked={group.done}
                    oncf-change={() => toggleGroup.send({ groupId: group.id })}
                  />
                  <div style={{ flex: "1" }}>
                    <h4 style={styles.groupName}>{group.name}</h4>
                    <div style={styles.details}>{group.details}</div>
                  </div>
                </div>
                {group.steps.map((step) => (
                  <div style={styles.step}>
                    <cf-checkbox
                      checked={step.done}
                      oncf-change={() => toggleStep.send({ key: step.key })}
                    />
                    <span style={styles.number}>{step.number}</span>
                    <span
                      style={{
                        flex: "1",
                        fontSize: "14px",
                        lineHeight: "1.5",
                        textDecoration: step.done ? "line-through" : "none",
                        opacity: step.done ? "0.6" : "1",
                      }}
                    >
                      {step.text}
                    </span>
                  </div>
                ))}
              </cf-card>
            ))}
          </cf-vstack>
        </cf-screen>
      ),
      done,
      stepsDone,
      stepsTotal,
      toggleStep,
      toggleGroup,
      reset,
    };
  },
);

export default Viewer;
