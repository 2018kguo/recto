#!/usr/bin/env python3
"""Writes src/forms.rs: CJK radicals and Arabic presentation forms to the
letters they stand for."""
import unicodedata
from pathlib import Path

def esc(s):
    return "".join("\\u{%04X}" % ord(ch) for ch in s)

def cjk(s):
    return all(0x4E00 <= ord(ch) <= 0x9FFF or 0x3400 <= ord(ch) <= 0x4DBF for ch in s)

def arabic(s):
    return all(0x0600 <= ord(ch) <= 0x06FF for ch in s)

rows = []
# Kangxi radicals and the radicals supplement: Chrome's embedded Noto CJK
# maps common ideographs (文, 用, 人) to these look-alike radicals.
for cp in list(range(0x2E80, 0x2F00)) + list(range(0x2F00, 0x2FE0)):
    c = chr(cp)
    nf = unicodedata.normalize("NFKC", c)
    if unicodedata.category(c) != "Cn" and nf != c and cjk(nf):
        rows.append((cp, nf))
for cp in list(range(0xFB50, 0xFE00)) + list(range(0xFE70, 0xFF00)):
    c = chr(cp)
    if unicodedata.category(c) == "Cn":
        continue
    nf = unicodedata.normalize("NFKC", c).strip()
    if nf == c or not nf or not arabic(nf):
        continue
    # Initial/medial Farsi yeh is drawn exactly like Arabic yeh.
    if cp in (0xFBFE, 0xFBFF):
        nf = "ي"
    rows.append((cp, nf))

body = "\n".join('    (0x%04X, "%s"),' % (cp, esc(nf)) for cp, nf in rows)
template = Path(__file__).with_name("forms.rs.in").read_text()
out = template.replace("{VERSION}", unicodedata.unidata_version).replace("{FORMS}", body)
Path(__file__).parent.parent.joinpath("src/forms.rs").write_text(out)
print(len(rows), "forms")
