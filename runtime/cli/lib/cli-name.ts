/** The name the CLI is invoked by, as its help and messages spell it. */
export function cliName(): "cf" {
  return "cf";
}

export function cliCommand(parts: Iterable<string>, name = cliName()): string {
  return [name, ...parts].join(" ");
}

export function cliText(text: string, name = cliName()): string {
  return text.replaceAll(/(^|[\s"'`(])cf(?=\s)/gm, `$1${name}`);
}
