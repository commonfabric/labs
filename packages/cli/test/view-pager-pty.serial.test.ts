/**
 * The interactive pager (pager.ts) and mod.ts's interactive branch touch a real
 * terminal, so they are driven here through a pseudo-terminal: the CLI is run
 * under `script`, which gives the child a TTY, and keystrokes are fed to it.
 * Every case quits in-band with `q` (no signals — those do not forward through
 * `script`).
 *
 * The driver is event-driven: each keystroke is sent only after the child's
 * output shows the state it depends on (the drawn document, the search input
 * line, the help overlay, the save prompt). Where a redraw carries no
 * distinctive text, the escape prefix every frame draw emits is counted
 * instead. The only clock is a watchdog for a child that stops producing
 * output entirely; it resets on every output chunk, so a slow child that is
 * still making progress never trips it, and a silent child fails the test
 * with the captured output. Skipped where `script` is unavailable.
 */

import { assert } from "@std/assert";
import { join } from "@std/path";

const CLI_MOD = join(import.meta.dirname!, "..", "mod.ts");
const ENC = new TextEncoder();

/** How long the child may go without writing any output before the test gives
 * up on it. Resets on every chunk, so it bounds silence, not total runtime. */
const STALL_MS = 60_000;

/** Every frame draw starts by disabling autowrap (see pager.ts `draw`), so
 * occurrences of this prefix count redraws. */
const FRAME = "\x1b[?7l";

async function hasScript(): Promise<boolean> {
  if (Deno.build.os !== "linux" && Deno.build.os !== "darwin") return false;
  try {
    const c = new Deno.Command("script", {
      args: Deno.build.os === "linux" ? ["--version"] : ["-h"],
      stdout: "null",
      stderr: "null",
    });
    await c.output();
    return true;
  } catch {
    return false;
  }
}
const SCRIPT = await hasScript();

