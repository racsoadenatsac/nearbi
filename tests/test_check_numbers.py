import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import check_numbers as cn  # noqa: E402


class CheckNumbers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pack = Path(self.tmp.name)
        (self.pack / "results").mkdir()
        (self.pack / "results" / "q.csv").write_text("name,n,pct\na,1036408,93.03\nb,7,9.8\nc,90,0.01\n")

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, prose, rounding=False):
        return cn.check_text(f"---\nparams: [30]\n---\n# T\n\n## Claim\n\n{prose}\n\n## Queries\n\n999 ignored\n", self.pack, rounding)

    def test_exact(self):
        self.assertEqual(self.check("1,036,408 tx, 93.03% and 0.01% over 30 days on 2026-10-01")[1], [])

    def test_untraced(self):
        _, bad = self.check("about 1.2 million, 42 signers")
        self.assertEqual([b[1] for b in bad], ["1.2", "42"])

    def test_multipliers_are_numbers(self):
        self.assertEqual([b[1] for b in self.check("3x the rest, 7x, `0x1f` and 0x2a")[1]], ["3x"])

    def test_rounding_off_by_default(self):
        self.assertEqual([b[1] for b in self.check("93% and 10 per signer")[1]], ["93%", "10"])

    def test_rounding(self):
        self.assertEqual(self.check("93%, 93.0%, 10 per signer", rounding=True)[1], [])

    def test_rounding_never_rounds_integers_or_invents(self):
        _, bad = self.check("1,036,000 tx, 1,040,000 tx, 94%, 9.9", rounding=True)
        self.assertEqual([b[1] for b in bad], ["1,036,000", "1,040,000", "94%", "9.9"])

    def test_published_reports_still_pass(self):
        for pack in sorted((ROOT / "reports").iterdir()):
            if (pack / "REPORT.md").exists():
                r = subprocess.run([sys.executable, "-I", str(ROOT / "tools/check_numbers.py"), str(pack)], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, f"{pack.name}: {r.stdout}")


if __name__ == "__main__":
    unittest.main()
