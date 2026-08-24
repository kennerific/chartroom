// Progress persistence. localStorage only, so nothing leaves the browser.

const KEY = "chartroom.progress.v1";
const THEME_KEY = "chartroom.theme";

export const NEW = 0, RELEARN = 1, KNOWN = 2;

function blank() {
  return { v: 1, items: {}, boards: {}, exam: null };
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || typeof d.items !== "object") return blank();
    d.boards = d.boards || {};
    return d;
  } catch (e) {
    // Corrupt or blocked storage should never take the app down.
    return blank();
  }
}

export class Store {
  constructor() {
    this.d = read();
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.d));
    } catch (e) {
      /* private mode or quota: run without persistence */
    }
  }

  item(id) {
    let r = this.d.items[id];
    if (!r) r = this.d.items[id] = { s: NEW, hits: 0, seen: 0, missed: 0 };
    return r;
  }

  state(id) {
    return this.item(id).s;
  }

  /** A feature already missed must be earned twice; a fresh one clears on the
   *  first clean hit. Returns true when it has reached KNOWN. */
  recordHit(id) {
    const r = this.item(id);
    r.seen++;
    r.hits++;
    const needed = r.s === RELEARN ? 2 : 1;
    if (r.hits >= needed) r.s = KNOWN;
    this.save();
    return r.s === KNOWN;
  }

  recordMiss(id) {
    const r = this.item(id);
    r.seen++;
    r.missed++;
    r.hits = 0;
    r.s = RELEARN;
    this.save();
  }

  studied(rid) {
    return !!(this.d.boards[rid] && this.d.boards[rid].studied);
  }

  markStudied(rid) {
    this.d.boards[rid] = Object.assign(this.d.boards[rid] || {}, { studied: true });
    this.save();
  }

  knownCount(ids) {
    return ids.filter((id) => this.state(id) === KNOWN).length;
  }

  recordExam(right, wrong, total) {
    const prev = this.d.exam;
    const run = { right, wrong, total, at: Date.now() };
    if (!prev || right > prev.right) this.d.exam = run;
    this.save();
    return this.d.exam;
  }

  get exam() {
    return this.d.exam;
  }

  resetBoard(ids) {
    ids.forEach((id) => delete this.d.items[id]);
    this.save();
  }

  resetAll() {
    this.d = blank();
    this.save();
  }
}

/* ------------------------------------------------------------------- theme */
export function initTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  return t;
}

export function toggleTheme() {
  const root = document.documentElement;
  const current =
    root.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
  return next;
}
