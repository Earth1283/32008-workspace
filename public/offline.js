/* Working without a connection: the last copy of the team's data, and a queue of changes waiting to reach the server.
   Both live in localStorage, which is written synchronously, so a change is safe before the screen updates.
   Each person has their own queue, so a shared tablet never sends one person's changes as another. */
(function () {
  const STATE_KEY = "008-state";
  const QUEUE_PREFIX = "008-queue:";
  const LEASE_KEY = "008-sync-lease";
  const LEASE_MS = 20_000;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const same = (a, b) => String(a) === String(b);
  const isLocalIssue = (id) => Number.isInteger(id) && id < 0;

  function saveState(storage, state) {
    try { storage.setItem(STATE_KEY, JSON.stringify({ at: Date.now(), state })); return true; } catch { return false; }
  }
  function loadState(storage) {
    try { return JSON.parse(storage.getItem(STATE_KEY)); } catch { return null; }
  }
  const clearState = (storage) => { try { storage.removeItem(STATE_KEY); } catch { /* storage unavailable */ } };

  /** One tab sends at a time. A tab that closes mid-sync loses the lease when it runs out. */
  function takeLease(storage, tab, now = Date.now()) {
    try {
      const held = JSON.parse(storage.getItem(LEASE_KEY));
      if (held && held.tab !== tab && held.until > now) return false;
      storage.setItem(LEASE_KEY, JSON.stringify({ tab, until: now + LEASE_MS }));
    } catch { /* storage unavailable: the server still ignores repeats */ }
    return true;
  }

  function releaseLease(storage, tab) {
    try {
      const held = JSON.parse(storage.getItem(LEASE_KEY));
      if (held && held.tab === tab) storage.removeItem(LEASE_KEY);
    } catch { /* storage unavailable */ }
  }

  /** Where a document points at an issue. Called with a replacement to rewrite those places. */
  function issueLinks(coll, doc, replace) {
    const found = [];
    const visit = (holder) => {
      if (!isLocalIssue(holder.issue)) return;
      found.push(holder.issue);
      if (replace) replace(holder);
    };
    if (coll === "notebook" || coll === "practice") visit(doc);
    if (coll === "meetings") (doc.actions ?? []).forEach(visit);
    return found;
  }
  const repoint = (coll, doc, localId, realId) => issueLinks(coll, doc, (holder) => { if (holder.issue === localId) holder.issue = realId; });

  function queue(storage, userId) {
    const key = QUEUE_PREFIX + userId;
    const read = () => { try { return JSON.parse(storage.getItem(key)) ?? []; } catch { return []; } };
    const write = (items) => { if (items.length) storage.setItem(key, JSON.stringify(items)); else storage.removeItem(key); };
    const change = (fn) => { const items = read(); const result = fn(items); write(items); return result; };
    let serial = 0;
    const newOp = (fields) => ({ id: `${Date.now().toString(36)}-${(serial++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`, v: 1, at: Date.now(), ...fields });
    const onTarget = (op, coll, id) => op.coll === coll && same(op.target, id);
    const waitingOnCreate = (op, items) => !!op.doc && issueLinks(op.coll, op.doc).some((id) => items.some((other) => other.type === "create" && other.coll === "issues" && other.target === id));
    const pending = (items) => items.filter((op) => !op.failed);

    return {
      key,
      all: read,
      pendingCount: () => pending(read()).length,
      failedCount: () => read().filter((op) => op.failed).length,

      create(coll, localId, cid, doc) {
        const { id: _id, rev: _rev, ...fields } = doc;
        change((items) => items.push(newOp({ type: "create", coll, target: localId, cid, doc: clone(fields) })));
      },

      /** Later edits of one document fold into the waiting one, keeping the copy the first edit started from. */
      save(coll, doc, was) {
        change((items) => {
          const waiting = items.find((op) => op.type !== "remove" && onTarget(op, coll, doc.id));
          if (!waiting) { items.push(newOp({ type: "save", coll, target: doc.id, doc: clone(doc), was: clone(was ?? doc) })); return; }
          const { id: _id, ...fields } = doc;
          waiting.doc = waiting.type === "create" ? clone({ ...fields, rev: undefined }) : clone(doc);
          waiting.v++;
          delete waiting.failed;
        });
      },

      remove(coll, id) {
        change((items) => {
          const neverSent = items.some((op) => op.type === "create" && onTarget(op, coll, id));
          for (let k = items.length - 1; k >= 0; k--) if (onTarget(items[k], coll, id)) items.splice(k, 1);
          if (!neverSent) items.push(newOp({ type: "remove", coll, target: id }));
        });
      },

      markRead(ids) {
        change((items) => {
          const waiting = items.find((op) => op.type === "read");
          if (!waiting) items.push(newOp({ type: "read", ids }));
          else waiting.ids = ids === "all" || waiting.ids === "all" ? "all" : [...new Set([...waiting.ids, ...ids])];
        });
      },

      /** The next change to send. An edit that points at a new issue waits until that issue exists on the server. */
      next() {
        const items = read(), ready = pending(items);
        return ready.find((op) => !waitingOnCreate(op, items)) ?? ready[0] ?? null;
      },

      /** The server gave a new document its real id: use it everywhere the waiting changes mention the local one. */
      resolve(coll, localId, realId) {
        change((items) => {
          for (const op of items) {
            if (onTarget(op, coll, localId)) { op.target = realId; if (op.type === "save") op.doc.id = realId; }
            if (coll === "issues") for (const doc of [op.doc, op.was]) if (doc) repoint(op.coll, doc, localId, realId);
          }
        });
      },

      /** A change reached the server. If it was edited while on its way, the newer text goes out as a further edit. */
      finish(opId, sentVersion, saved) {
        change((items) => {
          const at = items.findIndex((op) => op.id === opId);
          if (at < 0) return;
          const op = items[at];
          if (op.v === sentVersion) { items.splice(at, 1); return; }
          items[at] = { ...op, type: "save", target: saved.id, doc: { ...op.doc, id: saved.id, rev: saved.rev }, was: clone(saved) };
        });
      },

      fail(opId, message) { change((items) => { const op = items.find((x) => x.id === opId); if (op) op.failed = message; }); },
      retry(opId) { change((items) => { const op = items.find((x) => x.id === opId); if (op) delete op.failed; }); },
      discard(opId) { change((items) => { const at = items.findIndex((x) => x.id === opId); if (at >= 0) items.splice(at, 1); }); },

      /** The server's data with this device's waiting changes applied on top. */
      overlay(state) {
        const out = clone(state);
        for (const op of read()) {
          if (op.type === "read") {
            for (const note of out.inbox ?? []) if (op.ids === "all" || op.ids.includes(note.id)) note.read = true;
          } else if (op.type === "create") (out[op.coll] ??= []).push({ ...clone(op.doc), id: op.target, rev: 0 });
          else if (op.type === "save") out[op.coll] = out[op.coll].map((doc) => (same(doc.id, op.target) ? clone(op.doc) : doc));
          else out[op.coll] = out[op.coll].filter((doc) => !same(doc.id, op.target));
        }
        return out;
      },
    };
  }

  window.Offline = { saveState, loadState, clearState, takeLease, releaseLease, queue, repoint };
})();
