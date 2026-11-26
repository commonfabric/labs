import { expect } from "@std/expect";
import "../../../console/src/index.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("console/src/index", () => {
  it("registers the app and every view it draws", () => {
    for (
      const name of [
        "console-app",
        "console-run-view",
        "console-flow-view",
        "console-index-view",
      ]
    ) {
      expect(customElements.get(name)).toBeDefined();
    }
  });
});
