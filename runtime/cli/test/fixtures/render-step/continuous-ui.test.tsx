import {
  action,
  assert,
  computed,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { lateVDOMBranch } from "./subject.tsx";

export default pattern(() => {
  const phase = new Writable("initial");
  const advance = action(() => phase.set("late"));
  const view = (
    <div>
      {computed(() =>
        phase.get() === "late"
          ? <span>{computed(() => lateVDOMBranch())}</span>
          : null
      )}
    </div>
  );
  const isLate = assert(() => phase.get() === "late");

  return {
    [UI]: view,
    [TESTS]: [
      { action: advance },
      { assertion: isLate },
    ],
  };
});
