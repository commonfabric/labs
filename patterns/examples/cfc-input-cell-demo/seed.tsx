/**
 * The cells a cf-harness run is pointed at, before the run exists.
 *
 * An operator deploys this piece, then names two of its cells to a run with
 * `--input-cell secret=<link> --input-cell city=<link>`. The model holds a
 * handle for each and never the value behind it.
 *
 * The pair is the point: `secret` carries a declared confidentiality atom and
 * `city` carries none, so a pattern run over both derives a value the space
 * labels and a value it does not. Reading the two back is what says a
 * per-cell label is a fact about that cell rather than about the run.
 */
import {
  type Confidential,
  Default,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface State {
  secret: Writable<
    | Confidential<string, readonly ["demo-secret"]>
    | Default<"codeword osprey">
  >;
  city: Writable<string | Default<"Lisbon">>;
}

export default pattern<State>(({ secret, city }) => ({
  [NAME]: "CFC input-cell demo seed",
  [UI]: (
    <div>
      <p>Seeded for {city}. The confidential cell is not rendered here.</p>
    </div>
  ),
  secret,
  city,
}));
