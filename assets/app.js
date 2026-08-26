// Chartroom. Learn a board, drill a board, then sit the whole-world exam.
import {
  MapView, makeIndex, identify, hitItem, isWater, CAT_LABEL, WORLD,
} from "./map.js";
import { Store, NEW, RELEARN, KNOWN, initTheme, toggleTheme } from "./store.js";

const el = (id) => document.getElementById(id);
const ic = (n) => '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"></use></svg>';
const nameHTML = (it) => (isWater(it) ? '<i class="hydro">' + it.name + "</i>" : it.name);
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

let DATA, IDX, BY_ID, store;
let mode = "learn";
let board = null, stage = "study";
let mapL = null, mapE = null;

const study = { i: 0 };
const drill = { queue: [], right: 0, wrong: 0, streak: 0, locked: false };
const exam = {
  queue: [], right: 0, wrong: 0, streak: 0, total: 0,
  locked: false, missed: [], running: false,
};

/* =========================================================== boot */
initTheme();

function bootFailed(msg, err) {
  const b = el("boot");
  b.hidden = false;
  b.className = "boot failed";
  b.textContent = msg;
  if (err) console.error(err);
}

// Loading the data and starting the app fail for different reasons, so they get
// different messages. Folding them into one catch reported every code error as
// a missing-file error.
(async function boot() {
  let data;
  try {
    const r = await fetch("assets/mapdata.json");
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
  } catch (err) {
    return bootFailed(
      "Could not load assets/mapdata.json (" + err.message +
      "). Serve the site over HTTP rather than opening the file directly, or run " +
      "python tools/build_data.py to generate it.", err);
  }
  try {
    start(data);
  } catch (err) {
    bootFailed("The chart data loaded, but the interface failed to start: " + err.message, err);
  }
})();

function start(data) {
  DATA = data;
  BY_ID = {};
  DATA.items.forEach((i) => (BY_ID[i.id] = i));
  IDX = makeIndex(DATA.items);
  store = new Store();

  el("boot").hidden = true;
  // Unhide before constructing the maps: a canvas inside display:none has no
  // measurable box, so it would size to nothing.
  el("shell").hidden = false;
  el("tab-learn").onclick = () => setMode("learn");
  el("tab-exam").onclick = () => setMode("exam");
  syncThemeGlyph();
  el("theme").onclick = () => {
    toggleTheme();
    syncThemeGlyph();
    if (mapL) mapL.draw();
    if (mapE) mapE.draw();
  };

  mapL = new MapView(el("map-learn"), DATA, { labels: true, borders: true });
  mapE = new MapView(el("map-exam"), DATA, { labels: false, borders: false, terrain: false });
  attachHover(mapL, el("tip-learn"), () => (stage === "study" ? boardAllow() : null));
  attachHover(mapE, el("tip-exam"), () => null);

  el("map-learn").addEventListener("click", onLearnClick);
  el("map-exam").addEventListener("click", onExamClick);

  renderBoards();
  selectBoard(firstUnfinishedBoard(), false);
  setMode("learn");
  tally();

  // Fonts change text metrics, so redraw labels once they land.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { mapL.draw(); mapE.draw(); });
  }
}

/* =========================================================== chrome */
function setMode(m) {
  mode = m;
  el("tab-learn").setAttribute("aria-selected", m === "learn");
  el("tab-exam").setAttribute("aria-selected", m === "exam");
  // The exam has nothing to do with boards, so the rail collapses and the
  // world view gets the full width.
  el("shell").dataset.mode = m;
  el("view-learn").hidden = m !== "learn";
  el("view-exam").hidden = m !== "exam";
  // A canvas that was display:none has no measurable box, so size it now that
  // it is on screen rather than waiting for the ResizeObserver.
  (m === "exam" ? mapE : mapL).resize();
  if (m === "exam") renderExam();
  else renderPanel();
}

/** Show the mode you would switch to, not the one you are in. */
function syncThemeGlyph() {
  const dark =
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  el("theme-glyph").setAttribute("href", dark ? "#i-sun" : "#i-moon");
}

function tally() {
  const known = store.knownCount(DATA.items.map((i) => i.id));
  const total = DATA.items.length;
  el("tally-text").textContent = known + " of " + total + " known";
  el("tally-bar").style.width = (known / total) * 100 + "%";
}

const boardAllow = () => {
  const ids = new Set(board.ids);
  return (it) => ids.has(it.id);
};

