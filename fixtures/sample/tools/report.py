"""Builds the usage report."""
import json
import os.path

from . import formatting
from .formatting import bullet as make_bullet
from .models import Record, WeightedRecord


def load_records(path: str) -> list[Record]:
    """Read records from a JSON file."""
    if not os.path.exists(path):
        return []
    with open(path) as handle:
        rows = json.load(handle)
    return [WeightedRecord(row["user"], row["count"]) for row in rows]


def build_report(path: str) -> str:
    """Render every record as a bullet list."""
    lines = [make_bullet(f"{record.label()}: {record.describe()}") for record in load_records(path)]
    header = formatting.bullet("usage")
    return "\n".join([header, *lines])
