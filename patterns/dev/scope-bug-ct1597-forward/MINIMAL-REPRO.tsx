// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Fixture: a `PerUser` value read inside a `computed()` block in
 * `cf-screen`'s header slot.
 *
 * That shape once blanked the whole body while the same block reading a
 * `PerSpace` value rendered. `MINIMAL-REPRO.test.tsx` checks the header shows
 * the value the block read and that the body below it renders.
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
  // `adminName` is the `PerSpace` counterpart of `myName`, declared so the
  // two can be swapped in the computed below.
  ({ question, adminName: _adminName, myName }) => {
    return {
      [NAME]: "ct1597-minimal-repro",
      [UI]: (
        <cf-screen>
          <div slot="header">
            <h2>{question}</h2>
            {computed(() => {
              const value = trimmedName(myName);
              return <div>me is: "{value}"</div>;
            })}
          </div>
          <div>
            (body — renders below the header)
          </div>
        </cf-screen>
      ),
    };
  },
);
