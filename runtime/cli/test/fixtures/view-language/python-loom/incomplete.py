def count_items(path: Path) -> int:
    return sum(1 for entry in path.iterdir() if not entry.name.startswith(
