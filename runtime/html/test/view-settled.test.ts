/**
 * Tests for the view-readiness helpers (drainViewUpdates / viewSettled).
 *
 * The helpers read elements structurally (children, shadowRoot, updateComplete,
 * isUpdatePending), so the tests drive them with plain fakes rather than a real
 * DOM. updateComplete mirrors Lit's contract: it resolves true once settled,
 * false when the element re-triggered its own update (supersession), and rejects
 * when the update threw.
 */

import { assertEquals } from "@std/assert";
import { stub } from "@std/testing/mock";
import { drainViewUpdates, viewSettled } from "../src/debug.ts";

interface FakeEl {
  children: FakeEl[];
  shadowRoot: { children: FakeEl[] } | null;
  updateComplete?: Promise<boolean>;
  isUpdatePending?: boolean;
}

function lit(
  updateComplete: Promise<boolean>,
  opts: { isUpdatePending?: boolean; children?: FakeEl[]; shadow?: FakeEl[] } =
    {},
): FakeEl {
  return {
    children: opts.children ?? [],
    shadowRoot: opts.shadow ? { children: opts.shadow } : null,
    updateComplete,
    isUpdatePending: opts.isUpdatePending ?? false,
  };
}

function plain(opts: { children?: FakeEl[]; shadow?: FakeEl[] } = {}): FakeEl {
  return {
    children: opts.children ?? [],
    shadowRoot: opts.shadow ? { children: opts.shadow } : null,
  };
}

function roots(...els: FakeEl[]): Iterable<Element> {
  return els as unknown as Iterable<Element>;
}

Deno.test("drainViewUpdates - churn detection", async (t) => {
  await t.step("a settled element is not churning", async () => {
    assertEquals(
      (await drainViewUpdates(roots(lit(Promise.resolve(true))))).churned,
      false,
    );
  });

  await t.step(
    "plain elements without updateComplete are ignored",
    async () => {
      assertEquals(
        (await drainViewUpdates(roots(plain({ children: [plain()] }))))
          .churned,
        false,
      );
    },
  );

  await t.step("an element pending at scan time is churning", async () => {
    assertEquals(
      (await drainViewUpdates(
        roots(lit(Promise.resolve(true), { isUpdatePending: true })),
      )).churned,
      true,
    );
  });

  await t.step(
    "a superseded update (resolves false) is churning with no error",
    async () => {
      const { churned, errors } = await drainViewUpdates(
        roots(lit(Promise.resolve(false))),
      );
      assertEquals(churned, true);
      assertEquals(errors, []);
    },
  );

  await t.step(
    "a thrown update (rejects) is churning and surfaces the error",
    async () => {
      const boom = new Error("update threw");
      const rejected = Promise.reject(boom);
      rejected.catch(() => {});
      const { churned, errors } = await drainViewUpdates(roots(lit(rejected)));
      assertEquals(churned, true);
      assertEquals(errors, [boom]);
    },
  );

  await t.step("descends into children and shadow roots", async () => {
    const churningInShadow = plain({ shadow: [lit(Promise.resolve(false))] });
    assertEquals(
      (await drainViewUpdates(roots(churningInShadow))).churned,
      true,
    );

    const settledNested = plain({ children: [lit(Promise.resolve(true))] });
    assertEquals(
      (await drainViewUpdates(roots(settledNested))).churned,
      false,
    );
  });

  await t.step("no active renders means nothing is churning", async () => {
    assertEquals((await drainViewUpdates()).churned, false);
  });
});

Deno.test("viewSettled - loop", async (t) => {
  await t.step(
    "polls idle each pass until the view settles",
    async () => {
      const e = lit(Promise.resolve(false));
      let passes = 0;
      const idle = () => {
        passes++;
        if (passes >= 2) e.updateComplete = Promise.resolve(true);
        return Promise.resolve();
      };
      await viewSettled(idle, { roots: roots(e) });
      assertEquals(passes, 2);
    },
  );

  await t.step("settles in one pass when nothing is pending", async () => {
    let passes = 0;
    const idle = () => {
      passes++;
      return Promise.resolve();
    };
    await viewSettled(idle, { roots: roots(lit(Promise.resolve(true))) });
    assertEquals(passes, 1);
  });

  await t.step(
    "warns and gives up after maxPasses when the view never settles",
    async () => {
      const warn = stub(console, "warn", () => {});
      let passes = 0;
      const idle = () => {
        passes++;
        return Promise.resolve();
      };
      try {
        await viewSettled(idle, {
          roots: roots(lit(Promise.resolve(false))),
          maxPasses: 3,
        });
      } finally {
        warn.restore();
      }
      assertEquals(passes, 3);
      assertEquals(warn.calls.length, 1);
    },
  );

  await t.step(
    "names the thrown update when it gives up after maxPasses",
    async () => {
      const warn = stub(console, "warn", () => {});
      const boom = new Error("update threw");
      const rejected = Promise.reject(boom);
      rejected.catch(() => {});
      let passes = 0;
      const idle = () => {
        passes++;
        return Promise.resolve();
      };
      try {
        await viewSettled(idle, {
          roots: roots(lit(rejected)),
          maxPasses: 2,
        });
      } finally {
        warn.restore();
      }
      assertEquals(passes, 2);
      assertEquals(warn.calls.length, 1);
      // the actual error is surfaced as a console.warn argument, not lost
      assertEquals(warn.calls[0].args.includes(boom), true);
    },
  );
});
