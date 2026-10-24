(function () {
  const lower = (s) => String(s).toLowerCase();
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const MS_PER_DAY = 864e5;
  const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const SLOT_ROW_LIMIT = 6;
  const MAX_ROWS = 9;
  const LOOSE_ROW_LIMIT = 8;
  const PREFIX_MATCH_BONUS = 50;

  const utcMs = (iso) => Date.parse(iso + "T00:00:00Z");
  const isoFromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

  function resolveDate(text, today) {
    const word = lower(text).trim();
    if (word === "none" || word === "clear") return "";
    if (word === "today") return today;
    if (word === "tomorrow") return isoFromMs(utcMs(today) + MS_PER_DAY);
    if (ISO_DATE.test(word)) return isoFromMs(utcMs(word)) === word ? word : null;
    const weekday = WEEKDAYS.findIndex((day) => day === word || day.slice(0, 3) === word);
    if (weekday < 0) return null;
    const todayWeekday = new Date(utcMs(today)).getUTCDay();
    const daysAhead = ((weekday - todayWeekday + 6) % 7) + 1;
    return isoFromMs(utcMs(today) + daysAhead * MS_PER_DAY);
  }

  const parseTemplate = (source) => source.split(/\s+/).map((word) => (word[0] === "{" ? { slot: word.slice(1, -1) } : { words: word.split("|") }));
  const templateText = (parts, from = 0, to = parts.length) => parts.slice(from, to).map((part) => (part.words ? part.words[0] : `{${part.slot}}`)).join(" ");
  const literalRunEnd = (parts, from) => { let end = from; while (end < parts.length && parts[end].words) end++; return end; };
  const appendWord = (before, word) => (before && !before.endsWith(" ") ? before + " " : before) + word;

  function candidate({ id, names, label, hint = "", swatch }) {
    return { id, insert: names[0], names, keys: names.map(lower), label: label ?? capitalize(names[0]), hint, swatch };
  }

  function create(env) {
    const { F, ctx, act } = env;
    const cache = new Map();
    const cached = (key, build) => { if (!cache.has(key)) cache.set(key, build()); return cache.get(key); };

    const issueById = new Map(F.issues.map((issue) => [issue.id, issue]));
    const ref = (issue) => "FTC-" + issue.id;
    const isOpen = (issue) => issue.status !== "done";
    const isOverdue = (issue) => isOpen(issue) && issue.due && F.days(issue.due) < 0;
    const isDueWithin = (issue, days) => isOpen(issue) && issue.due && F.days(issue.due) >= 0 && F.days(issue.due) <= days;
    const isMine = (issue) => issue.who.includes(ctx.me);
    const isUnlogged = (issue) => issue.status === "done" && !issue.logged;
    const issueOnScreen = ctx.route === "issues" && ctx.arg ? issueById.get(+ctx.arg) ?? null : null;
    const daysLate = (issue) => -F.days(issue.due);
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

    function relevance(issue) {
      let score = issue.id / 1000;
      if (issue === issueOnScreen) score += 100;
      if (isOpen(issue)) score += 10;
      if (isOpen(issue) && isMine(issue)) score += 8;
      if (isOverdue(issue)) score += 12;
      else if (isDueWithin(issue, 2)) score += 7;
      if (issue.status === "blocked") score += 6;
      if (issue.status === "doing") score += 3;
      return score;
    }
    const issuesByRelevance = (command) => cached("issues:" + command.id, () =>
      F.issues.filter(command.issueFilter ?? (() => true)).map((issue) => [relevance(issue), issue]).sort((a, b) => b[0] - a[0]).map(([, issue]) => issue));
    const mostRelevant = (predicate) => issuesByRelevance({ id: "any" }).find(predicate);

    const NEXT_STATUS = { todo: "doing", doing: "review", review: "done", blocked: "doing" };
    const STATUS_ALIASES = { todo: ["to do"], doing: ["doing", "started"], review: ["review"], blocked: [], done: ["finished"] };
    const PAGES = [["home", "Home"], ["inbox", "Inbox"], ["mine", "My issues"], ["issues", "Issues"], ["season", "Season", ["calendar", "timeline"]], ["notebook", "Notebook"],
      ["parts", "Parts"], ["practice", "Practice"], ["meetings", "Meetings"], ["pit", "Pit board", ["pit"]], ["settings", "Settings", ["preferences"]]];
    const currentOr = (value, current) => (value === current ? "Current" : "");

    const firstName = (person) => person.name.split(" ")[0];
    const openLoad = (person) => cached("load:" + person.id, () => F.issues.filter((issue) => isOpen(issue) && issue.who.includes(person.id)).length);
    const experience = (person, sub) => (sub ? F.issues.filter((issue) => issue.sub === sub && issue.who.includes(person.id)).length : 0);

    function issueCandidates(command, wholeTitleAllowed) {
      return cached(`issueCandidates:${command.id}:${wholeTitleAllowed}`, () => issuesByRelevance(command).map((issue) => candidate({
        id: issue.id, label: ref(issue), hint: issue.title,
        names: [ref(issue), String(issue.id), "#" + issue.id, ...(wholeTitleAllowed ? [issue.title] : [])],
      })));
    }
    function dateCandidates(typed) {
      const named = (word, id) => candidate({ id, names: [word], hint: id ? F.fmt(id) : "Clear the date" });
      const base = cached("dates", () => [["today", F.today], ["tomorrow", resolveDate("tomorrow", F.today)], ["monday", resolveDate("monday", F.today)],
        ["wednesday", resolveDate("wednesday", F.today)], ["friday", resolveDate("friday", F.today)], ["none", ""]].map(([word, id]) => named(word, id)));
      const parsed = typed ? resolveDate(typed, F.today) : null;
      const alreadyListed = base.some((c) => c.keys.includes(lower(typed).trim()));
      return parsed && !alreadyListed ? [candidate({ id: parsed, names: [typed.trim()], label: F.fmt(parsed) }), ...base] : base;
    }
    const slotCandidates = {
      issue: (args, last, command) => issueCandidates(command, last),
      status: (args) => cached("status:" + (args.issue?.id ?? ""), () => {
        const current = issueById.get(args.issue?.id)?.status;
        const order = [...new Set([...(NEXT_STATUS[current] ? [NEXT_STATUS[current]] : []), ...F.statusOrder])];
        return order.filter((status) => status !== current).map((status) => candidate({
          id: status, label: F.status[status], names: [lower(F.status[status]), ...STATUS_ALIASES[status]], hint: NEXT_STATUS[current] === status ? "Next step" : "",
        }));
      }),
      pri: (args) => cached("pri:" + (args.issue?.id ?? ""), () => {
        const current = issueById.get(args.issue?.id)?.pri;
        return Object.entries(F.pri).filter(([key]) => key !== current).map(([key, label]) => candidate({ id: key, label, names: [lower(label)] }));
      }),
      person: (args) => cached("person:" + (args.issue?.id ?? ""), () => {
        const sub = issueById.get(args.issue?.id)?.sub;
        return [...F.people].sort((a, b) => experience(b, sub) - experience(a, sub) || openLoad(a) - openLoad(b)).map((person) => candidate({
          id: person.id, label: person.name,
          names: [lower(firstName(person)), lower(person.name), ...(person.id === ctx.me ? ["me"] : [])],
          hint: [`${openLoad(person)} open`, experience(person, sub) && `knows ${F.subs[sub].toLowerCase()}`, person.id === ctx.me && "you"].filter(Boolean).join(", "),
        }));
      }),
      date: (args, last, command, typed) => dateCandidates(typed),
      page: () => cached("page", () => PAGES.map(([id, label, aliases = []]) => candidate({ id, label, names: [lower(label), id, ...aliases] }))),
      sub: () => cached("sub", () => Object.entries(F.subs).map(([id, label]) => candidate({ id, label, names: [lower(label), id] }))),
      theme: () => cached("theme", () => ["dark", "light", "system"].map((id) => candidate({ id, names: [id], hint: currentOr(id, ctx.themePref) }))),
      density: () => cached("density", () => ["comfortable", "compact"].map((id) => candidate({ id, names: [id], hint: currentOr(id, ctx.density) }))),
      role: () => cached("role", () => ["captain", "programmer", "builder"].map((id) => candidate({ id, names: [id], hint: currentOr(id, ctx.role) }))),
      accent: () => cached("accent", () => env.accents.map(([value, name, color]) => candidate({
        id: value, label: name, swatch: color, names: [lower(name), ...(name.includes(" ") ? [lower(name.split(" ")[0])] : [])], hint: currentOr(value, ctx.accent),
      }))),
    };
    const FREE_TEXT_SLOT = "title";
    const BROWSABLE_SLOTS = new Set(["page", "sub", "theme", "density", "role", "accent"]);

    function candidatesFor(slot, args, last, command, typed = "") {
      return slotCandidates[slot](args, last, command, typed);
    }

    const writable = () => ctx.canWrite;
    const commands = [
      { id: "status", group: "Issue", available: writable, templates: ["set {issue} status to {status}", "mark {issue} as {status}", "move {issue} to {status}"],
        boost: () => (issueOnScreen ? 5 : 0), describe: (a) => `Set ${ref(issueById.get(a.issue.id))} to ${a.status.label}`, detail: (a) => issueById.get(a.issue.id).title,
        run: (a) => { const was = issueById.get(a.issue.id).status; act.setStatus(a.issue.id, a.status.id); return () => act.setStatus(a.issue.id, was); } },
      { id: "assign", group: "Issue", available: writable, templates: ["assign {issue} to {person}", "set {issue} assignee to {person}"],
        boost: () => (issueOnScreen ? 2 : 0), describe: (a) => `Assign ${ref(issueById.get(a.issue.id))} to ${a.person.label}`, detail: (a) => issueById.get(a.issue.id).title,
        run: (a) => {
          const was = issueById.get(a.issue.id).who.slice();
          act.setWho(a.issue.id, [a.person.id, ...was.slice(1).filter((id) => id !== a.person.id)]);
          return () => act.setWho(a.issue.id, was);
        } },
      { id: "priority", group: "Issue", available: writable, templates: ["set {issue} priority to {pri}"],
        boost: () => (issueOnScreen ? 1 : 0), describe: (a) => `Set ${ref(issueById.get(a.issue.id))} priority to ${a.pri.label}`, detail: (a) => issueById.get(a.issue.id).title,
        run: (a) => { const was = issueById.get(a.issue.id).pri; act.setField(a.issue.id, "pri", a.pri.id); return () => act.setField(a.issue.id, "pri", was); } },
      { id: "due", group: "Issue", available: writable, templates: ["set {issue} due to {date}"],
        boost: () => (issueOnScreen ? (issueOnScreen.due ? 1 : 3) : 0),
        describe: (a) => (a.date.id ? `Set ${ref(issueById.get(a.issue.id))} due ${F.fmt(a.date.id)}` : `Clear the due date on ${ref(issueById.get(a.issue.id))}`), detail: (a) => issueById.get(a.issue.id).title,
        run: (a) => { const was = issueById.get(a.issue.id).due ?? ""; act.setField(a.issue.id, "due", a.date.id); return () => act.setField(a.issue.id, "due", was); } },
      { id: "new", group: "Issue", available: writable, templates: ["new issue {title}", "create issue {title}"],
        boost: () => (ctx.route === "issues" ? 3 : 0), describe: (a) => `Create issue \u201C${a.title}\u201D`, run: (a) => act.newIssue(a.title) },
      { id: "draft", group: "Notebook", available: writable, templates: ["draft notebook entry for {issue}", "log {issue} in notebook"], issueFilter: (issue) => issue.status === "done",
        boost: () => (issueOnScreen && isUnlogged(issueOnScreen) ? 6 : F.issues.some(isUnlogged) ? 1 : 0),
        describe: (a) => `Draft the notebook entry for ${ref(issueById.get(a.issue.id))}`, detail: (a) => issueById.get(a.issue.id).title, run: (a) => act.draft(a.issue.id) },
      { id: "open", group: "Go", templates: ["open {issue}", "show {issue}", "go to {issue}"],
        describe: (a) => `Open ${ref(issueById.get(a.issue.id))}`, detail: (a) => issueById.get(a.issue.id).title, run: (a) => act.openIssue(a.issue.id) },
      { id: "page", group: "Go", templates: ["go to {page}", "open {page}", "show {page}"], describe: (a) => `Go to ${a.page.label}`, run: (a) => act.go(a.page.id) },
      { id: "filter", group: "Go", templates: ["filter issues by {sub}", "show {sub} issues"], describe: (a) => `Show ${a.sub.label} issues`, run: (a) => act.filterSub(a.sub.id) },
      { id: "theme", group: "Settings", templates: ["set theme to {theme}", "change theme to {theme}", "switch theme to {theme}"], boost: () => (ctx.route === "settings" ? 3 : 0),
        describe: (a) => `Set the theme to ${a.theme.id}`, run: (a) => { const was = ctx.themePref; act.setTheme(a.theme.id); return () => act.setTheme(was); } },
      { id: "accent", group: "Settings", templates: ["set accent to {accent}", "set accent color to {accent}", "set color to {accent}"], boost: () => (ctx.route === "settings" ? 2 : 0),
        describe: (a) => `Set the accent to ${lower(a.accent.label)}`, run: (a) => { const was = ctx.accent; act.setAccent(a.accent.id); return () => act.setAccent(was); } },
      { id: "density", group: "Settings", templates: ["set density to {density}"], boost: () => (ctx.route === "settings" ? 2 : 0),
        describe: (a) => `Set density to ${a.density.id}`, run: (a) => { const was = ctx.density; act.setDensity(a.density.id); return () => act.setDensity(was); } },
      { id: "role", group: "Settings", templates: ["set role to {role}", "switch role to {role}"], boost: () => (ctx.route === "settings" ? 1 : 0),
        describe: (a) => `Switch to the ${a.role.id} view`, run: (a) => { const was = ctx.role; act.setRole(a.role.id); return () => act.setRole(was); } },
      { id: "toggle", group: "Settings", templates: ["toggle theme"], describe: () => "Toggle the theme", run: () => { act.toggleTheme(); return () => act.toggleTheme(); } },
      { id: "github", group: "Admin", available: () => ctx.admin, templates: ["connect github"], describe: () => "Connect GitHub", run: () => act.connectGithub() },
      { id: "signout", group: "Account", templates: ["sign out", "log out"], describe: () => "Sign out", run: () => act.signOut() },
    ].filter((command) => !command.available || command.available()).map((command) => {
      const parsed = command.templates.map(parseTemplate);
      const slotNames = parsed[0].filter((part) => part.slot).map((part) => part.slot);
      return { ...command, parsed, boost: command.boost ?? (() => 0), browsable: slotNames.every((slot) => BROWSABLE_SLOTS.has(slot)) };
    });
    const commandById = new Map(commands.map((command) => [command.id, command]));
    const accentName = (value) => env.accents.find(([accent]) => accent === value)?.[1] ?? "Steel blue";
    const issueOf = (arg) => issueById.get(arg.id);
    const change = (label, from, to) => ({ label, from, to });
    const note = (text) => ({ text });
    const effects = {
      status: (a) => change(ref(issueOf(a.issue)), F.status[issueOf(a.issue).status], a.status.label),
      assign: (a) => change(ref(issueOf(a.issue)), F.person(issueOf(a.issue).who[0]).name, a.person.label),
      priority: (a) => change(ref(issueOf(a.issue)), F.pri[issueOf(a.issue).pri], a.pri.label),
      due: (a) => change(ref(issueOf(a.issue)), issueOf(a.issue).due ? F.fmt(issueOf(a.issue).due) : "no date", a.date.id ? F.fmt(a.date.id) : "no date"),
      theme: (a) => change("Theme", ctx.themePref, a.theme.id),
      accent: (a) => change("Accent", accentName(ctx.accent), a.accent.label),
      density: (a) => change("Density", ctx.density, a.density.id),
      role: (a) => change("View", ctx.role, a.role.id),
      toggle: () => change("Theme", ctx.theme, ctx.theme === "dark" ? "light" : "dark"),
      new: () => note("Opens the new issue form with this title"),
      draft: () => note("Opens the notebook with a draft entry"),
      open: () => note("Opens the issue"),
      page: () => note("Opens the page"),
      filter: () => note("Filters the issue list"),
      github: () => note("Opens the connection form"),
      signout: () => note("Ends this session on this device"),
    };
    const effectOf = (command, args) => effects[command.id]?.(args) ?? null;
    const boostOf = (command) => cached("boost:" + command.id, command.boost);

    function lookupCandidate(slot, word, args, command) {
      if (slot === FREE_TEXT_SLOT) return word ? { id: word, label: word } : null;
      const index = cached(`lookup:${slot}:${command.id}:${args.issue?.id ?? ""}`, () => {
        const byKey = new Map();
        for (const c of candidatesFor(slot, args, false, command)) for (const key of c.keys) if (!byKey.has(key)) byKey.set(key, c);
        return byKey;
      });
      return index.get(lower(word)) ?? null;
    }

    function walk(parts, text, command) {
      const args = {}, segments = [];
      let position = 0;
      for (let k = 0; k < parts.length; k++) {
        while (text[position] === " ") position++;
        const part = parts[k], isLast = k === parts.length - 1, start = position;
        const remaining = text.slice(position), spaceAt = remaining.indexOf(" ");
        const word = spaceAt < 0 ? remaining : remaining.slice(0, spaceAt);
        const stopHere = (partial, kind) => ({ k, partial, start, args, segments: partial ? [...segments, [start, start + partial.length, kind]] : segments });
        if (part.words) {
          if (spaceAt < 0) return !word || part.words.some((w) => w.startsWith(lower(word))) ? stopHere(word, "word") : null;
          if (!part.words.includes(lower(word))) return null;
          segments.push([start, start + word.length, "word"]);
        } else if (isLast) {
          return stopHere(remaining.trim(), "value");
        } else {
          if (spaceAt < 0) return stopHere(word, "value");
          const resolved = lookupCandidate(part.slot, word, args, command);
          if (!resolved) return null;
          args[part.slot] = resolved;
          segments.push([start, start + word.length, "value"]);
        }
        position = start + word.length;
      }
      while (text[position] === " ") position++;
      return position < text.length ? null : { k: parts.length, partial: "", start: position, args, segments, finished: true };
    }

    function pickCandidates(candidates, query, limit) {
      const wanted = lower(query).trim();
      if (!wanted) return candidates.slice(0, limit).map((c) => ({ c, via: c.insert }));
      const prefixHits = [], substringHits = [];
      for (const c of candidates) {
        const at = c.keys.findIndex((key) => key.startsWith(wanted));
        if (at >= 0) { prefixHits.push({ c, via: c.names[at] }); if (prefixHits.length >= limit) break; }
      }
      if (prefixHits.length < limit) {
        for (const c of candidates) {
          if (c.keys.some((key) => key.startsWith(wanted))) continue;
          if (c.keys.some((key) => key.includes(wanted))) { substringHits.push({ c, via: null }); if (prefixHits.length + substringHits.length >= limit) break; }
        }
      }
      return prefixHits.concat(substringHits);
    }

    function makeRow(command, parts, state, fields) {
      const complete = fields.complete;
      return {
        command: command.id, group: command.group, parts, stage: state.k, segments: state.segments, args: fields.args ?? state.args,
        score: boostOf(command) - (fields.order ?? 0) * 0.01 + (fields.ghostable ? PREFIX_MATCH_BONUS : 0),
        text: fields.text, complete, label: fields.label, detail: fields.detail ?? "", hint: fields.hint ?? "", swatch: fields.swatch,
        effect: complete ? effectOf(command, fields.args ?? state.args) : null,
        ghostable: !!fields.ghostable, atSlot: !!fields.atSlot,
        run: complete ? () => command.run(fields.args ?? state.args) : null,
      };
    }

    function rowsForState(command, parts, state, typed) {
      const before = typed.slice(0, state.start), part = parts[state.k];
      if (state.finished) return [makeRow(command, parts, state, { text: typed.trimEnd(), complete: true, label: command.describe(state.args), detail: command.detail?.(state.args) })];
      if (part.words) {
        if (!part.words.some((w) => w.startsWith(lower(state.partial)))) return [];
        const runEnd = literalRunEnd(parts, state.k), hasMore = runEnd < parts.length;
        const spoken = appendWord(before, parts.slice(state.k, runEnd).map((p) => p.words[0]).join(" "));
        return [makeRow(command, parts, state, hasMore
          ? { text: spoken + " ", complete: false, label: capitalize(templateText(parts, 0, runEnd)) + " …" }
          : { text: spoken, complete: true, label: command.describe(state.args) })];
      }
      const isLast = state.k === parts.length - 1;
      if (part.slot === FREE_TEXT_SLOT) {
        const title = state.partial;
        const args = { ...state.args, title };
        return [makeRow(command, parts, state, title
          ? { text: appendWord(before, title), complete: true, args, label: command.describe(args), atSlot: true }
          : { text: before, complete: false, label: capitalize(templateText(parts, 0, state.k)) + " …", hint: "Type a title", atSlot: true })];
      }
      const limit = isLast || state.partial ? SLOT_ROW_LIMIT : 1;
      const picks = pickCandidates(candidatesFor(part.slot, state.args, isLast, command, state.partial), state.partial, limit);
      const followingEnd = isLast ? parts.length : literalRunEnd(parts, state.k + 1);
      const followingWords = parts.slice(state.k + 1, followingEnd).map((p) => p.words[0]).join(" ");
      const hasMoreSlots = followingEnd < parts.length;
      return picks.map(({ c, via }, order) => {
        const args = { ...state.args, [part.slot]: c };
        const spoken = appendWord(before, via ?? c.insert);
        const text = isLast ? spoken : `${spoken} ${followingWords}${hasMoreSlots ? " " : ""}`;
        return makeRow(command, parts, state, {
          text, complete: isLast, args, order, ghostable: !!via, atSlot: true, swatch: c.swatch, hint: isLast ? c.hint : "",
          label: isLast ? command.describe(args) : `${capitalize(templateText(parts, 0, state.k))} ${c.label} ${followingWords}${hasMoreSlots ? " …" : ""}`,
          detail: isLast && command.detail ? command.detail(args) : c.hint,
        });
      });
    }

    function strictRows(typed) {
      const rows = [];
      for (const command of commands) {
        for (const parts of command.parsed) {
          const state = walk(parts, typed, command);
          if (!state) continue;
          const matched = rowsForState(command, parts, state, typed);
          if (!matched.length) continue;
          rows.push(...matched);
          break;
        }
      }
      return rows.sort((a, b) => b.score - a.score);
    }

    const searchBlobs = () => cached("blobs", () => F.issues.map((issue) => [lower(`${ref(issue)} ${issue.title}`), issue]));
    function looseRows(typed) {
      const words = lower(typed).split(/\s+/).filter(Boolean);
      const matchesAll = (haystack) => words.every((word) => haystack.includes(word));
      const rows = [];
      for (const command of commands) {
        if (!command.browsable) continue;
        const parts = command.parsed[0], slot = parts.find((part) => part.slot)?.slot;
        const options = slot ? candidatesFor(slot, {}, true, command) : [null];
        for (const option of options) {
          const args = slot ? { [slot]: option } : {};
          const label = command.describe(args);
          if (!matchesAll(lower(`${label} ${option ? option.keys.join(" ") : ""}`))) continue;
          const text = slot ? templateText(parts).replace(`{${slot}}`, option.insert) : templateText(parts);
          rows.push({ command: command.id, group: command.group, parts, stage: parts.length, segments: [], args, score: boostOf(command), text, complete: true, label, detail: "",
            hint: option?.hint ?? "", swatch: option?.swatch, effect: effectOf(command, args), ghostable: false, atSlot: false, loose: true, run: () => command.run(args) });
        }
      }
      const openCommand = commandById.get("open");
      const lowerTyped = lower(typed).trim();
      let issueRows = 0;
      for (const [blob, issue] of searchBlobs()) {
        if (!matchesAll(blob)) continue;
        const args = { issue: issueCandidates(openCommand, true).find((c) => c.id === issue.id) };
        rows.push({ command: "open", group: "Go", parts: openCommand.parsed[0], stage: 2, segments: [], args, score: -issueRows * 0.01, text: "open " + ref(issue), complete: true, label: ref(issue),
          detail: issue.title, hint: F.status[issue.status], effect: effectOf(openCommand, args), ghostable: false, atSlot: false, loose: true, titleStartsWithQuery: lower(issue.title).startsWith(lowerTyped),
          run: () => openCommand.run(args) });
        if (++issueRows >= LOOSE_ROW_LIMIT) break;
      }
      return rows.sort((a, b) => b.score - a.score);
    }

    function textFor(command, args) {
      return command.parsed[0].map((part) => (part.words ? part.words[0] : part.slot === FREE_TEXT_SLOT ? args.title : args[part.slot].insert)).join(" ").trim();
    }
    function suggestionRow(commandId, args, why, tone = "") {
      const command = commandById.get(commandId);
      if (!command) return null;
      return { command: commandId, group: command.group, parts: command.parsed[0], stage: command.parsed[0].length, segments: [], args, score: 0, text: textFor(command, args), complete: true,
        label: command.describe(args), detail: command.detail?.(args) ?? "", hint: "", effect: effectOf(command, args), ghostable: false, atSlot: false, why, tone, suggested: true, run: () => command.run(args) };
    }
    const issueArg = (issue) => issueCandidates(commandById.get("open"), true).find((c) => c.id === issue.id);
    const statusArg = (issue, id) => slotCandidates.status({ issue: { id: issue.id } }).find((c) => c.id === id);
    const lateWhy = (issue) => `Overdue by ${plural(daysLate(issue), "day")}`;

    function suggestions() {
      return cached("suggestions", () => {
        const out = [];
        const add = (row) => { if (row && !out.some((existing) => existing.text === row.text)) out.push(row); };
        const open = (issue, why, tone) => add(suggestionRow("open", { issue: issueArg(issue) }, why, tone));
        const current = issueOnScreen;
        if (current) {
          const arg = issueArg(current);
          if (isUnlogged(current)) add(suggestionRow("draft", { issue: arg }, "Done, not in the notebook yet", "warn"));
          if (current.status === "blocked") add(suggestionRow("status", { issue: arg, status: statusArg(current, "doing") }, "Blocked. Unblock it?", "warn"));
          else if (NEXT_STATUS[current.status]) add(suggestionRow("status", { issue: arg, status: statusArg(current, NEXT_STATUS[current.status]) }, "Next step for this issue"));
          if (isOverdue(current)) add(suggestionRow("due", { issue: arg, date: dateCandidates("")[1] }, lateWhy(current), "warn"));
          else if (isOpen(current) && !current.due) add(suggestionRow("due", { issue: arg, date: dateCandidates("")[4] }, "No due date yet"));
        }
        const elsewhere = (predicate) => mostRelevant((issue) => issue !== current && predicate(issue));
        const late = elsewhere((issue) => isOverdue(issue) && isMine(issue));
        if (late) open(late, lateWhy(late), "warn");
        const blocked = elsewhere((issue) => issue.status === "blocked");
        if (blocked) open(blocked, "Blocked", "warn");
        const soon = elsewhere((issue) => isDueWithin(issue, 3) && isMine(issue));
        if (soon) open(soon, F.days(soon.due) === 0 ? "Due today" : `Due ${F.fmt(soon.due)}`);
        const unlogged = F.issues.filter((issue) => issue !== current && isUnlogged(issue));
        if (unlogged.length) add(suggestionRow("draft", { issue: issueArg(unlogged[0]) }, `${unlogged.length} done, not in the notebook`));
        if (ctx.route === "settings") add(suggestionRow("theme", { theme: slotCandidates.theme().find((t) => t.id === (ctx.theme === "dark" ? "light" : "dark")) }, "Switch the look"));
        if (ctx.route === "issues" && !current && ctx.canWrite) add({ ...suggestionRow("new", { title: "" }, "Capture something"), text: "new issue ", complete: false, run: null, label: "New issue …" });
        const next = elsewhere((issue) => isOpen(issue) && isMine(issue));
        if (next) open(next, "Yours, most pressing");
        if (!out.length) add(suggestionRow("page", { page: slotCandidates.page().find((c) => c.id === "issues") }, "Start here"));
        return out.slice(0, 6);
      });
    }

    function verbMenu() {
      return cached("menu", () => commands.map((command) => {
        const parts = command.parsed[0], runEnd = literalRunEnd(parts, 0), hasMore = runEnd < parts.length;
        const text = parts.slice(0, runEnd).map((p) => p.words[0]).join(" ");
        return { command: command.id, group: command.group, parts, stage: 0, segments: [], args: {}, score: boostOf(command), text: hasMore ? text + " " : text, complete: !hasMore,
          label: capitalize(templateText(parts)), detail: "", hint: "", effect: null, menu: true, ghostable: false, atSlot: false,
          run: hasMore ? null : () => command.run({}) };
      }).sort((a, b) => b.score - a.score));
    }

    function ghostFor(typed, rows) {
      const lowerTyped = lower(typed);
      const continuing = rows.find((row) => !row.loose && row.text.length > typed.length && lower(row.text).startsWith(lowerTyped));
      if (continuing) return { ghost: continuing.text.slice(typed.length), row: continuing };
      const titled = rows.find((row) => row.titleStartsWithQuery);
      return titled ? { ghost: titled.detail.slice(typed.trim().length), row: titled } : { ghost: "", row: null };
    }

    function analyze(text) {
      const typed = text.replace(/^\s+/, "");
      if (!typed.trim()) {
        const lead = suggestions()[0] ?? null;
        return { rows: suggestions(), menu: verbMenu(), ghost: lead ? lead.text : "", ghostRow: lead, empty: true, typed };
      }
      const strict = strictRows(typed);
      const rows = (strict.length ? strict : looseRows(typed)).slice(0, MAX_ROWS);
      const { ghost, row } = ghostFor(typed, rows);
      return { rows, ghost, ghostRow: row, empty: false, typed };
    }

    return { analyze, commands };
  }

  window.CMD = { create, resolveDate };
})();
