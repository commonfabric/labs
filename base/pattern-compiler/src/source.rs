//! Positions in source text.

/// Maps a byte offset in one source text to a line and a column.
///
/// Lines and columns are 1-based. A column counts UTF-16 code units, which is
/// how the TypeScript compiler and editors report positions.
#[derive(Debug, Clone)]
pub struct LineIndex {
    line_starts: Vec<u32>,
}

impl LineIndex {
    pub fn new(text: &str) -> Self {
        let mut line_starts = vec![0];
        for (offset, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                line_starts.push(offset as u32 + 1);
            }
        }
        Self { line_starts }
    }

    /// The line and column of `offset` in `text`, the text this index was
    /// built from.
    pub fn position(&self, text: &str, offset: u32) -> (u32, u32) {
        let line = match self.line_starts.binary_search(&offset) {
            Ok(line) => line,
            Err(next) => next - 1,
        };
        let start = self.line_starts[line] as usize;
        let end = (offset as usize).min(text.len());
        let column = text[start..end].encode_utf16().count() as u32 + 1;
        (line as u32 + 1, column)
    }
}

#[cfg(test)]
mod tests {
    use super::LineIndex;

    #[test]
    fn position_counts_lines_and_utf16_columns() {
        let text = "ab\nc\u{1F369}d\n";
        let index = LineIndex::new(text);
        assert_eq!(index.position(text, 0), (1, 1));
        assert_eq!(index.position(text, 3), (2, 1));
        // The donut is one scalar value and two UTF-16 code units.
        let d = text.find('d').unwrap() as u32;
        assert_eq!(index.position(text, d), (2, 4));
    }
}
