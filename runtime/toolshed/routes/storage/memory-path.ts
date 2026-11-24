// The engine store root now lives with the rest of the on-disk layout contract
// in `@commonfabric/memory/v2/storage-path`, so the two functions that compose
// into a store path are read and changed together. Re-exported here for the
// existing import sites.
export { resolveMemoryEngineStoreRootUrl } from "@commonfabric/memory/v2/storage-path";
