# -*- coding: utf-8 -*-
"""Build assets/mapdata.json from Natural Earth 1:50m physical vectors.

Downloads the source layers on first run (cached in tools/cache/), extracts only
the 64 features on the study list, simplifies the geometry, and emits one compact
JSON file. Standard library only.

    python tools/build_data.py

Natural Earth is public domain: https://www.naturalearthdata.com/about/terms-of-use/
"""
import io, json, os, sys, urllib.request

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "cache")
DEST = os.path.join(ROOT, "assets", "mapdata.json")

BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
LAYERS = [
    "ne_50m_land",
    "ne_110m_admin_0_countries",
    "ne_50m_geography_regions_polys",
    "ne_50m_geography_marine_polys",
    "ne_50m_rivers_lake_centerlines",
    "ne_50m_lakes",
    "ne_110m_geographic_lines",
]


def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name + ".geojson")
    if not os.path.exists(path):
        url = "%s/%s.geojson" % (BASE, name)
        print("  downloading %s" % name)
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read()
        io.open(path, "wb").write(data)
    return path


def load(name):
    with io.open(fetch(name), encoding="utf-8") as fh:
        return json.load(fh)["features"]


def prop(f, *keys):
    p = f["properties"]
    for k in keys:
        if p.get(k):
            return p[k]
    return None


