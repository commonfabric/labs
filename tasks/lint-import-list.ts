/// <reference lib="deno.unstable" />

/**
 * A lint rule that holds one module's entry in a file's import list to one
 * statement of each kind.
 *
 * A module is imported in one statement, marking any type-only names inline,
 * or in two when one of them is an `import type` and the other is a value
 * import. What this rule reports is a second statement of the same kind for
 * one module: two value imports of it, or two `import type`s of it. Written
 * that way, one dependency reads as two, and the second is easy to miss when
 * the first is being edited or removed.
 *
 * A bare `import "x";` is a value statement, so it counts toward that module's
 * total, and what it counts against decides what happens to it. Beside a value
 * import that binds something, it adds nothing, since that import evaluates
 * the module, side effects included: the rule reports the bare statement.
 * Beside nothing but an `import type`, it is the only statement that evaluates
 * the module at all, and the rule leaves the pair alone as two statements of
 * different kinds.
 *
 * Between those sits a statement that names nothing but types, `import { type
 * Thing } from "x";`. It is a value statement to the grammar, and TypeScript
 * erases it as it erases an `import type`, so it evaluates nothing either.
 * Beside a bare import of the same module, the rule reports that statement
 * rather than the bare one, because writing it `import type` is what makes the
 * pair legal and leaves the module evaluated.
 *
 * An `import type` with an empty clause, `import type {} from "x";`, binds
 * nothing and evaluates nothing. The split above is about which statements
 * evaluate the module, and an `import type` answers that the same way whatever
 * its clause holds, so an empty one counts toward the module's `import type`
 * total like any other rather than standing apart as a bare statement does.
 *
 * The second rule, `types-are-import-type`, reports that same statement
 * wherever it stands. Deno reads the module a value statement names before it
 * starts a program, whether or not TypeScript goes on to erase the statement,
 * so one written inline pulls in everything that module imports. A pattern is
 * exempt, since its source is part of its identity, and so is a fixture.
 *
 * Whichever statement survives a merge goes where the earliest of the
 * statements it replaces sat. That is what keeps the module's evaluation at
 * the point in the list it was already reached from, which matters when the
 * module installs something that an import below it reads as that one loads.
 *
 * One pair has no merge at all: a namespace import takes no other name beside
 * it, so `import * as name from "x"` and a named import of `x` of the same
 * kind cannot become one statement. Usually the fix is to reach through the
 * namespace for what the named statement took. Where that reads worse — a
 * namespace imported only so its `typeof` names the whole module, against a
 * list of names the file uses throughout — the pair stays, and takes a
 * `deno-lint-ignore` saying which case it is.
 *
 * The rule reads a specifier as written, so two spellings of one module —
 * `@/thing.ts` and `../thing.ts` — are two modules to it. Which spelling to
 * use is a separate rule of the same section, and one for review.
 *
 * See the `Imports` section of docs/development/DEVELOPMENT.md.
 */

/** Which of the two kinds of statement a declaration is. */
type Kind = Deno.lint.ImportDeclaration["importKind"];

const REFERENCE =
  "See the `Imports` section of docs/development/DEVELOPMENT.md.";

/** What a message calls a statement of one kind. */
function kindWord(kind: Kind): string {
  return kind === "type" ? "`import type`" : "value import";
}

/** Reports a second statement of one kind naming a module. */
function mergeMessage(kind: Kind, specifier: string): string {
  return `This file already imports \`${specifier}\` in another ` +
    `${kindWord(kind)} above. A module takes one statement of each kind, so ` +
    "merge the two lists of names into one statement, marking a type-only " +
    "name inline with `type` where that is what the merge needs. The " +
    "statement that stays goes where the earlier of the two sat. Written as " +
    "two, one dependency reads as two, and the second is easy to miss when " +
    `the first is being edited or removed. ${REFERENCE}`;
}

/** Reports a second statement of one kind where one takes a namespace. */
function mergeThroughNamespaceMessage(kind: Kind, specifier: string): string {
  return `This file already imports \`${specifier}\` in another ` +
    `${kindWord(kind)} above, and one of the two takes the module as a ` +
    "namespace, which no other name may sit beside. So these two cannot " +
    "become one statement: reach through the namespace for what the other " +
    "one named, and drop that statement. Where that reads worse than the " +
    "pair — a namespace imported only so its `typeof` names the whole " +
    "module, against a list of names the file uses throughout — keep both " +
    "and say so with `// deno-lint-ignore " +
    `cf-import-list/one-statement-per-kind\`. ${REFERENCE}`;
}

/** Reports a bare import beside a statement that binds something. */
function bareBesideValueMessage(specifier: string): string {
  return `This file also imports \`${specifier}\` in a value import that ` +
    "names what it takes, and a value import evaluates the module, side " +
    "effects included. This bare statement adds nothing beside it: drop it, " +
    "and say in a comment on the statement that stays what the bare one was " +
    "there for. That statement goes where the earlier of the two sat, so the " +
    `module is still evaluated at the same point in the list. ${REFERENCE}`;
}

