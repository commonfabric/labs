#!/usr/bin/env python3
"""Drive an interactive shell through a pseudo-terminal, and report what it drew.

`cf sh` reads its keys off a terminal in raw mode and draws its lines back onto
one, and refuses to start when either standard stream is redirected. So a test
that runs it has to give it a terminal, and this is the terminal: a pty whose
slave the shell is handed and whose master this holds, typing into one end and
reading the drawing off the other.

What it hands back is the drawing taken apart rather than the bytes. The shell
paints through three writes (`lib/shuttle/paint.ts`), and two of them are told
apart in the stream by construction:

* a line being edited opens with `ESC 7` and then `CSI 0J`, and closes with
  `ESC 8` — the cursor is saved before the line is drawn and restored after it;
* a line written above it opens with a `CSI 0J` that no save precedes, and
  closes with the CRLF ending it, ahead of the repaint of the line beneath.

So what precedes the clear says which write this is, and what comes out is one
record per line typed: the line, what the shell wrote above the next prompt in
answer to it, and the prompt it then drew. That triple is the unit an assertion
is written against, and the prompt is half of it — after a `cd`, where the
prompt stands is the whole of what the verb did.

Nothing here waits on a clock for progress. A line has settled when the shell
draws a prompt with nothing typed at it, which it does once the line it was
running answered and at no other time: every drawing made while a line is being
typed carries what was typed after the `> `, and a line written above the prompt
while one is in flight repaints an empty line rather than a prompt. Each read
blocks until the terminal has bytes rather than asking again on an interval.

The one deadline is a stuck-condition backstop, and it is the distinction
`docs/development/waiting-in-tests.md` draws under "Browser-hosted unit tests
have a harness backstop": a safety net at the harness level rather than a bound
at the call site. No line is given a deadline of its own, because one per line
would cap what each line can observe, which is the thing being avoided; this one
only decides when to stop believing the shell will ever answer.

That document is honest about what the shape costs and so is this: an early fire
fails a session that would have finished. It is kept because the alternative —
letting the continuous-integration step's own bound expire — takes the whole job
down with nothing drawn to read, where this one fails with the transcript so far
and says how long it waited.

Usage:

    shuttle-terminal.py <script> <transcript> -- <command> [args...]

`<script>` is one line to type per line, with `#` comments and blank lines
ignored. Three of those lines are directives to this driver rather than lines
for the shell, and none of them makes a record of its own:

* `@frame <keys>` waits until the shell has taken the alternate screen for a
  full-screen view, then types `<keys>` at it. It belongs directly under the
  line that opens the view, because that line has not settled — the view is
  what it settles into — and typing at a view before it is drawn would put the
  keys on the line being typed next instead. `\r` in `<keys>` is the return
  that runs a line typed at the view, and `\\` is a backslash; those two are
  the whole of the reading, every other character being itself. The directive
  types no return of its own: a view is keys rather than lines, and the one
  place a return means anything there is a command line the view opened.
* `@drawn <text>` waits until `<text>` has been drawn anywhere on the screen
  since the `@frame` before it typed its keys. It is for what a view draws: a
  frame is drawn on the alternate screen and carries none of the writes
  `next_write` takes the drawing apart by, so `@said` cannot look there at all.
  It is what a line typed at a view is waited on with -- the keys of a `@frame`
  are typed in one go, so without it the key that closes the view is read
  before the line the key before it ran has come back, and what that line
  produced reaches the record after this one.

  Since the keys and not since the line, which is what makes it usable for
  text a view was already showing. A frame is redrawn whole on every repaint,
  so everything on it has been drawn since the line was typed -- and a wait
  measured from there would come back at once for a word the view is carrying
  already, before the line it was meant to wait for had run at all.
* `@said <text>` waits until `<text>` has been drawn, searching from the last
  line typed. It is for what the shell writes on its own account rather than in
  answer to a line: a watch's event line arrives when the runtime settles, which
  may be before or after the prompt that line drew, so waiting for it is the
  only ordering there is. Waiting is all it does -- which record the write lands
  in is decided by when it arrived, not by this: one drawn before the prompt
  that ends a line belongs to that line, one after it to the next line, and one
  with no next line to the trailing record. So a test asserting on such a line
  reads the whole transcript rather than a record of it.

Neither is a poll and neither is a clock: each blocks until the terminal has
more bytes, exactly as the settle wait does, and a condition that never holds
is left to the one session deadline above.

`<transcript>` is written as JSON: an array of
`{"line", "said", "prompt"}` records in the order the shell answered them,
between a leading record whose line is null carrying anything written before the
first prompt and, where the shell wrote anything after the last line settled, a
trailing one whose line is null carrying that. Both are the writes no typed line
accounts for. The exit status is the shell's own, and a shell that ended before
the script did is an error here.
"""

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

