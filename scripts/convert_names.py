#!/usr/bin/env python3
"""
Convert the provided baby names CSV into JSON records.

Usage:
  python scripts/convert_names.py data/names.csv [output.json]

If no output path is supplied, the JSON file is written next to the input with
the same stem. The script preserves all CSV columns and rounds Percent to a
single decimal place for smaller payloads on GitHub Pages.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any, Dict, Iterable


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert baby names CSV to JSON.")
    parser.add_argument("csv_path", type=Path, help="Path to data/names.csv")
    parser.add_argument(
        "json_path",
        nargs="?",
        type=Path,
        help="Optional output path (defaults to input stem + .json)",
    )
    return parser.parse_args()


def coerce_value(column: str, value: str) -> Any:
    text = value.strip()
    if not text:
        return None
    lower = column.lower()
    if lower in {"rank", "year"}:
        try:
            return int(text)
        except ValueError:
            return text
    if lower == "percent":
        try:
            return round(float(text), 1)
        except ValueError:
            return text
    return text


def convert_rows(rows: Iterable[Dict[str, str]]) -> Iterable[Dict[str, Any]]:
    for row in rows:
        yield {col: coerce_value(col, val or "") for col, val in row.items()}


def convert(csv_path: Path, json_path: Path) -> None:
    with csv_path.open(newline="", encoding="utf-8") as src:
        reader = csv.DictReader(src)
        records = list(convert_rows(reader))
    with json_path.open("w", encoding="utf-8") as dst:
        json.dump(records, dst, ensure_ascii=False, indent=2)
        dst.write("\n")


def main() -> None:
    args = parse_args()
    csv_path = args.csv_path.resolve()
    if not csv_path.exists():
        raise SystemExit(f"CSV file not found: {csv_path}")
    json_path = (args.json_path or csv_path.with_suffix(".json")).resolve()
    json_path.parent.mkdir(parents=True, exist_ok=True)
    convert(csv_path, json_path)


if __name__ == "__main__":
    main()