# ---------------------------------------------------------------- geometry
def rings(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        return list(c)
    if t == "MultiPolygon":
        return [r for poly in c for r in poly]
    if t == "LineString":
        return [c]
    if t == "MultiLineString":
        return list(c)
    return []


def dp(pts, tol):
    """Douglas-Peucker simplification."""
    if len(pts) < 3:
        return pts
    ax, ay = pts[0]
    bx, by = pts[-1]
    dx, dy = bx - ax, by - ay
    den = dx * dx + dy * dy
    imax, dmax = 0, -1.0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        if den == 0:
            d = (px - ax) ** 2 + (py - ay) ** 2
        else:
            t = ((px - ax) * dx + (py - ay) * dy) / den
            t = 0.0 if t < 0 else (1.0 if t > 1 else t)
            qx, qy = ax + t * dx, ay + t * dy
            d = (px - qx) ** 2 + (py - qy) ** 2
        if d > dmax:
            imax, dmax = i, d
    if dmax > tol * tol:
        return dp(pts[:imax + 1], tol)[:-1] + dp(pts[imax:], tol)
    return [pts[0], pts[-1]]


def split_dateline(ring):
    """Break an open path wherever it jumps the antimeridian."""
    out, cur = [], [ring[0]]
    for a, b in zip(ring, ring[1:]):
        if abs(b[0] - a[0]) > 180:
            out.append(cur)
            cur = [b]
        else:
            cur.append(b)
    out.append(cur)
    return [p for p in out if len(p) >= 2]


def unwrap(ring):
    out, off = [[ring[0][0], ring[0][1]]], 0.0
    for a, b in zip(ring, ring[1:]):
        d = b[0] - a[0]
        if d > 180:
            off -= 360
        elif d < -180:
            off += 360
        out.append([b[0] + off, b[1]])
    return out


def close_over_pole(ring):
    """A ring winding a full 360 deg encircles a pole.

    Splitting it at the antimeridian would leave open fragments that no
    point-in-polygon test can use, so keep it continuous and close it across
    the pole. The result sits outside [-180,180]; the renderer and hit test
    fold longitudes into its window.
    """
    u = unwrap(ring)
    if abs(u[-1][0] - u[0][0]) < 350:
        return None
    pole = 90.0 if sum(p[1] for p in u) / len(u) > 0 else -90.0
    return u + [[u[-1][0], pole], [u[0][0], pole]]


def clean(geom, tol, min_pts=3, is_area=True):
    parts = []
    for r in rings(geom):
        pts = [[float(p[0]), float(p[1])] for p in r]
        if is_area:
            # Closed rings are never split: Natural Earth already divides
            # polygons at the antimeridian, and a ring running along a polar
            # edge (Antarctica) is valid as it stands.
            polar = close_over_pole(pts)
            s = dp(polar if polar is not None else pts, tol)
            if len(s) >= min_pts:
                parts.append([[round(x, 2), round(y, 2)] for x, y in s])
            continue
        for seg in split_dateline(pts):
            s = dp(seg, tol)
            if len(s) >= min_pts:
                parts.append([[round(x, 2), round(y, 2)] for x, y in s])
    return parts


def bbox(parts):
    xs = [p[0] for r in parts for p in r]
    ys = [p[1] for r in parts for p in r]
    return [min(xs), min(ys), max(xs), max(ys)]


def ring_area(r):
    a = 0.0
    for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
        a += x1 * y2 - x2 * y1
    return abs(a) * 0.5


def centroid(parts):
    bx, by, ba = 0.0, 0.0, 0.0
    for r in parts:
        a = cx = cy = 0.0
        for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
            cr = x1 * y2 - x2 * y1
            a += cr
            cx += (x1 + x2) * cr
            cy += (y1 + y2) * cr
        if abs(a) > 1e-9:
            a *= 0.5
            if abs(a) > abs(ba):
                bx, by, ba = cx / (6 * a), cy / (6 * a), a
    if ba:
        return [round(bx, 2), round(by, 2)]
    longest = max(parts, key=len)
    return longest[len(longest) // 2]


def inside(lon, lat, parts):
    n = 0
    for r in parts:
        j = len(r) - 1
        for i in range(len(r)):
            xi, yi = r[i]
            xj, yj = r[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                n += 1
            j = i
    return n % 2 == 1


def point_on_surface(parts):
    """A point guaranteed to be inside the shape.

    Long curved features (the Andes, the Himalaya) have centroids that fall
    outside themselves, so fall back to the midpoint of the widest interior
    span found by scanning latitudes.
    """
    c = centroid(parts)
    if inside(c[0], c[1], parts):
        return c
    b = bbox(parts)
    best = None
    steps = 48
    for k in range(1, steps):
        y = b[1] + (b[3] - b[1]) * k / steps
        xs = []
        for r in parts:
            j = len(r) - 1
            for i in range(len(r)):
                xi, yi = r[i]
                xj, yj = r[j]
                if (yi > y) != (yj > y):
                    xs.append(xi + (y - yi) * (xj - xi) / (yj - yi))
                j = i
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            w = xs[i + 1] - xs[i]
            if best is None or w > best[0]:
                best = (w, (xs[i] + xs[i + 1]) / 2, y)
    return c if best is None else [round(best[1], 2), round(best[2], 2)]


def midpoint(parts):
    longest = max(parts, key=len)
    return longest[len(longest) // 2]


def zoombox(parts, kind):
    """Bbox for zooming that ignores parts stranded across the antimeridian,
    so the Aleutians do not stretch North America across the whole map."""
    key = len if kind == "line" else ring_area
    main = max(parts, key=key)
    mb = bbox([main])
    mid = (mb[0] + mb[2]) / 2
    keep = [main]
    for r in parts:
        if r is main:
            continue
        b = bbox([r])
        if abs((b[0] + b[2]) / 2 - mid) <= 100:
            keep.append(r)
    b = bbox(keep)
    padx = max((b[2] - b[0]) * 0.12, 1.5)
    pady = max((b[3] - b[1]) * 0.12, 1.5)
    return [round(max(-180, b[0] - padx), 2), round(max(-90, b[1] - pady), 2),
            round(min(180, b[2] + padx), 2), round(min(90, b[3] + pady), 2)]


# Latitude and longitude lines span the globe, so their geometric midpoint is a
# useless label anchor. Park each one over open water instead.
LINE_ANCHOR = {
    "arctic-circle": [-25, 66.5],
    "tropic-of-cancer": [-40, 23.5],
    "equator": [-25, 0],
    "tropic-of-capricorn": [-25, -23.5],
    "antarctic-circle": [-20, -66.5],
    "prime-meridian": [0, 6],
    "international-date-line": [180, 5],
}

# ---------------------------------------------------------------- study list
# (id, label, category, source layer, [source names], locator hint)
SPEC = [
    ("north-america", "North America", "continent", "regions", ["NORTH AMERICA"],
     "North of the Panama isthmus: Canada, the United States, Mexico and Central America."),
    ("south-america", "South America", "continent", "regions", ["SOUTH AMERICA"],
     "South east of Panama, widest in the north and tapering to Cape Horn."),
    ("australia", "Australia", "continent", "regions", ["AUSTRALIA"],
     "Between the Indian and Pacific oceans, south of Indonesia."),
    ("europe", "Europe", "continent", "regions", ["EUROPE"],
     "West of the Ural Mountains and north of the Mediterranean."),
    ("antarctica", "Antarctica", "continent", "regions", ["ANTARCTICA"],
     "The polar landmass south of the Antarctic Circle."),
    ("asia", "Asia", "continent", "regions", ["ASIA"],
     "East of the Urals and the Red Sea. The largest continent."),
    ("africa", "Africa", "continent", "regions", ["AFRICA"],
     "South of the Mediterranean, straddling the Equator."),

    ("atlantic-ocean", "Atlantic Ocean", "ocean", "marine",
     ["North Atlantic Ocean", "South Atlantic Ocean"],
     "Between the Americas to the west and Europe and Africa to the east."),
    ("pacific-ocean", "Pacific Ocean", "ocean", "marine",
     ["North Pacific Ocean", "South Pacific Ocean"],
     "The largest ocean. Asia and Australia to the west, the Americas to the east."),
    ("indian-ocean", "Indian Ocean", "ocean", "marine", ["INDIAN OCEAN"],
     "South of Asia, east of Africa, west of Australia."),
    ("arctic-ocean", "Arctic Ocean", "ocean", "marine", ["Arctic Ocean"],
     "Over the North Pole, ringed by North America, Europe and Asia."),

    ("north-sea", "North Sea", "sea", "marine", ["North Sea"],
     "Between Great Britain and Norway, Denmark, Germany and the Netherlands."),
    ("baltic-sea", "Baltic Sea", "sea", "marine", ["Baltic Sea"],
     "North east of Germany and Poland, enclosed by Sweden, Finland and the Baltic states."),
    ("english-channel", "English Channel", "sea", "marine", ["English Channel"],
     "The narrow water between southern England and northern France."),
    ("norwegian-sea", "Norwegian Sea", "sea", "marine", ["Norwegian Sea"],
     "Off the west coast of Norway, between Iceland and Scandinavia."),
    ("barents-sea", "Barents Sea", "sea", "marine", ["Barents Sea"],
     "North of Norway and north west Russia, inside the Arctic Circle."),
    ("mediterranean-sea", "Mediterranean Sea", "sea", "marine", ["Mediterranean Sea"],
     "Between southern Europe, north Africa and the Middle East."),
    ("adriatic-sea", "Adriatic Sea", "sea", "marine", ["Adriatic Sea"],
     "Between Italy and the Balkan coast, north of Greece."),
    ("aegean-sea", "Aegean Sea", "sea", "marine", ["Aegean Sea"],
     "Between Greece and Turkey, north of Crete."),
    ("black-sea", "Black Sea", "sea", "marine", ["Black Sea"],
     "North of Turkey, joined to the Mediterranean through the Bosporus."),
    ("caspian-sea", "Caspian Sea", "sea", "marine", ["Caspian Sea"],
     "Landlocked, east of the Caucasus, between Russia and Iran."),
    ("great-lakes", "Great Lakes", "sea", "lakes",
     ["Lake Superior", "Lake Michigan", "Lake Huron", "Lake Erie", "Lake Ontario"],
     "Five connected lakes on the border of the United States and Canada."),
    ("red-sea", "Red Sea", "sea", "marine", ["Red Sea"],
     "Between north east Africa and the Arabian Peninsula."),
    ("persian-gulf", "Persian Gulf", "sea", "marine", ["Persian Gulf"],
     "Between Arabia and Iran, north west of the Arabian Sea."),
    ("arabian-sea", "Arabian Sea", "sea", "marine", ["Arabian Sea"],
     "Between the Arabian Peninsula and India."),
    ("bay-of-bengal", "Bay of Bengal", "sea", "marine", ["Bay of Bengal"],
     "East of India, west of Myanmar, north of the Indian Ocean."),
    ("south-china-sea", "South China Sea", "sea", "marine", ["South China Sea"],
     "South of China, east of Vietnam, west of the Philippines."),
    ("east-china-sea", "East China Sea", "sea", "marine", ["East China Sea"],
     "Between China and the southern Japanese islands, north of Taiwan."),
    ("yellow-sea", "Yellow Sea", "sea", "marine", ["Yellow Sea"],
     "Between eastern China and the Korean Peninsula."),
    ("sea-of-japan", "Sea of Japan", "sea", "marine", ["Sea of Japan"],
     "Between Japan and the Korean Peninsula and the Russian coast."),

    ("nile", "Nile River", "river", "rivers",
     ["Nile", "White Nile", "Blue Nile", "Albert Nile", "Victoria Nile", "Bahr el Jebel"],
     "Flows north through Sudan and Egypt to the Mediterranean. The longest river in Africa."),
    ("amazon", "Amazon River", "river", "rivers", ["Amazonas", "Amazon"],
     "Crosses northern Brazil from west to east into the Atlantic."),
    ("mississippi", "Mississippi River", "river", "rivers", ["Mississippi"],
     "Runs south through the central United States to the Gulf of Mexico."),
    ("rio-grande", "Rio Grande", "river", "rivers", ["Rio Grande"],
     "Forms much of the border between Texas and Mexico."),
    ("indus", "Indus River", "river", "rivers", ["Indus"],
     "Flows south west through Pakistan to the Arabian Sea."),
    ("ganges", "Ganges River", "river", "rivers", ["Ganges"],
     "Flows east across northern India into the Bay of Bengal."),
    ("danube", "Danube River", "river", "rivers", ["Donau", "Danube"],
     "Runs east from southern Germany through central Europe to the Black Sea."),
    ("yangtze", "Yangtze River", "river", "rivers", ["Chang Jiang", "Yangtze"],
     "Crosses central China from west to east. The longest river in Asia."),
    ("yellow-river", "Yellow River", "river", "rivers", ["Huang", "Huang He"],
     "Loops through northern China to the coast, north of the Yangtze."),
    ("tigris", "Tigris River", "river", "rivers", ["Tigris"],
     "Flows south east through Iraq, on the eastern side of the pair."),
    ("euphrates", "Euphrates River", "river", "rivers", ["Euphrates"],
     "Flows south east through Syria and Iraq, on the western side of the pair."),

    ("alaska-range", "Alaska Range", "range", "regions", ["ALASKA RANGE"],
     "Arcs across southern Alaska. Contains Denali."),
    ("rocky-mountains", "Rocky Mountains", "range", "regions", ["ROCKY MOUNTAINS"],
     "Runs down western North America from Canada to New Mexico."),
    ("appalachian-mountains", "Appalachian Mountains", "range", "regions", ["APPALACHIAN MTS."],
     "Runs along eastern North America from Alabama up into Canada."),
    ("andes", "Andes Mountains", "range", "regions", ["ANDES"],
     "Runs the length of western South America. The longest range on land."),
    ("alps", "Alps", "range", "regions", ["ALPS"],
     "Arcs across south central Europe from France to Austria."),
    ("atlas-mountains", "Atlas Mountains", "range", "regions", ["ATLAS MOUNTAINS"],
     "Crosses Morocco, Algeria and Tunisia, north of the Sahara."),
    ("ural-mountains", "Ural Mountains", "range", "regions", ["URAL MOUNTAINS"],
     "Runs north to south through Russia. The boundary of Europe and Asia."),
    ("hindu-kush", "Hindu Kush", "range", "regions", ["HINDU KUSH"],
     "Between Afghanistan and Pakistan, west of the Himalaya."),
    ("himalayas", "Himalaya Mountains", "range", "regions", ["HIMALAYAS"],
     "Arcs along the northern edge of India. Contains Everest."),

    ("atacama-desert", "Atacama Desert", "desert", "regions", ["DESIERTO DE ATACAMA"],
     "A narrow coastal desert in northern Chile, west of the Andes."),
    ("sahara-desert", "Sahara Desert", "desert", "regions", ["SAHARA"],
     "Spans northern Africa. The largest hot desert."),
    ("gobi-desert", "Gobi Desert", "desert", "regions", ["GOBI DESERT"],
     "Across southern Mongolia and northern China."),
    ("kalahari-desert", "Kalahari Desert", "desert", "regions", ["KALAHARI DESERT"],
     "Across Botswana and into Namibia and South Africa."),
    ("namib-desert", "Namib Desert", "desert", "regions", ["NAMIB DESERT"],
     "A coastal strip along Namibia on the Atlantic side."),
    ("syrian-desert", "Syrian Desert", "desert", "regions", ["SYRIAN DESERT"],
     "Across Syria, Jordan and western Iraq."),
    ("great-sandy-desert", "Great Sandy Desert", "desert", "regions", ["GREAT SANDY DESERT"],
     "In north western Australia, inland from the coast."),

    ("arctic-circle", "Arctic Circle", "line", "lines", ["Arctic Circle"],
     "66.5 deg N. Above it the sun does not set at midsummer."),
    ("tropic-of-cancer", "Tropic of Cancer", "line", "lines", ["Tropic of Cancer"],
     "23.5 deg N. The northern limit of the overhead sun."),
    ("equator", "Equator", "line", "lines", ["Equator"],
     "0 deg latitude, midway between the poles."),
    ("tropic-of-capricorn", "Tropic of Capricorn", "line", "lines", ["Tropic of Capricorn"],
     "23.5 deg S. The southern limit of the overhead sun."),
    ("antarctic-circle", "Antarctic Circle", "line", "lines", ["Antarctic Circle"],
     "66.5 deg S, just off the Antarctic coast."),
    ("prime-meridian", "Prime Meridian", "line", "synthetic", [],
     "0 deg longitude, running through Greenwich in London."),
    ("international-date-line", "International Date Line", "line", "lines",
     ["International Date Line"],
     "Near 180 deg longitude, where the calendar date changes."),
]

TOL = {"continent": 0.30, "ocean": 0.35, "sea": 0.06, "river": 0.05,
       "range": 0.06, "desert": 0.10, "line": 0.50}

# Six boards, ordered easiest to hardest. Every id appears exactly once.
REGIONS = [
    ("americas", "The Americas", [-172, -58, -28, 74],
     ["north-america", "south-america", "rocky-mountains", "appalachian-mountains",
      "alaska-range", "andes", "atacama-desert", "mississippi", "rio-grande",
      "amazon", "great-lakes"]),
    ("europe", "Europe and the Mediterranean", [-22, 27, 72, 76],
     ["europe", "north-sea", "baltic-sea", "english-channel", "norwegian-sea",
      "barents-sea", "mediterranean-sea", "adriatic-sea", "aegean-sea", "black-sea",
      "caspian-sea", "danube", "alps", "ural-mountains"]),
    ("africa", "Africa and the Levant", [-22, -38, 58, 42],
     ["africa", "red-sea", "persian-gulf", "sahara-desert", "kalahari-desert",
      "namib-desert", "atlas-mountains", "syrian-desert", "nile", "tigris", "euphrates"]),
    ("asia", "South and Central Asia", [30, -2, 116, 56],
     ["asia", "arabian-sea", "bay-of-bengal", "indus", "ganges", "himalayas",
      "hindu-kush", "gobi-desert"]),
    ("pacific", "East Asia and Oceania", [92, -48, 168, 58],
     ["south-china-sea", "east-china-sea", "yellow-sea", "sea-of-japan", "yangtze",
      "yellow-river", "australia", "great-sandy-desert"]),
    ("global", "Oceans, poles and lines", [-180, -90, 180, 90],
     ["atlantic-ocean", "pacific-ocean", "indian-ocean", "arctic-ocean", "antarctica",
      "arctic-circle", "tropic-of-cancer", "equator", "tropic-of-capricorn",
      "antarctic-circle", "prime-meridian", "international-date-line"]),
]


def main():
    print("sources:")
    src = {
        "regions": (load("ne_50m_geography_regions_polys"), ("NAME", "NAME_EN")),
        "marine": (load("ne_50m_geography_marine_polys"), ("name", "name_en")),
        "rivers": (load("ne_50m_rivers_lake_centerlines"), ("name", "name_en")),
        "lakes": (load("ne_50m_lakes"), ("name", "name_en")),
        "lines": (load("ne_110m_geographic_lines"), ("name", "name_en")),
    }

    items, missing = [], []
    for iid, label, cat, layer, names, hint in SPEC:
        tol = TOL[cat]
        kind = "line" if cat in ("line", "river") else "area"
        if layer == "synthetic":
            parts = [[[0, y] for y in range(-90, 91, 5)]]
        else:
            feats, keys = src[layer]
            want = set(n.lower() for n in names)
            parts = []
            for f in feats:
                nm = prop(f, *keys)
                if nm and nm.lower() in want:
                    parts += clean(f["geometry"], tol, 2 if cat == "line" else 3,
                                   is_area=(kind == "area"))
        if not parts:
            missing.append(label)
            continue
        it = {"id": iid, "name": label, "cat": cat, "kind": kind, "hint": hint,
              "parts": parts, "bbox": bbox(parts), "zbox": zoombox(parts, kind)}
        if any(p[0] < -180.001 or p[0] > 180.001 for r in parts for p in r):
            it["wrap"] = 1
        it["c"] = LINE_ANCHOR[iid] if iid in LINE_ANCHOR else \
            (midpoint(parts) if kind == "line" else point_on_surface(parts))
        items.append(it)

    land = [r for r in (p for f in load("ne_50m_land")
                        for p in clean(f["geometry"], 0.12)) if len(r) > 4]
    borders = [r for r in (p for f in load("ne_110m_admin_0_countries")
                           for p in clean(f["geometry"], 0.25)) if len(r) > 4]

    regions = [{"id": rid, "name": nm, "box": box, "ids": ids}
               for rid, nm, box, ids in REGIONS]

    out = {"land": land, "borders": borders, "items": items, "regions": regions}
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with io.open(DEST, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))

    # ---- self checks -------------------------------------------------
    print()
    print("items          %d / %d" % (len(items), len(SPEC)))
    print("land rings     %d" % len(land))
    print("border rings   %d" % len(borders))
    print("mapdata.json   %.0f KB" % (os.path.getsize(DEST) / 1024))
    print("missing        %s" % (missing if missing else "none"))

    ids = [i["id"] for i in items]
    assigned = [i for r in REGIONS for i in r[3]]
    print("board coverage %d ids across %d boards" % (len(assigned), len(REGIONS)))
    dupes = sorted({i for i in assigned if assigned.count(i) > 1})
    unassigned = sorted(set(ids) - set(assigned))
    unknown = sorted(set(assigned) - set(ids))
    print("  duplicates   %s" % (dupes if dupes else "none"))
    print("  unassigned   %s" % (unassigned if unassigned else "none"))
    print("  unknown ids  %s" % (unknown if unknown else "none"))

    bad = []
    for it in items:
        if it["kind"] != "area":
            continue
        lon, lat = it["c"]
        if it.get("wrap"):
            lo = min(p[0] for r in it["parts"] for p in r)
            lon = lo + ((lon - lo) % 360)
        if not inside(lon, lat, it["parts"]):
            bad.append(it["id"])
    print("anchors outside their shape: %s" % (bad if bad else "none"))
    print("hints missing: %s" % ([i["id"] for i in items if not i.get("hint")] or "none"))
    dash = [i["id"] for i in items if "—" in i["hint"] or "–" in i["hint"]]
    print("hints with em/en dashes: %s" % (dash if dash else "none"))


main()
