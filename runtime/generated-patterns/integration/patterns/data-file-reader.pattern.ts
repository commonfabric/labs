/// <cts-enable />
import { dataFile, pattern } from "commonfabric";

/**
 * Reads an attached data file, so a scenario's `dataFiles` has something to
 * prove: the exported values come from the file rather than from the types.
 */
interface Cities {
  cities: string[];
}

export interface DataFileReaderOutput {
  cities: string[];
  count: number;
}

export const dataFileReader = pattern<
  Record<string, never>,
  DataFileReaderOutput
>(() => {
  const parsed = JSON.parse(dataFile("/data/cities.json")) as Cities;
  return { cities: parsed.cities, count: parsed.cities.length };
});

export default dataFileReader;
