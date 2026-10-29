export function normalizeMappedStack(stack: string): string[] {
  const lines = stack.split("\n").filter((line) => line.trim().length > 0);
  const message = lines[0] ? [lines[0]] : [];
  const authoredFrames = lines.slice(1).filter(isAuthoredFrame);
  if (authoredFrames.length > 0) {
    return [...message, ...authoredFrames];
  }
  const fallbackFrame = lines.slice(1).find((line) =>
    !isIgnorableRuntimeFrame(line)
  );
  return fallbackFrame ? [...message, fallbackFrame] : message;
}

export function assertNoInternalRuntimeFrames(stack: string): void {
  const leakingLine = stack.split("\n").find(isInternalRuntimeFrame);
  if (leakingLine) {
    throw new Error(
      `Unexpected internal runtime frame in surfaced stack: ${leakingLine}`,
    );
  }
}

function isAuthoredFrame(line: string): boolean {
  return /\.(?:ts|tsx):\d+:\d+/.test(line) &&
    !isInternalRuntimeFrame(line) &&
    !line.includes("runtime/runner/test/");
}

function isIgnorableRuntimeFrame(line: string): boolean {
  return isInternalRuntimeFrame(line) ||
    line.includes(" at new Promise ") ||
    line.includes(" at callback ") ||
    line.includes(" at eventLoopTick ") ||
    line.includes("ext:deno_web/") ||
    line.includes("ext:core/");
}

function isInternalRuntimeFrame(line: string): boolean {
  return line.includes("<CF_INTERNAL>") ||
    line.includes("runtime/runner/src/sandbox/ses-runtime.ts:") ||
    line.includes("runtime/runner/src/runner.ts:") ||
    line.includes("runtime/runner/src/harness/engine.ts:") ||
    line.includes("runtime/runner/src/scheduler.ts:") ||
    line.includes(" at wrapped ") ||
    line.includes(" at handler:wrapped ") ||
    line.includes(" at action:wrapped ");
}
