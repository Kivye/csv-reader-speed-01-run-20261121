// csv-reader drop-in (fast) v4: v3 single-pass scanner +
// (1) single-join string assembly everywhere (no rope concatenation),
// (2) per-record stray-CR-free flag: bare fields on a stray-CR-free first
// line skip the per-field CR search entirely.
// Semantics identical to SPEC.md; strings are cut once, never built
// per character.

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
  // fastCR: the current first line is known stray-CR-free, so no CR
  // search is needed while lineEnd >= 0 (a trailing CR before the LF is
  // the CRLF and is stripped from the final segment).
  // Sets pos + scanEnded, bumps line on record end. Returns the value.
  function scanBare(p, startLine, rowIdx, lineEnd, fastCR) {
    if (fastCR && lineEnd >= 0) {
      const c = text.indexOf(',', p);
      if (c !== -1 && c < lineEnd) {
        pos = c + 1;
        scanEnded = 0;
        return text.slice(p, c);
      }
      let end = lineEnd;
      if (lineEnd < n && lineEnd > p && text.charCodeAt(lineEnd - 1) === 13) end = lineEnd - 1;
      const seg = text.slice(p, end);
      if (lineEnd < n) line++;
      pos = lineEnd < n ? lineEnd + 1 : n;
      scanEnded = 1;
      return seg;
    }
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
          if (parts === null) return seg;
          parts.push(seg);
          return parts.join('');
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
      } else {
        if (m < n) line++;
        pos = m < n ? m + 1 : n;
        scanEnded = 1;
      }
      if (parts === null) return seg;
      parts.push(seg);
      return parts.join('');
    }
  }

  // Scan one quoted field starting at p (text[p] === '"').
  // Sets pos + scanEnded + fieldCrossed. Returns the value.
  function scanQuoted(p, startLine, rowIdx, lineEnd, fastCR) {
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
        const bare = scanBare(p + 1, startLine, rowIdx, -1, false);
        return ['"', bare].join('');
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
        line += lineLocal;
        fieldCrossed = lineLocal > 0;
        const after = q + 1;
        if (after >= n) {
          pos = n; scanEnded = 1;
          if (parts === null) return tail;
          parts.push(tail);
          return parts.join('');
        }
        const ch = text.charCodeAt(after);
        if (ch === 44) {
          pos = after + 1; scanEnded = 0;
          if (parts === null) return tail;
          parts.push(tail);
          return parts.join('');
        }
        if (ch === 10) {
          line++; pos = after + 1; scanEnded = 1;
          if (parts === null) return tail;
          parts.push(tail);
          return parts.join('');
        }
        if (ch === 13 && after + 1 < n && text.charCodeAt(after + 1) === 10) {
          line++;
          pos = after + 2;
          scanEnded = 1;
          if (parts === null) return tail;
          parts.push(tail);
          return parts.join('');
        }
        // Anything else: junk appended as-is up to comma / line break / EOF.
        const junk = scanBare(after, startLine, rowIdx, fieldCrossed ? -1 : lineEnd, fastCR && !fieldCrossed);
        if (junk.length > 0) errors.push({ code: 'quote_junk', line: startLine, row: rowIdx });
        if (parts === null) return junk.length > 0 ? [tail, junk].join('') : tail;
        parts.push(tail);
        if (junk.length > 0) parts.push(junk);
        return parts.join('');
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
    // (Cache reads inlined here: this is the per-record hot path.)
    let lf0 = lfVal;
    if (pos < lfPos || (lf0 !== -1 && lf0 < pos)) {
      lf0 = text.indexOf('\n', pos);
      lfVal = lf0;
      lfPos = pos;
    }
    let lineEnd = lf0 === -1 ? n : lf0;
    // Stray-CR-free first line? The only CR allowed at or before the
    // content end is the CR of a closing CRLF.
    let contentEnd = lineEnd;
    if (lineEnd < n && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) contentEnd = lineEnd - 1;
    let cr0 = crVal;
    if (pos < crPos || (cr0 !== -1 && cr0 < pos)) {
      cr0 = text.indexOf('\r', pos);
      crVal = cr0;
      crPos = pos;
    }
    const fastCR = cr0 === -1 || cr0 >= contentEnd;
    const fields = [];
    let firstQuoted = false;
    let f = 0;
    for (;;) {
      let val;
      if (text.charCodeAt(pos) === 34) {
        val = scanQuoted(pos, startLine, rowIdx, lineEnd, fastCR);
        if (f === 0) firstQuoted = true;
        if (fieldCrossed) lineEnd = -1;
      } else {
        val = scanBare(pos, startLine, rowIdx, lineEnd, fastCR && lineEnd >= 0);
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

// Cold-JIT priming (module init, once per process): sealed runs are
// always in a fresh container, so the scanner's hot functions are
// exercised on small synthetic inputs here to reach optimized code
// before the first real case. Results are discarded; run() itself
// stays pure and keeps no state between calls.
{
  const blockA = 'a,b,"c,d",e\r\n1,2,"x""y",3\n4,5,6,7\r8,"multi\nline",9,10\n';
  const blockB = 'p,"q,r",s\n1,2\n3,4,5,6\n\r\n"j"junk,z\r1\n"unterm';
  const sampleA = { text: blockA.repeat(40), header: true };
  const sampleB = { text: blockB.repeat(20), header: false };
  for (let i = 0; i < 20; i++) {
    JSON.stringify(run(sampleA));
    JSON.stringify(run(sampleB));
  }
}
