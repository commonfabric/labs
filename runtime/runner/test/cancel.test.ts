import { describe, expect, it } from "./scheduler-test-utils.ts";
import { useCancelGroup } from "../src/cancel.ts";

describe("cancel groups", () => {
  it("latches cancellation and immediately cancels late additions once", () => {
    const calls: string[] = [];
    const [cancel, addCancel] = useCancelGroup();

    addCancel(() => calls.push("early"));
    cancel();
    cancel();
    addCancel(() => calls.push("late"));
    expect(calls).toEqual(["early", "late"]);
    cancel();

    expect(calls).toEqual(["early", "late"]);
  });
});
