import type { JSONSchema } from "@commonfabric/api";
import type {
  CfcLabelView,
  CfcSandboxExitCodeObservation,
  CfcSandboxResult,
  CfcStreamObservation,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import { mergeCfcLabelViews } from "@commonfabric/runner/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";
import {
  classifyFileToolShellFailure,
  classifyPathResolutionError,
  createStructuredFileToolErrorOutput,
  detailFromShellFailure,
  detailFromUnknownError,
  type StructuredFileToolErrorOutput,
  structuredFileToolErrorOutputSchema,
} from "./file-errors.ts";
import {
  isResolvedPathInsideArtifactRoot,
  RESERVED_ARTIFACT_PATH_DETAIL,
} from "./reserved-artifacts.ts";

export interface EditFileTextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  expectedReplacements?: number;
}

export interface EditFileToolInput {
  path: string;
  edits: EditFileTextEdit[];
  expectedDigest?: string;
  // Trusted harness/test plumbing for invocation input labels. This is omitted
  // from the public tool schema so model-authored tool calls do not mint labels.
  cfcInputLabels?: CfcLabelView;
}

export interface EditFileToolSuccessOutput {
  outputId: string;
  path: string;
  editsApplied: number;
  replacements: number;
  oldDigest: string;
  newDigest: string;
  oldSizeBytes: number;
  newSizeBytes: number;
  diff: string;
  cfcResult?: CfcSandboxResult;
}

export type EditFileToolOutput =
  | EditFileToolSuccessOutput
  | StructuredFileToolErrorOutput;

export const isEditFileToolSuccessOutput = (
  output: unknown,
): output is EditFileToolSuccessOutput =>
  isObjectOrArray(output) &&
  "outputId" in output &&
  typeof output.outputId === "string" &&
  "path" in output &&
  typeof output.path === "string" &&
  "diff" in output &&
  typeof output.diff === "string";

interface AppliedEditResult {
  content: string;
  replacements: number;
}

interface ApplyEditsResult {
  content: string;
  replacements: number;
}

interface ChangedLineSpan {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface UnifiedDiffHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  spans: ChangedLineSpan[];
}

const textEncoder = new TextEncoder();
const MAX_UNIFIED_DIFF_LINES = 400;

const bytesForText = (text: string): Uint8Array => textEncoder.encode(text);

const sha256Digest = async (input: Uint8Array): Promise<string> => {
  const digestInput = input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};

const summarizeText = async (
  text: string,
): Promise<{ bytes: number; digest: string }> => {
  const bytes = bytesForText(text);
  return {
    bytes: bytes.byteLength,
    digest: await sha256Digest(bytes),
  };
};

const findOccurrences = (content: string, needle: string): number[] => {
  const positions: number[] = [];
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(needle, offset);
    if (index === -1) {
      break;
    }
    positions.push(index);
    offset = index + needle.length;
  }
  return positions;
};

const validateExpectedReplacements = (
  edit: EditFileTextEdit,
  editIndex: number,
): number | undefined => {
  if (edit.expectedReplacements === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(edit.expectedReplacements) ||
    edit.expectedReplacements <= 0
  ) {
    throw new Error(
      `edit ${editIndex + 1} expectedReplacements must be a positive integer`,
    );
  }
  if (edit.expectedReplacements !== 1 && edit.replaceAll !== true) {
    throw new Error(
      `edit ${
        editIndex + 1
      } expectedReplacements greater than 1 requires replaceAll=true`,
    );
  }
  return edit.expectedReplacements;
};

