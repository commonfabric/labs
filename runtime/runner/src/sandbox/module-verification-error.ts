export class ModuleVerificationError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly column: number,
    message: string,
  ) {
    super(`${file}:${line}:${column}: ${message}`);
    this.name = "ModuleVerificationError";
  }
}
