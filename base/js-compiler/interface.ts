import { type RawSourceMap } from "source-map-js";

export type Source = {
  name: string;
  contents: string;
};

// A program's entry point with a resolver to
// resolve other sources used in the program.
export type ProgramResolver = {
  main(): Promise<Source>;
  resolveSource(identifier: string): Promise<Source | undefined>;

  /**
   * Reads a data file the program's source declares, by the root-relative name
   * a `dataFile()` call gives it. Undefined when this resolver holds no such
   * file.
   *
   * A resolver that does not implement it has its data files read through
   * `resolveSource`, which is right wherever source and data come from the
   * same place. A resolver reads them itself when the transport calls for it:
   * the file system reads a data file strictly as UTF-8 and keeps a byte order
   * mark that module reading would consume.
   */
  resolveDataFile?(name: string): Promise<Source | undefined>;
};

// An entry point and its sources for a program.
export type Program = {
  main: string;
  files: Source[];

  /**
   * Names of entries in `files` that carry data rather than code. A data file
   * travels with the source package and is never transformed, compiled, or
   * executed; a pattern reads one by name with `dataFile()`.
   */
  dataFiles?: string[];
};

// A ready-to-execute string of JavaScript,
// with optional metadata.
export type JsScript = {
  js: string;
  sourceMap?: SourceMap;
  filename?: string;
};

export type SourceMap = RawSourceMap;
