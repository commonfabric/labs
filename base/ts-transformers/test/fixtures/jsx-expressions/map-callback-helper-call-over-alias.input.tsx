/**
 * FUTURE REPRO: patternized map callbacks should lower helper calls over aliases
 *
 * A direct alias may stay structural, but an ordinary helper call that consumes
 * that alias should still lower at its own seam.
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

const describeKind = (kind: "file" | "folder"): string =>
  kind === "folder" ? "dir" : "doc";

export default pattern<Input, Output>(({ files }) => {
  return {
    [UI]: (
      <div>
        {files.map((file) => {
          const kind = file.type;
          const label = describeKind(kind);
          return <span>{label}</span>;
        })}
      </div>
    ),
  };
});
