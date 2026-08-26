// Plate carree map renderer and hit tester. No dependencies.
//
// Equirectangular is deliberate: every parallel is a true horizontal and every
// meridian a true vertical, so the Arctic Circle, both Tropics, the Equator and
// the Prime Meridian draw as straight lines the learner can actually place.

export const PAD = 26;               // neatline gutter, CSS px
export const WORLD = [-180, -90, 180, 90];

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const WATER_CATS = { ocean: 1, sea: 1, river: 1 };
export const isWater = (it) => !!WATER_CATS[it.cat];

export const CAT_LABEL = {
  continent: "Continent", ocean: "Ocean", sea: "Sea or gulf", river: "River",
  range: "Mountain range", desert: "Desert", line: "Reference line",
};

/* ------------------------------------------------------------- hit testing */
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inArea(lon, lat, it) {
  let n = 0;
  for (let k = 0; k < it.parts.length; k++) {
    let L = lon;
    if (it.wmin) {                       // fold into this ring's 360 deg window
      const mn = it.wmin[k];
      L = mn + ((((lon - mn) % 360) + 360) % 360);
    }
    if (inRing(L, lat, it.parts[k])) n++;
  }
  return n % 2 === 1;                    // even-odd, so holes read as outside
}

function nearPath(lon, lat, it, tol) {
  const t2 = tol * tol;
  for (const part of it.parts) {
    for (let i = 0; i < part.length - 1; i++) {
      const [x1, y1] = part[i], [x2, y2] = part[i + 1];
      const dx = x2 - x1, dy = y2 - y1, den = dx * dx + dy * dy;
      const t = den ? clamp(((lon - x1) * dx + (lat - y1) * dy) / den, 0, 1) : 0;
      const qx = x1 + t * dx, qy = y1 + t * dy;
      if ((lon - qx) ** 2 + (lat - qy) ** 2 < t2) return true;
    }
  }
  return false;
}

const inBox = (lon, lat, b, pad = 0) =>
  lon >= b[0] - pad && lon <= b[2] + pad && lat >= b[1] - pad && lat <= b[3] + pad;

// `areaTol` forgives a click just outside a shape. The English Channel and the
// Persian Gulf are only a few pixels wide on a world view, so scoring them
// strictly would test aim rather than knowledge.
export function hitItem(lon, lat, it, tol, areaTol) {
  const pad = it.kind === "line" ? tol : areaTol || 0;
  if (!it.wrap && !inBox(lon, lat, it.bbox, pad)) return false;
  if (it.kind === "line") return nearPath(lon, lat, it, tol);
  return inArea(lon, lat, it) || (areaTol ? nearPath(lon, lat, it, areaTol) : false);
}

const boxArea = (i) => (i.bbox[2] - i.bbox[0]) * (i.bbox[3] - i.bbox[1]);
const SMALL = 1500;   // sq deg; under this a named area outranks a line crossing it

/** Build the lookup order once: smallest areas first so the Aegean beats Europe. */
export function makeIndex(items) {
  items.forEach((it) => {
    if (!it.wrap) return;
    it.wmin = it.parts.map((r) => {
      let m = Infinity;
      for (const p of r) if (p[0] < m) m = p[0];
      return m;
    });
  });
  return {
    areas: items.filter((i) => i.kind === "area").slice().sort((a, b) => boxArea(a) - boxArea(b)),
    rivers: items.filter((i) => i.cat === "river"),
    lines: items.filter((i) => i.cat === "line"),
  };
}

export function identify(idx, lon, lat, tol, allow) {
  const ok = (it) => !allow || allow(it);
  // Rivers are thin and unambiguous, so they win outright.
  for (const it of idx.rivers) if (ok(it) && hitItem(lon, lat, it, tol)) return it;

  let area = null;
  for (const it of idx.areas) if (ok(it) && hitItem(lon, lat, it, 0)) { area = it; break; }
  let line = null;
  for (const it of idx.lines) if (ok(it) && hitItem(lon, lat, it, tol)) { line = it; break; }

  // A parallel crosses half the world, so over a compact feature the feature is
  // the better answer, and over a continent or ocean the parallel is.
  if (area && line) return boxArea(area) < SMALL ? area : line;
  return line || area;
}

