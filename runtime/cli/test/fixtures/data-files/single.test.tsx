/// <cts-enable />
import { assert, dataFile, pattern, TESTS } from "commonfabric";

interface Cities {
  cities: string[];
}

export default pattern(() => {
  const parsed = JSON.parse(dataFile("/data/cities.json")) as Cities;
  const assert_reads_the_attached_data_file = assert(() =>
    parsed.cities.length === 2
  );
  return { [TESTS]: [{ assertion: assert_reads_the_attached_data_file }] };
});