function attachHover(map, tip, allowFn) {
  const cv = map.cv;
  cv.addEventListener("mousemove", (ev) => {
    const allow = allowFn();
    if (!allow) { tip.classList.remove("on"); return; }
    const [lon, lat] = map.geoFromEvent(ev);
    const it = identify(IDX, lon, lat, map.tolerance(6), allow);
    const r = cv.getBoundingClientRect();
    if (it) {
      tip.textContent = it.name;
      tip.classList.toggle("hydro", isWater(it));
      tip.style.left = ev.clientX - r.left + "px";
      tip.style.top = ev.clientY - r.top + "px";
      tip.classList.add("on");
    } else tip.classList.remove("on");
  });
  cv.addEventListener("mouseleave", () => tip.classList.remove("on"));
}

/* =========================================================== boards */
function firstUnfinishedBoard() {
  return (
    DATA.regions.find((r) => store.knownCount(r.ids) < r.ids.length) || DATA.regions[0]
  );
}

function renderBoards() {
  const host = el("boards");
  host.innerHTML = "";
  DATA.regions.forEach((r) => {
    const known = store.knownCount(r.ids);
    const pct = Math.round((known / r.ids.length) * 100);
    const done = known === r.ids.length;
    const studied = store.studied(r.id);
    const state = done ? "mastered" : studied ? "drilling" : "new";
    const glyph = done ? "check" : studied ? "crosshair" : "lock-simple";
    const label = done ? "Mastered" : studied ? "Studied, drilling" : "Not studied yet";
    const b = document.createElement("button");
    b.className = "brow";
    b.dataset.state = state;
    b.title = r.name + ". " + label + ". " + known + " of " + r.ids.length + " known.";
    b.setAttribute("aria-current", board && board.id === r.id ? "true" : "false");
    b.innerHTML =
      '<span class="bn">' + r.name + "</span>" +
      '<span class="bic" aria-hidden="true">' + ic(glyph) + "</span>" +
      '<span class="bmeta"><span class="bar"><i style="width:' + pct + '%"></i></span>' +
      "<span>" + known + "/" + r.ids.length + "</span></span>";
    b.onclick = () => selectBoard(r, true);
    host.appendChild(b);
  });
}

function selectBoard(r, animate) {
  board = r;
  el("board-name").textContent = r.name;
  // Study first. Once a board has been walked through, land straight on the drill.
  stage = store.studied(r.id) ? "drill" : "study";
  study.i = 0;
  mapL.layers = new Set(r.ids.map((id) => BY_ID[id].cat));
  mapL.setView(r.box, animate);
  resetDrill();
  renderBoards();
  renderPanel();
}

function setStage(s) {
  if (s === "drill" && !store.studied(board.id)) return;
  stage = s;
  if (s === "study") study.i = 0;
  else resetDrill();
  renderPanel();
}

/* =========================================================== panel */
/** One contextual line under the board name, in place of a standing paragraph
 *  of instructions nobody rereads. */
function stageNote() {
  const known = store.knownCount(board.ids);
  const total = board.ids.length;
  if (known === total) {
    return "<b>Board mastered.</b> All " + total +
      " features known. Pick another board, or sit the recall test.";
  }
  if (stage === "study") {
    return "Walk each feature once to see where it sits. " +
      "Finishing unlocks the drill, or skip ahead if you already know this board.";
  }
  return "Labels are off. Click the feature named on the right. " +
    "Anything you miss has to be found twice before it counts as known.";
}

function renderPanel() {
  const drillLocked = !store.studied(board.id);
  el("stage-study").setAttribute("aria-selected", stage === "study");
  el("stage-drill").setAttribute("aria-selected", stage === "drill");
  el("stage-drill").disabled = drillLocked;
  el("stage-drill").title = drillLocked
    ? "Study this board once to unlock the drill"
    : "Recall drill for this board";
  el("stage-drill").innerHTML =
    (drillLocked ? ic("lock-simple") : ic("crosshair")) + "<span>Drill</span>";

  mapL.opts.labels = stage === "study";
  mapL.opts.borders = el("opt-borders") ? el("opt-borders").checked : true;

  if (stage === "study") renderStudy();
  else renderDrill();
}

