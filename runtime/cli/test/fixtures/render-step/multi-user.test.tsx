import {
  action,
  assert,
  computed,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { lateVDOMBranch } from "./subject.tsx";

const alice = pattern(() => {
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
    [TESTS]: [
      { action: advance },
      { render: view },
      { assertion: isLate },
    ],
  };
});

export default multiUserTest({ participants: { alice } });
