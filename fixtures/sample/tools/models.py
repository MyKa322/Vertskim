"""Data models shared by the reporting tools."""


class Record:
    """One row of usage data."""

    def __init__(self, user_id: str, count: int) -> None:
        self.user_id = user_id
        self.count = count

    def describe(self) -> str:
        """Human-readable summary of the row."""
        return f"{self.user_id}: {self.count}"


class WeightedRecord(Record):
    """A record whose count is scaled."""

    def scaled(self, factor: int) -> int:
        return self.count * factor

    def describe(self) -> str:
        return f"{super().describe()} (x{self.scaled(2)})"
