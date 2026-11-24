/**
 * TRANSFORM REPRO: patternized map callback should lower reactive expression statements
 *
 * Once `.map(...)` lowers to `.mapWithPattern(...)`, the callback body is pattern-owned.
 * This bare statement call consumes reactive callback fields and should cross an explicit
 * compute boundary instead of operating directly on `file.key(...)` refs in plain code.
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
          console.log("mapping", file.name, file.type);
          return <span>{file.name}</span>;
        })}
      </div>
    ),
  };
});