# What the shell sends around the line it is drawing, and around the line it
# writes above that one. `paint.ts` composes both; these are the pieces that
# tell one from the other.
SAVE = "\x1b7"
CLEAR = "\x1b[0J"
RESTORE = "\x1b8"

# The end of a line written above the prompt: its own CRLF, then the carriage
# return and cursor save that open the repaint of the line beneath it.
ABOVE_END = "\r\n\r" + SAVE

# A prompt with nothing typed at it, which is the settle marker.
SETTLED = re.compile(r"^shuttle .*> $")

# What the shell sends when a full-screen view takes the screen. A frame is
# drawn there rather than on the transcript's own screen, and carries none of
# the three writes above, so what the parser wants from it is this one
# boundary: everything between it and the drawing that follows the view is
# invisible to `next_write`, which looks for a clear that a frame never sends.
ENTER_ALT = "\x1b[?1049h"

# The script lines that are instructions to this driver rather than to the
# shell. Each is documented in the module docstring above.
FRAME_KEYS = "@frame "
AWAIT_DRAWN = "@drawn "
AWAIT_SAID = "@said "

# How tall and wide the terminal is. Fixed rather than inherited, so that what
# a page bounds and what a line wraps at is the same on every machine.
ROWS = 24
COLUMNS = 100

# How long the whole session may take before the drawing so far is reported and
# the run gives up. The backstop the module docstring describes: one bound over
# the session, never one per line.
DEADLINE_SECONDS = float(os.environ.get("SHUTTLE_PTY_DEADLINE_SECONDS", "600"))


class Wedged(Exception):
    """Raised when the session ran out of time with a line still unanswered."""

    def __init__(self, drawn):
        super().__init__("the shell drew nothing further")
        self.drawn = drawn


class Terminal:
    """The pty, the process on the far end of it, and what has been drawn."""

    def __init__(self, argv):
        self.master, slave = pty.openpty()
        fcntl.ioctl(
            slave,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", ROWS, COLUMNS, 0, 0),
        )
        # Output processing off, so that what arrives at the master is what the
        # shell wrote. A terminal turns a line feed into a carriage return and
        # a line feed on its way out by default, and the shell already sends
        # both — the drawing would arrive with a return doubled in every place
        # a line breaks, and the sequences below would be looked for in a
        # stream that no writer composed.
        mode = termios.tcgetattr(slave)
        mode[1] &= ~termios.OPOST
        termios.tcsetattr(slave, termios.TCSANOW, mode)
        self.process = subprocess.Popen(
            argv,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=dict(os.environ, LINES=str(ROWS), COLUMNS=str(COLUMNS)),
            start_new_session=True,
        )
        os.close(slave)
        self.drawn = ""
        self.read_from = 0
        # Where the drawing stood when the last line was typed, which is where
        # a wait for something the shell wrote in answer to it searches from.
        # Consuming a write moves `read_from` past it, so a wait that searched
        # from there would miss what has already been read apart.
        self.typed_at = 0
        self.deadline = time.time() + DEADLINE_SECONDS

    def pump(self):
        """Blocks until the terminal has more bytes; false once it has none left."""
        left = self.deadline - time.time()
        if left <= 0 or not select.select([self.master], [], [], left)[0]:
            raise Wedged(self.drawn)
        try:
            chunk = os.read(self.master, 65536)
        except OSError:
            # The far end closed the terminal, which the process ending does.
            return False
        if not chunk:
            return False
        self.drawn += chunk.decode("utf8", "replace")
        return True

    def next_write(self):
        """The next thing drawn as an `("edit"|"above", text)` pair, None at the end."""
        while True:
            opened = self.drawn.find(CLEAR, self.read_from)
            if opened >= 0:
                body = opened + len(CLEAR)
                edited = self.drawn[opened - len(SAVE):opened] == SAVE
                ends = RESTORE if edited else ABOVE_END
                closed = self.drawn.find(ends, body)
                if closed >= 0:
                    self.read_from = closed + len(ends)
                    return ("edit" if edited else "above", self.drawn[body:closed])
            if not self.pump():
                return None

    def type(self, text):
        """Sends `text` to the terminal, as a person typing it would."""
        os.write(self.master, text.encode("utf8"))

    def type_line(self, text):
        """Types `text` and the return that runs it, marking where that was."""
        self.typed_at = len(self.drawn)
        self.type(text + "\r")

    def wait_for(self, needle, since=None):
        """Blocks until `needle` has been drawn since `since`, or since the line.

        `since` is an index into what has been drawn, which `drawn_so_far`
        gives; without one the search runs from where the last line was typed.
        """
        at = self.typed_at if since is None else since
        while self.drawn.find(needle, at) < 0:
            if not self.pump():
                raise EOFError("the shell ended before it drew %r" % needle)

    def drawn_so_far(self):
        """How much has been drawn, as a boundary a later `wait_for` takes."""
        return len(self.drawn)


