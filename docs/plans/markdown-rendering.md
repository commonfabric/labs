# One way to render Markdown

Three modules render Markdown, and each walks the tokens of the `marked` lexer
on its own:

- `packages/ui/src/v2/components/cf-markdown/markdown-template.ts` builds the
  Lit template behind `<cf-markdown>`. It gives headings ids, renders cell
  links as `<cf-cell-link>`, puts a copy button on code blocks, reports task
  checkboxes to the component, and checks URLs with `ui/src/v2/core/safe-url.ts`.
  It resolves character references by parsing them into a DOM element, so it
  runs only in a browser.
- `packages/cf-harness/console/src/markdown.ts` builds the Lit template the
  harness console shows answers in; a model's reasoning is shown as plain
  text instead. It shows each return referent a turn reveals as the string it
  stands for, shows a link's host beside it, shows images as their
  descriptions, and starts headings at `h3`. It resolves character references with the `entities` package and checks
  URLs against a scheme list of its own.
- `packages/cli/lib/view/languages/markdown/markdown.ts` renders Markdown as
  terminal lines for the `cf` pager. It resolves character references with the
  `entities` package.

Each one decides for itself how character references resolve, what happens to
raw HTML, which URL schemes a link may carry, and which token types it renders.
Those are questions with one right answer for the whole repository, and a fix
to any of them — a token type a new `marked` adds, a scheme found to be unsafe —
reaches only the module it was made in.

## Stages

1. **One character reference decoder.** The `ui` renderer resolves references
   with `decodeHTMLStrict` from `entities`, as the other two do. Its token walk
   then needs no DOM, and can be tested under Deno. The two decoders differ on
   one input: the HTML parser the `ui` renderer uses also resolves a reference
   with no semicolon, such as `&amp` or `&#38`, and the strict decoder leaves it
   as written. CommonMark resolves only a reference that ends in its semicolon,
   so `<cf-markdown>` showing `&amp` as written is the intended result of this
   stage.
2. **One URL policy.** `safe-url.ts` moves to a module that both `ui` and
   `cf-harness` may import, which is one at or below the Operation layer (see
   the pace layers in `AGENTS.md`), and the console checks links with it. The
   console allows fewer schemes than `safe-url.ts` does, so this stage settles
   whether the narrower list is a property of the console or a correction to
   the shared policy.
3. **One Lit token walk.** The walk the two Lit renderers share — paragraphs,
   emphasis, code spans, lists, tables, block quotes, rules, and raw HTML
   dropped — lives once, in the same module as the URL policy, and takes
   from its caller each rendering where the two differ: runs of text, code,
   headings, links, images and checkboxes.

The terminal renderer produces lines rather than templates, so it keeps its own
walk, and shares the decoder and the URL policy.

## Open question

The walk the two Lit renderers share is small next to what each does
differently, so the parameters stage 3 needs may cost more code than they
save. Stages 1 and 2 are worth doing on their own; stage 3 is to be judged
once they have landed, by whether the shared walk is smaller than the two it
replaces.
