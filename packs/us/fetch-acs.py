#!/usr/bin/env python3
"""
Relevé des tables Census utilisées par le socle États-Unis (packs/us), via l'API publique de data.census.gov
(sans clé) : ACS 2024 1-year (estimations, libellés des variables) et recensement 2020 (urbain / rural).
Écrit docs/research/socle-us-data/acs-2024.json : { table: { "label": ..., "universe": ..., "rows": { géo: { libellé: valeur } } } }.
Usage : python3 -I packs/us/fetch-acs.py  (≈ 40 requêtes ; relancer seulement pour actualiser le relevé).
"""
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "docs", "research", "socle-us-data", "acs-2024.json")
UA = {"User-Agent": "personas-socle-us/1.0 (research; contact via repository)"}
NATION = "010XX00US"
STATES = "010XX00US$0400000"

# (table, géographie) ; les tables « B » sont celles de l'ACS 2024 1-year (dataset acs/acs1)
TABLES = [
    ("B01001", NATION), ("B01001", STATES),
    ("B01001H", NATION), ("B01001I", NATION), ("B01001B", NATION), ("B01001D", NATION),
    ("B03002", NATION), ("B03002", STATES),
    ("B05003", NATION), ("B05003H", NATION), ("B05003I", NATION), ("B05003B", NATION), ("B05003D", NATION),
    ("B16005", NATION), ("B16006", NATION), ("B16007", NATION),
    ("B15001", NATION), ("C15002H", NATION), ("C15002I", NATION), ("C15002B", NATION), ("C15002D", NATION),
    ("B09021", NATION), ("B12002", NATION),
    ("B25007", NATION), ("B25027", NATION), ("B25003H", NATION), ("B25003I", NATION), ("B25003B", NATION), ("B25003D", NATION),
    ("B25032", NATION), ("B25064", STATES), ("B25088", STATES), ("B25063", NATION), ("B25087", NATION),
    ("B25064", NATION), ("B25088", NATION),
    ("B19001", NATION), ("B19013", NATION), ("B19080", NATION), ("B19081", NATION),
    ("B27010", NATION),
    ("B28005", NATION),
    ("B25044", NATION),
    ("B24011", NATION), ("C24010", NATION), ("B24080", NATION),
    ("B23001", NATION), ("B23022", NATION), ("B14004", NATION),
    ("B11005", NATION), ("B11001", NATION), ("B09019", NATION),
    ("B02015", NATION),
]
DEC = [("P2", STATES)]  # recensement 2020, DHC : population urbaine / rurale


def get(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(3 + attempt * 3)


def labels(dataset, table):
    meta = get(f"https://api.census.gov/data/{dataset}/groups/{table}.json")["variables"]
    out = {}
    concept = universe = ""
    for k, v in meta.items():
        # ACS : variables « …E » (estimations) ; recensement 2020 : « …N » (effectifs)
        if (k.endswith("E") and not k.endswith("EA") and not k.endswith("ME")) or (k.endswith("N") and not k.endswith("NA")):
            out[k] = v["label"].replace("Estimate!!", "").replace(":", "")
            concept = v.get("concept", concept)
            universe = v.get("universe", universe)
    return out, concept, universe


def fetch(dataset_id, dataset_api, table, geo):
    lab, concept, universe = labels(dataset_api, table)
    d = get(f"https://data.census.gov/api/access/data/table?id={dataset_id}.{table}&g={urllib.parse.quote(geo, safe='$')}")["response"]["data"]
    head = d[0]
    rows = {}
    for row in d[1:]:
        rec = dict(zip(head, row))
        name = rec.get("NAME") or rec.get("GEO_ID")
        vals = {}
        for k, v in rec.items():
            if k in lab and v not in (None, "", "null"):
                try:
                    vals[lab[k]] = float(v)
                except ValueError:
                    pass
        rows[name] = vals
    return {"concept": concept, "universe": universe, "dataset": dataset_id, "url": f"https://data.census.gov/table/{dataset_id}.{table}", "rows": rows}


def main():
    import urllib.parse  # noqa: F401
    out = {}
    if os.path.exists(OUT):
        out = json.load(open(OUT, encoding="utf-8"))
    for table, geo in TABLES:
        key = f"{table}@{'state' if geo == STATES else 'us'}"
        if key in out:
            continue
        try:
            out[key] = fetch("ACSDT1Y2024", "2024/acs/acs1", table, geo)
            print("ok", key, file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print("ÉCHEC", key, e, file=sys.stderr)
    for table, geo in DEC:
        key = f"DEC2020.{table}@{'state' if geo == STATES else 'us'}"
        if key in out:
            continue
        try:
            out[key] = fetch("DECENNIALDHC2020", "2020/dec/dhc", table, geo)
            print("ok", key, file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print("ÉCHEC", key, e, file=sys.stderr)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0, sort_keys=True)
        f.write("\n")


if __name__ == "__main__":
    import urllib.parse
    main()