/* ------------------------------------------------------------------ renderer */
export class MapView {
  constructor(canvas, data, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = data;
    this.opts = Object.assign(
      { ratio: 0.58, labels: false, borders: true, graticule: true, terrain: true },
      opts
    );
    this.layers = null;        // null = draw every category
    this.highlight = [];       // [{id, style: 'ok'|'no'|'focus'}]
    this.marks = [];           // [{lon, lat, style}]
    this.view = { clon: 0, clat: 0, scale: 1 };
    this.anim = null;
    this.pendingBox = WORLD;
    this.w = this.h = 0;
    this.byId = {};
    data.items.forEach((i) => (this.byId[i.id] = i));
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement);
    // The observer covers container changes, but not a viewport resize that
    // leaves the container the same width while changing how much height is
    // available, nor a devicePixelRatio change from moving between displays.
    this._onWin = () => this.resize();
    addEventListener("resize", this._onWin);
    this.resize();
  }

  destroy() {
    if (this.anim) cancelAnimationFrame(this.anim);
    this._ro.disconnect();
    removeEventListener("resize", this._onWin);
  }

  css(n) {
    return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  }

  resize() {
    const rect = this.cv.parentElement.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = rect.width;
    // Keep the map from growing taller than the screen on a short laptop
    // display, where a pure aspect ratio would push the answer panel off-screen.
    const ideal = Math.round(this.w * this.opts.ratio);
    const cap = Math.round(innerHeight * 0.62);
    this.h = Math.max(240, Math.min(ideal, Math.max(cap, 240)));
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.cv.style.height = this.h + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.setView(this.pendingBox, false);
  }

  fit(box) {
    const iw = this.w - PAD * 2, ih = this.h - PAD * 2;
    const dlon = Math.max(box[2] - box[0], 0.5), dlat = Math.max(box[3] - box[1], 0.5);
    return {
      clon: (box[0] + box[2]) / 2,
      clat: (box[1] + box[3]) / 2,
      scale: Math.min(iw / dlon, ih / dlat),
    };
  }

  setView(box, animate = true) {
    this.pendingBox = box;
    if (!this.w) return;
    const to = this.fit(box);
    if (!animate || REDUCED) {
      this.view = to;
      this.draw();
      return;
    }
    const from = Object.assign({}, this.view);
    const t0 = performance.now(), dur = 520;
    if (this.anim) cancelAnimationFrame(this.anim);
    const tick = (now) => {
      const p = clamp((now - t0) / dur, 0, 1);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      // Zoom interpolates geometrically so the rate of change feels even.
      this.view = {
        clon: from.clon + (to.clon - from.clon) * e,
        clat: from.clat + (to.clat - from.clat) * e,
        scale: from.scale * Math.pow(to.scale / from.scale, e),
      };
      this.draw();
      this.anim = p < 1 ? requestAnimationFrame(tick) : null;
    };
    this.anim = requestAnimationFrame(tick);
  }

  px(lon, lat) {
    const v = this.view;
    return [this.w / 2 + (lon - v.clon) * v.scale, this.h / 2 - (lat - v.clat) * v.scale];
  }

  geo(x, y) {
    const v = this.view;
    return [v.clon + (x - this.w / 2) / v.scale, v.clat - (y - this.h / 2) / v.scale];
  }

  geoFromEvent(ev) {
    const r = this.cv.getBoundingClientRect();
    return this.geo(ev.clientX - r.left, ev.clientY - r.top);
  }

  tolerance(px = 7) {
    return px / this.view.scale;
  }

  // `offsets` repeats geometry every 360 deg, which is how an unwrapped polar
  // ring (stored outside [-180,180]) still lands in the visible window.
  path(parts, close, offsets) {
    const p = new Path2D();
    for (const off of offsets || [0]) {
      for (const part of parts) {
        let started = false;
        for (const pt of part) {
          const [x, y] = this.px(pt[0] + off, pt[1]);
          if (!started) { p.moveTo(x, y); started = true; } else p.lineTo(x, y);
        }
        if (close) p.closePath();
      }
    }
    return p;
  }

  itemPath(it, close) {
    return this.path(it.parts, close, it.wrap ? [-360, 0, 360] : null);
  }

  visible(cat) {
    return !this.layers || this.layers.has(cat);
  }

  draw() {
    const ctx = this.ctx, w = this.w, h = this.h;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    const iw = w - PAD * 2, ih = h - PAD * 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD, PAD, iw, ih);
    ctx.clip();

    ctx.fillStyle = this.css("--map-water");
    ctx.fillRect(PAD, PAD, iw, ih);

    if (this.opts.graticule) this.drawGraticule();

    ctx.fillStyle = this.css("--map-land");
    ctx.strokeStyle = this.css("--map-coast");
    ctx.lineWidth = 0.7;
    const land = this.path(this.data.land, true);
    ctx.fill(land);
    ctx.stroke(land);

    if (this.opts.borders) {
      ctx.strokeStyle = this.css("--map-border");
      ctx.lineWidth = 0.55;
      ctx.stroke(this.path(this.data.borders, true));
    }

    this.drawItems();
    if (this.opts.labels) this.drawLabels();
    this.drawHighlights();
    this.drawMarks();

    ctx.restore();
    this.drawNeatline();
  }

  drawGraticule() {
    const ctx = this.ctx;
    const span = (this.w - PAD * 2) / this.view.scale;
    const step = span > 200 ? 30 : span > 90 ? 15 : span > 40 ? 10 : span > 15 ? 5 : 2;
    ctx.strokeStyle = this.css("--map-grid");
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += step) {
      const [x] = this.px(lon, 0);
      ctx.moveTo(x, PAD); ctx.lineTo(x, this.h - PAD);
    }
    for (let lat = -90; lat <= 90; lat += step) {
      const [, y] = this.px(0, lat);
      ctx.moveTo(PAD, y); ctx.lineTo(this.w - PAD, y);
    }
    ctx.stroke();
  }

  drawItems() {
    const ctx = this.ctx;
    for (const it of this.data.items) {
      if (!this.visible(it.cat)) continue;
      if (it.cat === "line") {
        ctx.strokeStyle = this.css("--accent-line");
        ctx.lineWidth = 1;
        ctx.setLineDash(it.id === "equator" ? [] : [5, 4]);
        ctx.stroke(this.itemPath(it, false));
        ctx.setLineDash([]);
      } else if (it.cat === "river") {
        ctx.strokeStyle = this.css("--map-coast");
        ctx.lineWidth = 1.15;
        ctx.stroke(this.itemPath(it, false));
      } else if (this.opts.terrain && (it.cat === "range" || it.cat === "desert")) {
        ctx.save();
        ctx.globalAlpha = it.cat === "desert" ? 0.28 : 0.34;
        ctx.fillStyle = this.css(it.cat === "desert" ? "--terrain-desert" : "--terrain-range");
        ctx.fill(this.itemPath(it, true), "evenodd");
        ctx.restore();
      }
    }
  }

  drawHighlights() {
    const ctx = this.ctx;
    for (const hl of this.highlight) {
      const it = this.byId[hl.id];
      if (!it) continue;
      const col =
        hl.style === "ok" ? this.css("--ok") :
        hl.style === "no" ? this.css("--no") : this.css("--accent");
      ctx.save();
      if (it.kind === "line") {
        ctx.strokeStyle = col;
        ctx.lineWidth = it.cat === "line" ? 2 : 2.6;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.shadowColor = col;
        ctx.shadowBlur = 9;
        ctx.stroke(this.itemPath(it, false));
      } else {
        const p = this.itemPath(it, true);
        ctx.globalAlpha = 0.34;
        ctx.fillStyle = col;
        ctx.fill(p, "evenodd");
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.8;
        ctx.lineJoin = "round";
        ctx.stroke(p);
      }
      ctx.restore();
    }
  }

  drawMarks() {
    const ctx = this.ctx;
    for (const m of this.marks) {
      const [x, y] = this.px(m.lon, m.lat);
      const col = m.style === "ok" ? this.css("--ok") : this.css("--no");
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      if (m.style === "ok") {
        ctx.moveTo(x - 5, y); ctx.lineTo(x - 1.5, y + 4); ctx.lineTo(x + 6, y - 5);
      } else {
        ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
        ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
      }
      ctx.stroke();
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Greedy placement: important categories claim space first, and any label
  // whose box collides with one already placed is dropped.
  drawLabels() {
    const ctx = this.ctx, placed = [];
    const order = ["continent", "ocean", "sea", "range", "desert", "river", "line"];
    const collides = (a) =>
      placed.some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
    const fUi = this.css("--f-ui"), fHydro = this.css("--f-hydro");
    ctx.textBaseline = "middle";

    for (const cat of order) {
      for (const it of this.data.items) {
        if (it.cat !== cat || !this.visible(cat)) continue;
        let text = it.name.replace(/ (River|Mountains)$/, "");
        const horiz = cat === "line" && it.bbox[3] - it.bbox[1] < 1;
        let x, y;
        if (horiz) { y = this.px(0, it.c[1])[1]; x = PAD + 62; }
        else { const p = this.px(it.c[0], it.c[1]); x = p[0]; y = p[1]; }
        if (x < PAD || x > this.w - PAD || y < PAD || y > this.h - PAD) continue;

        if (cat === "continent") {
          text = text.toUpperCase();
          ctx.font = "600 12px " + fUi;
          if ("letterSpacing" in ctx) ctx.letterSpacing = "2.4px";
        } else if (isWater(it)) {
          ctx.font = "italic 400 11.5px " + fHydro;
          if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
        } else {
          ctx.font = "500 10.5px " + fUi;
          if ("letterSpacing" in ctx) ctx.letterSpacing = ".3px";
        }

        const wd = ctx.measureText(text).width;
        let align = horiz ? "left" : "center";
        // A label anchored on the antimeridian would hang off the neatline.
        if (!horiz) {
          if (x + wd / 2 > this.w - PAD - 3) { align = "right"; x = this.w - PAD - 4; }
          else if (x - wd / 2 < PAD + 3) { align = "left"; x = PAD + 4; }
        }
        const bx = align === "center" ? x - wd / 2 - 2 : align === "right" ? x - wd - 2 : x - 2;
        const box = { x: bx, y: y - 7, w: wd + 4, h: 14 };
        if (collides(box)) { if ("letterSpacing" in ctx) ctx.letterSpacing = "0px"; continue; }
        placed.push(box);

        ctx.textAlign = align;
        ctx.lineWidth = 2.6;
        ctx.lineJoin = "round";
        ctx.strokeStyle = this.css("--map-water");
        ctx.strokeText(text, x, y);
        ctx.fillStyle =
          cat === "line" ? this.css("--accent") :
          isWater(it) ? this.css("--map-coast") : this.css("--ink");
        ctx.fillText(text, x, y);
        if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
      }
    }
    ctx.textAlign = "start";
  }

  // Double-ruled border with live coordinate ticks: the chart neatline.
  drawNeatline() {
    const ctx = this.ctx, w = this.w, h = this.h;
    const span = (w - PAD * 2) / this.view.scale;
    const step = span > 200 ? 60 : span > 90 ? 30 : span > 40 ? 15 : span > 15 ? 10 : 5;

    ctx.save();
    ctx.fillStyle = this.css("--panel");
    ctx.fillRect(0, 0, w, PAD);
    ctx.fillRect(0, h - PAD, w, PAD);
    ctx.fillRect(0, 0, PAD, h);
    ctx.fillRect(w - PAD, 0, PAD, h);

    ctx.strokeStyle = this.css("--ink-3");
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD - 0.5, PAD - 0.5, w - PAD * 2 + 1, h - PAD * 2 + 1);
    ctx.strokeStyle = this.css("--rule");
    ctx.strokeRect(4.5, 4.5, w - 9, h - 9);

    ctx.font = "400 8.5px " + this.css("--f-mono");
    ctx.fillStyle = this.css("--ink-3");
    ctx.strokeStyle = this.css("--ink-3");
    ctx.lineWidth = 0.8;
    ctx.beginPath();

    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let lon = -180; lon <= 180; lon += step) {
      const [x] = this.px(lon, 0);
      if (x < PAD + 8 || x > w - PAD - 8) continue;
      ctx.moveTo(x, PAD - 5); ctx.lineTo(x, PAD);
      ctx.moveTo(x, h - PAD); ctx.lineTo(x, h - PAD + 5);
      const t = Math.abs(lon) + (lon === 0 || Math.abs(lon) === 180 ? "" : lon > 0 ? "E" : "W");
      ctx.fillText(t, x, PAD - 8);
    }
    ctx.textBaseline = "middle";
    for (let lat = -90; lat <= 90; lat += step) {
      const [, y] = this.px(0, lat);
      if (y < PAD + 8 || y > h - PAD - 8) continue;
      ctx.moveTo(PAD - 5, y); ctx.lineTo(PAD, y);
      ctx.moveTo(w - PAD, y); ctx.lineTo(w - PAD + 5, y);
      const t = Math.abs(lat) + (lat === 0 ? "" : lat > 0 ? "N" : "S");
      ctx.textAlign = "right"; ctx.fillText(t, PAD - 7, y);
      ctx.textAlign = "left"; ctx.fillText(t, w - PAD + 7, y);
    }
    ctx.stroke();
    ctx.restore();
  }
}
