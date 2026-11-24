/**
 * FUTURE REPRO: patternized map callbacks should follow object aggregate aliases
 *
 * If a reactive field is first packed into a local object aggregate, later
 * computations over that aggregate should still lower correctly.
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
          const meta = { kind: file.type };
          const isFolder = meta.kind === "folder";
          return <span>{isFolder ? file.name : "locked"}</span>;
        })}
      </div>
    ),
  };
});
