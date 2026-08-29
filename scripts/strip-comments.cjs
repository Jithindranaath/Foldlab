// Removes comments while leaving all other original formatting (indentation,
// line breaks, quote style) untouched, unlike ts.createPrinter which
// reprints and reformats the whole file. Walks the raw token stream with
// skipTrivia=false so it sees comment trivia tokens directly, and excises
// only those exact text ranges.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const targets = process.argv.slice(2);

function stripComments(text, scriptKind) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, scriptKind, text);
  const ranges = [];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      // Triple-slash directives (`/// <reference ... />`) are comments
      // syntactically but carry real compiler meaning (pulling in ambient
      // types) — never strip them.
      if (!/^\/\/\/\s*</.test(text.slice(start, end))) {
        ranges.push([start, end]);
      }
    }
    kind = scanner.scan();
  }

  let out = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [start, end] = ranges[i];
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

for (const file of targets) {
  const abs = path.resolve(file);
  const text = fs.readFileSync(abs, 'utf8');
  const scriptKind = abs.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : abs.endsWith('.ts')
    ? ts.ScriptKind.TS
    : ts.ScriptKind.Unknown;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let output = stripComments(text, scriptKind);
  // Trim trailing whitespace left on lines where a comment used to sit,
  // then collapse the resulting blank-line runs down to at most one.
  // Split/rejoin on the file's own actual EOL style (CRLF here) rather than
  // bare \n, since a bare-\n collapse regex never matches inside \r\n text.
  const lines = output.split(/\r\n|\n/).map((line) => line.replace(/[ \t]+$/, ''));
  const collapsed = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === '') {
      blankRun++;
      if (blankRun > 1) continue;
    } else {
      blankRun = 0;
    }
    collapsed.push(line);
  }
  output = collapsed.join(eol);
  fs.writeFileSync(abs, output, 'utf8');
  console.log('stripped', file);
}
