import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { sqlLanguage } from "../../../../../lib/view/languages/sql/language.ts";
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

/** Each structure entry's label, kind, depth, and first and last lines. */
function outline(source: string): [string, string, number, number, number][] {
  return sqlLanguage.parseDocument(source).flatStructure.map((node) => [
    node.label,
    node.kind,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

const MIGRATION = [
  "-- Contacts and what they receive.",
  "create table if not exists public.contacts (",
  "  id uuid primary key default gen_random_uuid(),",
  "  email text not null unique,",
  "  status subscription_status not null default 'pending',",
  "  type text,",
  "  tags text[] not null default '{}',",
  "  primary key (id, email),",
  "  check (email <> '')",
  ");",
  "create unique index if not exists contacts_email on contacts (lower(email));",
  "create index on contacts (status);",
  "alter table only contacts add column if not exists notes text,",
  "  add constraint notes_short check (length(notes) < 100),",
  "  add seen_at timestamptz;",
  "create type subscription_status as enum ('pending', 'subscribed');",
].join("\n");

const FUNCTION = [
  "create or replace function contacts_guard() returns trigger",
  "language plpgsql as $body$",
  "declare",
  "  previous text := old.status;",
  "  wanted constant subscription_status;",
  "begin",
  "  if new.status <> previous then",
  "    raise exception 'status changed' using errcode = 'check_violation';",
  "  end if;",
  "  create table inside_body (x int);",
  "  return new;",
  "end $body$;",
  "create trigger contacts_guard before update on contacts",
  "  for each row execute function contacts_guard();",
].join("\n");

describe("sqlLanguage", () => {
  it("selects `.sql` files whatever the case of the extension", () => {
    expect(languageForFile("packages/crm/migrations/001_init.sql").id)
      .toBe("sql");
    expect(languageForFile("db/SCHEMA.SQL").id).toBe("sql");
    expect(languageForFile("db/schema.sqlite").id).not.toBe("sql");
  });

  it("colors keywords, types, names, literals, and punctuation in a migration", () => {
    const lines = sqlLanguage.highlightLines(MIGRATION);

    expect(classesOf(lines, "-- Contacts and what they receive."))
      .toEqual(["comment"]);
    expect(classesOf(lines, "create")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "table")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "not")).toEqual(["keyword"]);
    expect(classesOf(lines, "uuid")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "gen_random_uuid")).toEqual(["callName"]);
    expect(classesOf(lines, "lower")).toEqual(["callName"]);
    expect(classesOf(lines, "'pending'")).toEqual(["string"]);
    expect(classesOf(lines, "'{}'")).toEqual(["string"]);
    expect(classesOf(lines, "<>")).toEqual(["operator"]);
    expect(classesOf(lines, "<")).toEqual(["operator"]);
    expect(classesOf(lines, "100")).toEqual(["number"]);
    expect(classesOf(lines, ";")).toEqual(["punctuation"]);
    expect(classesOf(lines, "(")).toEqual(["bracket"]);
    expect(verbatim(lines)).toBe(MIGRATION);
  });

  it("colors the names a statement declares and the column types SQL does not define", () => {
    const lines = sqlLanguage.highlightLines(MIGRATION);

    expect(classesOf(lines, "public")).toEqual(["identifier"]);
    expect(classesOf(lines, "contacts")).toEqual([
      "interfaceName",
      "identifier",
    ]);
    expect(classesOf(lines, "id")).toEqual(["binding", "identifier"]);
    // A column may take a keyword's name, as `type` does here.
    expect(classesOf(lines, "type")).toEqual(["binding", "storageKeyword"]);
    expect(classesOf(lines, "subscription_status")).toEqual([
      "typeName",
      "interfaceName",
    ]);
    expect(classesOf(lines, "contacts_email")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "seen_at")).toEqual(["binding"]);
    expect(classesOf(lines, "notes_short")).toEqual(["identifier"]);
  });

  it("lists created things and altered tables with the columns each defines", () => {
    expect(outline(MIGRATION)).toEqual([
      ["table contacts", "object", 0, 1, 9],
      ["id", "variable", 1, 2, 2],
      ["email", "variable", 1, 3, 3],
      ["status", "variable", 1, 4, 4],
      ["type", "variable", 1, 5, 5],
      ["tags", "variable", 1, 6, 6],
      ["index contacts_email", "object", 0, 10, 10],
      ["index", "object", 0, 11, 11],
      ["alter table contacts", "statement", 0, 12, 14],
      ["notes", "variable", 1, 12, 12],
      ["seen_at", "variable", 1, 14, 14],
      ["type subscription_status", "typeAlias", 0, 15, 15],
    ]);
    const definitions = sqlLanguage.parseDocument(MIGRATION).definitions;
    expect(definitions.get("contacts")?.map((d) => d.startLine)).toEqual([1]);
    expect(definitions.has("public")).toBe(false);
  });

  it("colors a body that follows `AS` or `DO` as SQL, and its declarations as declarations", () => {
    const lines = sqlLanguage.highlightLines(FUNCTION);

    expect(classesOf(lines, "contacts_guard")).toEqual([
      "functionName",
      "interfaceName",
      "callName",
    ]);
    expect(classesOf(lines, "$body$")).toEqual(["punctuation"]);
    expect(classesOf(lines, "declare")).toEqual(["keyword"]);
    expect(classesOf(lines, "previous")).toEqual(["binding", "identifier"]);
    expect(classesOf(lines, "wanted")).toEqual(["binding"]);
    expect(classesOf(lines, "subscription_status")).toEqual(["typeName"]);
    expect(classesOf(lines, "if")).toEqual(["controlKeyword"]);
    expect(classesOf(lines, "raise")).toEqual(["controlKeyword"]);
    expect(classesOf(lines, "new")).toEqual(["identifier", "keyword"]);
    expect(classesOf(lines, ":=")).toEqual(["operator"]);
    expect(classesOf(lines, "'status changed'")).toEqual(["string"]);
    expect(verbatim(lines)).toBe(FUNCTION);
  });

  it("keeps statements inside a body out of the structure tree", () => {
    expect(outline(FUNCTION)).toEqual([
      ["function contacts_guard", "function", 0, 0, 11],
      ["trigger contacts_guard", "object", 0, 12, 13],
    ]);
  });

  it("colors a dollar quote anywhere else as a string, and a body inside a body as SQL", () => {
    const source = [
      "comment on table t is $$it's $body$ text$$;",
      "do $outer$ begin perform f($$x$$);",
      "  create function g() returns int as $inner$ select 1 $inner$;",
      "end $outer$;",
      "select $1, $name, :name, @total;",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "$$it's $body$ text$$")).toEqual(["string"]);
    expect(classesOf(lines, "$outer$")).toEqual(["punctuation"]);
    expect(classesOf(lines, "$$x$$")).toEqual(["string"]);
    expect(classesOf(lines, "$inner$")).toEqual(["punctuation"]);
    expect(classesOf(lines, "1")).toEqual(["number"]);
    expect(classesOf(lines, "perform")).toEqual(["keyword"]);
    for (const parameter of ["$1", "$name", ":name", "@total"]) {
      expect(classesOf(lines, parameter)).toEqual(["parameter"]);
    }
    expect(verbatim(lines)).toBe(source);
  });

  it("ends a body at the first copy of its tag, wherever it is", () => {
    // The tag ends the body inside a word and inside a comment, as PostgreSQL
    // ends it.
    for (
      const body of [
        "begin\n  return 1;\nend$$;",
        "select 1 -- the body ends here $$;",
      ]
    ) {
      const source = `create function f() returns int as $$ ${body}\n` +
        "create table t (a int);";
      expect(outline(source).map(([label]) => label)).toEqual([
        "function f",
        "table t",
        "a",
      ]);
    }
  });

  it("colors a body as a string when the statement names another language", () => {
    const source = [
      "create function f() returns int language plv8 as $$",
      "  // it's JavaScript",
      "$$;",
      "create function g() returns int as $$ select 1 $$ language plpython3u;",
      "do language plpgsql $$ begin perform 1; end $$;",
      "create table t (a int);",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "  // it's JavaScript")).toEqual(["string"]);
    expect(classesOf(lines, "$$ select 1 $$")).toEqual(["string"]);
    expect(classesOf(lines, "perform")).toEqual(["keyword"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "function f",
      "function g",
      "table t",
      "a",
    ]);
  });

  it("marks declarations only up to the end of their body", () => {
    const source = [
      "do $$ declare x int; $$;",
      "create table t (c int);",
      "select y from t;",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "x")).toEqual(["binding"]);
    expect(classesOf(lines, "create")).toEqual(["storageKeyword"]);
    expect(classesOf(lines, "select")).toEqual(["keyword"]);
    expect(classesOf(lines, "y")).toEqual(["identifier"]);
  });

  it("colors PostgreSQL's comment, string, identifier, number, and operator forms", () => {
    const source = [
      "select a # b, x #> '{k}' /* outer /* inner */ still */ from t",
      "  #>> '{a,b}';",
      "select E'it\\'s', 'it''s', B'101', X'ff', U&'d\\0061t', \"q\";",
      'select "odd""name""", `ticked`, 1.5e3, .5, 0x1F, 1_000;',
      "select a::int, b::subscription_status, c->>'k', d|| --tail",
      "e, f::public.my_type, g=:p, h[1:n] for i in 1..10;",
      "select timestamp with time zone '2026-01-01';",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "#")).toEqual(["operator"]);
    expect(classesOf(lines, "#>")).toEqual(["operator"]);
    expect(classesOf(lines, "#>>")).toEqual(["operator"]);
    expect(classesOf(lines, "/* outer /* inner */ still */"))
      .toEqual(["comment"]);
    expect(classesOf(lines, "E'it\\'s'")).toEqual(["string"]);
    expect(classesOf(lines, "'it''s'")).toEqual(["string"]);
    expect(classesOf(lines, "B'101'")).toEqual(["string"]);
    expect(classesOf(lines, "X'ff'")).toEqual(["string"]);
    expect(classesOf(lines, "U&'d\\0061t'")).toEqual(["string"]);
    expect(classesOf(lines, '"q"')).toEqual(["identifier"]);
    expect(classesOf(lines, '"odd""name"""')).toEqual(["identifier"]);
    expect(classesOf(lines, "`ticked`")).toEqual(["identifier"]);
    for (const number of ["1.5e3", ".5", "0x1F", "1_000", "10"]) {
      expect(classesOf(lines, number)).toEqual(["number"]);
    }
    expect(classesOf(lines, "..")).toEqual(["punctuation"]);
    expect(classesOf(lines, "::")).toEqual(["operator"]);
    expect(classesOf(lines, "int")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "subscription_status")).toEqual(["typeName"]);
    expect(classesOf(lines, "my_type")).toEqual(["typeName"]);
    expect(classesOf(lines, "public")).toEqual(["identifier"]);
    expect(classesOf(lines, "->>")).toEqual(["operator"]);
    expect(classesOf(lines, "||")).toEqual(["operator"]);
    expect(classesOf(lines, "--tail")).toEqual(["comment"]);
    expect(classesOf(lines, ":p")).toEqual(["parameter"]);
    expect(classesOf(lines, ":")).toEqual(["operator"]);
    expect(classesOf(lines, "n")).toEqual(["identifier"]);
    expect(classesOf(lines, "zone")).toEqual(["keyword"]);
    expect(verbatim(lines)).toBe(source);
  });

  it("colors MySQL's forms in a source that holds syntax only MySQL reads", () => {
    const source = [
      "# a MySQL comment",
      "INSERT INTO t VALUES ('O\\'Brien', \"say \\\"hi\\\"\"); # it's done",
      "SELECT a--b, 1 -- trailing",
      "  /* a /* b */ FROM t;",
      "/*!40101 SET @saved = @@character_set_client */;",
      "CREATE TABLE `t` (",
      "  `id` int unsigned NOT NULL AUTO_INCREMENT,",
      "  `key` varchar(20),",
      "  name text,",
      "  PRIMARY KEY (`id`),",
      "  KEY idx_name (name),",
      "  UNIQUE KEY u (`key`),",
      "  FULLTEXT INDEX f (name)",
      ") ENGINE=InnoDB;",
      "ALTER TABLE t ADD INDEX i (name), ADD KEY (id), ADD seen int;",
      "DELIMITER $$",
      "CREATE PROCEDURE p() BEGIN",
      "  SELECT 1;",
      "END$$",
      "DELIMITER ;",
      "CREATE TABLE after_procedure (a int);",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "# a MySQL comment")).toEqual(["comment"]);
    expect(classesOf(lines, "'O\\'Brien'")).toEqual(["string"]);
    expect(classesOf(lines, '"say \\"hi\\""')).toEqual(["string"]);
    expect(classesOf(lines, "# it's done")).toEqual(["comment"]);
    expect(classesOf(lines, "--")).toEqual(["operator"]);
    expect(classesOf(lines, "-- trailing")).toEqual(["comment"]);
    expect(classesOf(lines, "/* a /* b */")).toEqual(["comment"]);
    expect(classesOf(lines, "FROM")).toEqual(["keyword"]);
    expect(classesOf(lines, "/*!40101")).toEqual(["punctuation"]);
    expect(classesOf(lines, "SET")).toEqual(["keyword"]);
    expect(classesOf(lines, "@saved")).toEqual(["parameter"]);
    expect(classesOf(lines, "DELIMITER")).toEqual(["keyword"]);
    expect(classesOf(lines, "$$")).toEqual(["punctuation"]);
    expect(classesOf(lines, "END")).toEqual(["controlKeyword"]);
    expect(verbatim(lines)).toBe(source);
    expect(outline(source).map(([label, , depth]) => [label, depth])).toEqual([
      ["table `t`", 0],
      ["`id`", 1],
      ["`key`", 1],
      ["name", 1],
      ["alter table t", 0],
      ["seen", 1],
      ["procedure p", 0],
      ["table after_procedure", 0],
      ["a", 1],
    ]);
    expect(outline(source).find(([label]) => label === "procedure p"))
      .toEqual(["procedure p", "function", 0, 16, 18]);
  });

  it("colors in MySQL's syntax a source whose escaped quote PostgreSQL's syntax leaves open", () => {
    const lines = sqlLanguage.highlightLines(
      "create table t (a text) engine = InnoDB;\ninsert into t values ('x\\'y');",
    );

    expect(classesOf(lines, "'x\\'y'")).toEqual(["string"]);
  });

  it("keeps PostgreSQL's syntax for a `delimiter` column, a `DELIMITER` option, and prose about engines", () => {
    const source = [
      "-- The search engine = google setting lives elsewhere.",
      "create table csv_formats (",
      "  delimiter text not null,",
      '  quote "char"',
      ");",
      "copy csv_formats from '/tmp/formats.csv' with (format csv,",
      "  delimiter ',');",
      "create function f() returns int as $$ select 1 $$;",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, '"char"')).toEqual(["typeName"]);
    expect(classesOf(lines, "$$")).toEqual(["punctuation"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "table csv_formats",
      "delimiter",
      "quote",
      "function f",
    ]);
  });

  it("colors in MySQL's syntax for a `#` comment line with no space after the `#`", () => {
    const lines = sqlLanguage.highlightLines(
      "#comment\ninsert into t values ('it\\'s');",
    );

    expect(classesOf(lines, "'it\\'s'")).toEqual(["string"]);
  });

  it("ends a `create table` statement at its `;` when a column is named `begin`", () => {
    const source = [
      "create table spans (id int, begin timestamptz);",
      "create table other (a int);",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      "table spans",
      "id",
      "begin",
      "table other",
      "a",
    ]);
  });

  it("marks the declarations of a labeled block", () => {
    const lines = sqlLanguage.highlightLines(
      "do $$ <<outer>> declare v int; begin perform v; end $$;",
    );

    expect(classesOf(lines, "v")).toEqual(["binding", "identifier"]);
  });

  it("colors a body by a `LANGUAGE` clause outside brackets, quoted or not, past a comment that holds a `;`", () => {
    const source = [
      "create function search(q text, language regconfig)",
      "  returns table (language text) as $$ select 1 $$ language sql;",
      'create function g() returns int as $$ x = 1 $$ language "plpythonu";',
      "create function h() returns int as $$ x = 1 $$ -- note; more",
      "  language plpython3u;",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "$$")).toEqual(["punctuation"]);
    expect(classesOf(lines, "$$ x = 1 $$")).toEqual(["string"]);
  });

  it("closes a MySQL procedure's blocks at `END CASE`, `END IF`, and the procedure's `END`", () => {
    const source = [
      "DELIMITER $$",
      "CREATE PROCEDURE p(IN x INT)",
      "BEGIN CASE x WHEN 1 THEN SELECT 1; ELSE SELECT 2; END CASE;",
      "  IF x THEN SELECT 3; END IF; END$$",
      "DELIMITER ;",
      "CREATE TABLE t (a int) ENGINE=InnoDB; CREATE TABLE u (b int);",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      "procedure p",
      "table t",
      "a",
      "table u",
      "b",
    ]);
  });

  it("lists the `create` statements of a MySQL dump", () => {
    const source = [
      "/*!40101 SET @OLD_X=@@X */;",
      "CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() SELECT 1;",
      "CREATE DEFINER=root@localhost TRIGGER tr BEFORE INSERT ON t",
      "  FOR EACH ROW SET NEW.a = 1;",
      "/*!50001 CREATE ALGORITHM=UNDEFINED */",
      "/*!50013 DEFINER='root'@'%' SQL SECURITY DEFINER */",
      "/*!50001 VIEW `v` AS SELECT 1 */;",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "@OLD_X")).toEqual(["parameter"]);
    expect(classesOf(lines, "=")).toEqual(["operator"]);
    expect(classesOf(lines, "@@X")).toEqual(["parameter"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "procedure `p`",
      "trigger tr",
      "view `v`",
    ]);
  });

  it("names the tables and columns that take the names of SQL words", () => {
    const source = [
      "create table action (id int);",
      "create table if not exists user (role text);",
      "alter table comment add x int, add (y int, z text);",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      "table action",
      "id",
      "table user",
      "role",
      "alter table comment",
      "x",
      "y",
      "z",
    ]);
  });

  it("keeps PostgreSQL's syntax when only a string or a body holds MySQL's", () => {
    const source = [
      "insert into pages values ('",
      "# Welcome",
      "');",
      "create function f() returns int language plpython3u as $$",
      "# a Python comment",
      "$$;",
      "comment on table pages is $$Don't edit by hand$$;",
      "create table after_comment (a int);",
    ].join("\n");

    expect(
      classesOf(sqlLanguage.highlightLines(source), "$$Don't edit by hand$$"),
    )
      .toEqual(["string"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "function f",
      "table after_comment",
      "a",
    ]);
  });

  it("colors the data lines that follow a `COPY … FROM stdin` statement as data", () => {
    const source = [
      "COPY public.notes (id, body) FROM stdin;",
      "1\tit's fine",
      "2\tquote ' here",
      "\\.",
      "",
      "CREATE TABLE after_copy (a int);",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "1\tit's fine")).toEqual(["string"]);
    expect(classesOf(lines, "\\.")).toEqual(["punctuation"]);
    expect(verbatim(lines)).toBe(source);
    expect(outline(source).map(([label]) => label)).toEqual([
      "table after_copy",
      "a",
    ]);
  });

  it("marks the variable each MySQL `DECLARE` statement declares", () => {
    const lines = sqlLanguage.highlightLines(
      [
        "DELIMITER //",
        "CREATE PROCEDURE p() BEGIN",
        "  DECLARE done BOOLEAN DEFAULT FALSE;",
        "  DECLARE total money_amount;",
        "  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;",
        "END//",
      ].join("\n"),
    );

    expect(classesOf(lines, "done")).toEqual(["binding", "identifier"]);
    expect(classesOf(lines, "total")).toEqual(["binding"]);
    expect(classesOf(lines, "money_amount")).toEqual(["typeName"]);
    expect(classesOf(lines, "CONTINUE")).toEqual(["controlKeyword"]);
  });

  it("lists the tables of a MySQL script that opens with a `##` banner comment", () => {
    const source = [
      "## Users",
      "CREATE TABLE users (name VARCHAR(10) DEFAULT 'O\\'Brien');",
      "CREATE TABLE orders (id INT);",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      "table users",
      "name",
      "table orders",
      "id",
    ]);
  });

  it("keeps the actions in a rule's brackets inside the rule's entry", () => {
    const source = [
      "create rule log as on insert to t do also (",
      "  insert into a values (1); insert into b values (2));",
      "create table u (a int);",
    ].join("\n");

    expect(classesOf(sqlLanguage.highlightLines(source), "also"))
      .toEqual(["keyword"]);
    expect(outline(source)).toEqual([
      ["rule log", "object", 0, 0, 1],
      ["table u", "object", 0, 2, 2],
      ["a", "variable", 1, 2, 2],
    ]);
  });

  it("colors a cursor declaration's `cursor` as a keyword", () => {
    const lines = sqlLanguage.highlightLines(
      "do $$ declare c cursor for select 1; begin open c; end $$;",
    );

    expect(classesOf(lines, "c")).toEqual(["binding", "identifier"]);
    expect(classesOf(lines, "cursor")).toEqual(["keyword"]);
  });

  it("keeps PostgreSQL's syntax for a line that starts with jsonb's `#-` operator", () => {
    const source = [
      "update docs set data = data",
      "  #- '{draft}';",
      "create function f() returns int as $$ select 1 $$;",
    ].join("\n");

    expect(classesOf(sqlLanguage.highlightLines(source), "#-"))
      .toEqual(["operator"]);
    expect(outline(source).map(([label]) => label)).toEqual(["function f"]);
  });

  it("ends a statement whose brackets name a column or parameter `begin` or `case`", () => {
    const source = [
      "create function f(begin int) returns table (case int)",
      "  as $$ select 1, 2 $$ language sql;",
      "create table after_f (a int);",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      "function f",
      "table after_f",
      "a",
    ]);
  });

  it("lists no `alter table` entry for a mysqldump `DISABLE KEYS` statement", () => {
    const source = [
      "/*!40000 ALTER TABLE `t` DISABLE KEYS */;",
      "INSERT INTO `t` VALUES (1);",
      "/*!40000 ALTER TABLE `t` ENABLE KEYS */;",
      "ALTER TABLE `t` ADD COLUMN `b` int;",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      "alter table `t`",
      "`b`",
    ]);
  });

  it("keeps PostgreSQL's syntax for a line inside a statement that starts with `#`", () => {
    const source = [
      "select a",
      "  # b from t;",
      'create table "x" (a int);',
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      'table "x"',
      "a",
    ]);
  });

  it("colors the data after a `COPY … FROM stdin` statement with options as data", () => {
    const source = [
      "COPY people (name) FROM stdin WITH (FORMAT csv);",
      "O'Brien",
      "\\.",
      "CREATE TABLE after_copy (id int);",
    ].join("\n");

    expect(classesOf(sqlLanguage.highlightLines(source), "O'Brien"))
      .toEqual(["string"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "table after_copy",
      "id",
    ]);
  });

  it("colors a `DELIMITER` command's argument, not the blanks after it", () => {
    const lines = sqlLanguage.highlightLines("DELIMITER //  \nSELECT 1//");

    expect(lines[0].spans.map(({ text, cls }) => [text, cls])).toEqual([
      ["DELIMITER", "keyword"],
      [" ", "whitespace"],
      ["//", "punctuation"],
      ["  ", "whitespace"],
    ]);
  });

  it("labels MySQL's events, full-text and spatial indexes, and partitions", () => {
    const source = [
      "# MySQL",
      "CREATE EVENT IF NOT EXISTS purge ON SCHEDULE EVERY 1 DAY DO DELETE FROM t;",
      "CREATE FULLTEXT INDEX ft ON t (body);",
      "CREATE SPATIAL INDEX sp ON t (shape);",
      "ALTER TABLE t ADD PARTITION (PARTITION p3 VALUES LESS THAN (2030));",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      "event purge",
      "index ft",
      "index sp",
      "alter table t",
    ]);
  });

  it("reads MySQL's syntax for a banner of `#` comments", () => {
    const source = [
      "#==========",
      "# Don't edit",
      "#==========",
      "CREATE TABLE t (a int);",
      "CREATE TABLE u (b int);",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "# Don't edit")).toEqual(["comment"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "table t",
      "a",
      "table u",
      "b",
    ]);
  });

  it("keeps PostgreSQL's syntax for a `delimiter` option inside a statement", () => {
    const source = [
      "copy t from '/tmp/t.csv' with (format csv,",
      "  delimiter $$|$$);",
      "create function f() returns int as $$ select 1 $$;",
    ].join("\n");

    expect(classesOf(sqlLanguage.highlightLines(source), "$$|$$"))
      .toEqual(["string"]);
    expect(outline(source).map(([label]) => label)).toEqual(["function f"]);
  });

  it("lists the tables of a MySQL migration whose escaped quote follows its first table", () => {
    const source = [
      "CREATE TABLE t (a int) DEFAULT CHARACTER SET utf8mb4;",
      "CREATE TABLE u (b varchar(10) DEFAULT 'O\\'B') CHARSET utf8mb4;",
      "CREATE TABLE v (c int);",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      "table t",
      "a",
      "table u",
      "b",
      "table v",
      "c",
    ]);
  });

  it("labels a MySQL procedure whose definer is `CURRENT_USER()`", () => {
    expect(
      outline("# x\nCREATE DEFINER=CURRENT_USER() PROCEDURE p() SELECT 1;")
        .map(([label]) => label),
    ).toEqual(["procedure p"]);
  });

  it("ends a psql command at the end of its line", () => {
    const source = [
      "\\set ON_ERROR_STOP on",
      "\\c mydb",
      "CREATE TABLE users (id int);",
      "\\echo done",
      "CREATE INDEX users_id ON users (id);",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "\\set")).toEqual(["keyword"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "table users",
      "id",
      "index users_id",
    ]);
  });

  it("reads MySQL's syntax for a quote escaped with a backslash", () => {
    const source = [
      "CREATE TABLE t (id INT, name VARCHAR(20));",
      "INSERT INTO t VALUES (1, 'it\\'s');",
      "CREATE TABLE u (id INT);",
    ].join("\n");

    expect(classesOf(sqlLanguage.highlightLines(source), "'it\\'s'"))
      .toEqual(["string"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "table t",
      "id",
      "name",
      "table u",
      "id",
    ]);
  });

  it("colors a comment on a `COPY … FROM stdin` statement's line, and data after it", () => {
    const source = [
      "COPY t (a) FROM stdin; -- the rows",
      "it's",
      "\\.",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "-- the rows")).toEqual(["comment"]);
    expect(classesOf(lines, "it's")).toEqual(["string"]);
  });

  it("reads MySQL's syntax for a string that ends in an escaped quote", () => {
    const source = [
      "INSERT INTO t VALUES ('a\\'', 'b');",
      "CREATE TABLE z (c int);",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual(["table z", "c"]);
  });

  it("reads MySQL's syntax for a trailing `#` comment that holds a quote", () => {
    const source = [
      "CREATE TABLE a (",
      "  id int, # the user's id",
      "  name text",
      ");",
      "CREATE TABLE b (x int);",
    ].join("\n");

    expect(classesOf(sqlLanguage.highlightLines(source), "# the user's id"))
      .toEqual(["comment"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "table a",
      "id",
      "name",
      "table b",
      "x",
    ]);
  });

  it("colors the data after a psql `\\copy … from stdin` command as data", () => {
    const source = [
      "\\copy t (a, b) from stdin",
      "1\tO'Brien",
      "\\.",
      "create table u (x int);",
    ].join("\n");

    expect(classesOf(sqlLanguage.highlightLines(source), "1\tO'Brien"))
      .toEqual(["string"]);
    expect(outline(source).map(([label]) => label)).toEqual(["table u", "x"]);
  });

  it("colors psql's quoted variables and SQLite's numbered parameters as parameters", () => {
    const lines = sqlLanguage.highlightLines(
      "select :'name', :\"col\", ?1 from t where a = :id;",
    );

    for (const parameter of [":'name'", ':"col"', "?1", ":id"]) {
      expect(classesOf(lines, parameter)).toEqual(["parameter"]);
    }
  });

  it("colors a function's parameters and the type it returns", () => {
    const lines = sqlLanguage.highlightLines(
      "create function f(in amount money_amount, flag boolean, int) " +
        "returns setof subscription_status as $$ select 1 $$;\n" +
        "create function g() returns trigger as $$ select 1 $$;",
    );

    expect(classesOf(lines, "amount")).toEqual(["parameter"]);
    expect(classesOf(lines, "money_amount")).toEqual(["typeName"]);
    expect(classesOf(lines, "flag")).toEqual(["parameter"]);
    expect(classesOf(lines, "int")).toEqual(["typeKeyword"]);
    expect(classesOf(lines, "subscription_status")).toEqual(["typeName"]);
    expect(classesOf(lines, "trigger")).toEqual(["typeKeyword"]);
  });

  it("reads MySQL's syntax for an executed comment with no version number", () => {
    const source = [
      "/*! SET NAMES utf8mb4 */;",
      'CREATE TABLE t (a varchar(10) DEFAULT "x");',
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "SET")).toEqual(["keyword"]);
    expect(classesOf(lines, '"x"')).toEqual(["string"]);
  });

  it("labels each `create` statement with the kind of thing it makes and its name", () => {
    const source = [
      "create index concurrently if not exists recent on t (a);",
      "create virtual table docs using fts5(body);",
      "create aggregate total(int) (sfunc = int4pl, stype = int);",
      "create text search configuration english_simple (copy = simple);",
      "create user mapping for bob server files;",
      "create trusted language plx;",
      "create cast (int as text) with inout;",
      "create foreign table remote (id int) server files;",
      "create event trigger audit on ddl_command_end execute function f();",
    ].join("\n");

    expect(outline(source).map(([label, kind]) => [label, kind])).toEqual([
      ["index recent", "object"],
      ["table docs", "object"],
      ["aggregate total", "function"],
      ["text search configuration english_simple", "object"],
      ["user mapping", "object"],
      ["language plx", "object"],
      ["cast", "object"],
      ["table remote", "object"],
      ["id", "variable"],
      ["trigger audit", "object"],
    ]);
    const lines = sqlLanguage.highlightLines(source);
    expect(classesOf(lines, "recent")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "total")).toEqual(["functionName"]);
  });

  it("adds no column for an `alter table` action that adds something else", () => {
    const source = [
      "alter table t alter column id add generated always as identity,",
      "  add column key text, add check (id > 0);",
    ].join("\n");

    expect(outline(source).map(([label]) => label)).toEqual([
      "alter table t",
      "key",
    ]);
  });

  it("keeps the statements in a trigger's `begin` block inside the trigger's entry", () => {
    const source = [
      "create trigger touch after update on t begin",
      "  update t set n = case when n > 1 then n else 1 end;",
      "  select 1;",
      "end;",
      "create table u (a int);",
    ].join("\n");

    expect(outline(source)).toEqual([
      ["trigger touch", "object", 0, 0, 3],
      ["table u", "object", 0, 4, 4],
      ["a", "variable", 1, 4, 4],
    ]);
  });

  it("colors a name before `(` as a call unless a keyword places a relation there", () => {
    const source = [
      "insert into events(id) select now() from logs(x)",
      "  join peers(y) on true where exists(select 1);",
      "create table t (a int references contacts(id), b int default coalesce(1, 2));",
    ].join("\n");
    const lines = sqlLanguage.highlightLines(source);

    expect(classesOf(lines, "events")).toEqual(["identifier"]);
    expect(classesOf(lines, "logs")).toEqual(["identifier"]);
    expect(classesOf(lines, "peers")).toEqual(["identifier"]);
    expect(classesOf(lines, "contacts")).toEqual(["identifier"]);
    expect(classesOf(lines, "now")).toEqual(["callName"]);
    expect(classesOf(lines, "coalesce")).toEqual(["callName"]);
    expect(classesOf(lines, "exists")).toEqual(["keyword"]);
    expect(classesOf(lines, "true")).toEqual(["boolean"]);
  });

  it("reconstructs unclosed strings, identifiers, comments, and bodies exactly", () => {
    for (
      const source of [
        "select 'open\nfrom t;",
        'select "open\nfrom t;',
        "select 1; /* open /* nested */\nselect 2;",
        "create function f() returns int as $$\nbegin\n  return 1;",
        "select $tag$ open\nmore",
        "create table t (a int,",
        "create",
        "alter table",
        "",
      ]
    ) {
      const doc = sqlLanguage.parseDocument(source);
      expect(verbatim(doc.lines)).toBe(source);
    }
    const lines = sqlLanguage.highlightLines("select 'open\nfrom t;");
    expect(classesOf(lines, "from t;")).toEqual(["string"]);
    expect(outline("create function f() returns int as $$\nbegin")).toEqual([
      ["function f", "function", 0, 0, 1],
    ]);
    expect(outline("create table t (a int,")).toEqual([
      ["table t", "object", 0, 0, 0],
      ["a", "variable", 1, 0, 0],
    ]);
  });

  it("re-colors the whole text after an edit that opens a string", () => {
    const highlighter = sqlLanguage.createHighlighter("select a from t;");
    expect(classesOf(highlighter.lines, "from")).toEqual(["keyword"]);

    const lines = highlighter.update("select 'a from t;");
    expect(classesOf(lines, "'a from t;")).toEqual(["string"]);
    expect(verbatim(lines)).toBe("select 'a from t;");
  });
});
