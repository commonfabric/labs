/**
 * FUTURE REPRO: patternized map callbacks should follow array-destructured aliases
 *
 * Destructuring a reactive array-valued field into a local alias should still
 * let later computations lower through that alias.
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
  tags: ["file" | "folder", string];
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
          const [kind] = file.tags;
          const isFolder = kind === "folder";
          return <span>{isFolder ? file.name : "locked"}</span>;
        })}
      </div>
    ),
  };
});
