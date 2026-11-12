// The comparison's sample documents, generated here (bench/generate.mjs): nothing third-party.
import { reportPdf } from "../generate.mjs";

export function sampleDocs() {
  return new Map([
    // Under recto's 8 MiB cut, so its viewer reads it whole.
    ["report-200.pdf", { label: "Report, 200 pages", bytes: reportPdf({ pages: 200, imageEvery: 4, imageSize: 320, outline: true }) }],
    ["brief-12.pdf", { label: "Brief, 12 pages", bytes: reportPdf({ pages: 12, imageEvery: 2, imageSize: 480, seed: 3 }) }],
    // Past it, so both read it by range.
    ["archive-600.pdf", { label: "Archive, 600 pages", bytes: reportPdf({ pages: 600, imageEvery: 4, imageSize: 320, seed: 5 }) }],
  ]);
}