/**
 * Reports a statement naming nothing but types beside a bare import of the
 * same module.
 */
function typesBesideBareMessage(specifier: string): string {
  return `This file also imports \`${specifier}\` for its side effect, in a ` +
    "bare `import` statement. This statement names nothing but types, so " +
    "TypeScript erases the whole of it and the bare statement is what " +
    "evaluates the module. Write this one as `import type`: the two are then " +
    "one statement of each kind, which is the second of the two shapes the " +
    `section allows. ${REFERENCE}`;
}

/** Reports a bare import beside another bare import of the same module. */
function repeatedBareMessage(specifier: string): string {
  return `This file already imports \`${specifier}\` for its side effect ` +
    "above. A module is evaluated once however many times it is imported, " +
    `so this statement does nothing: drop it. ${REFERENCE}`;
}

/** Reports a value statement that names nothing but types. */
function allTypesMessage(specifier: string): string {
  return `This statement names nothing but types, so write it \`import type ` +
    `{ ... } from "${specifier}"\`. TypeScript erases either spelling, but ` +
    "Deno reads what a value statement names, and everything that imports, " +
    "before it starts a program, however little of it the program runs. " +
    `${REFERENCE}`;
}

/** The statements of one kind naming one module, in the order written. */
interface Run {
  readonly kind: Kind;
  readonly specifier: string;
  /** The statements that name what they take. */
  readonly named: Deno.lint.ImportDeclaration[];
  /** The bare statements, which name nothing and run the module. */
  readonly bare: Deno.lint.ImportDeclaration[];
}

/**
 * Whether a statement binds anything the program can reach at run time. A
 * statement whose every name is marked `type` inline binds nothing, and
 * TypeScript erases it along with those names, so it does not evaluate the
 * module it names.
 */
function bindsValue(node: Deno.lint.ImportDeclaration): boolean {
  return node.specifiers.some((specifier) =>
    specifier.type !== "ImportSpecifier" || specifier.importKind !== "type"
  );
}

/** Whether a statement takes the whole module under one name. */
function takesNamespace(node: Deno.lint.ImportDeclaration): boolean {
  return node.specifiers.some((specifier) =>
    specifier.type === "ImportNamespaceSpecifier"
  );
}

export default {
  name: "cf-import-list",
  rules: {
    "types-are-import-type": {
      create(context) {
        // A pattern's source is part of its identity, so its import list is
        // not rewritten for what a program start costs. A fixture is often a
        // frozen copy of one.
        if (/\/(patterns|fixtures)\//.test(context.filename)) return {};
        return {
          ImportDeclaration(node) {
            if (
              node.importKind === "value" && node.specifiers.length > 0 &&
              !bindsValue(node)
            ) {
              context.report({
                node,
                message: allTypesMessage(node.source.value),
              });
            }
          },
        };
      },
    },
    "one-statement-per-kind": {
      create(context) {
        const runs = new Map<string, Run>();

        return {
          ImportDeclaration(node) {
            const kind = node.importKind;
            const specifier = node.source.value;
            const key = `${kind} ${specifier}`;
            let run = runs.get(key);
            if (run === undefined) {
              run = { kind, specifier, named: [], bare: [] };
              runs.set(key, run);
            }
            // The split is about which statements evaluate the module, which
            // is a question only a value statement raises: an `import type`
            // evaluates nothing whatever its clause holds, so an empty one
            // counts toward its kind rather than standing apart as bare.
            const statements = kind === "type" || node.specifiers.length > 0
              ? run.named
              : run.bare;
            statements.push(node);
          },

          "Program:exit"() {
            for (const { kind, specifier, named, bare } of runs.values()) {
              // A statement merges into the first of its kind, so what
              // decides which message it takes is whether either of those two
              // takes a namespace, rather than whether any statement in the
              // run does.
              for (const node of named.slice(1)) {
                const throughNamespace = takesNamespace(named[0]) ||
                  takesNamespace(node);
                context.report({
                  node,
                  message: throughNamespace
                    ? mergeThroughNamespaceMessage(kind, specifier)
                    : mergeMessage(kind, specifier),
                });
              }
              if (kind === "type" || bare.length === 0) continue;
              if (named.some(bindsValue)) {
                for (const node of bare) {
                  context.report({
                    node,
                    message: bareBesideValueMessage(specifier),
                  });
                }
                continue;
              }
              // Nothing here evaluates the module but the bare statements, so
              // the first of those stays and the rest repeat it. A statement
              // naming nothing but types is spelled to say so.
              if (named.length > 0) {
                context.report({
                  node: named[0],
                  message: typesBesideBareMessage(specifier),
                });
              }
              for (const node of bare.slice(1)) {
                context.report({
                  node,
                  message: repeatedBareMessage(specifier),
                });
              }
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
