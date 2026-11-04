import { assertEquals, assertRejects } from "@std/assert";
import { Browser } from "../browser.ts";
import { waitForCondition } from "../utils.ts";

Deno.test("waitForCondition transports only lossless JSON answers", async () => {
  const browser = await Browser.launch();
  const page = await browser.newPage();

  try {
    const answer = await waitForCondition(page, () => ({
      point: { x: 12.5, y: 24 },
      labels: ["ready", null, true],
    }));
    assertEquals(answer, {
      point: { x: 12.5, y: 24 },
      labels: ["ready", null, true],
    });

    const functionAnswer = () => () => "silently dropped by JSON.stringify";
    await assertRejects(
      () => {
        // @ts-expect-error Page-condition answers must be plain JSON values.
        return waitForCondition(page, functionAnswer);
      },
      Error,
      "function at $ is not JSON-safe",
    );
    await assertRejects(
      () => waitForCondition(page, () => ({ value: -0 })),
      Error,
      "Negative zero at $.value is not JSON-safe",
    );

    await assertRejects(
      () =>
        waitForCondition(page, () => {
          const sparse = ["placeholder"];
          delete sparse[0];
          return sparse;
        }),
      Error,
      "Sparse array at $ is not JSON-safe",
    );

    await assertRejects(
      () =>
        waitForCondition(page, () => {
          const augmented = ["value"];
          Object.defineProperty(augmented, "label", {
            enumerable: true,
            value: "lost by JSON.stringify",
          });
          return augmented;
        }),
      Error,
      "Array properties at $ are not JSON-safe",
    );

    await assertRejects(
      () =>
        waitForCondition(page, () => {
          const augmented = ["value"];
          Object.defineProperty(augmented, Symbol("label"), {
            enumerable: true,
            value: "lost by JSON.stringify",
          });
          return augmented;
        }),
      Error,
      "Array properties at $ are not JSON-safe",
    );

    await assertRejects(
      () =>
        waitForCondition(page, () => {
          const overridden = ["value"];
          Object.defineProperty(overridden, "toJSON", {
            value: () => "different value",
          });
          return overridden;
        }),
      Error,
      "toJSON at $ is not JSON-safe",
    );
  } finally {
    await page.close().finally(() => browser.close());
  }
});
