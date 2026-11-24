/**
 * FUTURE REPRO: patternized map callbacks should follow object-destructured aliases
 *
 * A destructured alias may remain structural, but later computations over it
 * should still lower at their own seam.
 */

import {
  Default,
  pattern,
  UI,
  VNode,
  Writable,
} from "commonfabric";

interface FileEntry {
  name: string;
  type: "file" | "folder";
}

interface Input {
  files: Writable<Default<FileEntry[], []>>;
}

interface Output {
  [UI]: VNode;
}

export default pattern<Input, Output>(({ files }) => {
  return {
    [UI]: (
      <div>
        {files.map((file) => {
          const { type: kind } = file;
          const isFolder = kind === "folder";
          return <span>{isFolder ? file.name : "locked"}</span>;
        })}
      </div>
    ),
  };
});
