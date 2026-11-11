from tools.report import build_report


def test_missing_file_gives_header_only():
    assert build_report("missing.json").count("\n") == 0