const applySingleEdit = (
  content: string,
  edit: EditFileTextEdit,
  editIndex: number,
): AppliedEditResult => {
  if (edit.oldText.length === 0) {
    throw new Error(`edit ${editIndex + 1} oldText must be non-empty`);
  }
  const expectedReplacements = validateExpectedReplacements(edit, editIndex);
  const occurrences = findOccurrences(content, edit.oldText);
  if (occurrences.length === 0) {
    throw new Error(`edit ${editIndex + 1} oldText was not found`);
  }
  if (
    expectedReplacements !== undefined &&
    occurrences.length !== expectedReplacements
  ) {
    throw new Error(
      `edit ${
        editIndex + 1
      } expected ${expectedReplacements} replacement(s) but found ${occurrences.length}`,
    );
  }
  if (edit.replaceAll === true) {
    return {
      content: content.split(edit.oldText).join(edit.newText),
      replacements: occurrences.length,
    };
  }
  if (occurrences.length !== 1) {
    throw new Error(
      `edit ${
        editIndex + 1
      } oldText matched ${occurrences.length} times; provide more surrounding context or set replaceAll=true`,
    );
  }
  const index = occurrences[0]!;
  return {
    content: content.slice(0, index) + edit.newText +
      content.slice(index + edit.oldText.length),
    replacements: 1,
  };
};

const applyEdits = (
  content: string,
  edits: readonly EditFileTextEdit[],
): ApplyEditsResult => {
  if (edits.length === 0) {
    throw new Error("edit_file edits must include at least one edit");
  }
  let nextContent = content;
  let replacements = 0;
  for (const [index, edit] of edits.entries()) {
    const result = applySingleEdit(nextContent, edit, index);
    nextContent = result.content;
    replacements += result.replacements;
  }
  return { content: nextContent, replacements };
};

