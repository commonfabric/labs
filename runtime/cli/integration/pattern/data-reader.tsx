import { dataFile, pattern } from "commonfabric";

/**
 * Reads an attached data file. The deployed piece exposes both the parsed
 * contents and the raw text, so the integration run can check the bytes that
 * reached the runtime rather than only that the pattern compiled.
 *
 * The optional input exists so a later `setsrc` has an argument schema that
 * accepts the deployed piece's existing arguments.
 */
export default pattern<{ label?: string }>(({ label }) => {
  const raw = dataFile("/data/cities.json");
  return {
    label,
    cities: JSON.parse(raw).cities,
    raw,
  };
});
