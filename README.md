# Chartroom

A browser drill for the 64 physical geography features on the study list:
7 continents, 4 oceans, 19 seas and gulfs, 11 rivers, 9 mountain ranges,
7 deserts and the 7 reference lines.

Study a board, drill it, then sit the whole-world exam. No dependencies,
no build step, no accounts, no network calls at runtime.

## How it works

**Learn** splits the list into six boards, ordered easiest to hardest:

| Board | Features |
| --- | --- |
| The Americas | 11 |
| Europe and the Mediterranean | 14 |
| Africa and the Levant | 11 |
| South and Central Asia | 8 |
| East Asia and Oceania | 8 |
| Oceans, poles and lines | 12 |

Each board has two stages.

**Study** walks you through every feature on the board one at a time. The map
zooms to it, outlines it, and tells you where it sits relative to things you
already know. Labels stay on, and you can hover anywhere on the board to
identify what you are looking at. The drill stays locked until you have walked
a board once, so the recall test is never a cold start. If you already know a
board, `Skip to drill` unlocks it immediately.

**Drill** hides the labels and names a feature for you to click. Scoring uses a
small Leitner rule: a fresh feature clears on the first clean hit, but one you
have already missed has to be found twice before it counts as known. Misses go
straight back into the rotation, so the features you keep failing are the ones
you keep seeing.

**Exam** is the recall test at full scope: all 64 features, world view, no zoom,
no labels, no hints, and terrain shading and country borders off by default. One
pass through the list. Anything you miss is pushed back to its board as `AGAIN`,
so the result tells you what to go and practise. Only a completed pass records a
personal best.

Progress lives in `localStorage` under `chartroom.progress.v1`. Nothing leaves
the browser.

## Running it locally

The page fetches `assets/mapdata.json`, so it needs to be served over HTTP.
Opening `index.html` straight from the file system will fail the fetch and show
an error telling you so.

```bash
python -m http.server 8123
```

Then open `http://localhost:8123`.

## Regenerating the map data

`assets/mapdata.json` is committed, so the site works without running anything.
To rebuild it from source:

```bash
python tools/build_data.py
```

The script downloads the Natural Earth layers it needs into `tools/cache/`
(gitignored, about 11 MB), extracts only the 64 features on the list,
simplifies the geometry with Douglas-Peucker, and writes a single ~360 KB JSON
file. Standard library only, no pip install.

It prints its own self checks: feature count, board coverage, duplicate or
unassigned ids, and whether every label anchor actually falls inside its own
shape. All of those should read clean.

To refresh the icon sprite after changing which glyphs are used, edit `WANTED`
in `tools/build_icons.py`, put the matching Phosphor SVGs in `tools/icons_raw/`,
and run:

```bash
python tools/build_icons.py
```

That writes `tools/sprite.inc.svg`, which is pasted inline into `index.html`.

## Design notes

**Projection.** Equirectangular, also called plate carree. Every parallel draws
as a true horizontal and every meridian as a true vertical, which matters
because five of the items on the list are latitude lines and two are
longitude lines. On any curved projection those become arcs that are much harder
to place. It also needs no mapping library: the whole projection is two
multiplications.

**Hit testing** runs against the real Natural Earth polygons, not hand-placed
hotspots, so clicking the Aegean is checked against the actual Aegean. Three
details are worth knowing:

- Smallest match wins, so a click inside the Aegean reports the Aegean rather
  than the Mediterranean or Europe.
- Rivers always win outright, since they are thin. Reference lines lose to any
  compact feature they cross, so clicking the Kalahari where the Tropic of
  Capricorn passes through it reports the Kalahari.
- Clicks just outside a shape are forgiven by a few pixels. The English Channel
  and the Persian Gulf are only a few pixels wide at world scale, and scoring
  them strictly would test aim rather than knowledge.

**Polar geometry.** A ring that winds a full 360 degrees encircles a pole, and
splitting it at the antimeridian leaves open fragments that no point-in-polygon
test can use. Those rings are kept continuous and closed across the pole
instead, which is why the Arctic Ocean is clickable at all. Ordinary polygons
are never split, because Natural Earth already divides them and Antarctica's
ring along the -90 edge is valid as it stands.

**Label anchors** come from a point-on-surface scan rather than a centroid. Long
curved features like the Andes and the Himalaya have centroids that fall outside
themselves, which would put the label and the zoom target in open water.

**Typography** follows the chart convention: hydrographic names in italic serif,
terrestrial names in roman sans, continents in letterspaced caps.

**Colour** is a working-chart palette rather than an antique-atlas one: pale
chart paper, buff land, ink-navy type, and the magenta that real charts reserve
for overprinted cautionary notes. Dark mode is the ECDIS night palette. Every
text and background pair is checked to WCAG AA 4.5:1 in both themes.

## Known limits

- Answering requires pointing at the map, so the drill and exam are not
  keyboard operable. Everything else is.
- The Ross Ice Shelf sector reads as water, so a click there does not count as
  Antarctica. The land layer and the continent polygon agree, so nothing looks
  wrong on screen, but it is a real edge if you aim there.
- Board membership is fixed rather than user editable.

## Credits

Geometry from [Natural Earth](https://www.naturalearthdata.com/) 1:50m and
1:110m, public domain. Icons from [Phosphor](https://phosphoricons.com/), MIT.
Typefaces Archivo, Spectral and IBM Plex Mono via Google Fonts, all open
licensed.
