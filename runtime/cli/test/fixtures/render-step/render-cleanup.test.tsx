import {
  action,
  assert,
  computed,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { afterRenderBranch, lateVDOMBranch } from "./subject.tsx";

export default pattern(() => {
  const phase = new Writable("initial");
  const reachLate = action(() => phase.set("late"));
  const advanceAfterRender = action(() => phase.set("after-render"));
  const view = (
    <div>
      {computed(() => {
        if (phase.get() === "late") {
          return <span>{computed(() => lateVDOMBranch())}</span>;
        }
        if (phase.get() === "after-render") {
          return <span>{computed(() => afterRenderBranch())}</span>;
        }
        return null;
      })}
    </div>
  );
  const isAfterRender = assert(() => phase.get() === "after-render");

  return {
    [TESTS]: [
      { action: reachLate },
      { render: view },
      { action: advanceAfterRender },
      { assertion: isAfterRender },
    ],
  };
});
