import { __cf_data, dataFile } from "commonfabric";

/**
 * Names a data file that is not stored under the program root, so building the
 * program refuses rather than compiling something that fails at the read.
 */
export default __cf_data(dataFile("/data/absent.json"));
