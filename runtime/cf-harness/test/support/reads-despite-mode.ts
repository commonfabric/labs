/**
 * Whether this process reads a directory whose mode forbids it, as a
 * privileged one does. No mode makes a path unreadable to such a process, so
 * a test needing one cannot be set up for it and should be ignored there.
 */
export const readsDespiteMode = (): boolean => {
  const dir = Deno.makeTempDirSync({ prefix: "cf-harness-mode-" });
  try {
    Deno.chmodSync(dir, 0o000);
    try {
      Deno.readDirSync(dir)[Symbol.iterator]().next();
      return true;
    } catch {
      return false;
    }
  } finally {
    Deno.chmodSync(dir, 0o700);
    Deno.removeSync(dir, { recursive: true });
  }
};
