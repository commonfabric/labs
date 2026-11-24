export type ToolOutputId = string & {
  readonly __toolOutputIdBrand: unique symbol;
};

export interface ToolResultRef {
  type: "cf-harness.tool-result-ref";
  outputId: ToolOutputId;
  toolId: string;
  runId: string;
  artifactPath?: string;
}

export const createToolOutputId = (
  runId: string,
  toolId: string,
  sequence: number,
): ToolOutputId => `${runId}:${toolId}:${sequence}` as ToolOutputId;

export const createToolResultRef = (
  outputId: ToolOutputId,
  toolId: string,
  runId: string,
  artifactPath?: string,
): ToolResultRef => ({
  type: "cf-harness.tool-result-ref",
  outputId,
  toolId,
  runId,
  ...(artifactPath !== undefined ? { artifactPath } : {}),
});
