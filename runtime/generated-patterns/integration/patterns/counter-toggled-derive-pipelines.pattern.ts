import { cell, Default, handler, lift, pattern, str } from "commonfabric";
import type { Cell } from "commonfabric";

type PipelineMode = "double" | "mirror";

/**
 * Arguments controlling the toggled derive pipeline counter.
 * `mode` selects which derive pipeline runs against the sanitized count.
 */
interface TogglePipelineArgs {
  count: Default<number, 0>;
  mode: Default<PipelineMode, "double">;
}

type PipelineResult = {
  mapped: number;
  label: string;
  status: string;
};

type PipelineFn = (value: number) => PipelineResult;

const doublePipeline: PipelineFn = (value) => {
  const mapped = value * 2;
  return {
    mapped,
    label: `Double pipeline -> ${mapped}`,
    status: `${value} doubled to ${mapped}`,
  };
};

const mirrorPipeline: PipelineFn = (value) => {
  const mapped = -value;
  return {
    mapped,
    label: `Mirror pipeline -> ${mapped}`,
    status: `${value} mirrored to ${mapped}`,
  };
};

const liftSwitchCountView = lift((value: number | undefined) =>
  typeof value === "number" ? value : 0
);

const liftSafeCount = lift((value: number | undefined) =>
  typeof value === "number" ? value : 0
);

const liftSafeMode = lift((value: PipelineMode | undefined) =>
  value === "mirror" ? "mirror" : "double"
);

const liftPipelineResult = lift((inputs: {
  mode: PipelineMode | undefined;
  value: number | undefined;
}): PipelineResult => {
  const sanitizedMode = inputs.mode === "mirror" ? "mirror" : "double";
  const pipeline = sanitizedMode === "mirror" ? mirrorPipeline : doublePipeline;
  const value = typeof inputs.value === "number" ? inputs.value : 0;
  return pipeline(value);
});

const liftMappedValue = lift((result: PipelineResult) => result.mapped);

const liftStatus = lift((result: PipelineResult) => result.status);

const liftHistoryView = lift((history: PipelineMode[] | undefined) =>
  Array.isArray(history) ? history : []
);

const adjustCount = handler(
  (
    event: { amount?: number } | undefined,
    context: { count: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.count.get();
    const base = typeof current === "number" ? current : 0;
    context.count.set(base + amount);
  },
);

/**
 * Counter pattern that swaps between derive pipelines based on an argument-
 * backed mode cell. The active pipeline reference changes without rebuilding
 * the surrounding reactive graph.
 */
const togglePipeline = handler(
  (
    event: { mode?: PipelineMode } | undefined,
    context: {
      mode: Cell<PipelineMode>;
      switches: Cell<number>;
      history: Cell<PipelineMode[]>;
    },
  ) => {
    const current = context.mode.get();
    const currentMode = current === "mirror" ? "mirror" : "double";
    const requested = event?.mode;
    const next = requested === "mirror"
      ? "mirror"
      : requested === "double"
      ? "double"
      : currentMode === "mirror"
      ? "double"
      : "mirror";

    if (next !== currentMode) {
      context.mode.set(next);
      const switchCount = context.switches.get();
      const steps = typeof switchCount === "number" ? switchCount : 0;
      context.switches.set(steps + 1);
    }

    const historyState = context.history.get() ?? [];
    context.history.set([...historyState, next]);
  },
);

export const counterWithToggledDerivePipelines = pattern<TogglePipelineArgs>(
  ({ count, mode }) => {
    const switchCount = cell(0);
    const pipelineHistory = cell<PipelineMode[]>([]);
    const switchCountView = liftSwitchCountView(switchCount);
    const historyView = liftHistoryView(pipelineHistory);

    const safeCount = liftSafeCount(count);
    const safeMode = liftSafeMode(mode);

    const pipelineName = safeMode;

    const pipelineResult = liftPipelineResult({
      mode: safeMode,
      value: safeCount,
    });

    const mappedValue = liftMappedValue(pipelineResult);
    const status = liftStatus(pipelineResult);

    return {
      count,
      mode: safeMode,
      pipelineName,
      mappedValue,
      status,
      label: str`${pipelineName} mapped ${mappedValue}`,
      pipelineHistory: historyView,
      switchCount: switchCountView,
      increment: adjustCount({ count }),
      togglePipeline: togglePipeline({
        mode,
        switches: switchCount,
        history: pipelineHistory,
      }),
    };
  },
);

export default counterWithToggledDerivePipelines;
