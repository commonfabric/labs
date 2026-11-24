/**
 * TRANSFORM REPRO: patternized map callback should lower callback-local const initializers
 *
 * These callback-local aliases read reactive fields from the map element. Once the callback
 * becomes `mapWithPattern(pattern(...))`, both initializers should lower at their own seams.
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
  contentType: "text" | "binary";
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
          const isFolder = file.type === "folder";
          const isOpenable = isFolder || file.contentType !== "binary";

          return <span>{isOpenable ? file.name : "locked"}</span>;
        })}
      </div>
    ),
  };
});
