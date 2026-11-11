"""Output helpers."""

INDENT = "  "


def bullet(text: str) -> str:
    """Format one bullet line."""
    return f"{INDENT}- {text}"


def _private_helper() -> None:
    pass