/* ---------------------------------------------------------- study */
function renderStudy() {
  el("stage-note").innerHTML = stageNote();
  const ids = board.ids;
  const it = BY_ID[ids[study.i]];
  const last = study.i === ids.length - 1;

  mapL.highlight = [{ id: it.id, style: "focus" }];
  mapL.marks = [];
  mapL.setView(it.zbox);

  el("panel-learn").innerHTML =
    '<div class="sec head">' +
      '<div class="eyebrow">' + CAT_LABEL[it.cat] + " &middot; " +
        (study.i + 1) + " of " + ids.length + "</div>" +
      '<div class="subject' + (isWater(it) ? " hydro" : "") + '">' + it.name + "</div>" +
      '<p class="hint">' + it.hint + "</p>" +
    "</div>" +
    '<div class="sec"><div class="btn-row">' +
      '<button class="btn" id="s-back"' + (study.i === 0 ? " disabled" : "") + ">" +
        ic("caret-left") + "<span>Back</span></button>" +
      '<button class="btn primary" id="s-next">' +
        (last ? ic("check") + "<span>Finish studying</span>"
              : "<span>Next</span>" + ic("caret-right")) + "</button>" +
      '<button class="btn" id="s-skip">Skip to drill</button>' +
    "</div></div>" +
    '<div class="sec">' +
      '<label class="toggle"><input type="checkbox" id="opt-borders"' +
        (mapL.opts.borders ? " checked" : "") + "><span>Country borders</span></label>" +
      '<label class="toggle"><input type="checkbox" id="opt-whole"' +
        (mapL.pendingBox === board.box ? " checked" : "") +
        "><span>Hold the whole board in view</span></label>" +
    "</div>" +
    '<div class="sec" style="padding:0">' +
      '<div class="eyebrow" style="padding:12px 17px 6px">On this board</div>' +
      '<div class="list" id="s-list"></div>' +
    "</div>";

  el("s-back").onclick = () => { if (study.i > 0) { study.i--; renderStudy(); } };
  el("s-next").onclick = () => {
    if (last) {
      store.markStudied(board.id);
      renderBoards();
      setStage("drill");
    } else { study.i++; renderStudy(); }
  };
  el("s-skip").onclick = () => {
    store.markStudied(board.id);
    renderBoards();
    setStage("drill");
  };
  el("opt-borders").onchange = (e) => { mapL.opts.borders = e.target.checked; mapL.draw(); };
  el("opt-whole").onchange = (e) => {
    if (e.target.checked) mapL.setView(board.box);
    else mapL.setView(BY_ID[board.ids[study.i]].zbox);
  };

  const list = el("s-list");
  ids.forEach((id, n) => {
    const f = BY_ID[id];
    const b = document.createElement("button");
    b.className = "row";
    b.setAttribute("aria-current", n === study.i ? "true" : "false");
    b.innerHTML =
      '<span class="nm' + (isWater(f) ? " hydro" : "") + '">' + f.name + "</span>" +
      '<span class="st">' + CAT_LABEL[f.cat].split(" ")[0] + "</span>";
    b.onclick = () => { study.i = n; renderStudy(); };
    list.appendChild(b);
  });
}

/* ---------------------------------------------------------- drill */
function resetDrill() {
  const pending = board.ids.filter((id) => store.state(id) !== KNOWN);
  drill.queue = shuffle(pending.length ? pending.slice() : board.ids.slice());
  drill.right = drill.wrong = drill.streak = 0;
  drill.locked = false;
}

