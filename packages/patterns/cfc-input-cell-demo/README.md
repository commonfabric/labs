# CFC input-cell demo

Two patterns that put a labelled cell in front of a cf-harness run and let it
compose over one without reading it, so the console has something to draw. The
pair is the smallest arrangement that separates the two facts a per-cell label
carries: what a cell is labelled, and whether that label was derived or merely
carried in.

- **`seed.tsx`** — the cells the run is pointed at, deployed before the run
  exists. `secret` declares a confidentiality atom; `city` declares none.
- **`briefing.tsx`** — what the run composes. `briefing` mixes both cells, so
  the space derives a label for it and records the lifted function that did the
  deriving; `climate` reads only `city`, so it derives nothing.

## Running it

A local toolshed and a matched client, per
[`LOCAL_DEV_SERVERS.md`](../../../docs/development/LOCAL_DEV_SERVERS.md). Every
command below wants `-i <keyfile> -a http://localhost:8000 -s <space>`; the
space is named by name, because the console composes a URL from it.

Deploy the seed and read the address of each cell it exposes:

```sh
deno task cf piece new packages/patterns/cfc-input-cell-demo/seed.tsx \
  --root . -i "$CF_KEY" -a http://localhost:8000 -s "$CF_SPACE"

deno task cf cell get --piece "$SEED_PIECE" --select 'secret@,city@' \
  -i "$CF_KEY" -a http://localhost:8000 -s "$CF_SPACE"
```

Hand both to a run as input cells. The names are operator-authored prose and are
the whole of what the model is told each token stands for — the values
themselves never enter the prompt:

The sandbox is the platform's native `runsc` runtime, which the run takes where
no runtime is named. Its CFC policy comes from the native store: an enforcing
run refuses to start without one rather than degrading quietly.

```sh
deno task --cwd packages/cf-harness run \
  --fabric-api-url http://localhost:8000 \
  --fabric-identity "$CF_KEY" \
  --fabric-space "$CF_SPACE" \
  --fabric-cfc-posture max-enforcement \
  --input-cell secret="$SECRET_LINK" \
  --input-cell city="$CITY_LINK" \
  --artifact-root .cf-harness-console/runs \
  --prompt "Run a Common Fabric pattern over the two cells you hold handles for.
Call run_pattern once, passing sourceText exactly as given below and wiring
secret and city to the handles of those names. Do not restate any value.

sourceText:
$(cat packages/patterns/cfc-input-cell-demo/briefing.tsx)"
```

The pattern's source rides in the prompt because it is the pattern that is
checked in — a run that composed one for itself would be demonstrating the model
rather than the labels. Source is not what the arrangement withholds; the cells
are.

`--artifact-root` points at the console's own run tree, so the console reads the
run back without being told where it is. Then open the run. The console takes
its sandbox runtime from the environment, and with none named takes the same
default the run did:

```sh
deno task --cwd packages/cf-harness console
```

## What the console shows

The `run_pattern` call reads two cells and produces one. Opening the produced
cell's chip:

- `secret` carries its declared atom, `origin: declared`.
- `city` carries no label, under a run whose snapshot was taken — which the map
  header states, so the empty chip reads as a fact about the cell rather than
  about the page.
- The result carries the atom `secret` contributed, `origin: derived`, and the
  provenance atom naming the lifted function that derived it.

That last line is the one worth checking against the second and third. A result
object's label is the join of its fields, so a confidentiality atom on its own
does not say a value was computed from something confidential. The `derived`
origin and the provenance beside it do.
