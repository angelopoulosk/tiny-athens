# To do

## Open

- **T6 tram route is still wrong in the centre.** Following T6 draws a branch from Vas. Olgas past
  the tennis courts, along the south of the Olympieion and diagonally through Neos Kosmos to
  Syngrou-Fix; it doesn't match the real route. The route comes from `viewer/rail.json`
  (`scripts/make_rail.py`: stops from athens-transit-rt `/v2/lines/stasy:T6`, snapped to
  OpenStreetMap tram tracks, joined by the shortest path along the tracks). Things to check:
  which OSM tram ways exist there (disused/old tracks tagged `railway=tram`?), whether the
  feed's stop coordinates are right, and whether the shortest path takes the wrong branch of
  a one-way loop. Possible fix: use the OSM route relations for T6/T7 (per direction) instead
  of shortest paths. Live trams are also snapped to these tracks (`snapRail` in transit.js).
- Upload the ring around the pilot (`ring1`) when `draw_map.sh` finishes it (drawing overnight on the Mac).

## Done (6 Nov 2026)

- Live buses/trolleys with ΕΘΕΛ liveries, Line 1 and trams, night mode toggle
- Shareable views, 📍 locate me, follow a line, overview map, 🚦 speeds heatmap, rain/storm
- Fog of war prototype (`?fog=1`), map planner (`planner.html`)
- First real pixel-art map online: the pilot area, 72% style + pixel snap (replaced the preview)
