/**
 * Sends `SIGTERM` to `child`, discarding every failure to send it rather than
 * only the expected one. A process the runtime has already reaped takes no
 * signal, and `kill()` reports that by throwing; such a process is already in
 * the state the signal asks for, so a caller taking one down wants the same
 * outcome either way. Waiting for the process to go is the caller's own to do.
 */
export function terminateChildProcess(
  child: Pick<Deno.ChildProcess, "kill">,
): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // The failure to send the signal is discarded.
  }
}
