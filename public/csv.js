/* Reading spreadsheets into parts and issues. Handles what Excel really produces: CSV in several encodings, comma,
   semicolon or tab separators, title rows above the header, and cells pasted straight from a sheet. */
(function () {
  const PREVIEW_ROWS = 6;
  const MAX_ROWS = 2000;
  const HEADER_SEARCH_ROWS = 5;

  const FIELDS = {
    parts: [
      { key: "name", label: "Part", required: true, aliases: ["part", "name", "item", "part name", "component", "description"] },
      { key: "sub", label: "Subsystem", aliases: ["subsystem", "system", "category", "mechanism"] },
      { key: "have", label: "Have", aliases: ["have", "on hand", "in stock", "stock", "owned", "qty on hand"] },
      { key: "need", label: "Need", aliases: ["need", "needed", "required", "quantity", "qty", "total"] },
      { key: "ordered", label: "Ordered", aliases: ["ordered", "on order"] },
      { key: "price", label: "Unit price", aliases: ["price", "unit price", "price each", "cost", "unit cost"] },
      { key: "vendor", label: "Vendor", aliases: ["vendor", "supplier", "store", "source", "seller"] },
    ],
    issues: [
      { key: "title", label: "Title", required: true, aliases: ["title", "task", "issue", "summary", "name", "what", "to do"] },
      { key: "sub", label: "Subsystem", aliases: ["subsystem", "system", "category", "area"] },
      { key: "status", label: "Status", aliases: ["status", "state", "progress"] },
      { key: "pri", label: "Priority", aliases: ["priority", "pri", "importance"] },
      { key: "who", label: "Assignee", aliases: ["assignee", "assigned to", "owner", "who", "person", "responsible"] },
      { key: "due", label: "Due", aliases: ["due", "due date", "deadline", "by when"] },
      { key: "desc", label: "Description", aliases: ["description", "details", "notes", "comments"] },
    ],
  };

  const STATUS_WORDS = {
    todo: ["todo", "to do", "not started", "open", "backlog", "planned", "new"],
    doing: ["doing", "in progress", "started", "working", "wip", "active"],
    review: ["review", "in review", "testing", "needs review"],
    blocked: ["blocked", "waiting", "stuck", "on hold"],
    done: ["done", "complete", "completed", "finished", "closed", "yes"],
  };
  const PRIORITY_WORDS = { high: ["high", "h", "urgent", "critical", "1"], low: ["low", "l", "minor", "3"] };

  const normalize = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const clip = (s, max) => String(s ?? "").trim().slice(0, max);
  const titleIdentity = (s) => clip(s, 200).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  const keyWord = (table, text, fallback) => Object.keys(table).find((k) => table[k].includes(normalize(text))) ?? fallback;

  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("windows-1252").decode(bytes); }
  }

  function separatorOf(text) {
    const firstLines = text.split(/\r?\n/).slice(0, HEADER_SEARCH_ROWS).join("\n").replace(/"[^"]*"/g, "");
    const count = (ch) => firstLines.split(ch).length - 1;
    if (count("\t")) return "\t";
    return count(";") > count(",") ? ";" : ",";
  }

  /** Every row as an array of cells, each with its line in the file. Quotes may contain separators and line breaks. */
  function splitRows(text) {
    const separator = separatorOf(text), rows = [];
    let cells = [], cell = "", quoted = false, line = 1, rowLine = 1;
    const endCell = () => { cells.push(cell.trim()); cell = ""; };
    const endRow = () => { endCell(); rows.push({ line: rowLine, cells }); cells = []; rowLine = line; };
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (quoted) {
        if (ch === '"' && text[k + 1] === '"') { cell += '"'; k++; }
        else if (ch === '"') quoted = false;
        else { if (ch === "\n") line++; cell += ch; }
      } else if (ch === '"' && !cell) quoted = true;
      else if (ch === separator) endCell();
      else if (ch === "\n") { line++; endRow(); }
      else if (ch !== "\r") cell += ch;
    }
    if (cell || cells.length) endRow();
    return rows.filter((row) => row.cells.some(Boolean));
  }

  /** The header is the first row with at least two filled cells, so a title row above it is ignored. */
  function parse(text) {
    const rows = splitRows(String(text ?? "").replace(/^﻿/, ""));
    const searched = rows.slice(0, HEADER_SEARCH_ROWS).findIndex((row) => row.cells.filter(Boolean).length >= 2);
    const at = Math.max(0, searched);
    return { headers: rows[at]?.cells ?? [], rows: rows.slice(at + 1) };
  }

  function guessColumns(kind, headers) {
    const taken = new Set(), columns = {};
    const names = headers.map(normalize);
    const take = (field, matches) => {
      if (columns[field.key] !== undefined) return;
      const at = names.findIndex((name, k) => !taken.has(k) && name && field.aliases.some((alias) => matches(name, alias)));
      if (at >= 0) { columns[field.key] = at; taken.add(at); }
    };
    for (const field of FIELDS[kind]) take(field, (name, alias) => name === alias);
    for (const field of FIELDS[kind]) take(field, (name, alias) => alias.length >= 4 && name.includes(alias));
    return columns;
  }

  function parseNumber(text) {
    const cleaned = String(text ?? "").replace(/[$€£\s]/g, "");
    if (!cleaned) return 0;
    let plain;
    if (cleaned.includes(",") && cleaned.includes(".")) {
      const decimal = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? "," : ".";
      const group = decimal === "," ? "." : ",";
      const [whole, fraction, extra] = cleaned.split(decimal);
      const groups = whole.split(group);
      if (extra !== undefined || !/^\d+$/.test(fraction) || !/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((s) => !/^\d{3}$/.test(s))) return null;
      plain = groups.join("") + "." + fraction;
    } else plain = /^\d+,\d{1,2}$/.test(cleaned) ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
    const value = Number(plain);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const isoDate = (y, m, d) => {
    const year = y < 100 ? 2000 + y : y, date = new Date(Date.UTC(year, m - 1, d));
    return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${year}-${pad(m)}-${pad(d)}` : null;
  };
  /** YYYY-MM-DD, or month/day/year. A first number over 12 can only be a day, so that is read as day/month/year. */
  function parseDate(text) {
    const s = String(text ?? "").trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return isoDate(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
    if (m) return +m[1] > 12 ? isoDate(+m[3], +m[2], +m[1]) : isoDate(+m[3], +m[1], +m[2]);
    return null;
  }

  function findSubsystem(text, subs) {
    const wanted = normalize(text);
    return Object.keys(subs).find((key) => key === wanted || normalize(subs[key]) === wanted) ?? "team";
  }

  function findPeople(text, people) {
    const names = String(text ?? "").split(/[,;/&]| and /).map(normalize).filter(Boolean);
    const matches = (person, name) => normalize(person.name) === name || normalize(person.name).split(" ")[0] === name || person.handle === name;
    return names.map((name) => people.find((person) => matches(person, name))?.id).filter(Boolean);
  }

  const cellOf = (row, columns, key) => (columns[key] === undefined ? "" : row.cells[columns[key]] ?? "");

  function partFrom(cell, ctx) {
    const counts = {};
    for (const key of ["have", "need", "ordered", "price"]) {
      const value = parseNumber(cell(key));
      if (value === null) return { reason: `${key} isn't a number` };
      counts[key] = key === "price" ? value : Math.round(value);
      const max = key === "price" ? 1_000_000 : 100_000;
      if (counts[key] > max) return { reason: `${key} can't be more than ${max}` };
    }
    return { doc: { name: clip(cell("name"), 200), sub: findSubsystem(cell("sub"), ctx.subs), ...counts, need: cell("need") ? counts.need : 1, vendor: clip(cell("vendor"), 100) } };
  }

  function issueFrom(cell, ctx, notes) {
    const sub = findSubsystem(cell("sub"), ctx.subs);
    const who = findPeople(cell("who"), ctx.people);
    if (cell("who") && !who.length) notes.unknownPeople++;
    const due = cell("due") ? parseDate(cell("due")) : undefined;
    if (due === null) notes.badDates++;
    return { doc: {
      title: clip(cell("title"), 200), type: ctx.typeFor(sub), sub,
      status: keyWord(STATUS_WORDS, cell("status"), "todo"), pri: keyWord(PRIORITY_WORDS, cell("pri"), "med"),
      who: who.length ? who.slice(0, 10) : [ctx.me], created: ctx.today, due: due ?? undefined, desc: clip(cell("desc"), 5000),
    } };
  }

  /** Turns rows into documents. Rows that can't be used, or that already exist, are listed with the reason. */
  function prepare(kind, table, columns, ctx) {
    const titleKey = FIELDS[kind][0].key;
    const seen = new Set(ctx.existing.map(titleIdentity));
    const ready = [], skipped = [], notes = { unknownPeople: 0, badDates: 0 };
    for (const row of table.rows.slice(0, MAX_ROWS)) {
      const cell = (key) => cellOf(row, columns, key);
      const title = titleIdentity(cell(titleKey));
      if (!title) { skipped.push({ line: row.line, reason: `no ${FIELDS[kind][0].label.toLowerCase()}` }); continue; }
      if (seen.has(title)) { skipped.push({ line: row.line, reason: `${clip(cell(titleKey), 40)} is already here` }); continue; }
      const { doc, reason } = kind === "parts" ? partFrom(cell, ctx) : issueFrom(cell, ctx, notes);
      if (reason) { skipped.push({ line: row.line, reason }); continue; }
      seen.add(title);
      ready.push(doc);
    }
    if (table.rows.length > MAX_ROWS) skipped.push({ line: table.rows[MAX_ROWS].line, reason: `only the first ${MAX_ROWS} rows are read` });
    return { ready, skipped, notes };
  }

  window.CsvImport = { FIELDS, PREVIEW_ROWS, decode, parse, guessColumns, prepare, parseDate, parseNumber };
})();
