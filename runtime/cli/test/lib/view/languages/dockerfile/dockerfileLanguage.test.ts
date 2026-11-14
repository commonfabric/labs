import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { dockerfileLanguage } from "../../../../../lib/view/languages/dockerfile/language.ts";
import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import type {
  Line,
  StructureNode,
  TokenClass,
} from "../../../../../lib/view/model.ts";

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Every distinct class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return [
    ...new Set(
      lines.flatMap((line) =>
        line.spans.filter((span) => span.text === text).map((span) => span.cls)
      ),
    ),
  ];
}

function highlight(source: string): Line[] {
  const lines = dockerfileLanguage.highlightLines(source);
  expect(verbatim(lines)).toBe(source);
  return lines;
}

/** Each node's label and line range, with its children's labels. */
function outline(
  nodes: readonly StructureNode[],
): [string, number, number, string[]][] {
  return nodes.map((node) => [
    node.label,
    node.startLine,
    node.endLine,
    node.children.map((child) => child.label),
  ]);
}

describe("dockerfileLanguage", () => {
  beforeAll(() => dockerfileLanguage.prepare!());

  describe("selection", () => {
    // The shared fixture corpus carries the Dockerfile language's
    // representative filenames and aliases; these cases are the ones it does
    // not.

    it("selects `.dockerfile` and `.containerfile` files in any case", () => {
      for (
        const path of ["ci/test.Dockerfile", "x.dockerfile", "x.CONTAINERFILE"]
      ) {
        expect(languageForFile(path).id).toBe("dockerfile");
      }
    });

    it("leaves the ignore files paired with a Dockerfile, and similar names, to other languages", () => {
      for (
        const path of [
          "memory-router/Dockerfile.build.dockerignore",
          "Containerfile.containerignore",
          ".dockerignore",
          "lib/dockerfile.ts",
          "DOCKERFILE",
          "Dockerfiles",
          "Dockerfile.",
        ]
      ) {
        expect(languageForFile(path).id).not.toBe("dockerfile");
      }
    });

    it("leaves a name whose last suffix another language claims to that language", () => {
      expect(languageForFile("Dockerfile.sh").id).toBe("shell");
      expect(languageForFile("Containerfile.json").id).toBe("json");
      expect(languageForFile("Dockerfile.txt").id).toBe("plain-text");
      expect(languageForFile("Dockerfile.cfg").id).toBe("dockerfile");
    });
  });

  describe("highlighting", () => {
    it("colors instructions in any case, the base image, and the stage name", () => {
      const lines = highlight(
        "from golang:1.26@sha256:abc as builder\nRun go build\n",
      );

      expect(classesOf(lines, "from")).toEqual(["keyword"]);
      expect(classesOf(lines, "Run")).toEqual(["keyword"]);
      expect(classesOf(lines, "golang:1.26@sha256:abc")).toEqual(["typeName"]);
      expect(classesOf(lines, "as")).toEqual(["keyword"]);
      expect(classesOf(lines, "builder")).toEqual(["functionName"]);
    });

    it("colors flags, and the variable references in their values", () => {
      const lines = highlight(
        "FROM --platform=$BUILDPLATFORM base\n" +
          "RUN --mount=type=cache,target=/root/.cache go test\n" +
          "COPY --from=builder --link /out /usr/bin/\n",
      );

      for (const flag of ["--platform", "--mount", "--from", "--link"]) {
        expect(classesOf(lines, flag)).toEqual(["parameter"]);
      }
      expect(classesOf(lines, "BUILDPLATFORM")).toEqual(["propertyName"]);
      expect(classesOf(lines, "go")).toEqual(["callName"]);
      expect(classesOf(lines, "type=cache,target=/root/.cache")).toEqual([
        "plain",
      ]);
    });

    it("colors the exec form as a JSON array of strings", () => {
      const lines = highlight(
        'ENTRYPOINT ["dumb-init", "--"]\nCMD []\nVOLUME ["/data"]\n' +
          'RUN ["sh", "-c", "ls"]\nCMD ["echo \\"hi\\""]\nCMD ["one \\\n  two"]\n' +
          'CMD ["four \\\n# A "quote".\nfive", "six"]\n',
      );

      expect(classesOf(lines, "[")).toEqual(["bracket"]);
      expect(classesOf(lines, "]")).toEqual(["bracket"]);
      expect(classesOf(lines, '"dumb-init"')).toEqual(["string"]);
      expect(classesOf(lines, ",")).toEqual(["punctuation"]);
      expect(classesOf(lines, '"/data"')).toEqual(["string"]);
      expect(classesOf(lines, '"ls"')).toEqual(["string"]);
      expect(classesOf(lines, '"echo \\"hi\\""')).toEqual(["string"]);
      expect(classesOf(lines, '"one ')).toEqual(["string"]);
      expect(classesOf(lines, '"six"')).toEqual(["string"]);
    });

    it("reads a command that is not a JSON array of strings as shell", () => {
      const lines = highlight(
        'CMD ["a", b]\nCMD ["a" "b"], c\nCMD ["a",]\nCMD ["a"] b\nCMD ["a\nSHELL ["\\q"]\nRUN ls\n',
      );

      expect(classesOf(lines, ",")).not.toContain("punctuation");
      expect(classesOf(lines, "ls")).toEqual(["callName"]);
    });

    it("colors the shell form as shell across continuations, and the comments and blank lines they skip", () => {
      const lines = highlight(
        "RUN apt-get update && \\\n" +
          "# Packages for the build.\n" +
          "\n" +
          "    apt-get install -y curl && \\\n" +
          "    rm -rf /var/lib/apt/lists/*\n",
      );

      expect(classesOf(lines, "apt-get")).toEqual(["callName"]);
      expect(classesOf(lines, "rm")).toEqual(["callName"]);
      expect(classesOf(lines, "&&")).toEqual(["operator"]);
      expect(classesOf(lines, "# Packages for the build.")).toEqual([
        "comment",
      ]);
    });

    it("continues lines with the character an `escape` directive names", () => {
      const lines = highlight(
        "# escape=`\nRUN echo a `\n    && echo b\nCOPY a\\b c\n",
      );

      expect(classesOf(lines, "escape")).toEqual(["keyword"]);
      expect(classesOf(lines, "=")).toEqual(["operator"]);
      expect(classesOf(lines, "`")).toContain("string");
      expect(classesOf(lines, "echo")).toEqual(["callName"]);
      expect(classesOf(lines, "&&")).toEqual(["operator"]);
    });

    it("hands the shell a continued command as BuildKit joins it", () => {
      const lines = highlight(
        "RUN echo a # note \\\n    echo b\n" +
          "RUN apt-get install -y\\\n# Packages.\ncurl\n" +
          "RUN ec\\\nho hi\n",
      );

      expect(classesOf(lines, "# note ")).toEqual(["comment"]);
      expect(classesOf(lines, "    echo b")).toEqual(["comment"]);
      expect(classesOf(lines, "curl")).toEqual(["plain"]);
      expect(classesOf(lines, "ec")).toEqual(["callName"]);
      expect(classesOf(lines, "ho")).toEqual(["callName"]);
    });

    it("reads an instruction keyword across a continuation, as BuildKit joins it", () => {
      const lines = highlight("RU\\\nN echo hi\nUSER\\\napp\n");

      expect(classesOf(lines, "RU")).toEqual(["keyword"]);
      expect(classesOf(lines, "N")).toEqual(["keyword"]);
      expect(classesOf(lines, "USER\\")).toEqual(["plain"]);
    });

    it("does not continue a line whose escape character another escapes", () => {
      const lines = highlight("WORKDIR C:\\\\\nFROM b AS c\n");

      expect(classesOf(lines, "FROM")).toEqual(["keyword"]);
      expect(classesOf(lines, "c")).toEqual(["functionName"]);
    });

    it("reads lines that end in a carriage return and a line feed", () => {
      const lines = highlight("RUN make \\\r\n    install\r\nUSER app\r\n");

      expect(classesOf(lines, "make")).toEqual(["callName"]);
      expect(classesOf(lines, "USER")).toEqual(["keyword"]);
    });

    it("continues a line whose escape character blanks follow", () => {
      const lines = highlight("RUN make \\  \n    install\nUSER app\n");

      expect(classesOf(lines, "make")).toEqual(["callName"]);
      expect(classesOf(lines, "USER")).toEqual(["keyword"]);
    });

    it("leaves the lines after a continuation that nothing continues to be read as they are", () => {
      const lines = highlight("RUN make \\\n# Done.\n");

      expect(classesOf(lines, "make")).toEqual(["callName"]);
      expect(classesOf(lines, "# Done.")).toEqual(["comment"]);
    });

    it("colors a command that starts on the line after its flags", () => {
      const lines = highlight(
        "RUN --mount=type=cache,target=/go \\\n    go build\n",
      );

      expect(classesOf(lines, "--mount")).toEqual(["parameter"]);
      expect(classesOf(lines, "go")).toEqual(["callName"]);
    });

    it("keeps an escaped character as part of its word or string", () => {
      const lines = highlight(
        'ENV A=one\\ B C="say \\"hi\\" for $5" \\\n    D=\\$E F="$"\n',
      );

      expect(classesOf(lines, "A")).toEqual(["propertyName"]);
      expect(classesOf(lines, "B")).toEqual(["plain"]);
      expect(classesOf(lines, '"say \\"hi\\" for ')).toEqual(["string"]);
      expect(classesOf(lines, "5")).toEqual(["propertyName"]);
      expect(classesOf(lines, "D")).toEqual(["propertyName"]);
      expect(classesOf(lines, "\\$E")).toEqual(["plain"]);
      expect(classesOf(lines, '"$"')).toEqual(["string"]);
    });

    it("reads parser directives only before every other line", () => {
      for (const opening of ["# Note.\n", "# syntax=\n"]) {
        const lines = highlight(`${opening}# escape=\`\nRUN echo a \`\n`);

        expect(classesOf(lines, "# escape=`")).toEqual(["comment"]);
        expect(classesOf(lines, "escape")).toEqual([]);
      }
    });

    it("reads a parser directive that blanks indent", () => {
      const lines = highlight("  # escape=`\nRUN echo a `\n    && echo b\n");

      expect(classesOf(lines, "escape")).toEqual(["keyword"]);
      expect(classesOf(lines, "&&")).toEqual(["operator"]);
    });

    it("colors the names, values, and variable references of `ENV`, `ARG`, and `LABEL`", () => {
      const lines = highlight(
        "ARG VERSION=1 TARGETARCH\n" +
          `ENV A=1 B="two \${VERSION:-0}" C='$A' \\\n    D=$TARGETARCH\n` +
          'LABEL "org.example.vendor"="Example" version=2\n',
      );

      for (const name of ["VERSION", "TARGETARCH", "A", "B", "C", "D"]) {
        expect(classesOf(lines, name)).toContain("propertyName");
      }
      expect(classesOf(lines, '"org.example.vendor"')).toEqual([
        "propertyName",
      ]);
      expect(classesOf(lines, "version")).toEqual(["propertyName"]);
      expect(classesOf(lines, '"two ')).toEqual(["string"]);
      expect(classesOf(lines, "${")).toEqual(["punctuation"]);
      expect(classesOf(lines, ":-")).toEqual(["operator"]);
      expect(classesOf(lines, "'$A'")).toEqual(["string"]);
      expect(classesOf(lines, "$")).toEqual(["punctuation"]);
    });

    it("joins a variable name that a continuation splits", () => {
      const lines = highlight("ENV A=$FO\\\nO B=1\n");

      expect(classesOf(lines, "FO")).toEqual(["propertyName"]);
      expect(classesOf(lines, "O")).toEqual(["propertyName"]);
    });

    it("colors the variable references in the exec form of `COPY`", () => {
      const lines = highlight('COPY ["$SRC", "/app"]\n');

      expect(classesOf(lines, "SRC")).toEqual(["propertyName"]);
    });

    it("joins the words on either side of a continuation", () => {
      const source = "FROM a\nENV A=foo\\\nbar=baz\n";
      const lines = highlight(source);

      expect(classesOf(lines, "bar=baz")).toEqual(["plain"]);
      expect(
        dockerfileLanguage.parseDocument(source).structure[0].children.map((
          child,
        ) => child.label),
      ).toEqual(["ENV A"]);
    });

    it("reads an `ENV` whose name has no `=` as one variable set to the rest of the line", () => {
      const lines = highlight("ENV PATH /usr/local/bin:$PATH\n");

      expect(classesOf(lines, "PATH")).toEqual(["propertyName"]);
      expect(classesOf(lines, "/usr/local/bin:")).toEqual(["plain"]);
    });

    it("colors the ports `EXPOSE` names as numbers", () => {
      const lines = highlight("EXPOSE 8080 \\\n# Port 2.\n    53/udp\n");

      expect(classesOf(lines, "8080")).toEqual(["number"]);
      expect(classesOf(lines, "53")).toEqual(["number"]);
      expect(classesOf(lines, "# Port 2.")).toEqual(["comment"]);
    });

    it("colors a health check's command as shell", () => {
      const lines = highlight(
        "HEALTHCHECK --interval=30s CMD curl -f http://localhost/ || exit 1\n" +
          "HEALTHCHECK NONE\n",
      );

      expect(classesOf(lines, "--interval")).toEqual(["parameter"]);
      expect(classesOf(lines, "CMD")).toEqual(["keyword"]);
      expect(classesOf(lines, "NONE")).toEqual(["keyword"]);
      expect(classesOf(lines, "curl")).toEqual(["callName"]);
    });

    it("colors the instruction an `ONBUILD` registers, apart from another `ONBUILD`", () => {
      const lines = highlight(
        "ONBUILD RUN make\nONBUILD ONBUILD RUN make\n",
      );

      expect(classesOf(lines, "RUN")).toEqual(["keyword", "plain"]);
      expect(classesOf(lines, "make")).toContain("callName");
    });

    it("gives a stage built from another the other stage's shell", () => {
      const lines = highlight(
        'FROM base AS win\nSHELL ["pwsh", "-c"]\nFROM win\nRUN Get-Item x\n' +
          "FROM base\nRUN ls\n",
      );

      expect(classesOf(lines, "Get-Item")).toEqual(["plain"]);
      expect(classesOf(lines, "ls")).toEqual(["callName"]);
    });

    it("leaves the shell form plain after a `SHELL` that names another shell, until the next stage", () => {
      const lines = highlight(
        'FROM windows\nSHELL ["powershell", "-Command"]\nRUN Get-Item x\n' +
          'FROM linux\nSHELL ["/bin/bash", "-o", "pipefail", "-c"]\nRUN ls\n' +
          'SHELL ["/usr/bin/env", "bash", "-c"]\nRUN cat\n',
      );

      expect(classesOf(lines, "Get-Item")).toEqual(["plain"]);
      expect(classesOf(lines, "ls")).toEqual(["callName"]);
      expect(classesOf(lines, "cat")).toEqual(["callName"]);
    });

    it("looks for a heredoc script's shebang after stripping the tabs `<<-` strips", () => {
      const lines = highlight(
        "RUN <<-EOF\n\t#!/usr/bin/env python3\n\tprint(1)\n\tEOF\n",
      );

      expect(classesOf(lines, "\tprint(1)")).toEqual(["string"]);
    });

    it("colors a heredoc script by its shebang, or else by the stage's shell", () => {
      const lines = highlight(
        'SHELL ["pwsh", "-c"]\nRUN <<EOF\n#!/bin/sh\nls\nEOF\n' +
          "RUN <<EOF\nGet-Item x\nEOF\nRUN <<A <<B\na\nA\nb\nB\n",
      );

      expect(classesOf(lines, "ls")).toEqual(["callName"]);
      expect(classesOf(lines, "Get-Item x")).toEqual(["string"]);
      expect(classesOf(lines, "b")).toEqual(["string"]);
    });

    it("colors the variable references BuildKit expands in a `COPY` heredoc with an unquoted delimiter", () => {
      const lines = highlight(
        "COPY <<EOF /x\nhome='$HOME'\nEOF\nCOPY <<\"EOF\" /y\nraw=$USER\nEOF\n",
      );

      expect(classesOf(lines, "HOME")).toEqual(["propertyName"]);
      expect(classesOf(lines, "raw=$USER")).toEqual(["string"]);
    });

    it("runs the body of a `RUN` whose command is a single heredoc as a shell script", () => {
      const lines = highlight(
        "RUN <<EOF\nset -e\napt-get update\nEOF\nWORKDIR /app\n",
      );

      expect(classesOf(lines, "<<")).toEqual(["operator"]);
      expect(classesOf(lines, "EOF")).toEqual(["string"]);
      expect(classesOf(lines, "set")).toEqual(["callName"]);
      expect(classesOf(lines, "apt-get")).toEqual(["callName"]);
      expect(classesOf(lines, "WORKDIR")).toEqual(["keyword"]);
    });

    it("colors a heredoc script whose shebang names another interpreter as a string", () => {
      const lines = highlight(
        '#!/bin/sh\nRUN <<"PY"\n#!/usr/bin/env python3\nprint("hi")\nPY\n',
      );

      expect(classesOf(lines, 'print("hi")')).toEqual(["string"]);
      expect(classesOf(lines, '"PY"')).toEqual(["string"]);
    });

    it("lets the shell read the heredocs of any other `RUN`", () => {
      const lines = highlight(
        "RUN cat <<EOF > /etc/motd\nhello\nEOF\nUSER app\n",
      );

      expect(classesOf(lines, "cat")).toEqual(["callName"]);
      expect(classesOf(lines, "hello")).toEqual(["string"]);
      expect(classesOf(lines, "USER")).toEqual(["keyword"]);
    });

    it("colors the bodies of `COPY` heredocs as strings, ending them at their delimiters", () => {
      const lines = highlight(
        "COPY <<-CONF /etc/app.conf\n\tFROM x\n\tCONF\nRUN ls\n" +
          "ADD <<A <<B /\na\nA\nb\nB\n",
      );

      expect(classesOf(lines, "<<-")).toEqual(["operator"]);
      expect(classesOf(lines, "\tFROM x")).toEqual(["string"]);
      expect(classesOf(lines, "\tCONF")).toEqual(["string"]);
      expect(classesOf(lines, "ls")).toEqual(["callName"]);
      expect(classesOf(lines, "b")).toEqual(["string"]);
    });

    it("runs a heredoc's body to the end of the source when no delimiter ends it", () => {
      const lines = highlight("COPY <<EOF /x\nRUN ls\n");

      expect(classesOf(lines, "RUN ls")).toEqual(["string"]);
    });

    it("reads the heredocs of the instruction an `ONBUILD` registers", () => {
      const lines = highlight(
        "ONBUILD COPY <<EOF /x\nRUN ls\nEOF\nONBUILD RUN <<EOF\nmake\nEOF\n",
      );

      expect(classesOf(lines, "RUN ls")).toEqual(["string"]);
      expect(classesOf(lines, "make")).toEqual(["callName"]);
    });

    it("leaves the stage's shell and variables as they are after an `ONBUILD`", () => {
      const source = 'FROM a\nONBUILD ENV X=1\nONBUILD SHELL ["pwsh", "-c"]\n' +
        "RUN ls\n";
      const lines = highlight(source);

      expect(classesOf(lines, "ls")).toEqual(["callName"]);
      expect(
        dockerfileLanguage.parseDocument(source).structure[0].children,
      ).toEqual([]);
    });

    it("reads a quoted `<<` as text rather than as a heredoc", () => {
      const lines = highlight(
        'FROM a\nRUN echo "a <<EOF b"\nFROM x AS y\n',
      );

      expect(classesOf(lines, "y")).toEqual(["functionName"]);
    });

    it("runs a single heredoc as the script when it names a file descriptor or strips tabs", () => {
      const lines = highlight(
        "RUN 3<<EOF\nmake\nEOF\nRUN <<-EOF\n\tls\n\tEOF\n",
      );

      expect(classesOf(lines, "make")).toEqual(["callName"]);
      expect(classesOf(lines, "ls")).toEqual(["callName"]);
      expect(classesOf(lines, "\tEOF")).toEqual(["string"]);
    });

    it("ends a heredoc at a partly quoted delimiter, and colors no references in its body", () => {
      const lines = highlight('COPY <<E"O"F /x\n$HOME\nEOF\nUSER app\n');

      expect(classesOf(lines, "$HOME")).toEqual(["string"]);
      expect(classesOf(lines, "USER")).toEqual(["keyword"]);
    });

    it("reads a heredoc marker that a continuation splits", () => {
      const lines = highlight(
        "COPY <\\\n# Note.\n<E\\\nOF /x\nRUN ls\nEOF\nUSER app\n",
      );

      expect(classesOf(lines, "<")).toEqual(["operator"]);
      expect(classesOf(lines, "# Note.")).toEqual(["comment"]);
      expect(classesOf(lines, "RUN ls")).toEqual(["string"]);
      expect(classesOf(lines, "USER")).toEqual(["keyword"]);
    });

    it("ends a heredoc at a delimiter that a backslash escapes, and colors the references in its body", () => {
      const lines = highlight(
        "COPY <<\\EOF /x\n$HOME\nEOF\nRUN cat <<\\EOF\nbody\nEOF\nUSER app\n",
      );

      expect(classesOf(lines, "HOME")).toEqual(["propertyName"]);
      expect(classesOf(lines, "USER")).toEqual(["keyword"]);
    });

    it("reads blanks after `<<`, but not after `<<-`, as part of the heredoc marker", () => {
      const source = "FROM a AS build\nCOPY << EOF /etc/x\nFROM b\nEOF\n" +
        "RUN cat << EOF\nhi\nEOF\nCOPY <<- EOF /y\nUSER app\n";
      const lines = highlight(source);

      expect(classesOf(lines, "FROM b")).toEqual(["string"]);
      expect(classesOf(lines, "hi")).toEqual(["string"]);
      expect(classesOf(lines, "USER")).toEqual(["keyword"]);
      expect(
        dockerfileLanguage.parseDocument(source).structure.map((node) =>
          node.label
        ),
      ).toEqual(["build"]);
    });

    it("reads a `<<-` with no delimiter as text rather than as a heredoc", () => {
      const lines = highlight("RUN cat <<-\nFROM x AS y\n");

      expect(classesOf(lines, "y")).toEqual(["functionName"]);
    });

    it("reads a heredoc body with BuildKit's backslash escape whatever the `escape` directive names", () => {
      const lines = highlight(
        "# escape=`\nCOPY <<EOF /x\n`$HOME \\$USER\nEOF\n",
      );

      expect(classesOf(lines, "HOME")).toEqual(["propertyName"]);
      expect(classesOf(lines, " \\$USER")).toEqual(["string"]);
    });

    it("ends a heredoc at a quoted delimiter that holds blanks", () => {
      const lines = highlight("COPY <<'E O F' /x\nbody\nE O F\nUSER app\n");

      expect(classesOf(lines, "'E O F'")).toEqual(["string"]);
      expect(classesOf(lines, "USER")).toEqual(["keyword"]);
    });

    it("colors heredoc markers that no body follows", () => {
      for (const source of ["RUN <<EOF", "COPY <<A <<B /\na\nA"]) {
        const lines = highlight(source);

        expect(classesOf(lines, "<<")).toEqual(["operator"]);
      }
    });

    it("reads an opening line that is not an instruction as shell, as a diff hunk inside a command shows it", () => {
      const lines = highlight(
        "    apt-get install -y curl && \\\n    rm -rf /tmp/x\nmake all\n",
      );

      expect(classesOf(lines, "apt-get")).toEqual(["callName"]);
      expect(classesOf(lines, "rm")).toEqual(["callName"]);
      expect(classesOf(lines, "make")).toEqual(["plain"]);
    });

    it("leaves `MAINTAINER` text without variable references", () => {
      const lines = highlight("MAINTAINER Someone $NAME\n");

      expect(classesOf(lines, "MAINTAINER")).toEqual(["keyword"]);
      expect(classesOf(lines, "$NAME")).toEqual(["plain"]);
    });
  });

  describe("structure", () => {
    it("lists each stage, by name or base image, with the variables it sets", () => {
      const document = dockerfileLanguage.parseDocument(
        "ARG BASE=ubuntu\n" +
          "FROM golang@sha256:0123 AS builder\n" +
          "ENV CGO_ENABLED=0\n" +
          "RUN go build\n" +
          "\n" +
          "FROM $BASE\n" +
          "ARG TARGETARCH\n" +
          "COPY --from=builder /out /out\n",
      );

      expect(outline(document.structure)).toEqual([
        ["ARG BASE", 0, 0, []],
        ["builder", 1, 3, ["ENV CGO_ENABLED"]],
        ["$BASE", 5, 7, ["ARG TARGETARCH"]],
      ]);
      expect(document.definitions.get("builder")?.[0].startLine).toBe(1);
      expect(document.definitions.get("CGO_ENABLED")?.[0].startLine).toBe(2);
      expect(document.structure[1].nameOffset).toBe(
        "ARG BASE=ubuntu\nFROM golang@sha256:0123 AS ".length,
      );
    });

    it("lists a stage name and a variable that a continuation splits under the joined names", () => {
      const document = dockerfileLanguage.parseDocument(
        "FROM x A\\\nS bui\\\nlder\nENV A\\\nB=1\n",
      );

      expect(outline(document.structure)).toEqual([
        ["builder", 0, 4, ["ENV AB"]],
      ]);
    });

    it("leaves `LABEL` keys and names that hold references out of the structure", () => {
      const document = dockerfileLanguage.parseDocument(
        "FROM x\nLABEL version=1\nENV ${X}=1\n",
      );

      expect(outline(document.structure)).toEqual([["x", 0, 2, []]]);
    });
  });
});
