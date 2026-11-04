/**
 * TRANSFORM REPRO: patternized flatMap callback should lower reactive expression statements
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
        {files.flatMap((file) => {
          console.log("mapping", file.name, file.type);
          return [<span>{file.name}</span>];
        })}
      </div>
    ),
  };
});