function renderDrill() {
  el("stage-note").innerHTML = stageNote();
  mapL.opts.labels = false;
  const known = store.knownCount(board.ids);
  const total = board.ids.length;
  const it = drill.queue.length ? BY_ID[drill.queue[0]] : null;

  el("panel-learn").innerHTML =
    '<div class="sec head">' +
      '<div class="eyebrow">' + (it ? CAT_LABEL[it.cat] : "Board complete") + "</div>" +
      '<div class="subject' + (it && isWater(it) ? " hydro" : "") + '" id="d-subject">' +
        (it ? it.name : "Every feature mastered") + "</div>" +
      '<div class="verdict" id="d-verdict">' + ic("caret-right") +
        "<span>" + (it ? "Find it on the map." : "Pick another board, or sit the exam.") +
        "</span></div>" +
    "</div>" +
    '<div class="stats">' +
      '<div class="stat"><div class="v" id="d-right">' + drill.right + '</div><div class="k">Right</div></div>' +
      '<div class="stat"><div class="v" id="d-wrong">' + drill.wrong + '</div><div class="k">Wrong</div></div>' +
      '<div class="stat"><div class="v" id="d-streak">' + drill.streak + '</div><div class="k">Streak</div></div>' +
    "</div>" +
    '<div class="progress"><i id="d-bar" style="width:' + (known / total) * 100 + '%"></i></div>' +
    '<div class="sec"><div class="btn-row">' +
      '<button class="btn" id="d-show"' + (it ? "" : " disabled") + ">" +
        ic("eye") + "<span>Show me</span></button>" +
      '<button class="btn" id="d-skip"' + (it ? "" : " disabled") + ">Skip</button>" +
      '<button class="btn" id="d-restudy">' + ic("book-open") + "<span>Study again</span></button>" +
    "</div></div>" +
    '<div class="sec">' +
      '<label class="toggle"><input type="checkbox" id="opt-borders"' +
        (mapL.opts.borders ? " checked" : "") + "><span>Country borders</span></label>" +
      '<div style="margin-top:6px"><button class="btn" id="d-reset">' +
        ic("arrow-counter-clockwise") + "<span>Reset this board</span></button></div>" +
    "</div>" +
    '<div class="sec" style="padding:0">' +
      '<div class="eyebrow" style="padding:12px 17px 6px">Board progress</div>' +
      '<div class="list" id="d-list"></div>' +
    "</div>";

  el("d-show").onclick = revealCurrent;
  el("d-skip").onclick = () => {
    if (!drill.locked && drill.queue.length > 1) {
      drill.queue.push(drill.queue.shift());
      renderDrill();
    }
  };
  el("d-restudy").onclick = () => setStage("study");
  el("d-reset").onclick = () => {
    store.resetBoard(board.ids);
    resetDrill();
    renderBoards();
    tally();
    renderDrill();
  };
  el("opt-borders").onchange = (e) => { mapL.opts.borders = e.target.checked; mapL.draw(); };

  const list = el("d-list");
  board.ids.forEach((id) => {
    const f = BY_ID[id], s = store.state(id);
    const b = document.createElement("button");
    b.className = "row";
    b.setAttribute("aria-current", it && it.id === id ? "true" : "false");
    const cls = s === KNOWN ? "known" : s === RELEARN ? "relearn" : "";
    b.innerHTML =
      '<span class="nm' + (isWater(f) ? " hydro" : "") + '">' + f.name + "</span>" +
      '<span class="st ' + cls + '">' +
        (s === KNOWN ? "KNOWN" : s === RELEARN ? "AGAIN" : "NEW") + "</span>";
    b.onclick = () => {
      mapL.highlight = [{ id, style: "focus" }];
      mapL.setView(f.zbox);
      verdict("d-verdict", "", "eye", "Showing " + nameHTML(f) + ".");
    };
    list.appendChild(b);
  });

  if (it) {
    mapL.highlight = [];
    mapL.marks = [];
    mapL.setView(board.box);
  }
}

function verdict(id, cls, icon, html) {
  const v = el(id);
  if (!v) return;
  v.className = "verdict" + (cls ? " " + cls : "");
  v.innerHTML = ic(icon) + "<span>" + html + "</span>";
}

function revealCurrent() {
  if (drill.locked || !drill.queue.length) return;
  const it = BY_ID[drill.queue[0]];
  drill.locked = true;
  store.recordMiss(it.id);
  drill.wrong++;
  drill.streak = 0;
  mapL.highlight = [{ id: it.id, style: "no" }];
  mapL.setView(it.zbox);
  verdict("d-verdict", "no", "eye", "Here is " + nameHTML(it) + ". It stays in the queue.");
  el("d-wrong").textContent = drill.wrong;
  el("d-streak").textContent = "0";
  drill.queue.push(drill.queue.shift());
  setTimeout(() => { drill.locked = false; renderDrill(); tally(); }, 2100);
}

