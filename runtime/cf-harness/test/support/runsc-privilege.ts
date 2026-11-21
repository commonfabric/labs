import { join } from "@std/path";

/**
 * Whether this process makes entries in a directory whose mode forbids it,
 * as a privileged one does. No mode keeps such a process out, so a case
 * needing a directory it cannot write cannot be set up for it.
 */
export const writesDespiteMode = (): boolean => {
  const dir = Deno.makeTempDirSync({ prefix: "runsc-privilege-" });
  try {
    Deno.chmodSync(dir, 0o500);
    try {
      Deno.mkdirSync(join(dir, "in"));
      return true;
    } catch {
      return false;
    }
  } finally {
    Deno.chmodSync(dir, 0o700);
    Deno.removeSync(dir, { recursive: true });
  }
};