function spawnUnderPty(args: string[]): Deno.ChildProcess {
  const inner = [Deno.execPath(), "run", "-A", CLI_MOD, ...args];
  const cmd = Deno.build.os === "linux"
    // util-linux: -e returns the child's exit code, -c runs the command.
    ? new Deno.Command("script", {
      args: ["-q", "-e", "-c", inner.join(" "), "/dev/null"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    })
    // BSD: the command follows the typescript file argument.
    : new Deno.Command("script", {
      args: ["-q", "/dev/null", ...inner],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
  return cmd.spawn();
}

/**
 * A pager child under a pseudo-terminal, with its output accumulated as it
 * arrives. `send` records where the output stood, and `expect` waits for text
 * that appears after that point, so an expectation always refers to the
 * response to the most recent keystroke.
 */
class PtyPager {
  #child: Deno.ChildProcess;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #out = "";
  #err = "";
  #outDone: Promise<void>;
  #errDone: Promise<void>;
  #outEof = false;
  #exited = false;
  #mark = 0;
  #waiters = new Set<{ wake: () => void }>();

  constructor(args: string[]) {
    this.#child = spawnUnderPty(args);
    this.#writer = this.#child.stdin.getWriter();
    this.#outDone = this.#drain(
      this.#child.stdout,
      (text) => this.#out += text,
      () => this.#outEof = true,
    );
    this.#errDone = this.#drain(this.#child.stderr, (text) => {
      this.#err += text;
    });
    this.#child.status.then(() => {
      this.#exited = true;
      this.#wakeAll();
    });
  }

  async #drain(
    stream: ReadableStream<Uint8Array>,
    sink: (text: string) => void,
    onEnd?: () => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        sink(decoder.decode(chunk, { stream: true }));
        this.#wakeAll();
      }
      sink(decoder.decode());
    } catch { /* a pipe broken by a kill reads as end of stream */ }
    onEnd?.();
    this.#wakeAll();
  }

  #wakeAll(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const w of waiters) w.wake();
  }

  /** Resolves when more output arrives, the child exits, or the output stream
   * ends. After {@link STALL_MS} with none of those, kills the child and
   * rejects with the captured output. */
  #nextActivity(waitingFor: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        wake: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        try {
          this.#child.kill("SIGKILL");
        } catch { /* already gone */ }
        reject(
          new Error(this.#report(
            `the pager wrote no output for ${
              STALL_MS / 1000
            }s while waiting for ${waitingFor}`,
          )),
        );
      }, STALL_MS);
      this.#waiters.add(waiter);
    });
  }

  #report(problem: string): string {
    const tail = (label: string, s: string) =>
      `--- ${label} (${s.length} chars, tail shown) ---\n${
        JSON.stringify(s.slice(-2000))
      }`;
    return `${problem}\n${tail("stdout", this.#out)}\n${
      tail("stderr", this.#err)
    }`;
  }

  output(): string {
    return this.#out;
  }

  /** The number of frames drawn so far, over the whole output. */
  frameCount(): number {
    let n = 0;
    for (
      let i = this.#out.indexOf(FRAME);
      i !== -1;
      i = this.#out.indexOf(FRAME, i + FRAME.length)
    ) {
      n++;
    }
    return n;
  }

  async send(text: string): Promise<void> {
    this.#mark = this.#out.length;
    try {
      await this.#writer.write(ENC.encode(text));
    } catch (error) {
      throw new Error(this.#report(
        `writing ${JSON.stringify(text)} to the child failed (${
          error instanceof Error ? error.message : error
        })`,
      ));
    }
  }

  /** Waits until `needle` appears in the output written after the last
   * {@link send}. */
  async expect(needle: string, what: string): Promise<void> {
    const label = `${what} (${JSON.stringify(needle)})`;
    while (!this.#out.includes(needle, this.#mark)) {
      if (this.#outEof) {
        throw new Error(this.#report(`output ended before ${label} appeared`));
      }
      await this.#nextActivity(label);
    }
  }

  /** Waits until at least `target` frames have been drawn in total. */
  async expectFrameCount(target: number, what: string): Promise<void> {
    while (this.frameCount() < target) {
      if (this.#outEof) {
        throw new Error(this.#report(`output ended before ${what}`));
      }
      await this.#nextActivity(what);
    }
  }

  /** Sends a keystroke whose redraw has no distinctive text and waits for the
   * frame it causes. */
  async sendExpectingRedraw(text: string): Promise<void> {
    const target = this.frameCount() + 1;
    await this.send(text);
    await this.expectFrameCount(
      target,
      `a redraw after sending ${JSON.stringify(text)}`,
    );
  }

  /** Closes stdin and waits for the child to exit and its streams to end. */
  async waitExit(): Promise<void> {
    try {
      await this.#writer.close();
    } catch { /* the child may have already exited */ }
    while (!this.#exited) {
      await this.#nextActivity("the child to exit");
    }
    await this.#outDone;
    await this.#errDone;
    await this.#child.status;
  }

  /** Reaps the child and releases its pipes; safe after any failure. */
  async dispose(): Promise<void> {
    if (!this.#exited) {
      try {
        this.#child.kill("SIGKILL");
      } catch { /* already gone */ }
    }
    try {
      await this.#writer.close();
    } catch { /* may already be closed */ }
    await this.#outDone;
    await this.#errDone;
    await this.#child.status;
  }
}

async function driveInteractive(
  args: string[],
  drive: (p: PtyPager) => Promise<void>,
): Promise<{ out: string }> {
  const p = new PtyPager(args);
  try {
    await drive(p);
    await p.waitExit();
  } finally {
    await p.dispose();
  }
  return { out: p.output() };
}

const SRC =
  "export const greet = pattern(() => ({ value: 1 }));\nconst other = greet;\n";
const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
-const old = 1;
+const next = 2;
 const ctx = next;
`;

function withDoc(
  text: string,
  fn: (file: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const dir = Deno.makeTempDirSync();
    try {
      const file = join(dir, "doc.ts");
      Deno.writeTextFileSync(file, text);
      await fn(file);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  };
}

Deno.test({
  name: "pager: opens a TTY, draws the document, quits on q",
  ignore: !SCRIPT,
  fn: withDoc(SRC, async (file) => {
    const { out } = await driveInteractive(["view", file], async (p) => {
      await p.expect("greet", "the first frame of the document");
      await p.send("q");
    });
    assert(out.includes("greet"), `drew the document: ${out.slice(0, 120)}`);
  }),
});

Deno.test({
  name: "pager: scrolling and search keystrokes are handled",
  ignore: !SCRIPT,
  fn: withDoc(
    SRC + "x\n".repeat(60),
    async (file) => {
      await driveInteractive(["view", file], async (p) => {
        await p.expect("greet", "the first frame of the document");
        await p.sendExpectingRedraw("j");
        await p.sendExpectingRedraw("k");
        await p.send("\\");
        await p.expect(
          "Line wrapping: hard",
          "backslash enables hard wrapping",
        );
        await p.send("\\");
        await p.expect(
          "Line wrapping: word",
          "backslash enables word wrapping",
        );
        await p.send("\\");
        await p.expect(
          "Line wrapping: off",
          "backslash cycles back to unwrapped lines",
        );
        await p.send("G");
        await p.expect("END", "the end-of-document position indicator");
        await p.sendExpectingRedraw("g");
        await p.send("/greet");
        await p.expect("/greet", "the search input line");
        await p.send("\r");
        await p.expect("match 1/2", "the match counter after the search");
        await p.send("n");
        await p.expect("match 2/2", "the counter on the next match");
        await p.send("?");
        await p.expect("cf view — keys", "the help overlay");
        await p.sendExpectingRedraw("\x1b"); // escape closes the overlay
        await p.send("q");
      });
    },
  ),
});

Deno.test({
  name: "pager: an edit triggers the deferred reparse, then quits",
  ignore: !SCRIPT,
  fn: withDoc(SRC, async (file) => {
    await driveInteractive(["view", file], async (p) => {
      await p.expect("greet", "the first frame of the document");
      await p.send("e"); // 'e' enters edit mode, revealing the text cursor
      await p.expect("Done", "the edit-mode status hint (Esc Done)");
      // Typing redraws once immediately; the deferred re-parse redraws a
      // second time once the debounce elapses.
      const frames = p.frameCount();
      await p.send("Z");
      await p.expectFrameCount(
        frames + 2,
        "the keystroke redraw and the deferred re-parse redraw",
      );
      await p.sendExpectingRedraw("\x1b"); // escape back to navigation
      await p.send("q"); // the dirty buffer raises the save prompt
      await p.expect("Save changes to", "the save-prompt dialog");
      await p.send("d"); // the Discard button, and exit
    });
  }),
});

Deno.test({
  name: "pager: a diff is viewed interactively",
  ignore: !SCRIPT,
  fn: withDoc(DIFF, async (file) => {
    const { out } = await driveInteractive(["view", file], async (p) => {
      await p.expect("next", "the first frame of the diff");
      await p.send("q");
    });
    assert(out.includes("next"), `drew the diff: ${out.slice(0, 120)}`);
  }),
});

Deno.test({
  name: "pager: a terminal stdin with no file is reported as no input",
  ignore: !SCRIPT,
  // No file argument and a TTY on stdin: the input reader returns empty rather
  // than blocking on the keyboard, so the viewer reports there is nothing to
  // show and exits.
  fn: async () => {
    const { out } = await driveInteractive(["view"], async (p) => {
      await p.expect("no input", "the no-input report");
    });
    assert(
      out.toLowerCase().includes("no input"),
      `reported no input: ${out.slice(0, 160)}`,
    );
  },
});
