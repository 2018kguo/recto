# Test fixtures

No file here is a real document; each has known text.

| File | What it is | How it was made |
|---|---|---|
| `linearized.pdf` | 6 pages of `Page N, line M` with a form field, rotated and odd-sized pages | `make-linearized.ts` (pdf-lib, then qpdf) |
| `chrome-mixed-rtl.pdf` | Lines of Hebrew, Arabic, Latin and digits | Headless Chromium printing `about:blank`, with a DejaVu Sans subset |
| `cjk-embedded.pdf` | `中文日本한국` | `make-cjk-embedded.mjs` (a subset of `assets/cjk-fallback.ttf`) |
| `cjk-predefined-cmap.pdf` | CJK on predefined CMaps, no embedded fonts | `cjkPdf()` in `cjk.test.ts` |
| `cjk-fallback-poppler.gray.gz` | The pages above rendered with Poppler, to compare glyph shapes | `pdftoppm`, with only `assets/cjk-fallback.ttf` visible to fontconfig |
| `user-password-secret.pdf` | Encrypted with the password `secret`, one blank page | Written for the tests |
| `encrypted-objstm-shifted.pdf` | 3 pages of `Encrypted page N`, encrypted, offsets shifted to force a repair | MuPDF |
| `encrypted-r6-no-trailer.pdf`, `encrypted-r6-password-no-trailer.pdf` | Revision 6, trailer and xref cut off, the second with the password `secret` | qpdf, then cut by hand |
| `encrypted-r4-no-trailer.pdf` | Revision 4, trailer and xref cut off, so its key can't be derived | qpdf, then cut by hand |
| `half-red-half-blue.jp2` | 16 x 16, the left half red and the right half blue | Drawn for the tests, then `sips -s format jp2` |
