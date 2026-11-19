/**
 * The pattern a cf-harness run composes over the seeded cells.
 *
 * `run_pattern` is given this source and the two handles the operator seeded,
 * so the run reads both cells without the model ever holding either value.
 *
 * Two results, deliberately unalike. `briefing` mixes the confidential cell
 * with the plain one, so the space derives a label for it and records the
 * lifted function that did the deriving. `climate` reads only the plain cell,
 * so it derives no label at all. A reader that colored a cell by the label its
 * containing object carries would call both confidential; the difference lives
 * in each cell's own derived label.
 */
import { type Confidential, lift, NAME, pattern, UI } from "commonfabric";

interface State {
  secret: Confidential<string, readonly ["demo-secret"]>;
  city: string;
}

const briefingOf = lift<{ city: string; secret: string }, string>(
  ({ city, secret }) => `Agent stationed in ${city}; codeword is ${secret}`,
);

const climateOf = lift<{ city: string }, string>(({ city }) =>
  city.length % 2 === 0 ? "coastal" : "inland"
);

export default pattern<State>(({ secret, city }) => ({
  [NAME]: "CFC input-cell demo briefing",
  [UI]: <div>A briefing was derived for {city}.</div>,
  briefing: briefingOf({ city, secret }),
  climate: climateOf({ city }),
}));
