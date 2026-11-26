"""Exercise the staged primary runtime with its own interpreter (CORP-DSH-PLAN-026 §4.3 P2-4).

Run as ``python -I -B <this file> <pythonPackages JSON> <python version>`` from a
directory that holds nothing of the payload: every import has to come from the
payload's own site-packages, and every distribution it declares has to be
installed at exactly the version ``runtime.json`` records.
"""

import csv
import importlib.metadata
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

# The distributions whose upstream test suites the staging removes.
PRUNED = {"numpy", "pandas"}


def normalized(name):
    """The name pip compares distributions by: case and runs of ``-``, ``_`` and ``.`` set aside."""
    return re.sub(r"[-_.]+", "-", name).lower()


def check_distributions(declared):
    """Every declared distribution is installed at its version, and nothing else is."""
    installed = {normalized(dist.metadata["Name"]): dist.version for dist in importlib.metadata.distributions()}
    wanted = {normalized(name): version for name, version in declared.items()}
    # pip ships with the interpreter itself and is the one distribution runtime.json does not name.
    unexpected = sorted(set(installed) - set(wanted) - {"pip"})
    missing = sorted(set(wanted) - set(installed))
    assert not unexpected and not missing, {"unexpected": unexpected, "missing": missing}
    wrong = sorted(name for name, version in wanted.items() if installed[name] != version)
    assert not wrong, wrong
    return installed


def check_records(installed):
    """Each RECORD read back names files that are present, and a removed test suite left no row behind.

    pip is left out: it comes with the interpreter rather than a wheel, and its
    RECORD still names the bytecode files the standalone build strips.
    """
    for name in installed:
        distribution = importlib.metadata.distribution(name)
        record = distribution.read_text("RECORD")
        assert record, name
        if name == "pip":
            continue
        for row, _hash, _size in csv.reader(io.StringIO(record)):
            if not row:
                continue
            assert distribution.locate_file(row).exists(), (name, row)
            if name in PRUNED:
                assert "/tests/" not in f"/{row}", (name, row)


def check_interpreters(executable):
    """Each command alias starts, reports itself, and makes a virtual environment that carries pip."""
    names = [executable.name] if sys.platform == "win32" else ["python", "python3", executable.name]
    for name in names:
        interpreter = executable.with_name(name)
        child = subprocess.run(
            [
                str(interpreter),
                "-I",
                "-B",
                "-c",
                "import ctypes, sqlite3, ssl, sys; from pathlib import Path; "
                "assert Path(sys.executable) == Path(sys.argv[1])",
                str(interpreter),
            ],
            check=False,
            timeout=60,
        )
        assert child.returncode == 0, name
    with tempfile.TemporaryDirectory(prefix="heluo primary runtime ") as directory:
        environment = Path(directory) / "environment"
        subprocess.run([str(executable.with_name(names[0])), "-I", "-B", "-m", "venv", str(environment)], check=True, timeout=120)
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        subprocess.run([str(python), "-I", "-B", "-c", "import sys; assert sys.prefix != sys.base_prefix"], check=True, timeout=60)
        subprocess.run([str(python), "-I", "-B", "-m", "pip", "check"], check=True, timeout=120)


def check_libraries():
    """The numerical libraries compute, and the pruned test suites are gone from them."""
    import numpy
    import pandas

    # The testing helper is a native extension the libraries keep even without their test suites.
    import numpy._core._multiarray_tests  # noqa: F401

    assert numpy.arange(4).sum() == 6
    assert pandas.DataFrame({"n": [1, 2]}).n.sum() == 3
    for library in (numpy, pandas):
        root = Path(library.__file__).parent
        assert not any(path.is_dir() for path in root.rglob("tests")), root


def check_documents(root):
    """Write and read back one document of each Office kind with the bundled libraries."""
    from docx import Document
    from docx.shared import Inches as DocxInches
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Font
    from PIL import Image
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches
    import pandas

    image = root / "chart.png"
    Image.new("RGB", (80, 40), "#2878bc").save(image)
    with Image.open(image) as restored:
        assert restored.size == (80, 40)

    document = Document()
    document.add_heading("Office 文档", 0)
    document.add_paragraph("Editable text")
    document.add_table(rows=2, cols=2).cell(1, 1).text = "42"
    document.add_picture(str(image), width=DocxInches(1))
    document.save(root / "document.docx")
    reopened = Document(root / "document.docx")
    assert reopened.paragraphs[0].text == "Office 文档"
    assert reopened.tables[0].cell(1, 1).text == "42"

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1)).text = "Office 演示"
    slide.shapes.add_picture(str(image), Inches(1), Inches(2))
    chart_data = CategoryChartData()
    chart_data.categories = ["A", "B"]
    chart_data.add_series("Values", [2, 4])
    slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(3), Inches(2), Inches(4), Inches(3), chart_data)
    presentation.save(root / "presentation.pptx")
    reopened_presentation = Presentation(root / "presentation.pptx")
    assert len(reopened_presentation.slides) == 1
    chart = next(shape.chart for shape in reopened_presentation.slides[0].shapes if shape.has_chart)
    assert list(chart.series[0].values) == [2.0, 4.0]

    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Value", "Formula"])
    sheet.append([42, "=A2*2"])
    sheet["A1"].font = Font(bold=True)
    workbook.save(root / "workbook.xlsx")
    reopened_workbook = load_workbook(root / "workbook.xlsx")
    try:
        assert reopened_workbook.active["A2"].value == 42
        assert reopened_workbook.active["B2"].value == "=A2*2"
        assert reopened_workbook.active["A1"].font.bold
    finally:
        reopened_workbook.close()
    assert pandas.read_excel(root / "workbook.xlsx")["Value"].iloc[0] == 42


def main():
    # -I keeps the user's site-packages and PYTHON* variables out; -B keeps the payload as staged.
    assert sys.flags.isolated and sys.flags.dont_write_bytecode, "run with -I -B"
    assert sys.version_info[:3] == tuple(int(part) for part in sys.argv[2].split(".")), sys.version
    installed = check_distributions(json.loads(sys.argv[1]))
    check_records(installed)
    check_interpreters(Path(sys.executable))
    check_libraries()
    with tempfile.TemporaryDirectory(prefix="heluo office smoke-") as directory:
        check_documents(Path(directory))
    print("primary runtime smoke passed")


if __name__ == "__main__":
    main()
