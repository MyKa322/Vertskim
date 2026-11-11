/// Wraps text in the report's line markers.
pub fn line(text: &str) -> String {
    format!("| {} |", text)
}

#[cfg(test)]
mod tests {
    use super::line;

    #[test]
    fn wraps() {
        assert_eq!(line("a"), "| a |");
    }
}
