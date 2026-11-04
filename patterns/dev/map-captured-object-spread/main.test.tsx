import { action, assert, pattern, TESTS } from "commonfabric";
import CapturedObjectSpread from "./main.tsx";

export default pattern(() => {
  const subject = CapturedObjectSpread({
    ids: ["a", "b"],
    log: [],
    prefix: "p",
  });

  // The handler runs only when the spread handed it both cells.
  const action_record_second = action(() => {
    subject.record[1].send();
  });
  const assert_recorded = assert(() => subject.log.join(",") === "p:b");

  return {
    [TESTS]: [
      { action: action_record_second },
      { assertion: assert_recorded },
    ],
  };
});
