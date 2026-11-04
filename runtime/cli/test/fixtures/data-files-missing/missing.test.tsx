/// <cts-enable />
// FIXTURE: names a data file that is not stored beside it, so building the
// program refuses rather than leaving the read to fail.
import { assert, dataFile, pattern, TESTS } from "commonfabric";

export default pattern(() => {
  const contents = dataFile("/data/absent.json");
  const assert_never_runs = assert(() => contents.length > 0);
  return { [TESTS]: [{ assertion: assert_never_runs }] };
});
