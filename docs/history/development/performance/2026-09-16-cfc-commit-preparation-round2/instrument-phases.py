from pathlib import Path
import sys

root = Path(sys.argv[1])
cfc = root / 'packages/runner/src/cfc'
(cfc / 'round2-phase-timer.ts').write_text('''export const totals: Record<string, number> = {};
export function timed<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try { return fn(); }
  finally { totals[name] = (totals[name] ?? 0) + performance.now() - start; }
}
export function reset() { for (const key in totals) delete totals[key]; }
''', encoding='utf-8')
p = cfc / 'prepare.ts'
s = p.read_text(encoding="utf-8")
s = 'import { timed } from "./round2-phase-timer.ts";\n' + s
start = s.index('      const authoritativeCoverFor = (')
body = s.index('): IFCLabel | undefined => {', start)
end = s.index('\n      };', body)
s = s[:body] + s[body:end].replace('): IFCLabel | undefined => {', '): IFCLabel | undefined => timed("cover", () => {', 1) + '\n      });' + s[end+9:]
p.write_text(s, encoding="utf-8")
p = cfc / 'consumed-label-index.ts'
s = 'import { timed } from "./round2-phase-timer.ts";\n' + p.read_text(encoding="utf-8")
start = s.index('  overlapping(')
body = s.index('): readonly IndexedEntry[] {', start)
end = s.rindex('\n  }')
s = s[:body] + s[body:end].replace('): readonly IndexedEntry[] {', '): readonly IndexedEntry[] {\n    return timed(path.includes("*") ? "wildcard" : "concrete", () => {', 1) + '\n    });' + s[end:]
p.write_text(s, encoding="utf-8")
p = root / 'packages/runner/test/cfc-prepare-exact-ladder.bench.ts'
s = 'import { totals, reset } from "../src/cfc/round2-phase-timer.ts";\n' + p.read_text(encoding="utf-8")
s = s.replace('              b.start();', '              reset();\n              b.start();')
s = s.replace('              b.end();', '''              b.end();
              if (phase === "prepare") benchDiagnostic(JSON.stringify({phaseTimes: { ...totals }, reads, paths, entries}));''')
p.write_text(s, encoding="utf-8")
