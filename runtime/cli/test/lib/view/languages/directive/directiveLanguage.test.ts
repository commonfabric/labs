import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  languageForFile,
  languageForSource,
} from "../../../../../lib/view/languages/language.ts";
import { directiveLanguage } from "../../../../../lib/view/languages/directive/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

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

/** Each structure entry's label, name, depth, and first and last lines. */
function outline(
  source: string,
): [string, string | undefined, number, number, number][] {
  return directiveLanguage.parseDocument(source).flatStructure.map((node) => [
    node.label,
    node.name,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

const NGINX = [
  "worker_processes auto;",
  "events { worker_connections 1024; }",
  "http {",
  "    server_tokens off;",
  "    proxy_cache_path /var/cache/nginx levels=1:2",
  "                     max_size=1g inactive=5m;",
  "    # Match the original path.",
  "    map $request_uri $cache_path {",
  '        "~^[0-9]{8,}$" 1;',
  "    }",
  "    server {",
  "        listen 8080; # public",
  "        location = /health {",
  '            proxy_set_header Authorization "Bearer ${token}x";',
  "        }",
  "    }",
  "}",
].join("\n");

const NETDATA = [
  "# Alert for toolshed-binary services",
  "template: web_log_1m_internal_errors",
  "      on: web_log.type_requests",
  "  chart labels: unit_name=*toolshed*",
  "    calc: $this * 100 / $web_log_1m_requests",
  "    warn: ($this > 5) ? (1) : (0)",
  "   delay: down 60s multiplier 1.5 max 1h",
  "    info: server errors (5xx)",
  "",
  "alarm: web_log_1m_successful",
  "   every: 10s",
].join("\n");

const APACHE = [
  "<VirtualHost *:80>",
  '    ServerName "example.test"',
  "    <Directory /tmp/html/>",
  "        Options Indexes FollowSymLinks",
  "        RewriteRule ^/a$ /b \\",
  "            [L]",
  "    </directory>",
  "</VirtualHost>",
].join("\n");

describe("directiveLanguage", () => {
  it("selects nginx, Apache, and nftables files by name, and no other", () => {
    for (
      const name of [
        "images/benchmarks/nginx/nginx.conf",
        "nginx_gofer.conf",
        "NGINX.CONF",
        "httpd.conf",
        "apache2.conf",
        "httpd-vhosts.conf",
        "apache2-tmpdir.conf",
        "public/.htaccess",
        "files/cve-2026-98432.nft",
        "/etc/nftables.conf",
      ]
    ) {
      expect(languageForFile(name).id).toBe("directive");
    }
    for (
      const name of [
        "toolshed.conf",
        "nginxconf",
        "nginx.conf.txt",
        "deploy/users.conf",
        "apache2tmp.conf",
        "SQLite3/module.modulemap",
      ]
    ) {
      expect(languageForFile(name).id).not.toBe("directive");
    }
  });

  it("selects a `.conf` file whose first statement is a directive's", () => {
    expect(languageForSource("health.d/web_log.conf", NETDATA).id)
      .toBe("directive");
    expect(languageForSource("sites/default.conf", APACHE).id)
      .toBe("directive");
    expect(languageForSource("sites/default.conf", NGINX).id)
      .toBe("directive");
    expect(languageForSource("a.conf", "\n# note\nserver {\n}").id)
      .toBe("directive");
    expect(languageForSource("a.conf", "user nginx; # who\n").id)
      .toBe("directive");
    expect(languageForSource("a.conf", "alarm : x").id).toBe("directive");
    expect(languageForSource("a.conf", "<DirectoryMatch ^/a>\n").id)
      .toBe("directive");
    expect(languageForSource("a.conf", "<virtualhost *:80>\n").id)
      .toBe("directive");
    expect(languageForSource("a.conf", "<IfFile /x>\n").id).toBe("directive");
    expect(languageForSource("a.conf", "<directorymatch ^/a>\n").id)
      .toBe("directive");
    expect(languageForSource("users.conf", "u! root 0\n").id)
      .toBe("directive");
    expect(
      languageForSource("default.conf", "events { worker_connections 1; }").id,
    ).toBe("directive");
    expect(
      languageForSource(
        "deploy/users.conf",
        '# users\nu memory-router-key 991 "Memory TLS key" - -',
      ).id,
    ).toBe("directive");
    expect(
      languageForSource(undefined, "#!/usr/sbin/nft -f\nflush ruleset")
        .id,
    ).toBe("directive");
  });

  it("leaves other `.conf` syntaxes to their own languages or to plain text", () => {
    for (
      const source of [
        "d /run/legibility 0755 legibility legibility -",
        "r /run/legibility",
        "u\n",
        "user: x\n",
        ";;;;;;;;;;;;\n; FPM\n;;;;;;;;;;;;\n[global]\npid = /run/fpm.pid",
        ";\n[global]",
        "name: {a: 1}",
        "<fontconfig>\n</fontconfig>",
        "U x\n",
        '{"Dhcp4": {}}',
        "#!/bin/sh\nset -eu; exec foo",
        'JAVA_OPTS="-Xmx1g -Dfoo=${BAR}"',
        "NAME=value; other",
        "u = 1\ng = 9.81",
        "key = a;b",
        "jobs:\n  - a;b",
        "[Service]\nMemoryMax=4G",
        "ServerRoot /etc/httpd",
        "flush ruleset\n# a ; b {",
        "",
      ]
    ) {
      expect(languageForSource("deploy/users.conf", source).id)
        .not.toBe("directive");
    }
    expect(languageForSource("go.d/systemdunits.conf", "jobs:\n  - name: x").id)
      .toBe("yaml");
    expect(languageForSource("nginx.txt", NGINX).id).toBe("plain-text");
  });

  it("colors directives, arguments, strings, variables, numbers, and booleans", () => {
    const lines = directiveLanguage.highlightLines(NGINX);

    expect(classesOf(lines, "worker_processes")).toEqual(["keyword"]);
    expect(classesOf(lines, "auto")).toEqual(["plain"]);
    expect(classesOf(lines, ";")).toEqual(["punctuation"]);
    expect(classesOf(lines, "{")).toEqual(["bracket"]);
    expect(classesOf(lines, "}")).toEqual(["bracket"]);
    expect(classesOf(lines, "1024")).toEqual(["number"]);
    expect(classesOf(lines, "1g")).toEqual([]);
    expect(classesOf(lines, "max_size=1g")).toEqual(["plain"]);
    expect(classesOf(lines, "off")).toEqual(["boolean"]);
    expect(classesOf(lines, "8080")).toEqual(["number"]);
    expect(classesOf(lines, "# public")).toEqual(["comment"]);
    expect(classesOf(lines, "# Match the original path.")).toEqual([
      "comment",
    ]);
    expect(classesOf(lines, "$request_uri")).toEqual(["propertyName"]);
    expect(classesOf(lines, '"~^[0-9]{8,}$"')).toEqual(["string"]);
    expect(classesOf(lines, '"Bearer ')).toEqual(["string"]);
    expect(classesOf(lines, "${token}")).toEqual(["propertyName"]);
    expect(classesOf(lines, 'x"')).toEqual(["string"]);
    expect(verbatim(lines)).toBe(NGINX);
  });

  it("continues a statement on a line indented further than its first", () => {
    const lines = directiveLanguage.highlightLines(NGINX);

    expect(classesOf(lines, "proxy_cache_path")).toEqual(["keyword"]);
    expect(classesOf(lines, "inactive=5m")).toEqual(["plain"]);
    expect(
      classesOf(
        directiveLanguage.highlightLines(
          "gzip_types\n\n    # types\n    text/css;\nnext 1;",
        ),
        "text/css",
      ),
    ).toEqual(["plain"]);
  });

  it("starts a statement on each line that sets a key, however it is indented", () => {
    const lines = directiveLanguage.highlightLines(NETDATA);

    for (const key of ["template", "on", "chart", "labels", "calc", "warn"]) {
      expect(classesOf(lines, key)).toEqual(["keyword"]);
    }
    // A key's `:` is punctuation, and the `:` of an expression is plain.
    expect(classesOf(lines, ":")).toEqual(["punctuation", "plain"]);
    expect(classesOf(lines, "web_log.type_requests")).toEqual(["plain"]);
    expect(classesOf(lines, "unit_name=*toolshed*")).toEqual(["plain"]);
    expect(classesOf(lines, "$this")).toEqual(["propertyName"]);
    expect(classesOf(lines, "$web_log_1m_requests")).toEqual(["propertyName"]);
    expect(classesOf(lines, "(")).toEqual(["bracket"]);
    expect(classesOf(lines, "60s")).toEqual(["number"]);
    expect(classesOf(lines, "1.5")).toEqual(["number"]);
    expect(classesOf(lines, "1h")).toEqual(["number"]);
    expect(classesOf(lines, "5xx")).toEqual(["plain"]);
    expect(verbatim(lines)).toBe(NETDATA);
  });

  it("colors Apache section tags and continues a line that ends with `\\`", () => {
    const lines = directiveLanguage.highlightLines(APACHE);

    expect(classesOf(lines, "<")).toEqual(["punctuation"]);
    expect(classesOf(lines, "VirtualHost")).toEqual(["typeName"]);
    expect(classesOf(lines, "*:80")).toEqual(["plain"]);
    expect(classesOf(lines, ">")).toEqual(["punctuation"]);
    expect(classesOf(lines, "/tmp/html/")).toEqual(["plain"]);
    expect(classesOf(lines, "</")).toEqual(["punctuation"]);
    expect(classesOf(lines, "directory")).toEqual(["typeName"]);
    expect(classesOf(lines, "ServerName")).toEqual(["keyword"]);
    expect(classesOf(lines, '"example.test"')).toEqual(["string"]);
    expect(classesOf(lines, "RewriteRule")).toEqual(["keyword"]);
    expect(classesOf(lines, "L")).toEqual(["plain"]);
    expect(verbatim(lines)).toBe(APACHE);
  });

  it("reads a `${name}` or `%{name}` outside quotes as a reference inside its word", () => {
    const source = [
      "ErrorLog ${APACHE_LOG_DIR}/error.log",
      "RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R]",
      "calc: ${this} * 2",
    ].join("\n");
    const lines = directiveLanguage.highlightLines(source);

    expect(classesOf(lines, "${APACHE_LOG_DIR}")).toEqual(["propertyName"]);
    expect(classesOf(lines, "/error.log")).toEqual(["plain"]);
    expect(classesOf(lines, "%{HTTP_HOST}%{REQUEST_URI}")).toEqual([
      "propertyName",
    ]);
    expect(classesOf(lines, "${this}")).toEqual(["propertyName"]);
    expect(classesOf(lines, "*")).toEqual(["plain"]);
    expect(outline(source)).toEqual([]);
  });

  it("reads a `{` followed by a comma on its line as a list, not a block", () => {
    const source = [
      "table inet filter {",
      "  chain input {",
      "    tcp dport { 22, 80, 443 } accept",
      "    ct state vmap { established : accept, invalid : drop }",
      "    elements = { 10.0.0.1,",
      "                 10.0.0.2 }",
      "  }",
      "}",
    ].join("\n");
    const lines = directiveLanguage.highlightLines(source);

    expect(classesOf(lines, "22")).toEqual(["number"]);
    expect(classesOf(lines, ",")).toEqual(["punctuation"]);
    expect(classesOf(lines, "accept")).toEqual(["plain"]);
    expect(classesOf(lines, "established")).toEqual(["plain"]);
    expect(outline(source)).toEqual([
      ["table inet filter", "filter", 0, 0, 7],
      ["chain input", "input", 1, 1, 6],
    ]);
  });

  it("starts a string only at the start of a word, and ends it at its line's end", () => {
    const lines = directiveLanguage.highlightLines(
      "info: the server's load\nroot \"/tmp\nnext 'a\\\nb",
    );

    expect(classesOf(lines, "server's")).toEqual(["plain"]);
    expect(classesOf(lines, '"/tmp')).toEqual(["string"]);
    expect(classesOf(lines, "next")).toEqual(["keyword"]);
    expect(classesOf(lines, "'a\\")).toEqual(["string"]);
    expect(classesOf(lines, "b")).toEqual(["plain"]);
  });

  it("names a block whose `{` starts the next line by the statement before it", () => {
    expect(outline("http\n{\n  server\n  {\n  }\n}")).toEqual([
      ["http", undefined, 0, 0, 5],
      ["server", undefined, 1, 2, 4],
    ]);
    expect(outline("a;\n{\n}")).toEqual([["{", undefined, 0, 1, 2]]);
  });

  it("leaves a parenthesized condition out of a block's name", () => {
    expect(outline("if ($a = b) {\n}\nlocation ~ (x) /y {\n}")).toEqual([
      ["if ($a = b)", undefined, 0, 0, 1],
      ["location ~ (x) /y", "/y", 0, 2, 3],
    ]);
  });

  it("does not continue a statement past a blank line after a `\\`", () => {
    const lines = directiveLanguage.highlightLines(
      "RewriteCond a \\\n\n  RewriteRule b",
    );

    expect(classesOf(lines, "RewriteRule")).toEqual(["keyword"]);
  });

  it("reads a `#` line after a `\\` as the continued statement's text", () => {
    const lines = directiveLanguage.highlightLines(
      "RewriteCond a \\\n# note\nRewriteRule b",
    );

    expect(classesOf(lines, "#")).toEqual(["plain"]);
    expect(classesOf(lines, "RewriteRule")).toEqual(["keyword"]);
  });

  it("reads a `;`, `{`, or `<` inside a section tag as part of the tag", () => {
    for (const unit of ["<If ;", "< {", "<x ;{ "]) {
      const source = `a;\n${unit.repeat(5_000)}\n`;
      const document = directiveLanguage.parseDocument(source);

      expect(verbatim(document.lines)).toBe(source);
      expect(document.flatStructure.length).toBeLessThanOrEqual(1);
    }
  });

  it("does not continue a statement past a `\\` inside a comment", () => {
    const lines = directiveLanguage.highlightLines(
      "a 1;\nx 1 # see C:\\\nnext 2;",
    );

    expect(classesOf(lines, "next")).toEqual(["keyword"]);
  });

  it("reads only lowercase words before a `:` as a key", () => {
    const lines = directiveLanguage.highlightLines("add_header Server: x;");

    expect(classesOf(lines, "add_header")).toEqual(["keyword"]);
    expect(classesOf(lines, "Server:")).toEqual(["plain"]);
  });

  it("reads quotes inside a section tag, where `>` does not close it", () => {
    const lines = directiveLanguage.highlightLines(
      "<If \"%{X} == 'a>b'\">\n</If>",
    );

    expect(classesOf(lines, " == 'a>b'\"")).toEqual(["string"]);
    expect(classesOf(lines, "b")).toEqual([]);
    expect(classesOf(lines, ">")).toEqual(["punctuation"]);
    expect(classesOf(lines, "If")).toEqual(["typeName"]);
  });

  it("reads only a `{` that ends its line as a block where lines do not end with `;`", () => {
    const source = [
      "RewriteCond %{REQUEST_URI} ^/[0-9]{4}/",
      "RewriteRule ^/x{3}$ /y",
      "table ip t {",
      "  tcp dport { 22, 80 } accept",
      "}",
    ].join("\n");
    const lines = directiveLanguage.highlightLines(source);

    expect(classesOf(lines, "4")).toEqual(["number"]);
    expect(classesOf(lines, "$")).toEqual(["plain"]);
    expect(classesOf(lines, "accept")).toEqual(["plain"]);
    expect(outline(source)).toEqual([["table ip t", "t", 0, 2, 4]]);
  });

  it("reads a `#` after the start of a line as text where lines do not end with `;`", () => {
    const lines = directiveLanguage.highlightLines("info: count of # files");

    expect(classesOf(lines, "#")).toEqual(["plain"]);
    expect(classesOf(lines, "files")).toEqual(["plain"]);
    expect(outline("a { # x\n}")).toEqual([]);
  });

  it("reads lines that end with `;` only outside comments, and before a closing `}`", () => {
    const commented = directiveLanguage.highlightLines(
      '# Example: Header set X "a; b";\nRewriteCond a\n    RewriteRule b',
    );
    expect(classesOf(commented, "RewriteRule")).toEqual(["keyword"]);

    const oneLine = directiveLanguage.highlightLines(
      "location /b { return 204; }",
    );
    expect(classesOf(oneLine, ";")).toEqual(["punctuation"]);
  });

  it("reads a `{` closed on its line around content with no `;` as a list", () => {
    const source = "chain c {\n  tcp dport { 22 } accept;\n  events {}\n}";
    const lines = directiveLanguage.highlightLines(source);

    expect(classesOf(lines, "accept")).toEqual(["plain"]);
    expect(outline(source)).toEqual([
      ["chain c", "c", 0, 0, 3],
      ["events", undefined, 1, 2, 2],
    ]);
  });

  it("reads a `{` after `=`, or followed by a comma on its line, as a list", () => {
    const source = [
      'location / { add_header Cache-Control "no-cache, no-store"; }',
      "http {",
      "    # Basic settings, tuned",
      "    set allowed {",
      "      elements = {",
      "        10.0.0.1, 10.0.0.2",
      "      }",
      "    };",
      "    chain allow_est {",
      "      ct state established,related accept;",
      "    }",
      "}",
    ].join("\n");
    const lines = directiveLanguage.highlightLines(source);

    expect(classesOf(lines, "add_header")).toEqual(["keyword"]);
    expect(classesOf(lines, "10.0.0.1")).toEqual(["plain"]);
    expect(outline(source)).toEqual([
      ["location /", "/", 0, 0, 0],
      ["http", undefined, 0, 1, 11],
      ["set allowed", "allowed", 1, 3, 7],
      ["chain allow_est", "allow_est", 1, 8, 10],
    ]);
  });

  it("ends statements at line feeds in a source whose lines do not end with `;`", () => {
    const source = [
      "Alias /static /srv/static",
      "    <Directory /srv/static>",
      "        Require all granted",
      "    </Directory>",
      "ServerName a",
      "    DocumentRoot /x",
      "info: the server's errors; see docs",
    ].join("\n");
    const lines = directiveLanguage.highlightLines(source);

    expect(classesOf(lines, "Require")).toEqual(["keyword"]);
    expect(classesOf(lines, "DocumentRoot")).toEqual(["keyword"]);
    expect(classesOf(lines, "errors;")).toEqual(["plain"]);
    expect(classesOf(lines, "see")).toEqual(["plain"]);
    expect(outline(source)).toEqual([
      ["<Directory /srv/static>", "/srv/static", 0, 1, 3],
    ]);
  });

  it("continues a quoted string over several lines in a source whose lines end with `;`", () => {
    const source = [
      `add_header Content-Security-Policy "default-src 'self';`,
      "    # still the header",
      `    script-src 'self'";`,
      "next 1;",
    ].join("\n");
    const lines = directiveLanguage.highlightLines(source);

    expect(classesOf(lines, "    # still the header")).toEqual(["string"]);
    expect(classesOf(lines, `    script-src 'self'"`)).toEqual(["string"]);
    expect(classesOf(lines, "next")).toEqual(["keyword"]);
  });

  it("reads every opening section tag as opening a section", () => {
    expect(outline("<Directory />\n  Options None\n</Directory>\nnext"))
      .toEqual([["<Directory />", "/", 0, 0, 2]]);
  });

  it("reads an escaped quote inside a section tag as part of its string", () => {
    const source =
      'listen 80;\n<If "%{X} =~ /a\\">\n  Require all granted\n</If>\nnext 1;';
    const lines = directiveLanguage.highlightLines(source);

    expect(classesOf(lines, "Require")).toEqual(["keyword"]);
    expect(classesOf(lines, "next")).toEqual(["keyword"]);
  });

  it("reads only the code before a comment when deciding whether `;` ends statements", () => {
    const commented = directiveLanguage.highlightLines(
      "a b # see c;\nRewriteRule ^/x{2}$ /y\n",
    );
    expect(classesOf(commented, "2")).toEqual(["number"]);

    const terse = directiveLanguage.highlightLines(
      "a 1;#first\nb 2;# second\nc\n  3;",
    );
    expect(classesOf(terse, "#first")).toEqual(["comment"]);
    expect(classesOf(terse, "3")).toEqual(["number"]);

    const quoted = directiveLanguage.highlightLines(
      'add_header X "bar # baz";\nc\n  3;',
    );
    expect(classesOf(quoted, '"bar # baz"')).toEqual(["string"]);

    const apostrophe = directiveLanguage.highlightLines(
      "info: the server's load # a;\nnext x # note",
    );
    expect(classesOf(apostrophe, "# note")).toEqual([]);
    expect(classesOf(apostrophe, "note")).toEqual(["plain"]);
    expect(classesOf(quoted, "3")).toEqual(["number"]);
  });

  it("decides whether `;` ends statements from most statement lines", () => {
    const apache = directiveLanguage.highlightLines(
      "php_admin_value open_basedir /var/www:/tmp;\nRewriteRule ^/x{2}$ /y\n" +
        "RewriteEngine on\nServerName a",
    );
    expect(classesOf(apache, "2")).toEqual(["number"]);

    const nginx = directiveLanguage.highlightLines(
      "http {\n  a 1;\n  b 2;\n  c\n    3;\n}",
    );
    expect(classesOf(nginx, "3")).toEqual(["number"]);
    expect(classesOf(nginx, "c")).toEqual(["keyword"]);
  });

  it("reads a `{` after `=` as a list wherever it falls on its line", () => {
    const lines = directiveLanguage.highlightLines(
      "elements = { 10.0.0.0/8, 192.168.0.0/16,\n             172.16.0.0/12 }\nnext x",
    );

    expect(classesOf(lines, "172.16.0.0/12")).toEqual(["plain"]);
    expect(classesOf(lines, "next")).toEqual(["keyword"]);
  });

  it("reads a `{` whose comma comes before a `;` on its line as a block", () => {
    const source =
      "location /x { add_header Cache-Control no-store,no-cache; }\nnext 1;";

    expect(outline(source)).toEqual([["location /x", "/x", 0, 0, 0]]);
    expect(classesOf(directiveLanguage.highlightLines(source), "add_header"))
      .toEqual(["keyword"]);
  });

  it("starts a comment only at a `#` after white space, `;`, `{`, or `}`", () => {
    const source = "location ~ ^/(#x) {\n  b 2;\n}";

    expect(outline(source)).toEqual([["location ~ ^/(#x)", "^/", 0, 0, 2]]);
    expect(classesOf(directiveLanguage.highlightLines(source), "b"))
      .toEqual(["keyword"]);
  });

  it("reconstructs a run of section tags with no space, and lines holding a carriage return", () => {
    for (const unit of ["<A/x>", "x ;# \r"]) {
      const source = `a;\n${unit.repeat(20_000)}\n`;
      expect(verbatim(directiveLanguage.parseDocument(source).lines)).toBe(
        source,
      );
    }
  });

  it("continues a statement on each line of an open list", () => {
    const lines = directiveLanguage.highlightLines(
      "set s {\n  elements = {\n    10.0.0.1,\n    10.0.0.2\n  }\n}",
    );

    expect(classesOf(lines, "10.0.0.1")).toEqual(["plain"]);
    expect(classesOf(lines, "10.0.0.2")).toEqual(["plain"]);
  });

  it("starts Netdata entries only at the top level, each ending at the next", () => {
    expect(outline("a {\n  alarm: x;\n}\nb;")).toEqual([
      ["a", undefined, 0, 0, 2],
    ]);
    expect(outline("alarm: x\n  on: y\n\n# c\nalarm: z")).toEqual([
      ["alarm: x", "x", 0, 0, 1],
      ["alarm: z", "z", 0, 4, 4],
    ]);
  });

  it("lists blocks nested deeper than the call stack, outermost first", () => {
    const document = directiveLanguage.parseDocument("a {\n".repeat(20_000));

    expect(document.flatStructure.length).toBe(20_000);
    expect(document.flatStructure.map((node) => node.depth).slice(-2))
      .toEqual([19_998, 19_999]);
    expect(document.flatStructure[0].endLine).toBe(19_999);
  });

  it("closes nothing at a `}` or a closing tag that no open entry matches", () => {
    expect(outline("<a>\n}\n</b>\nc {\n</a>\nd")).toEqual([
      ["<a>", undefined, 0, 0, 4],
      ["c", undefined, 1, 3, 4],
    ]);
  });

  it("lists blocks by the statement that opens them, named by its last word", () => {
    expect(outline(NGINX)).toEqual([
      ["events", undefined, 0, 1, 1],
      ["http", undefined, 0, 2, 16],
      ["map $request_uri $cache_path", "$cache_path", 1, 7, 9],
      ["server", undefined, 1, 10, 15],
      ["location = /health", "/health", 2, 12, 14],
    ]);
    expect(outline("module SQLite3 [system] {\n  export *;\n}")).toEqual([
      ["module SQLite3 [system]", "SQLite3", 0, 0, 2],
    ]);
    expect(outline("a [ (b [c] {\n}")[0][1]).toBe("(b");
    const document = directiveLanguage.parseDocument(NGINX);
    expect(document.definitions.get("/health")?.map((d) => d.startLine))
      .toEqual([12]);
  });

  it("lists Apache sections, closing each at the tag that names it in any case", () => {
    expect(outline(APACHE)).toEqual([
      ["<VirtualHost *:80>", "*:80", 0, 0, 7],
      ["<Directory /tmp/html/>", "/tmp/html/", 1, 2, 6],
    ]);
    expect(outline("<IfModule a>\n</Location>\nb c\n<Files>\n</IfModule>"))
      .toEqual([
        ["<IfModule a>", "a", 0, 0, 4],
        ["<Files>", undefined, 1, 3, 4],
      ]);
  });

  it("lists each Netdata alert entry up to the next one", () => {
    expect(outline(NETDATA)).toEqual([
      [
        "template: web_log_1m_internal_errors",
        "web_log_1m_internal_errors",
        0,
        1,
        7,
      ],
      ["alarm: web_log_1m_successful", "web_log_1m_successful", 0, 9, 10],
    ]);
    expect(outline("template: a # note\n")[0][1]).toBe("a # note");
    expect(outline("template:\n  on: x")).toEqual([
      ["template:", undefined, 0, 0, 1],
    ]);
  });

  it("ignores a stray `}`, and extends an unclosed block to the end", () => {
    expect(
      outline("}\na {\n  b;\n").map(([label, , , start, end]) => [
        label,
        start,
        end,
      ]),
    ).toEqual([["a", 1, 2]]);
    expect(outline("{ x; }")).toEqual([["{", undefined, 0, 0, 0]]);
  });

  it("ends lines only where the pager does, at a line feed", () => {
    const source = "a {\r\n  b 1;\r\n}\r\nc 2\rd";
    const document = directiveLanguage.parseDocument(source);

    expect(classesOf(document.lines, "1")).toEqual(["number"]);
    expect(classesOf(document.lines, "2")).toEqual(["number"]);
    expect(classesOf(document.lines, "d")).toEqual(["plain"]);
    expect(outline(source)).toEqual([["a", undefined, 0, 0, 2]]);
    expect(verbatim(document.lines)).toBe(source);
  });

  it("reconstructs incomplete input exactly", () => {
    for (
      const source of [
        "a {",
        'root "/tmp/ht',
        "root '/tmp\\'",
        "<Directory /tmp",
        "</",
        "warn: (($status",
        "x ${unclosed",
        "k ☕ 😀;",
        "",
        "\n\n",
      ]
    ) {
      expect(verbatim(directiveLanguage.parseDocument(source).lines)).toBe(
        source,
      );
    }
    expect(
      classesOf(directiveLanguage.highlightLines('root "/tmp/ht'), '"/tmp/ht'),
    ).toEqual(["string"]);
    expect(outline("<Directory /tmp")).toEqual([
      ["<Directory /tmp", "/tmp", 0, 0, 0],
    ]);
  });

  it("recolors each edit", () => {
    const highlighter = directiveLanguage.createHighlighter("a 1;");
    expect(highlighter.update("a 1;")).toBe(highlighter.lines);
    expect(classesOf(highlighter.update("a on;"), "on")).toEqual(["boolean"]);
  });
});