def frame_keys(text):
    """The keys `@frame` types, reading `\\r` as a return and `\\\\` as a backslash.

    A view answers to keys rather than to lines, so the script writes each key
    as itself — but a command line a view opened is run by a return, and a
    script file has no way to hold one. Two escapes and no more: a reading
    wider than that would make every other character a question.
    """
    keys = []
    at = 0
    while at < len(text):
        pair = text[at:at + 2]
        if pair == "\\r":
            keys.append("\r")
            at += 2
        elif pair == "\\\\":
            keys.append("\\")
            at += 2
        else:
            keys.append(text[at])
            at += 1
    return "".join(keys)


def settle(terminal, said):
    """Reads until an empty prompt is drawn, collecting what was written above it."""
    while True:
        write = terminal.next_write()
        if write is None:
            raise EOFError("the shell ended before the line it was given settled")
        kind, text = write
        if kind == "above":
            said.append(text.replace("\r\n", "\n"))
        elif SETTLED.match(text):
            return text


def run(script, argv):
    """Drives `argv` through `script`, and is the records it made and the exit status."""
    terminal = Terminal(argv)
    banner = []
    prompt = settle(terminal, banner)
    records = [{"line": None, "said": "\n".join(banner), "prompt": prompt}]
    at = 0
    while at < len(script):
        line = script[at]
        at += 1
        if line.startswith(AWAIT_SAID):
            terminal.wait_for(line[len(AWAIT_SAID):])
            continue
        said = []
        terminal.type_line(line)
        # A view opens instead of the line settling, so the keys that close it
        # are typed before the settle rather than after it.
        # Where a `@drawn` starts looking: after the keys typed before it, so
        # that a word the view was already showing is not what it comes back
        # for. The screen taken is found from where the line was typed instead,
        # a second `@frame` being under the same one view as the first.
        since = terminal.drawn_so_far()
        while at < len(script) and (
            script[at].startswith(FRAME_KEYS)
            or script[at].startswith(AWAIT_DRAWN)
        ):
            if script[at].startswith(AWAIT_DRAWN):
                terminal.wait_for(script[at][len(AWAIT_DRAWN):], since)
            else:
                terminal.wait_for(ENTER_ALT)
                terminal.type(frame_keys(script[at][len(FRAME_KEYS):]))
                since = terminal.drawn_so_far()
            at += 1
        prompt = settle(terminal, said)
        records.append({"line": line, "said": "\n".join(said), "prompt": prompt})
    # `ctrl-d` on an empty line is how a session ends, and the terminal closes
    # when the process on the far end of it does.
    terminal.type("\x04")
    while terminal.pump():
        pass
    # What the shell drew after the last line settled, which is what it wrote on
    # its own account: a watch's event line arrives when the runtime goes quiet,
    # which can be after the prompt that ended the last record. Every earlier
    # one is taken by the next line's settle; there is no next line for these,
    # so without this they are drawn and then dropped -- and a `@said` waiting
    # on one as the last directive of a script would be the case where what was
    # waited for reaches no record at all. It carries no line of its own, as the
    # banner record does not, for the same reason: no line was typed for it.
    trailing = []
    while True:
        write = terminal.next_write()
        if write is None:
            break
        kind, text = write
        if kind == "above":
            trailing.append(text.replace("\r\n", "\n"))
    if trailing:
        records.append(
            {"line": None, "said": "\n".join(trailing), "prompt": ""},
        )
    return records, terminal.process.wait()


def main():
    if "--" not in sys.argv:
        raise SystemExit(
            "usage: shuttle-terminal.py <script> <transcript> -- <command> [args...]",
        )
    split = sys.argv.index("--")
    script_path, transcript_path = sys.argv[1:split]
    argv = sys.argv[split + 1:]
    with open(script_path) as source:
        script = [
            line.strip() for line in source
            if line.strip() != "" and not line.lstrip().startswith("#")
        ]
    try:
        records, status = run(script, argv)
    except Wedged as wedged:
        sys.stderr.write(
            "The shell answered nothing for %ds. What it drew:\n%s\n"
            % (DEADLINE_SECONDS, wedged.drawn),
        )
        raise SystemExit(2)
    except EOFError as ended:
        sys.stderr.write("%s\n" % ended)
        raise SystemExit(3)
    with open(transcript_path, "w") as out:
        json.dump(records, out, indent=2)
    raise SystemExit(status)


main()
