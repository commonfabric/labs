import { expect } from "@std/expect";

import { authorizedKeysLanguage } from "../../../../../lib/view/languages/authorized-keys/language.ts";
import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import type { Line } from "../../../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Each colored span of `source` other than white space, as `class:text`. */
function spans(source: string): string[] {
  return authorizedKeysLanguage.highlightLines(source).flatMap((line) =>
    line.spans.filter((span) => span.cls !== "whitespace").map((span) =>
      `${span.cls}:${span.text}`
    )
  );
}

const ED25519 =
  "AAAAC3NzaC1lZDI1NTE5AAAAIOBQEYE5U9wooasEc65wjRyBmOMI2ikTlmu0kOtGDpsI";

describe("authorizedKeysLanguage", () => {
  it("selects authorized keys files and public key files by name", () => {
    for (
      const name of [
        ".ssh/authorized_keys",
        ".ssh/authorized_keys2",
        "files/deploy_authorized_keys",
        "keys/ci.authorized_keys",
        "tofu/infra-read-key.pub",
        "id_ed25519.PUB",
      ]
    ) {
      expect([name, languageForFile(name).id]).toEqual([
        name,
        "authorized-keys",
      ]);
    }
    for (
      const name of ["authorized_keys.bak", "known_hosts", "unauthorized_keyss"]
    ) {
      expect(languageForFile(name).id).toBe("plain-text");
    }
  });

  it("colors a key's type, its data, and its comment", () => {
    expect(spans(`ssh-ed25519 ${ED25519} alice@laptop (work)`)).toEqual([
      "typeName:ssh-ed25519",
      `string:${ED25519}`,
      "comment:alice@laptop (work)",
    ]);
    expect(spans(`sk-ssh-ed25519@openssh.com ${ED25519}`)).toEqual([
      "typeName:sk-ssh-ed25519@openssh.com",
      `string:${ED25519}`,
    ]);
  });

  it("colors options, whose quoted values may hold commas, spaces, and escaped quotes", () => {
    expect(
      spans(
        `restrict,from="10.0.0.0/8,::1",command="echo \\"a b\\"" ecdsa-sha2-nistp256 ${ED25519} ci`,
      ),
    ).toEqual([
      "propertyName:restrict",
      "punctuation:,",
      "propertyName:from",
      "operator:=",
      'string:"10.0.0.0/8,::1"',
      "punctuation:,",
      "propertyName:command",
      "operator:=",
      'string:"echo \\"a b\\""',
      "typeName:ecdsa-sha2-nistp256",
      `string:${ED25519}`,
      "comment:ci",
    ]);
  });

  it("colors comment lines, and leaves a line that lists no key uncolored", () => {
    expect(spans("  # Managed by Ansible")).toEqual([
      "comment:# Managed by Ansible",
    ]);
    expect(spans("restrict,from=x not-a-key data")).toEqual([
      "plain:restrict,from=x",
      "plain:not-a-key",
      "plain:data",
    ]);
    expect(spans("ssh-rsa\u00a0AAAA c")).toEqual([
      "plain:ssh-rsa",
      "plain:AAAA",
      "plain:c",
    ]);
    expect(spans('restrict,command="unclosed ssh-rsa AAAA')).toEqual([
      'plain:restrict,command="unclosed',
      "plain:ssh-rsa",
      "plain:AAAA",
    ]);
  });

  it("lists each key under its comment, or its type when it has none", () => {
    const document = authorizedKeysLanguage.parseDocument(
      [
        "# Deploy keys",
        `ssh-ed25519 ${ED25519} deploy@ci`,
        "",
        `no-pty ssh-rsa ${ED25519}`,
      ].join("\n"),
    );
    expect(
      document.flatStructure.map((node) => [node.label, node.startLine]),
    ).toEqual([["deploy@ci", 1], ["ssh-rsa", 3]]);
  });

  it("reconstructs incomplete input and carriage returns exactly", () => {
    for (
      const source of [
        `ssh-ed25519 ${ED25519} a\r\n\r\nssh-rsa`,
        'command="',
        "",
        "ssh-ed25519",
      ]
    ) {
      expect(verbatim(authorizedKeysLanguage.highlightLines(source))).toBe(
        source,
      );
    }
    const document = authorizedKeysLanguage.parseDocument(
      `# keys\r\nssh-rsa ${ED25519}\r\n`,
    );
    expect(document.lines[0].spans.map((span) => span.text)).toEqual([
      "# keys",
      "\r",
    ]);
    expect(document.flatStructure[0].endOffset).toBe(8 + 8 + ED25519.length);
    expect(spans(`ssh-ed25519 ${ED25519} a\r\n`)).toEqual([
      "typeName:ssh-ed25519",
      `string:${ED25519}`,
      "comment:a",
    ]);
  });

  it("recolors each edit", () => {
    const highlighter = authorizedKeysLanguage.createHighlighter("ssh-rsa");
    const lines = highlighter.update("# ssh-rsa");
    expect(lines[0].spans.map((span) => span.cls)).toEqual(["comment"]);
  });
});
