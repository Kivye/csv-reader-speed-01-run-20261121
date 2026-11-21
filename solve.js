// csv-reader drop-in (fast): bulk slicing + clean-line fast path.
// Written from the prose spec only: no per-character string building
// on the hot path; indexOf/slice/split do the work.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  let pos = 0;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  const rows = [];
  const errors = [];
  let columns = null;
  let width = -1;
  let line = 1; // line number of the line starting at pos
  let firstDone = false; // a real record has been consumed (header or first row)

  const rowOf = () => (header && !firstDone ? null : rows.length);

  // Scan one bare (unquoted) field starting at p: up to the next comma
  // (field ends, record continues) or LF / CRLF / EOF (record ends).
  // A CR not followed by LF is dropped with a stray_cr error.
  // Returns [value, nextPos, ended] with ended 0 = comma, 1 = record end.
  function scanBare(p, startLine) {
    let parts = null;
    let start = p;
    for (;;) {
      const c = text.indexOf(',', p);
      const lf = text.indexOf('\n', p);
      let m = n;
      let kind = 1; // 0 comma, 1 LF/EOF
      if (c !== -1) { m = c; kind = 0; }
      if (lf !== -1 && lf < m) { m = lf; kind = 1; }
      // CR search bounded to [p, m): a CR past the field end cannot matter.
      const crRel = text.slice(p, m).indexOf('\r');
      if (crRel !== -1) {
        const cr = p + crRel;
        if (cr + 1 === m && kind === 1 && m < n) {
          // CRLF ending the record.
          const seg = text.slice(start, cr);
          line++;
          return [parts === null ? seg : parts.join('') + seg, m + 1, 1];
        }
        // stray CR: dropped, error recorded, field continues
        errors.push({ code: 'stray_cr', line: startLine, row: rowOf() });
        if (parts === null) parts = [text.slice(start, cr)];
        else parts.push(text.slice(start, cr));
        p = cr + 1;
        start = p;
        continue;
      }
      if (m === n) {
        const tail = text.slice(start);
        return [parts === null ? tail : parts.join('') + tail, n, 1];
      }
      const seg = text.slice(start, m);
      if (kind === 0) return [parts === null ? seg : parts.join('') + seg, m + 1, 0];
      line++;
      return [parts === null ? seg : parts.join('') + seg, m + 1, 1];
    }
  }

  // Scan one quoted field starting at p (text[p] === '"').
  // Returns [value, nextPos, ended] with ended 0 = comma, 1 = record end.
  function scanQuoted(p, startLine) {
    let qpos = p + 1;
    const parts = [];
    let lineLocal = 0; // lines passed inside quotes; committed only on close
    for (;;) {
      const q = text.indexOf('"', qpos);
      if (q === -1) {
        // Never closed: the quote is a literal, the rest is re-read bare.
        errors.push({ code: 'unterminated_quote', line: startLine, row: rowOf() });
        const r = scanBare(p + 1, startLine);
        return ['"' + r[0], r[1], r[2]];
      }
      // Any CR / LF inside the chunk [qpos, q)? Bounded to the chunk.
      const chunk = text.slice(qpos, q);
      const crRel = chunk.indexOf('\r');
      const lfRel = chunk.indexOf('\n');
      let s = -1;
      if (crRel !== -1) s = qpos + crRel;
      if (lfRel !== -1 && (s === -1 || qpos + lfRel < s)) s = qpos + lfRel;
      if (s === -1) {
        // Clean chunk: no line break before the quote.
        if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
          // Doubled quote -> one quote in the value.
          parts.push(text.slice(qpos, q + 1));
          qpos = q + 2;
          continue;
        }
        // Closing quote.
        parts.push(text.slice(qpos, q));
        line += lineLocal;
        qpos = q + 1;
        break;
      }
      // A line break sits inside the quotes: it becomes one LF in the value.
      parts.push(text.slice(qpos, s));
      parts.push('\n');
      lineLocal++;
      if (text.charCodeAt(s) === 13 && s + 1 < n && text.charCodeAt(s + 1) === 10) qpos = s + 2;
      else qpos = s + 1;
    }
    // Closed. What follows the closing quote?
    if (qpos >= n) return [parts.join(''), n, 1];
    const ch = text.charCodeAt(qpos);
    if (ch === 44) return [parts.join(''), qpos + 1, 0]; // comma
    if (ch === 10) { line++; return [parts.join(''), qpos + 1, 1]; } // LF
    if (ch === 13 && qpos + 1 < n && text.charCodeAt(qpos + 1) === 10) {
      line++;
      return [parts.join(''), qpos + 2, 1]; // CRLF
    }
    // Anything else: junk appended as-is up to comma / line break / EOF.
    const r = scanBare(qpos, startLine);
    if (r[0].length > 0) errors.push({ code: 'quote_junk', line: startLine, row: rowOf() });
    return [parts.join('') + r[0], r[1], r[2]];
  }

  // Parse one record starting at startPos with the general scanner.
  // Returns [fields, quotedFlags, endPos].
  function parseGeneral(startPos, startLine) {
    const fields = [];
    const quoted = [];
    let p = startPos;
    for (;;) {
      let r;
      if (text.charCodeAt(p) === 34) {
        r = scanQuoted(p, startLine);
        quoted.push(true);
      } else {
        r = scanBare(p, startLine);
        quoted.push(false);
      }
      fields.push(r[0]);
      p = r[1];
      if (r[2] === 1) return [fields, quoted, p];
    }
  }

  // Consume one finished record: skip rule, header, width pad/cut.
  function finishRecord(fields, quoted, startLine) {
    // A record of exactly one empty unquoted field is not a record
    // (a line of stray CRs only); its stray_cr errors still stand.
    if (fields.length === 1 && fields[0] === '' && (quoted === null || !quoted[0])) return;
    if (width === -1) {
      width = fields.length;
      firstDone = true;
      if (header) { columns = fields; return; }
      rows.push(fields);
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: startLine, row: rows.length, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: startLine, row: rows.length, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }

  while (pos < n) {
    const startLine = line;
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    if (lineEnd === pos) { // blank line: LF at once
      pos = lf + 1;
      line++;
      continue;
    }
    let contentEnd = lineEnd;
    if (lf !== -1 && text.charCodeAt(lineEnd - 1) === 13) contentEnd = lineEnd - 1; // CRLF
    if (contentEnd === pos) { // line is just "\r\n": blank line
      pos = lf + 1;
      line++;
      continue;
    }
    // Fast path: clean line (no quote, no CR inside the content).
    // Searches bounded to the line via a slice view.
    const lineSeg = text.slice(pos, contentEnd);
    if (lineSeg.indexOf('"') === -1 && lineSeg.indexOf('\r') === -1) {
      {
        const fields = lineSeg.split(',');
        pos = lf === -1 ? n : lf + 1;
        if (lf !== -1) line++;
        finishRecord(fields, null, startLine);
        continue;
      }
    }
    // General path.
    const g = parseGeneral(pos, startLine);
    pos = g[2];
    finishRecord(g[0], g[1], startLine);
  }

  return { columns, rows, errors };
}
