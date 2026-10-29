/**
 * FUTURE REPRO: patternized map callbacks should follow tuple aggregate aliases
 *
 * If a reactive field is packed into a local tuple aggregate, later tuple-index
 * computations should still lower correctly.
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
          const info = [file.type, file.name] as const;
          const isFolder = info[0] === "folder";
          return <span>{isFolder ? info[1] : "locked"}</span>;
        })}
      </div>
    ),
  };
});
