//! Which files of `patterns/` are the corpus.
//!
//! The rule is the one the corpus measurement beside the specification
//! uses. It starts from the files `deno task cfcheck` compiles
//! (`isPatternSource` in `tasks/pattern-files.ts`), adds what those import
//! by relative path, and takes out a file that shares no program with
//! pattern code.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use oxc_allocator::Allocator;

use crate::module::{ExportTarget, ModuleModel, SpecifierKind};
use crate::parse;
use crate::program::SourceFile;

/// Whether `path`, relative to the patterns directory, is a file that
/// `deno task cfcheck` compiles.
pub fn is_pattern_source(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let typescript = name.ends_with(".ts") || name.ends_with(".tsx");
    let test = name.ends_with(".test.ts") || name.ends_with(".test.tsx");
    let host = path.starts_with("integration/")
        || path.starts_with("tools/")
        || path.starts_with("apps/topics/tools/");
    let iframe = path
        .split('/')
        .rev()
        .skip(1)
        .any(|directory| directory.starts_with("iframe-"));
    let guest = iframe && matches!(name, "guest.ts" | "guest.tsx" | "contract.ts");
    typescript && !test && name != "mod.ts" && !host && !guest
}

/// Every `.ts` and `.tsx` file under `root`, with its path written from
/// `prefix`, sorted by path.
pub fn read_tree(root: &Path, prefix: &str) -> std::io::Result<Vec<SourceFile>> {
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), prefix.to_string())];
    while let Some((directory, prefix)) = pending.pop() {
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = format!("{prefix}/{name}");
            let kind = entry.file_type()?;
            if kind.is_dir() {
                if name != "node_modules" && !name.starts_with('.') {
                    pending.push((entry.path(), path));
                }
            } else if name.ends_with(".ts") || name.ends_with(".tsx") {
                files.push(SourceFile {
                    path,
                    text: std::fs::read_to_string(entry.path())?,
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// The corpus among `files`, the `.ts` and `.tsx` files of a patterns
/// directory whose paths begin with `prefix` and a slash.
pub fn select(files: Vec<SourceFile>, prefix: &str) -> Vec<SourceFile> {
    let index: BTreeMap<&str, usize> = files
        .iter()
        .enumerate()
        .map(|(index, file)| (file.path.as_str(), index))
        .collect();
    // The modules each file imports by relative path, and whether it
    // imports `commonfabric`.
    let mut edges: Vec<Vec<usize>> = vec![Vec::new(); files.len()];
    let mut api: Vec<bool> = vec![false; files.len()];
    for (from, file) in files.iter().enumerate() {
        let allocator = Allocator::default();
        let Ok(parsed) = parse::parse(&allocator, &file.path, &file.text) else {
            continue;
        };
        let model = ModuleModel::build(&parsed);
        let mut specifiers: Vec<&str> = model
            .imports
            .iter()
            .map(|import| import.specifier.as_str())
            .chain(model.star_exports.iter().map(String::as_str))
            .collect();
        for export in &model.exports {
            if let ExportTarget::From { specifier, .. } = &export.target {
                specifiers.push(specifier);
            }
        }
        for specifier in specifiers {
            if SpecifierKind::of(specifier).is_api() {
                api[from] = true;
            }
            if let Some(to) = index.get(resolve(&file.path, specifier).as_str()) {
                edges[from].push(*to);
            }
        }
    }
    let relative = |path: &str| {
        path.strip_prefix(prefix)
            .map(|rest| rest.trim_start_matches('/').to_string())
    };
    let mut chosen: BTreeSet<usize> = files
        .iter()
        .enumerate()
        .filter(|(_, file)| relative(&file.path).is_some_and(|path| is_pattern_source(&path)))
        .map(|(index, _)| index)
        .collect();
    // Add what the chosen files import, and what those import.
    let mut stack: Vec<usize> = chosen.iter().copied().collect();
    while let Some(from) = stack.pop() {
        for &to in &edges[from] {
            if chosen.insert(to) {
                stack.push(to);
            }
        }
    }
    // Take out a file that shares no program with pattern code.
    let reaches_api = closure(&edges, &api, false);
    let reached_from_api = closure(&edges, &api, true);
    files
        .into_iter()
        .enumerate()
        .filter(|(index, _)| {
            chosen.contains(index) && (reaches_api[*index] || reached_from_api[*index])
        })
        .map(|(_, file)| file)
        .collect()
}

/// For each module, whether it is one of `seeds` or is connected to one by
/// imports: it imports one, directly or through other modules, or, with
/// `forward`, one imports it.
fn closure(edges: &[Vec<usize>], seeds: &[bool], forward: bool) -> Vec<bool> {
    let mut graph: Vec<Vec<usize>> = vec![Vec::new(); edges.len()];
    for (from, targets) in edges.iter().enumerate() {
        for &to in targets {
            if forward {
                graph[from].push(to);
            } else {
                graph[to].push(from);
            }
        }
    }
    let mut marked = seeds.to_vec();
    let mut stack: Vec<usize> = (0..edges.len()).filter(|index| seeds[*index]).collect();
    while let Some(from) = stack.pop() {
        for &to in &graph[from] {
            if !marked[to] {
                marked[to] = true;
                stack.push(to);
            }
        }
    }
    marked
}

fn resolve(from: &str, specifier: &str) -> String {
    if !specifier.starts_with('.') {
        return String::new();
    }
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for part in specifier.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::is_pattern_source;

    #[test]
    fn is_pattern_source_keeps_patterns_and_drops_host_programs() {
        assert!(is_pattern_source("system/fabrichat/room.tsx"));
        assert!(is_pattern_source("apps/iframe-game/main.tsx"));
        assert!(!is_pattern_source("system/fabrichat/room.test.tsx"));
        assert!(!is_pattern_source("mod.ts"));
        assert!(!is_pattern_source("integration/fixtures/a/main.tsx"));
        assert!(!is_pattern_source("apps/topics/tools/cli.ts"));
        assert!(!is_pattern_source("apps/iframe-game/guest.ts"));
        assert!(!is_pattern_source("apps/iframe-game/contract.ts"));
        assert!(!is_pattern_source("README.md"));
    }
}