const splitLines = (text: string): string[] => {
  if (text.length === 0) {
    return [];
  }
  const parts = text.split("\n");
  const lines = parts.map((line, index) =>
    index < parts.length - 1 ? `${line}\n` : line
  );
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

const renderDiffLine = (prefix: string, line: string): string =>
  `${prefix}${line.endsWith("\n") ? line.slice(0, -1) : line}`;

const rangeHeader = (startZeroBased: number, count: number): string =>
  count === 0 ? `${startZeroBased},0` : `${startZeroBased + 1},${count}`;

const findUniqueCommonAnchor = (
  oldLines: readonly string[],
  newLines: readonly string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): { oldIndex: number; newIndex: number } | undefined => {
  const oldOccurrences = new Map<string, { count: number; index: number }>();
  const newOccurrences = new Map<string, { count: number; index: number }>();

  for (let index = oldStart; index < oldEnd; index += 1) {
    const line = oldLines[index]!;
    const occurrence = oldOccurrences.get(line);
    oldOccurrences.set(line, {
      count: (occurrence?.count ?? 0) + 1,
      index,
    });
  }
  for (let index = newStart; index < newEnd; index += 1) {
    const line = newLines[index]!;
    const occurrence = newOccurrences.get(line);
    newOccurrences.set(line, {
      count: (occurrence?.count ?? 0) + 1,
      index,
    });
  }

  const oldMidpoint = (oldStart + oldEnd) / 2;
  const newMidpoint = (newStart + newEnd) / 2;
  let best:
    | { oldIndex: number; newIndex: number; score: number }
    | undefined;
  for (const [line, oldOccurrence] of oldOccurrences) {
    const newOccurrence = newOccurrences.get(line);
    if (
      oldOccurrence.count !== 1 ||
      newOccurrence === undefined ||
      newOccurrence.count !== 1
    ) {
      continue;
    }
    const score = Math.abs(oldOccurrence.index - oldMidpoint) +
      Math.abs(newOccurrence.index - newMidpoint);
    if (best === undefined || score < best.score) {
      best = {
        oldIndex: oldOccurrence.index,
        newIndex: newOccurrence.index,
        score,
      };
    }
  }
  return best;
};

const collectChangedLineSpans = (
  oldLines: readonly string[],
  newLines: readonly string[],
  oldStart = 0,
  oldEnd = oldLines.length,
  newStart = 0,
  newEnd = newLines.length,
): ChangedLineSpan[] => {
  while (
    oldStart < oldEnd &&
    newStart < newEnd &&
    oldLines[oldStart] === newLines[newStart]
  ) {
    oldStart += 1;
    newStart += 1;
  }
  while (
    oldEnd > oldStart &&
    newEnd > newStart &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  if (oldStart === oldEnd && newStart === newEnd) {
    return [];
  }

  const anchor = findUniqueCommonAnchor(
    oldLines,
    newLines,
    oldStart,
    oldEnd,
    newStart,
    newEnd,
  );
  if (anchor === undefined) {
    return [{ oldStart, oldEnd, newStart, newEnd }];
  }

  return [
    ...collectChangedLineSpans(
      oldLines,
      newLines,
      oldStart,
      anchor.oldIndex,
      newStart,
      anchor.newIndex,
    ),
    ...collectChangedLineSpans(
      oldLines,
      newLines,
      anchor.oldIndex + 1,
      oldEnd,
      anchor.newIndex + 1,
      newEnd,
    ),
  ];
};

const createUnifiedDiffHunks = (
  spans: readonly ChangedLineSpan[],
  oldLineCount: number,
  newLineCount: number,
  contextLineCount: number,
): UnifiedDiffHunk[] => {
  const hunks: UnifiedDiffHunk[] = [];
  for (const span of spans) {
    const hunk: UnifiedDiffHunk = {
      oldStart: Math.max(0, span.oldStart - contextLineCount),
      oldEnd: Math.min(oldLineCount, span.oldEnd + contextLineCount),
      newStart: Math.max(0, span.newStart - contextLineCount),
      newEnd: Math.min(newLineCount, span.newEnd + contextLineCount),
      spans: [span],
    };
    const previous = hunks.at(-1);
    if (
      previous !== undefined &&
      hunk.oldStart <= previous.oldEnd &&
      hunk.newStart <= previous.newEnd
    ) {
      previous.oldEnd = Math.max(previous.oldEnd, hunk.oldEnd);
      previous.newEnd = Math.max(previous.newEnd, hunk.newEnd);
      previous.spans.push(span);
    } else {
      hunks.push(hunk);
    }
  }
  return hunks;
};

const renderUnifiedDiffHunk = (
  lines: string[],
  oldLines: readonly string[],
  newLines: readonly string[],
  hunk: UnifiedDiffHunk,
): void => {
  lines.push(
    `@@ -${rangeHeader(hunk.oldStart, hunk.oldEnd - hunk.oldStart)} +${
      rangeHeader(hunk.newStart, hunk.newEnd - hunk.newStart)
    } @@`,
  );

  let oldCursor = hunk.oldStart;
  let newCursor = hunk.newStart;
  for (const span of hunk.spans) {
    while (oldCursor < span.oldStart && newCursor < span.newStart) {
      lines.push(renderDiffLine(" ", oldLines[oldCursor]!));
      oldCursor += 1;
      newCursor += 1;
    }
    for (let index = span.oldStart; index < span.oldEnd; index += 1) {
      lines.push(renderDiffLine("-", oldLines[index]!));
    }
    for (let index = span.newStart; index < span.newEnd; index += 1) {
      lines.push(renderDiffLine("+", newLines[index]!));
    }
    oldCursor = span.oldEnd;
    newCursor = span.newEnd;
  }
  while (oldCursor < hunk.oldEnd && newCursor < hunk.newEnd) {
    lines.push(renderDiffLine(" ", oldLines[oldCursor]!));
    oldCursor += 1;
    newCursor += 1;
  }
};

const truncateUnifiedDiffLines = (lines: readonly string[]): string[] => {
  if (lines.length <= MAX_UNIFIED_DIFF_LINES) {
    return [...lines];
  }
  const retainedLineCount = MAX_UNIFIED_DIFF_LINES - 1;
  const omittedLineCount = lines.length - retainedLineCount;
  return [
    ...lines.slice(0, retainedLineCount),
    `[diff truncated: ${omittedLineCount} additional line(s) omitted]`,
  ];
};

const createUnifiedDiff = (
  path: string,
  oldContent: string,
  newContent: string,
  contextLineCount = 3,
): string => {
  if (oldContent === newContent) {
    return "";
  }
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const spans = collectChangedLineSpans(oldLines, newLines);
  const hunks = createUnifiedDiffHunks(
    spans,
    oldLines.length,
    newLines.length,
    contextLineCount,
  );
  const lines = [
    `--- ${path}`,
    `+++ ${path}`,
  ];
  for (const hunk of hunks) {
    renderUnifiedDiffHunk(lines, oldLines, newLines, hunk);
  }
  return `${truncateUnifiedDiffLines(lines).join("\n")}\n`;
};

const filterCfcInputLabels = (
  labels: CfcLabelView | undefined,
  roots: readonly string[],
): CfcLabelView | undefined => {
  if (labels === undefined) {
    return undefined;
  }
  const rootSet = new Set(roots);
  const entries = labels.entries.filter((entry) =>
    entry.path.length > 0 && rootSet.has(entry.path[0]!)
  );
  return mergeCfcLabelViews([
    entries.length > 0 ? { version: 1, entries } : undefined,
  ]);
};

const cfcLabelViewForReadStdout = (
  cfcResult: CfcSandboxResult | undefined,
): CfcLabelView | undefined =>
  cfcResult === undefined ? undefined : {
    version: 1,
    entries: [{ path: ["stdin"], label: cfcResult.stdout.label }],
  };

const mergeCfcLabels = (
  labels: Array<IFCLabel | undefined>,
): IFCLabel => {
  const view = mergeCfcLabelViews(
    labels.map((label) =>
      label === undefined
        ? undefined
        : { version: 1, entries: [{ path: [], label }] }
    ),
  );
  return view?.entries[0]?.label ?? {};
};

const observedStream = (
  channel: "stdout" | "stderr",
  label: IFCLabel,
  text = "",
): CfcStreamObservation => ({
  channel,
  policy: "observed",
  label,
  segments: [{ text, label }],
});

const observedStreamText = (
  observation: CfcStreamObservation,
): string | undefined =>
  observation.policy === "observed"
    ? observation.segments.map((segment) => segment.text).join("")
    : undefined;

const diffObservationForEditOutput = (
  path: string,
  read: CfcStreamObservation | undefined,
  verify: CfcStreamObservation | undefined,
): CfcStreamObservation | undefined => {
  if (read === undefined || verify === undefined) {
    return undefined;
  }
  const label = mergeCfcLabels([read.label, verify.label]);
  if (read.policy === "denied" || verify.policy === "denied") {
    return {
      channel: "stdout",
      policy: "denied",
      label,
      reason:
        "edit_file diff includes content that was not released by CFC policy",
    };
  }
  if (read.policy === "opaque" || verify.policy === "opaque") {
    return {
      channel: "stdout",
      policy: "opaque",
      label,
      byteLength: (read.policy === "opaque" ? read.byteLength ?? 0 : 0) +
        (verify.policy === "opaque" ? verify.byteLength ?? 0 : 0),
      truncated: read.truncated === true || verify.truncated === true,
    };
  }
  const oldText = observedStreamText(read);
  const newText = observedStreamText(verify);
  if (oldText === undefined || newText === undefined) {
    return undefined;
  }
  return observedStream(
    "stdout",
    label,
    createUnifiedDiff(path, oldText, newText),
  );
};

const cfcResultForEditOutput = (
  path: string,
  readResult: CfcSandboxResult | undefined,
  verifyResult: CfcSandboxResult | undefined,
): CfcSandboxResult | undefined => {
  if (readResult === undefined || verifyResult === undefined) {
    return undefined;
  }
  const stdout = diffObservationForEditOutput(
    path,
    readResult.stdout,
    verifyResult.stdout,
  );
  if (stdout === undefined) {
    return undefined;
  }
  const stderrLabel = mergeCfcLabels([
    readResult.stderr.label,
    verifyResult.stderr.label,
  ]);
  const exitCodeLabel = mergeCfcLabels([
    readResult.exitCode.label,
    verifyResult.exitCode.label,
  ]);
  const exitCode: CfcSandboxExitCodeObservation =
    readResult.exitCode.policy === "denied" ||
      verifyResult.exitCode.policy === "denied"
      ? {
        policy: "denied",
        label: exitCodeLabel,
        reason: "edit_file exit status was not released by CFC policy",
      }
      : readResult.exitCode.policy === "opaque" ||
          verifyResult.exitCode.policy === "opaque"
      ? { policy: "opaque", label: exitCodeLabel }
      : { policy: "observed", label: exitCodeLabel, value: 0 };
  return {
    version: 1,
    stdout,
    stderr: observedStream("stderr", stderrLabel),
    exitCode,
    ...(readResult.diagnostics !== undefined ||
        verifyResult.diagnostics !== undefined
      ? {
        diagnostics: [
          ...(readResult.diagnostics ?? []),
          ...(verifyResult.diagnostics ?? []),
        ],
      }
      : {}),
  };
};

const READ_FILE_COMMAND = [
  "set -eu",
  'if [ ! -e "$1" ]; then',
  '  echo "file not found: $1" >&2',
  "  exit 10",
  "fi",
  'if [ ! -f "$1" ]; then',
  '  echo "not a file: $1" >&2',
  "  exit 11",
  "fi",
  'exec cat "$1"',
].join("\n");

const WRITE_FILE_COMMAND = [
  "set -eu",
  'path="$1"',
  'if [ ! -e "$path" ]; then',
  '  echo "file not found: $path" >&2',
  "  exit 10",
  "fi",
  'if [ ! -f "$path" ]; then',
  '  echo "not a file: $path" >&2',
  "  exit 11",
  "fi",
  'cat > "$path"',
].join("\n");

export const editFileToolDescriptor: HarnessToolDescriptor = {
  toolId: "edit_file",
  title: "Edit File",
  description:
    "Apply exact string-replacement edits to an existing file in the target VM. Use this for targeted changes after reading the file; use write_file for new files or full rewrites.",
  effectClass: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
            replaceAll: { type: "boolean" },
            expectedReplacements: { type: "integer", minimum: 1 },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
      expectedDigest: { type: "string" },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        path: { type: "string" },
        editsApplied: { type: "integer", minimum: 0 },
        replacements: { type: "integer", minimum: 0 },
        oldDigest: { type: "string" },
        newDigest: { type: "string" },
        oldSizeBytes: { type: "integer", minimum: 0 },
        newSizeBytes: { type: "integer", minimum: 0 },
        diff: { type: "string" },
        cfcResult: { type: "object" },
      },
      required: [
        "outputId",
        "path",
        "editsApplied",
        "replacements",
        "oldDigest",
        "newDigest",
        "oldSizeBytes",
        "newSizeBytes",
        "diff",
      ],
      additionalProperties: false,
    }, structuredFileToolErrorOutputSchema],
  } satisfies JSONSchema,
  tags: ["file", "write", "vm", "edit"],
};