function onLearnClick(ev) {
  if (stage === "study") return;
  if (drill.locked || !drill.queue.length) return;
  const it = BY_ID[drill.queue[0]];
  const [lon, lat] = mapL.geoFromEvent(ev);
  const tol = mapL.tolerance(7);
  drill.locked = true;

  if (hitItem(lon, lat, it, tol, tol)) {
    const mastered = store.recordHit(it.id);
    drill.right++;
    drill.streak++;
    mapL.highlight = [{ id: it.id, style: "ok" }];
    mapL.marks = [{ lon, lat, style: "ok" }];
    if (mastered) {
      drill.queue.shift();
      verdict("d-verdict", "ok", "check", "Correct. " + nameHTML(it) + ".");
    } else {
      drill.queue.push(drill.queue.shift());
      verdict("d-verdict", "ok", "check",
        "Correct. " + nameHTML(it) + " comes back once more before it counts.");
    }
  } else {
    store.recordMiss(it.id);
    drill.wrong++;
    drill.streak = 0;
    mapL.highlight = [{ id: it.id, style: "no" }];
    mapL.marks = [{ lon, lat, style: "no" }];
    const other = identify(IDX, lon, lat, tol, boardAllow());
    verdict("d-verdict", "no", "x",
      (other && other.id !== it.id ? "That is " + nameHTML(other) + ". " : "") +
      nameHTML(it) + " is outlined.");
    drill.queue.push(drill.queue.shift());
  }

  el("d-right").textContent = drill.right;
  el("d-wrong").textContent = drill.wrong;
  el("d-streak").textContent = drill.streak;
  const known = store.knownCount(board.ids);
  el("d-bar").style.width = (known / board.ids.length) * 100 + "%";
  mapL.draw();
  tally();
  renderBoards();

  const wasRight = drill.streak > 0;
  setTimeout(() => { drill.locked = false; renderDrill(); }, wasRight ? 820 : 1850);
}

/* =========================================================== exam */
function renderExam() {
  const total = DATA.items.length;
  const known = store.knownCount(DATA.items.map((i) => i.id));
  const boardsDone = DATA.regions.filter((r) => store.knownCount(r.ids) === r.ids.length).length;
  const best = store.exam;

  el("exam-readiness").innerHTML =
    "<b>" + boardsDone + " of " + DATA.regions.length + " boards mastered</b>, " +
    known + " of " + total + " features known." +
    (best ? " Best exam so far: " + best.right + " of " + best.total + "." : "") +
    (boardsDone === DATA.regions.length
      ? " You are ready."
      : " The exam is open whenever you want it, but the boards are the gentler road.");

  el("exam-results").hidden = true;
  el("exam-work").hidden = false;
  if (!exam.running) renderExamStart();
  else renderExamPanel();
}

function renderExamStart() {
  mapE.layers = null;
  mapE.highlight = [];
  mapE.marks = [];
  mapE.setView(WORLD, false);
  el("panel-exam").innerHTML =
    '<div class="sec head">' +
      '<div class="eyebrow">Recall test</div>' +
      '<div class="subject">All 64, world view</div>' +
      '<div class="verdict">' + ic("graduation-cap") +
        "<span>No labels, no zoom, no hints. One pass through every feature.</span></div>" +
    "</div>" +
    '<div class="sec"><div class="btn-row">' +
      '<button class="btn primary" id="e-start">' + ic("crosshair") +
      "<span>Begin exam</span></button></div></div>" +
    '<div class="sec">' +
      '<label class="toggle"><input type="checkbox" id="e-terrain"><span>Shade ranges and deserts</span></label>' +
      '<label class="toggle"><input type="checkbox" id="e-borders"><span>Country borders</span></label>' +
    "</div>";
  el("e-start").onclick = startExam;
  el("e-terrain").onchange = (e) => { mapE.opts.terrain = e.target.checked; mapE.draw(); };
  el("e-borders").onchange = (e) => { mapE.opts.borders = e.target.checked; mapE.draw(); };
}

function startExam() {
  exam.queue = shuffle(DATA.items.map((i) => i.id));
  exam.total = exam.queue.length;
  exam.right = exam.wrong = exam.streak = 0;
  exam.missed = [];
  exam.locked = false;
  exam.running = true;
  mapE.setView(WORLD, false);
  renderExamPanel();
}

function renderExamPanel() {
  const it = exam.queue.length ? BY_ID[exam.queue[0]] : null;
  if (!it) return finishExam(true);
  const done = exam.total - exam.queue.length;

  el("panel-exam").innerHTML =
    '<div class="sec head">' +
      '<div class="eyebrow">' + CAT_LABEL[it.cat] + " &middot; " +
        (done + 1) + " of " + exam.total + "</div>" +
      '<div class="subject' + (isWater(it) ? " hydro" : "") + '">' + it.name + "</div>" +
      '<div class="verdict" id="e-verdict">' + ic("caret-right") +
        "<span>Click it on the map.</span></div>" +
    "</div>" +
    '<div class="stats">' +
      '<div class="stat"><div class="v" id="e-right">' + exam.right + '</div><div class="k">Right</div></div>' +
      '<div class="stat"><div class="v" id="e-wrong">' + exam.wrong + '</div><div class="k">Wrong</div></div>' +
      '<div class="stat"><div class="v" id="e-streak">' + exam.streak + '</div><div class="k">Streak</div></div>' +
    "</div>" +
    '<div class="progress"><i id="e-bar" style="width:' + (done / exam.total) * 100 + '%"></i></div>' +
    '<div class="sec"><div class="btn-row">' +
      '<button class="btn" id="e-pass">Pass and move on</button>' +
      '<button class="btn" id="e-abandon">End exam</button>' +
    "</div></div>";

  el("e-pass").onclick = () => {
    if (exam.locked) return;
    exam.wrong++;
    exam.streak = 0;
    exam.missed.push(it.id);
    exam.queue.shift();
    renderExamPanel();
  };
  // Bind through a lambda: passing finishExam directly would hand it the
  // click Event as `completed`, which is truthy.
  el("e-abandon").onclick = () => finishExam(false);
}

