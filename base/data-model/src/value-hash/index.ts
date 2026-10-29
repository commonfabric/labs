/**
 * Content hashing of `FabricValue`s. This submodule produces deterministic
 * digests based on values' logical structure, by traversing the value tree
 * directly and feeding type-tagged data into a single SHA-256 context. See
 * Section 6 of the formal spec and the byte-level spec for the full algorithm.
 *
 * `ValueHasher`, which does the feeding, stays internal to the package, and is
 * reached from its own file.
 */

export * from "./impl.ts";
