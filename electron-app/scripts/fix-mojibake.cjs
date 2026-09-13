// One-off repair v4: exhaustively replace every mojibake sequence in
// browser/main.tsx with its intended character. Sequences are the
// accumulated result of 1–3 UTF-8→cp1252 corruption passes.
const fs = require('fs');
const f = 'src/browser/main.tsx';
let text = fs.readFileSync(f, 'utf8');

// Build the replacement map from the observed unique runs.
const c = (...codes) => String.fromCharCode(...codes);
const map = [
  // ” (right double quote) through 1–3 corruption passes
  [c(0x00C3, 0x0192, 0x00C2, 0x00A2, 0x00C3, 0x00A2, 0x00E2, 0x20AC, 0x0161, 0x00C2, 0x00AC, 0x00C3, 0x201A, 0x00C2, 0x009D), '\u201D'],
  [c(0x00C3, 0x0192, 0x00C2, 0x00A2, 0x00C3, 0x00A2, 0x00E2, 0x20AC, 0x0161, 0x00C2, 0x00AC, 0x00C3, 0x00A2, 0x00E2, 0x201A, 0x00AC, 0x00C2, 0x009D), '\u201D'],
  // “ (left double quote) through 2 passes
  [c(0x00C3, 0x0192, 0x00C2, 0x00A2, 0x00C3, 0x00A2, 0x00E2, 0x20AC, 0x0161, 0x00C2, 0x00AC, 0x00C3, 0x2026, 0x00E2, 0x20AC, 0x0153), '\u201C'],
  // ” through 1 pass
  [c(0x00C3, 0x00A2, 0x00E2, 0x201A, 0x00AC, 0x00E2, 0x20AC, 0x009D), '\u201D'],
  // … through 1 pass
  [c(0x00C3, 0x00A2, 0x00E2, 0x201A, 0x00AC, 0x00C2, 0x00A6), '\u2026'],
  // ’ (right single quote) through 2 passes — in "doesn't"/"TorWatch's"
  [c(0x00C3, 0x0192, 0x00C6, 0x2019, 0x00C3, 0x00A2, 0x00E2, 0x201A, 0x00AC, 0x00E2, 0x20AC, 0x009D), '\u2019'],
  // › (single right angle) through 2 passes — the ‹ in back-labels
  [c(0x00C3, 0x0192, 0x00C2, 0x00A2, 0x00C3, 0x00A2, 0x00E2, 0x201A, 0x00AC, 0x00C5, 0x00BE, 0x00C3, 0x201A, 0x00C2, 0x00A2), '\u2039'],
  // · through 2 passes
  [c(0x00C3, 0x0192, 0x00E2, 0x20AC, 0x0161, 0x00C3, 0x201A, 0x00C2, 0x00B7), '\u00B7'],
];

let total = 0;
for (const [bad, good] of map) {
  let count = 0;
  while (text.includes(bad)) {
    text = text.split(bad).join(good);
    count++;
  }
  total += count;
}
fs.writeFileSync(f, text, 'utf8');
const remaining = (text.match(/[^\x00-\x7F]/g) || []).filter((ch) => ch.codePointAt(0) > 0x2000).length;
console.log(`replaced ${total} sequence groups; legitimate non-ascii remaining: ${remaining}`);
