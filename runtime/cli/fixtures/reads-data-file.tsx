import { __cf_data, dataFile } from "commonfabric";

/**
 * Reads an attached data file, so `--datafile` has something to prove: the
 * exported value is the file's parsed contents, not a shape derived from types.
 *
 * `dataFile` returns text, so parsing it yields `any`. Naming the shape keeps
 * the export explicit, and reading at module scope takes the `__cf_data`
 * snapshot the verifier asks of any top-level value.
 */
interface Cities {
  cities: string[];
}

export default __cf_data(
  (JSON.parse(dataFile("/data/cities.json")) as Cities).cities,
);
