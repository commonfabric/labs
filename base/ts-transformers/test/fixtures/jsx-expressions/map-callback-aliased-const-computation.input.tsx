/**
 * TRANSFORM REPRO: patternized map callback should compute-wrap uses of aliased field refs
 *
 * A direct alias may stay structural, but a later computation over that alias
 * should still lower at its own seam.
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
          const kind = file.type;
          const isFolder = kind === "folder";
          return <span>{isFolder ? file.name : "locked"}</span>;
        })}
      </div>
    ),
  };
});
