import { __cf_data, dataFile } from "commonfabric";

/**
 * Reads a data file through a path computed at run time, which no build step
 * can see, so the read itself is what finds the file missing.
 */
const name = ["absent", "json"].join(".");

export default __cf_data(dataFile(`/data/${name}`));
