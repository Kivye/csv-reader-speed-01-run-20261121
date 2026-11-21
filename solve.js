// csv-reader drop-in (fast) v3: single-pass scanner, cached line end,
// no per-field array returns, no per-line slice copies.
// Written from the prose spec only: indexOf/slice do the work;
// strings are cut once, never built per character.

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
  let firstDone = false; // a real record has been consumed

  let scanEnded = 1; // set by scanners: 0 = comma (record continues), 1 = record end
  let fieldCrossed = false; // set by scanQuoted: quoted content crossed a line break

  // Monotonic next-occurrence caches: parse positions only move forward,
  // so the first CR / LF at or after a watermark is found once and reused
  // instead of rescanning the same region per field.
  let crPos = 0;
  let crVal = text.indexOf('\r', 0);
  function nextCR(p) {
    if (p < crPos || (crVal !== -1 && crVal < p)) {
      crVal = text.indexOf('\r', p);
      crPos = p;
    }
    return crVal;
  }
  let lfPos = 0;
  let lfVal = text.indexOf('\n', 0);
  function nextLF(p) {
    if (p < lfPos || (lfVal !== -1 && lfVal < p)) {
      lfVal = text.indexOf('\n', p);
      lfPos = p;
    }
    return lfVal;
  }

  // Scan one bare (unquoted) field starting at p.
  // lineEnd: index of the LF ending the current line, n for an EOF line,
  // or -1 when unknown (quoted content crossed lines earlier).
  // Sets pos + scanEnded, bumps line on record end. Returns the value.
  function scanBare(p, startLine, rowIdx, lineEnd) {
    let parts = null;
    let start = p;
    for (;;) {
      const c = text.indexOf(',', p);
      let m, kind; // kind 0 = comma, 1 = line end / EOF
      if (lineEnd >= 0) {
        if (c !== -1 && c < lineEnd) { m = c; kind = 0; }
        else { m = lineEnd; kind = 1; }
      } else {
        const lf = nextLF(p);
        if (c !== -1 && (lf === -1 || c < lf)) { m = c; kind = 0; }
        else if (lf !== -1) { m = lf; kind = 1; }
        else { m = n; kind = 1; }
      }
      const cr = nextCR(p);
      if (cr !== -1 && cr < m) {
        if (kind === 1 && cr + 1 === m && m < n) {
          // CRLF ending the record.
          const seg = text.slice(start, cr);
          line++;
          pos = m + 1;
          scanEnded = 1;
          return parts === null ? seg : parts.join('') + seg;
        }
        // Stray CR: dropped, error recorded, field continues.
        errors.push({ code: 'stray_cr', line: startLine, row: rowIdx });
        if (parts === null) parts = [text.slice(start, cr)];
        else parts.push(text.slice(start, cr));
        p = cr + 1;
        start = p;
        continue;
      }
      const seg = text.slice(start, m);
      if (kind === 0) {
        pos = m + 1;
        scanEnded = 0;
        return parts === null ? seg : parts.join('') + seg;
      }
      if (m < n) line++;
      pos = m < n ? m + 1 : n;
      scanEnded = 1;
      return parts === null ? seg : parts.join('') + seg;
    }
  }

  // Scan one quoted field starting at p (text[p] === '"').
  // Sets pos + scanEnded + fieldCrossed. Returns the value.
  function scanQuoted(p, startLine, rowIdx, lineEnd) {
    let qpos = p + 1;
    let segStart = qpos;
    let parts = null;
    let lineLocal = 0; // breaks inside quotes; committed to line only on close
    fieldCrossed = false;
    for (;;) {
      const q = text.indexOf('"', qpos);
      if (q === -1) {
        // Never closed: the quote is a literal, the rest is re-read bare.
        errors.push({ code: 'unterminated_quote', line: startLine, row: rowIdx });
        const bare = scanBare(p + 1, startLine, rowIdx, -1);
        return '"' + bare;
      }
      // First line break inside [segStart, q), if any.
      let brk = -1;
      let brkIsCR = false;
      const lfI = nextLF(segStart);
      if (lfI !== -1 && lfI < q) brk = lfI;
      const crI = nextCR(segStart);
      if (crI !== -1 && crI < q && (brk === -1 || crI < brk)) { brk = crI; brkIsCR = true; }
      if (brk === -1) {
        // Clean chunk up to the quote at q.
        if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
          // Doubled quote -> one quote in the value.
          if (parts === null) parts = [text.slice(segStart, q + 1)];
          else parts.push(text.slice(segStart, q + 1));
          qpos = q + 2;
          segStart = qpos;
          continue;
        }
        // Closing quote.
        const tail = text.slice(segStart, q);
        const value = parts === null ? tail : parts.join('') + tail;
        line += lineLocal;
        fieldCrossed = lineLocal > 0;
        const after = q + 1;
        if (after >= n) { pos = n; scanEnded = 1; return value; }
        const ch = text.charCodeAt(after);
        if (ch === 44) { pos = after + 1; scanEnded = 0; return value; }
        if (ch === 10) { line++; pos = after + 1; scanEnded = 1; return value; }
        if (ch === 13 && after + 1 < n && text.charCodeAt(after + 1) === 10) {
          line++;
          pos = after + 2;
          scanEnded = 1;
          return value;
        }
        // Anything else: junk appended as-is up to comma / line break / EOF.
        const junk = scanBare(after, startLine, rowIdx, fieldCrossed ? -1 : lineEnd);
        if (junk.length > 0) errors.push({ code: 'quote_junk', line: startLine, row: rowIdx });
        return value + junk;
      }
      // A line break inside the quotes becomes one LF in the value.
      if (parts === null) parts = [text.slice(segStart, brk), '\n'];
      else { parts.push(text.slice(segStart, brk)); parts.push('\n'); }
      lineLocal++;
      if (brkIsCR && brk + 1 < n && text.charCodeAt(brk + 1) === 10) qpos = brk + 2;
      else qpos = brk + 1;
      segStart = qpos;
    }
  }

  // Consume one finished record: skip rule, header, width pad/cut.
  function finishRecord(fields, firstQuoted, startLine) {
    // A record of exactly one empty unquoted field is not a record
    // (blank line, or a line of stray CRs only); its stray_cr errors stand.
    if (fields.length === 1 && fields[0] === '' && !firstQuoted) return;
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
    const rowIdx = header && !firstDone ? null : rows.length;
    // LF ending this record's first line (n when the rest has no LF).
    const lf0 = nextLF(pos);
    let lineEnd = lf0 === -1 ? n : lf0;
    const fields = [];
    let firstQuoted = false;
    let f = 0;
    for (;;) {
      let val;
      if (text.charCodeAt(pos) === 34) {
        val = scanQuoted(pos, startLine, rowIdx, lineEnd);
        if (f === 0) firstQuoted = true;
        if (fieldCrossed) lineEnd = -1;
      } else {
        val = scanBare(pos, startLine, rowIdx, lineEnd);
      }
      fields.push(val);
      f++;
      if (scanEnded === 1) break;
    }
    finishRecord(fields, firstQuoted, startLine);
  }

  if (header && columns === null) columns = [];
  return { columns, rows, errors };
}