function onExamClick(ev) {
  if (!exam.running || exam.locked || !exam.queue.length) return;
  const it = BY_ID[exam.queue[0]];
  const [lon, lat] = mapE.geoFromEvent(ev);
  const tol = mapE.tolerance(7);
  exam.locked = true;
  const right = hitItem(lon, lat, it, tol, tol);

  if (right) {
    exam.right++;
    exam.streak++;
    mapE.highlight = [{ id: it.id, style: "ok" }];
    mapE.marks = [{ lon, lat, style: "ok" }];
    verdict("e-verdict", "ok", "check", "Correct.");
  } else {
    exam.wrong++;
    exam.streak = 0;
    exam.missed.push(it.id);
    // Send it back to the boards so the result is something you can act on.
    store.recordMiss(it.id);
    mapE.highlight = [{ id: it.id, style: "no" }];
    mapE.marks = [{ lon, lat, style: "no" }];
    const other = identify(IDX, lon, lat, tol);
    verdict("e-verdict", "no", "x",
      (other && other.id !== it.id ? "That is " + nameHTML(other) + ". " : "") +
      "Outlined in place.");
  }
  el("e-right").textContent = exam.right;
  el("e-wrong").textContent = exam.wrong;
  el("e-streak").textContent = exam.streak;
  mapE.draw();

  exam.queue.shift();
  setTimeout(() => {
    exam.locked = false;
    mapE.highlight = [];
    mapE.marks = [];
    if (exam.queue.length) { mapE.setView(WORLD, false); renderExamPanel(); }
    else finishExam(true);
  }, right ? 780 : 1650);
}

function finishExam(completed) {
  exam.running = false;
  const attempted = exam.right + exam.wrong;
  // Only a full pass sets a personal best. Ending early is practice, not a score.
  if (completed && attempted) store.recordExam(exam.right, exam.wrong, exam.total);

  const byCat = {};
  exam.missed.forEach((id) => {
    const f = BY_ID[id];
    (byCat[CAT_LABEL[f.cat]] = byCat[CAT_LABEL[f.cat]] || []).push(f);
  });
  const groups = Object.keys(byCat).map((k) =>
    "<div><h4>" + k + "</h4><ul>" +
    byCat[k].map((f) => "<li>" + nameHTML(f) + "</li>").join("") +
    "</ul></div>"
  ).join("");

  el("exam-work").hidden = true;
  const box = el("exam-results");
  box.hidden = false;
  box.innerHTML =
    "<h3>" + (completed ? "Exam result" : "Exam ended early") + "</h3>" +
    '<div class="score">' + exam.right + " / " + attempted + "</div>" +
    "<p>" + (exam.missed.length
      ? "Every miss has been sent back to its board as " +
        "<b>AGAIN</b>, so it will resurface when you drill."
      : attempted
      ? "Nothing missed. The whole list is solid."
      : "No answers recorded.") + "</p>" +
    (groups ? '<div class="missed">' + groups + "</div>" : "") +
    '<div class="btn-row"><button class="btn primary" id="e-again">' + ic("arrow-counter-clockwise") +
      "<span>Retake</span></button>" +
      '<button class="btn" id="e-back">' + ic("book-open") + "<span>Back to the boards</span></button></div>";
  el("e-again").onclick = () => { startExam(); el("exam-results").hidden = true; el("exam-work").hidden = false; };
  el("e-back").onclick = () => setMode("learn");
  tally();
}

/* =========================================================== stage tabs */
el("stage-study").onclick = () => setStage("study");
el("stage-drill").onclick = () => setStage("drill");
