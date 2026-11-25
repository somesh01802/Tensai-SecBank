"""Make a tagged copy of the SecBank Canvas wallboard export: P1/P2/P3 tags on the Journey Health tiles,
the Technology Stack service chips and the Customers 'impacted' chip, plus the detector filter on the
Problems row. Every other element is copied unchanged. The copy gets a new workpad id and name, so
importing it never overwrites the original.

    python kibana/add-priority-tags.py kibana/canvas-wallboard-current.json kibana/canvas-wallboard-tagged.json

Each tag re-runs its tile's / chip's own query up to the row it shows (chips re-sort by error rate, so the
service in a slot changes), then looks up the most severe OPEN detector problem for that journey / service.
"""
import json, re, sys, uuid

src, dst = sys.argv[1], sys.argv[2]
w = json.load(open(src, encoding='utf-8'))
page = w['pages'][0]
els = page['elements']

WHERE = "\\\"problem.status\\\" = 'open' AND \\\"labels.data_source\\\" = 'detector'"
TAIL = (' | var_set name="r" value={getCell "r"}'
        ' | markdown {var "r" | switch {case when=1 then="P1"} {case when=2 then="P2"} {case when=3 then="P3"} default=""}'
        ' font={font family="Inter, Helvetica Neue, Arial, sans-serif" size=11 weight="bold" color="#FFFFFF" align="center"}'
        ' | render containerStyle={containerStyle borderRadius="4px" backgroundColor={var "r" | switch'
        ' {case when=1 then="#e0234e"} {case when=2 then="#d6a000"} {case when=3 then="#7b61c4"} default="transparent"}}')


def lookup(field, var):
    """Tag lookup for the value held in Canvas variable `var` (set from the tile's own row)."""
    return (f' | var_set name="{var}" value={{getCell "{var}"}} | clear | essql query={{string'
            f' "SELECT MIN(\\"problem.severity_rank\\") AS r FROM \\"bank-problems\\" WHERE {WHERE} AND \\"{field}\\" = \'"'
            f' {{var "{var}"}} "\'"}}' + TAIL)


def at(x, y):
    hits = [e for e in els if round(e['position']['left']) == x and round(e['position']['top']) == y]
    if len(hits) != 1:
        sys.exit(f'expected one element at ({x},{y}), found {len(hits)}: the workpad layout changed')
    return hits[0]


def prefix(e):
    """The element's expression up to the row it displays (everything before its markdown)."""
    parts = re.split(r'\s*\|\s*markdown\b', e['expression'], maxsplit=1)
    if len(parts) != 2:
        sys.exit(f'no markdown stage in {e["id"]}')
    return parts[0]


def tag(x, y, expr, wd=32, ht=16):
    return {'id': f'element-{uuid.uuid4()}', 'position': {'left': x, 'top': y, 'width': wd, 'height': ht, 'angle': 0, 'parent': None},
            'expression': expr, 'filter': None}


new = []
# Journey Health: 10 tiles (179 x 76); the name element sits at (+14, +6). Tag under the name, like the reference.
for tx in (44, 233):
    for ty in (324, 408, 492, 576, 660):
        name = at(tx + 14, ty + 6)
        new.append(tag(tx + 14, ty + 32, prefix(name) + lookup('journey.name', 'j')))
# Technology Stack services: 6 chips (205 x 34), re-sorted by error rate. Badge on the chip's top-right corner.
for cx in (600, 813, 1026):
    for cy in (464, 510):
        chip = at(cx, cy)
        new.append(tag(cx + 205 - 36, cy - 8, prefix(chip) + lookup('service.name', 's'), 30, 14))
# Customers 'impacted' chip: most severe open problem of any kind, just right of the chip.
new.append(tag(808 + 210 + 6, 326 + 9,
               f'essql "SELECT MIN(\\"problem.severity_rank\\") AS r FROM \\"bank-problems\\" WHERE {WHERE}"' + TAIL))

# Problems row: only problems written by the SecBank detector (the retired workflow's documents are ignored).
row = at(600, 602)
old = "WHERE \\\"problem.status\\\" = 'open' ORDER BY r"
if old not in row['expression']:
    sys.exit('Problems row query changed; not patching it')
row['expression'] = row['expression'].replace(old, f"WHERE {WHERE} ORDER BY r")

els.extend(new)
w['id'] = 'workpad-secbank-wallboard-tagged'
w['name'] = (w.get('name') or 'SecBank wallboard') + ' (tagged)'
json.dump(w, open(dst, 'w', encoding='utf-8'), ensure_ascii=False)
print(f'{len(new)} tags added, Problems row filtered; {len(els)} elements -> {dst}')
