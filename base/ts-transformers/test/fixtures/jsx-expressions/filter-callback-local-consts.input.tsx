/**
 * TRANSFORM REPRO: patternized filter callback should lower callback-local const initializers
 */

import {
  pattern,
  UI,
  VNode,
} from "commonfabric";

interface FileEntry {
  name: string;
  type: "file" | "folder";
}

interface Input {
  files: FileEntry[];
}

interface Output {
  [UI]: VNode;
}

export default pattern<Input, Output>(({ files }) => {
  return {
    [UI]: (
      <div>
        {files
          .filter((file) => {
            const isFolder = file.type === "folder";
            return isFolder;
          })
          .map((file) => <span>{file.name}</span>)}
      </div>
    ),
  };
});
