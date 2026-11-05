// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * CT-1597 — Minimal reproduction of the remaining blank-render trigger.
 *
 * SYMPTOM: Pattern's body renders BLANK (only the breadcrumb chrome shows).
 *          Page title [NAME] still shows, indicating the pattern itself runs.
 *
 * TRIGGER (this file): reading a PerUser-scoped cell inside a
 *   {computed(() => ...)} block inside cf-screen's slot="header".
 *
 * TO REPRODUCE: deploy this file to a fresh space and visit it in the browser.
 *   CF_IDENTITY=./claude.key deno task cf piece new <this-file> \
 *     --api-url http://localhost:8000 --space ct1597-min
 *   then open http://localhost:8000/ct1597-min/<piece-id>
 *
 * RESULT: page shows ONLY "Cozy lunch poll" in breadcrumb + horizontal divider.
 *   No heading. No "me is" line. No body.
 *
 * CONTROL: swap `myName` (PerUser) for `adminName` (PerSpace) at the marked
 *   line below; both renders correctly. Same JSX structure, same computed()
 *   shape, same trimmedName() helper, same div output. PerSpace vs PerUser
 *   in this one position is the ONLY thing that flips the render.
 *
 * NOT a trigger (verified individually):
 *   - Reading PerUser in derive() at the pattern output level (renders)
 *   - Reading PerSpace inside the same computed-in-slot=header shape (renders)
 *   - cf-screen + slot=header + static <h2>{question}</h2> with no
 *     computed at all (renders)
 *   - Trivial computed in slot=header that doesn't read any scoped cell
 *     (renders)
 *
 * NOT fixed by PR #3603 (the "preserve array-shaped derive inputs" fix),
 * which addresses a separate transformer-side issue from a different
 * bisection branch. The previous bisection's minimal repro
 * (scope-bug-ct1597-reduce/main.tsx) is genuinely fixed by #3603.
 */

import {
  computed,
  Default,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

type NameCell = Writable<string | Default<"">>;

const trimmedName = (n: string | undefined) => (n ?? "").trim();

interface Input {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  adminName?: PerSpace<string | Default<"">>;
  myName?: PerUser<string | Default<"">>;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<Input, Output>(
  // `adminName` (PerSpace) is declared but not referenced below — it's the
  // control swap: replacing `myName` with `adminName` in the marked computed
  // restores rendering. Renamed to `_adminName` to satisfy lint.
  ({ question, adminName: _adminName, myName }) => {
    return {
      [NAME]: "ct1597-minimal-repro",
      [UI]: (
        <cf-screen>
          <div slot="header">
            <h2>{question}</h2>
            {computed(() => {
              // ⬇⬇⬇ THIS IS THE TRIGGER ⬇⬇⬇
              // Reading PerUser (myName) here blanks the entire body.
              // Swap to `trimmedName(adminName)` (PerSpace) and it renders.
              const value = trimmedName(myName);
              // ⬆⬆⬆
              return <div>me is: "{value}"</div>;
            })}
          </div>
          <div>
            (body — this would render too if the header didn't blank everything)
          </div>
        </cf-screen>
      ),
    };
  },
);