export const editFileTool: HarnessToolDefinition<
  EditFileToolInput,
  EditFileToolOutput
> = {
  descriptor: editFileToolDescriptor,
  async invoke(context, input) {
    let resolvedPath: string;
    try {
      resolvedPath = context.resolvePath(input.path);
    } catch (error) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: input.path,
        code: classifyPathResolutionError(error),
        detail: detailFromUnknownError(error),
      });
    }
    if (await isResolvedPathInsideArtifactRoot(context, resolvedPath)) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: resolvedPath,
        code: "permission_denied",
        detail: RESERVED_ARTIFACT_PATH_DETAIL,
      });
    }

    const outputId = context.nextOutputId("edit_file");
    const pathInputLabels = filterCfcInputLabels(input.cfcInputLabels, [
      "args",
    ]);
    const readArgs = [resolvedPath];
    const readResult = await context.sandbox.runShell({
      command: READ_FILE_COMMAND,
      args: readArgs,
      cwd: context.currentDir,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "edit_file",
        toolOutputId: outputId,
        operation: "shell",
        cwd: context.currentDir,
        command: READ_FILE_COMMAND,
        args: readArgs,
        ...(pathInputLabels !== undefined
          ? { cfcInputLabels: pathInputLabels }
          : {}),
        cfcInputLabelPaths: [["args"]],
      }),
    });
    if (readResult.exitCode !== 0) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        outputId,
        path: resolvedPath,
        code: classifyFileToolShellFailure(readResult),
        detail: detailFromShellFailure(readResult),
        exitCode: readResult.exitCode,
      });
    }

    const oldSummary = await summarizeText(readResult.stdout);
    if (
      input.expectedDigest !== undefined &&
      input.expectedDigest !== oldSummary.digest
    ) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        outputId,
        path: resolvedPath,
        code: "edit_conflict",
        detail:
          `expected digest ${input.expectedDigest} but current digest is ${oldSummary.digest}`,
      });
    }

    let edited: ApplyEditsResult;
    try {
      edited = applyEdits(readResult.stdout, input.edits);
    } catch (error) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        outputId,
        path: resolvedPath,
        code: "edit_conflict",
        detail: detailFromUnknownError(error),
      });
    }

    const newSummary = await summarizeText(edited.content);
    const writeArgs = [resolvedPath];
    const writeInputLabels = mergeCfcLabelViews([
      input.cfcInputLabels,
      cfcLabelViewForReadStdout(readResult.cfcResult),
    ]);
    const writeResult = await context.sandbox.runShell({
      command: WRITE_FILE_COMMAND,
      args: writeArgs,
      cwd: context.currentDir,
      stdinText: edited.content,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "edit_file",
        toolOutputId: outputId,
        operation: "shell",
        cwd: context.currentDir,
        command: WRITE_FILE_COMMAND,
        args: writeArgs,
        stdinText: edited.content,
        ...(writeInputLabels !== undefined
          ? { cfcInputLabels: writeInputLabels }
          : {}),
        cfcInputLabelPaths: [["args"], ["stdin"]],
      }),
    });
    if (writeResult.exitCode !== 0) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        outputId,
        path: resolvedPath,
        code: classifyFileToolShellFailure(writeResult),
        detail: detailFromShellFailure(writeResult),
        exitCode: writeResult.exitCode,
      });
    }

    const verifyResult = await context.sandbox.runShell({
      command: READ_FILE_COMMAND,
      args: readArgs,
      cwd: context.currentDir,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "edit_file",
        toolOutputId: outputId,
        operation: "shell",
        cwd: context.currentDir,
        command: READ_FILE_COMMAND,
        args: readArgs,
        ...(pathInputLabels !== undefined
          ? { cfcInputLabels: pathInputLabels }
          : {}),
        cfcInputLabelPaths: [["args"]],
      }),
    });
    if (verifyResult.exitCode !== 0) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        outputId,
        path: resolvedPath,
        code: classifyFileToolShellFailure(verifyResult),
        detail: detailFromShellFailure(verifyResult),
        exitCode: verifyResult.exitCode,
      });
    }
    if (verifyResult.stdout !== edited.content) {
      const observedSummary = await summarizeText(verifyResult.stdout);
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        outputId,
        path: resolvedPath,
        code: "edit_conflict",
        detail:
          `post-write verification failed: expected ${newSummary.digest} but observed ${observedSummary.digest}`,
      });
    }

    return {
      outputId,
      path: resolvedPath,
      editsApplied: input.edits.length,
      replacements: edited.replacements,
      oldDigest: oldSummary.digest,
      newDigest: newSummary.digest,
      oldSizeBytes: oldSummary.bytes,
      newSizeBytes: newSummary.bytes,
      diff: createUnifiedDiff(resolvedPath, readResult.stdout, edited.content),
      ...(() => {
        const cfcResult = cfcResultForEditOutput(
          resolvedPath,
          readResult.cfcResult,
          verifyResult.cfcResult,
        );
        return cfcResult !== undefined ? { cfcResult } : {};
      })(),
    };
  },
};
