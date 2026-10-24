#!/usr/bin/env python3
"""
Construit les tables du socle Singapour (packs/sg/*.json) à partir des chiffres relevés dans
docs/research/socle-sg.md. Les chiffres officiels sont recopiés tels quels ; les hypothèses sont
marquées `assumption: true` avec leur justification. Relancer : python3 packs/sg/build-tables.py
(livingStandard est ensuite recalé sur le générateur : npx tsx packs/sg/calibrate-living-standard.ts).
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

def src(org, title, year, url, detail=None):
    s = {"org": org, "title": title, "year": year, "url": url}
    if detail:
        s["detail"] = detail
    return s

TB = "https://tablebuilder.singstat.gov.sg/table"
S_M810001 = src("Department of Statistics Singapore (DOS)", "Indicators On Population, Annual (M810001)", 2026, f"{TB}/TS/M810001")
S_M810791 = src("DOS", "Share Of Non-Resident Population By Pass Types, At End June (M810791)", 2026, f"{TB}/TS/M810791")
S_PIB = src("Strategy Group / NPTD", "Population in Brief 2026", 2026, "https://www.strategygroup.gov.sg/media-centre/publications/population-in-brief/")
S_MOM_FW = src("Ministry of Manpower (MOM)", "Foreign workforce numbers", 2026, "https://www.mom.gov.sg/documents-and-publications/foreign-workforce-numbers")
S_C020001 = src("DOS", "General Household Survey 2025: Resident Population by Age Group, Ethnic Group, Sex and Residential Status (C020001)", 2025, f"{TB}/CT/C020001")
S_C020053 = src("DOS", "GHS 2025: Religion by ethnic group (C020053)", 2025, f"{TB}/CT/C020053")
S_C02003x = src("DOS", "GHS 2025: Language most frequently spoken at home by age and ethnic group (C020029-C020034)", 2025, f"{TB}/CT/C020034")
S_C020018 = src("DOS", "GHS 2025: Highest qualification attained by age, sex and ethnic group (C020018)", 2025, f"{TB}/CT/C020018")
S_C020125 = src("DOS", "GHS 2025: Resident Population by Planning Area and Type of Dwelling (C020125)", 2025, f"{TB}/CT/C020125")
S_M810381 = src("DOS", "Singapore Residents By Age Group And Type Of Dwelling (M810381)", 2026, f"{TB}/TS/M810381")
S_C020065 = src("DOS", "GHS 2025: Resident households by type of dwelling and tenancy (C020065)", 2025, f"{TB}/CT/C020065")
S_C020009 = src("DOS", "GHS 2025: Marital status by age and sex (C020009)", 2025, f"{TB}/CT/C020009")
S_M810891 = src("DOS", "Residents In Resident Households By Living Arrangement, Age Group And Sex (M810891)", 2025, f"{TB}/TS/M810891")
S_C020011 = src("DOS", "GHS 2025: Children born alive to ever-married resident females (C020011)", 2025, f"{TB}/CT/C020011")
S_LF = src("MOM", "Labour Force in Singapore 2025 (tables A4, A5, C1-C4, D1, D5, E7, L7)", 2025, "https://stats.mom.gov.sg/Pages/Labour-Force-In-Singapore-2025.aspx")
S_MINDEF = src("MINDEF", "NS allowance to increase from 1 July 2025", 2025, "https://mindef.gov.sg/news-and-events/latest-releases/03mar25_fs3")
S_CPF = src("CPF Board", "CPF contribution rates from 1 January 2026", 2026, "https://www.cpf.gov.sg/content/dam/web/employer/employer-obligations/documents/CPFcontributionratesfrom1Jan2026.pdf")
S_IRAS = src("IRAS", "Individual Income Tax rates", 2026, "https://www.iras.gov.sg/taxes/individual-income-tax/basics-of-individual-income-tax/tax-residency-and-tax-rates/individual-income-tax-rates")
S_EP = src("MOM", "Written answer to PQ on salary of new EP applications by percentiles", 2026, "https://www.mom.gov.sg/newsroom/parliament-questions-and-replies/2026/0112-written-answer-to-pq-on-salary-of-new-ep-applications-by-percentiles")
S_EPQS = src("MOM", "Employment Pass eligibility", 2026, "https://www.mom.gov.sg/passes-and-permits/employment-pass/eligibility")
S_WP = src("MOM", "Written answer on wages of Work Permit holders", 2021, "https://www.mom.gov.sg/newsroom/parliament-questions-and-replies/2021/0802-written-answer-by-dr-tan-see-leng-to-pq-on-wages-of-work-permit-holders")
S_HES = src("DOS", "Household Expenditure Survey 2023 (tables 17967, 18010, 18013)", 2023, f"{TB}/CT/17967")
S_KHIT = src("DOS", "Key Household Income Trends 2025 (M810361, M810871)", 2025, f"{TB}/TS/M810871")
S_SSS = src("CPF Board", "Silver Support Scheme", 2026, "https://www.cpf.gov.sg/member/retirement-income/government-support/silver-support-scheme")
S_GSTV = src("govbenefits.gov.sg", "GST Voucher", 2026, "https://www.govbenefits.gov.sg/government-benefits-schemes/gst-voucher/")
S_HDBRENT = src("HDB", "Median Rent by Town and Flat Type (data.gov.sg)", 2025, "https://data.gov.sg/collections/156/view")
S_MND_LOAN = src("MND", "Written answer on loans serviced by HDB homeowners", 2023, "https://mnd.gov.sg/newsroom/speeches/view/written-answer-by-ministry-of-national-development-on-loans-serviced-by-hdb-homeowners")
S_PTC = src("Public Transport Council", "Fare Review Exercise 2025", 2025, "https://www.ptc.gov.sg/media-centre/newsroom/fare-review-exercise-2025/")
S_IMDA = src("IMDA via DOS", "Annual Survey on Infocomm Usage in Households and by Individuals (M920301, M920311, M920321, M920341)", 2024, f"{TB}/TS/M920341")
S_DORM = src("EdgeProp (Knight Frank, DASL)", "Worker dormitory occupancy and rents", 2026, "https://www.edgeprop.sg/property-news/worker-dormitory-rents-resume-growth-1h2026-despite-easing-occupancy")
S_ROGERS = src("Everett M. Rogers", "Diffusion of Innovations (5th edition)", 2003, "https://en.wikipedia.org/wiki/Diffusion_of_innovations")
S_SPOTIFY = src("Spotify", "Spotify Premium Singapore", 2026, "https://www.spotify.com/sg-en/intro/")
S_NETFLIX = src("Netflix", "Plans and pricing (Singapore)", 2026, "https://help.netflix.com/en/node/24926/sg")
S_DISNEY = src("Disney+", "What is Disney+ (Singapore)", 2025, "https://www.disneyplus.com/en-sg/explore/what-is-disneyplus")
S_MOBILE = src("WhistleOut Singapore", "Best SIM-only mobile plans", 2026, "https://www.whistleout.com.sg/MobilePhones/Best-SIM-Only-Mobile-Phone-Plans-SLP3")
S_FIBRE = src("SingSaver", "Best home fibre broadband plans", 2026, "https://www.singsaver.com.sg/telco/blog/best-home-fibre-broadband-plan")
S_REUTERS = src("Reuters Institute", "Digital News Report 2026: Singapore", 2026, "https://reutersinstitute.politics.ox.ac.uk/digital-news-report/2026/singapore")

def table(id_, title, data, sources, year=None, assumption=False, justification=None, notes=None):
    t = {"id": id_, "title": title, "assumption": assumption, "sources": sources}
    if year is not None:
        t["referenceYear"] = year
    if justification:
        t["justification"] = justification
    if notes:
        t["notes"] = notes
    t["data"] = data
    return t

def write(name, obj):
    with open(os.path.join(HERE, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")

BANDS5 = [(20, 24), (25, 29), (30, 34), (35, 39), (40, 44), (45, 49), (50, 54), (55, 59), (60, 64), (65, 69), (70, 74), (75, 79)]
ALL_BANDS = [(18, 19)] + BANDS5

def norm(d):
    t = sum(d.values())
    return {k: round(v / t, 4) for k, v in d.items()} if t else d

# ─── Statut de résidence × âge × sexe ─────────────────────────────────────────
# C020001 (juin 2025) : citoyens et PR par âge et sexe ; 18-19 = 2/5 des 15-19.
CIT = {  # (M, F)
    (15, 19): (96822, 92313), (20, 24): (103259, 96265), (25, 29): (119756, 110729), (30, 34): (131661, 125885),
    (35, 39): (125181, 124996), (40, 44): (117265, 122049), (45, 49): (112606, 120980), (50, 54): (122574, 131029),
    (55, 59): (122339, 129319), (60, 64): (134243, 138190), (65, 69): (126268, 132547), (70, 74): (98401, 107533),
    (75, 79): (67333, 80168),
}
PR = {
    (15, 19): (10643, 11616), (20, 24): (7831, 11331), (25, 29): (12710, 20540), (30, 34): (23680, 38610),
    (35, 39): (26671, 43277), (40, 44): (29428, 43030), (45, 49): (31062, 37367), (50, 54): (27118, 28257),
    (55, 59): (19101, 19024), (60, 64): (12802, 11440), (65, 69): (7246, 6358), (70, 74): (4713, 3970),
    (75, 79): (2882, 2437),
}

def resident_bands(t):
    out = [{"from": 18, "to": 19, "M": round(t[(15, 19)][0] * 0.4), "F": round(t[(15, 19)][1] * 0.4)}]
    for b in BANDS5:
        out.append({"from": b[0], "to": b[1], "M": t[b][0], "F": t[b][1]})
    return out

# Non-résidents adultes (HYPOTHÈSE, docs/research/socle-sg.md § 1.4 et 2.3) : effectifs 2026 × part adulte,
# répartition par âge (18-24, 25-29 … 55-59, 60-79) et part d'hommes.
FOREIGN = {
    # code, sector: (effectif adulte, % hommes, [18-24, 25-29, 30-34, 35-39, 40-44, 45-49, 50-54, 55-59, 60-79], part des 18-24 à 18-19)
    ("wp", "cmp"): (474500, 0.98, [11, 21, 22, 18, 13, 8, 4, 2, 1], 2 / 7),
    ("wp", "other"): (415200, 0.70, [10, 18, 20, 17, 13, 10, 6, 4, 2], 2 / 7),
    ("mdw", None): (316300, 0.0, [3, 14, 21, 22, 18, 12, 6, 3, 1], 0.0),
    ("ep", None): (round(197700 * 0.995), 0.66, [1, 12, 22, 22, 18, 12, 7, 4, 2], 2 / 7),
    ("spass", None): (round(177900 * 0.995), 0.55, [6, 22, 25, 19, 13, 8, 4, 2, 1], 2 / 7),
    ("dependant", None): (round(296500 * 0.62), 0.30, [8, 8, 17, 21, 17, 10, 6, 3, 10], 2 / 7),
    ("student", None): (round(98900 * 0.5), 0.50, [82, 13, 3, 1, 1, 0, 0, 0, 0], 30 / 82),
}
OLD_SPLIT = [0.55, 0.30, 0.10, 0.05]  # 60-79 → 60-64, 65-69, 70-74, 75-79

def foreign_bands(total, male, dist, share1819):
    s = sum(dist)
    w = [x / s for x in dist]
    cells = [w[0] * share1819, w[0] * (1 - share1819)] + w[1:8] + [w[8] * x for x in OLD_SPLIT]
    out = []
    for (a, b), c in zip(ALL_BANDS, cells):
        n = total * c
        out.append({"from": a, "to": b, "M": round(n * male), "F": round(n * (1 - male))})
    return out

statuses = [{"code": "citizen", "bands": resident_bands(CIT)}, {"code": "pr", "bands": resident_bands(PR)}]
for (code, sector), (n, male, dist, s1819) in FOREIGN.items():
    st = {"code": code, "bands": foreign_bands(n, male, dist, s1819)}
    if sector:
        st["sector"] = sector
    statuses.append(st)

write("residency.json", table(
    "sg-residency", "Population adulte (18-79 ans) par statut de résidence, âge et sexe",
    {
        "labels": {"citizen": "Singapore citizen", "pr": "Permanent resident", "ep": "Employment Pass", "spass": "S Pass", "wp": "Work Permit", "mdw": "Migrant domestic worker", "dependant": "Dependant's Pass or LTVP", "student": "Student's Pass"},
        "statuses": statuses,
    },
    [S_C020001, S_M810791, S_PIB, S_MOM_FW], 2026, assumption=True,
    justification="Citoyens et PR : effectifs officiels par âge et sexe (GHS 2025, C020001), 18-19 ans = 2/5 des 15-19 ans. Non-résidents : effectifs 2026 = parts officielles par pass (M810791) × 1 976 999 non-résidents ; la répartition par âge et sexe de chaque pass n'est pas publiée (MOM) : hypothèses justifiées dans docs/research/socle-sg.md § 2.3 (règles d'âge des MDW, salaires minimaux EP croissants avec l'âge, 70 % de femmes parmi les LTVP). Mineurs exclus : 38 % des DP/LTVP et 50 % des Student's Pass (hypothèse).",
    notes="Total ≈ 5,2 millions d'adultes, dont ≈ 35 % de non-résidents (WP CMP ≈ 9 %, WP hors CMP ≈ 8 %, MDW ≈ 6 %).",
))

# ─── âge × sexe (table commune : somme des statuts) ───────────────────────────
agg = {(a, b): [0, 0] for a, b in ALL_BANDS}
for st in statuses:
    for bd in st["bands"]:
        agg[(bd["from"], bd["to"])][0] += bd["M"]
        agg[(bd["from"], bd["to"])][1] += bd["F"]
write("age-sex.json", table(
    "sg-age-sex", "Population adulte de 18 à 79 ans par sexe et tranche d'âge (résidents et non-résidents)",
    {"bands": [{"from": a, "to": b, "M": agg[(a, b)][0], "F": agg[(a, b)][1]} for a, b in ALL_BANDS]},
    [S_C020001, S_M810791], 2026, assumption=True,
    justification="Somme des statuts de residency.json (résidents officiels, non-résidents par hypothèse) : sert à la validation des marges et au tableau de bord.",
))

# ─── Ethnie, nationalités ─────────────────────────────────────────────────────
ETH_CIT = {  # Chinese, Malays, Indians, Others
    (15, 19): (133727, 32452, 17721, 5235), (20, 24): (138611, 36950, 19269, 4694), (25, 29): (162171, 43367, 19915, 5032),
    (30, 34): (184694, 47867, 20654, 4331), (35, 39): (182898, 43336, 19306, 4637), (40, 44): (180817, 35592, 18335, 4570),
    (45, 49): (185493, 26519, 17776, 3798), (50, 54): (200442, 29366, 19776, 4019), (55, 59): (193931, 33875, 20232, 3620),
    (60, 64): (209491, 39256, 20613, 3073), (65, 69): (206729, 31886, 17691, 2509), (70, 74): (170591, 21211, 12393, 1739),
    (75, 79): (125667, 12359, 8197, 1278),
}
ETH_PR = {
    (15, 19): (8615, 355, 9192, 4097), (20, 24): (9978, 365, 5087, 3732), (25, 29): (26750, 710, 3052, 2738),
    (30, 34): (51548, 1339, 4221, 5182), (35, 39): (52558, 1704, 7508, 8178), (40, 44): (44979, 2194, 14330, 10955),
    (45, 49): (37717, 2605, 16348, 11759), (50, 54): (30691, 2086, 11658, 10940), (55, 59): (22726, 1430, 6285, 7684),
    (60, 64): (15981, 737, 2980, 4544), (65, 69): (9246, 603, 1452, 2303), (70, 74): (6044, 585, 818, 1236),
    (75, 79): (3682, 464, 491, 682),
}

def eth_bands(t):
    out = []
    for a, b in ALL_BANDS:
        key = (15, 19) if a == 18 else (a, b)
        c = t[key]
        out.append({"from": a, "to": b, "shares": norm({"chinese": c[0], "malay": c[1], "indian": c[2], "others": c[3]})})
    return out

PASSES = ["ep", "spass", "wp_cmp", "wp_other", "mdw", "dependant", "student"]
NAT = {  # pourcentages par pass : EP, S Pass, WP CMP, WP non-CMP, MDW, DP+LTVP, étudiants
    "india": [26, 15, 30, 8, 1, 24, 14],
    "china": [22, 28, 15, 20, 0, 24, 35],
    "malaysia": [10, 20, 3, 45, 1, 10, 8],
    "bangladesh": [0, 2, 36, 5, 0, 1, 0],
    "myanmar": [1, 5, 10, 8, 15, 2, 6],
    "philippines": [6, 20, 1, 7, 35, 6, 2],
    "indonesia": [2, 3, 0, 2, 46, 4, 8],
    "other_asia": [1, 2, 5, 5, 2, 1, 1],
    "vietnam": [1, 2, 0, 0, 0, 5, 8],
    "east_asia": [7, 1, 0, 0, 0, 6, 6],
    "western": [20, 1, 0, 0, 0, 14, 7],
    "other": [4, 1, 0, 0, 0, 3, 5],
}
by_pass = {p: {n: NAT[n][i] for n in NAT if NAT[n][i] > 0} for i, p in enumerate(PASSES)}
nationalities = [
    {"code": "india", "label": "India", "ethnicity": {"indian": 1}, "names": "india_pro", "namesByPass": {"wp_cmp": "india_wp", "wp_other": "india_wp", "mdw": "india_wp"}},
    {"code": "china", "label": "China", "ethnicity": {"chinese": 1}, "names": "china"},
    {"code": "malaysia", "label": "Malaysia", "ethnicity": {"chinese": 0.65, "malay": 0.20, "indian": 0.15},
     "ethnicityByPass": {"wp_cmp": {"chinese": 0.4, "malay": 0.45, "indian": 0.15}, "wp_other": {"chinese": 0.4, "malay": 0.45, "indian": 0.15}, "mdw": {"chinese": 0.4, "malay": 0.45, "indian": 0.15}},
     "names": "chinese", "namesByEthnicity": {"chinese": "chinese", "malay": "malay", "indian": "indian"}},
    {"code": "bangladesh", "label": "Bangladesh", "ethnicity": {"indian": 1}, "names": "bangladesh"},
    {"code": "myanmar", "label": "Myanmar", "ethnicity": {"chinese": 0.10, "indian": 0.05, "others": 0.85}, "names": "myanmar"},
    {"code": "philippines", "label": "Philippines", "ethnicity": {"others": 1}, "names": "philippines"},
    {"code": "indonesia", "label": "Indonesia", "ethnicity": {"chinese": 0.40, "malay": 0.55, "others": 0.05},
     "ethnicityByPass": {"mdw": {"chinese": 0.02, "malay": 0.90, "others": 0.08}, "wp_cmp": {"chinese": 0.02, "malay": 0.90, "others": 0.08}, "wp_other": {"chinese": 0.02, "malay": 0.90, "others": 0.08}},
     "names": "indonesia"},
    {"code": "other_asia", "label": "Thailand or another Asian country", "labelByEthnicity": {"indian": "Sri Lanka"}, "ethnicity": {"indian": 0.3, "others": 0.7}, "names": "thailand", "namesByEthnicity": {"indian": "india_pro"}},
    {"code": "vietnam", "label": "Vietnam", "ethnicity": {"others": 1}, "names": "vietnam"},
    {"code": "east_asia", "label": "Japan or South Korea", "labelByEthnicity": {"chinese": "Taiwan or Hong Kong"}, "ethnicity": {"chinese": 0.35, "others": 0.65}, "names": "east_asia", "namesByEthnicity": {"chinese": "china"}},
    {"code": "western", "label": "United Kingdom, Europe, North America or Oceania", "ethnicity": {"others": 1}, "names": "western"},
    {"code": "other", "label": "another country", "ethnicity": {"others": 1}, "names": "western"},
]
write("ethnicity.json", table(
    "sg-ethnicity", "Ethnie des résidents (par statut et âge) ; nationalités des non-résidents par pass",
    {
        "labels": {"chinese": "Chinese", "malay": "Malay", "indian": "Indian", "others": "Others (Eurasian, Filipino, Caucasian, etc.)"},
        "residents": {"citizen": eth_bands(ETH_CIT), "pr": eth_bands(ETH_PR)},
        "nationalities": nationalities,
        "byPass": by_pass,
    },
    [S_C020001, src("MOM", "Written answer on Dependant Pass holders (nationalities not published)", 2021, "https://www.mom.gov.sg/newsroom/parliament-questions-and-replies/2021/0405-written-answer-by-minister-for-manpower-josephine-teo-on-dependent-pass-holders")],
    2025, assumption=True,
    justification="Résidents : effectifs officiels par ethnie, statut et âge (C020001). Non-résidents : MOM ne publie pas les nationalités ; parts par pass et rattachement aux catégories ethniques de Singapour en hypothèse (docs/research/socle-sg.md § 3.2), avec un seul repère quasi officiel : 26 % d'Indiens parmi les EP en 2020.",
))

# ─── Religion ─────────────────────────────────────────────────────────────────
REL = {  # C020053 : No religion, Buddhism, Taoism, Islam, Hinduism, Sikhism, Catholic, Other Christians, Other
    "chinese": [30.3, 40.1, 9.7, 0.4, 0.0, 0.0, 7.8, 11.7, 0.1],
    "malay": [0.4, 0.1, 0.0, 98.6, 0.2, 0.1, 0.3, 0.3, 0.0],
    "indian": [3.2, 0.9, 0.1, 22.5, 58.8, 3.4, 6.9, 3.9, 0.3],
    "others": [23.6, 21.9, 0.5, 8.6, 1.3, 0.0, 31.8, 11.6, 0.8],
}
def rel(v):
    return norm({"none": v[0], "buddhism": v[1], "taoism": v[2], "islam": v[3], "hinduism": v[4], "sikhism": v[5], "christianity": v[6] + v[7], "other": v[8]})
by_group = {k: rel(v) for k, v in REL.items()}
FOREIGN_REL = {  # HYPOTHÈSE (docs/research/socle-sg.md § 4, non-résidents)
    "bangladesh": {"islam": 0.90, "hinduism": 0.09, "other": 0.01},
    "india": {"hinduism": 0.78, "islam": 0.08, "christianity": 0.07, "sikhism": 0.02, "none": 0.05},
    "indonesia": {"islam": 0.88, "christianity": 0.09, "buddhism": 0.02, "other": 0.01},
    "philippines": {"christianity": 0.88, "islam": 0.05, "none": 0.07},
    "myanmar": {"buddhism": 0.85, "christianity": 0.07, "islam": 0.05, "hinduism": 0.03},
    "china": {"none": 0.70, "buddhism": 0.22, "christianity": 0.06, "taoism": 0.02},
    "vietnam": {"none": 0.6, "buddhism": 0.33, "christianity": 0.07},
    "east_asia": {"none": 0.55, "buddhism": 0.28, "christianity": 0.17},
    "western": {"none": 0.50, "christianity": 0.42, "islam": 0.03, "other": 0.05},
    "other": {"none": 0.35, "christianity": 0.35, "islam": 0.2, "other": 0.1},
    "other_asia": {"buddhism": 0.65, "hinduism": 0.15, "islam": 0.1, "christianity": 0.1},
}
for k, v in FOREIGN_REL.items():
    by_group[k] = norm({r: v.get(r, 0) for r in ["buddhism", "taoism", "christianity", "islam", "hinduism", "sikhism", "other", "none"]})
write("religion.json", table(
    "sg-religion", "Religion par ethnie (résidents 15+) ; par nationalité (non-résidents, hypothèse)",
    {"labels": {"buddhism": "Buddhism", "taoism": "Taoism", "christianity": "Christianity", "islam": "Islam", "hinduism": "Hinduism", "sikhism": "Sikhism", "other": "Other religion", "none": "No religion"}, "byGroup": by_group},
    [S_C020053], 2025, assumption=True,
    justification="Résidents : religion par ethnie (GHS 2025, C020053 ; catholiques et autres chrétiens regroupés). Non-résidents (clé = nationalité) : hypothèses fondées sur la composition religieuse des pays d'origine (Bangladesh ≈ 90 % musulmans, Philippines ≈ 85-90 % chrétiens…), docs/research/socle-sg.md § 4. Les Malaisiens suivent la table de leur ethnie.",
))

# ─── Langue la plus parlée à la maison ────────────────────────────────────────
LANG_AGES = [(15, 19), (20, 24), (25, 29), (30, 34), (35, 39), (40, 44), (45, 49), (50, 54), (55, 59), (60, 64), (65, 69), (70, 74), (75, 79)]
L_CH = [(77.4, 21.8, 0.8, 0.0), (73.7, 25.0, 1.2, 0.1), (67.7, 30.6, 1.5, 0.3), (66.3, 32.1, 1.3, 0.3), (62.4, 34.7, 2.5, 0.4), (58.4, 39.1, 2.5, 0.1), (55.7, 38.9, 4.8, 0.5), (54.9, 38.1, 6.9, 0.3), (49.2, 43.8, 7.0, 0.1), (45.9, 44.6, 9.4, 0.2), (42.2, 45.2, 12.3, 0.2), (35.1, 47.9, 16.8, 0.2), (32.5, 46.3, 21.2, 0.1)]
L_MA = [(65.3, 34.3, 0.3), (59.5, 40.2, 0.3), (55.1, 44.9, 0.3), (53.5, 46.7, 0.0), (63.3, 36.7, 0.2), (58.8, 40.9, 0.3), (55.8, 42.7, 1.5), (53.4, 46.3, 0.7), (41.2, 58.5, 0.3), (36.6, 63.1, 0.3), (35.2, 64.5, 0.0), (23.8, 76.2, 0.0), (20.4, 79.6, 0.0)]
L_IN = [(71.2, 1.9, 21.7, 4.9, 0.7), (64.4, 5.1, 24.1, 6.5, 0.5), (71.3, 4.5, 21.3, 2.2, 0.6), (73.3, 6.9, 15.9, 3.9, 0.0), (73.2, 5.4, 13.8, 7.6, 0.0), (59.9, 4.2, 25.6, 10.4, 0.0), (59.2, 3.4, 29.0, 8.7, 0.0), (54.8, 3.8, 30.1, 10.6, 0.7), (60.1, 4.0, 28.9, 6.3, 0.4), (70.8, 6.2, 19.0, 4.1, 0.0), (61.4, 8.5, 26.8, 2.6, 0.7), (58.3, 9.6, 28.7, 3.5, 0.0), (50.7, 19.7, 25.4, 4.2, 0.0)]
L_OT = [(87.8, 0.0, 1.2, 11.0), (81.9, 0.0, 1.4, 16.7), (83.3, 1.7, 1.7, 13.3), (80.8, 9.0, 2.6, 7.7), (70.1, 11.1, 2.6, 16.2), (79.9, 4.7, 2.0, 13.4), (70.5, 4.7, 1.3, 23.5), (68.7, 4.0, 0.7, 27.3), (62.7, 5.9, 1.0, 29.4), (77.6, 1.3, 2.6, 18.4), (75.0, 9.1, 6.8, 11.4), (78.0, 5.0, 2.0, 15.0), (78.0, 5.0, 4.0, 13.0)]
def lang_rows(rows, f):
    out = []
    for (a, b), r in zip(LANG_AGES, rows):
        d = f(r)
        out.append({"from": 18 if a == 15 else a, "to": b, "shares": norm({k: d.get(k, 0) for k in ["english", "mandarin", "chinese_dialects", "malay", "tamil", "other_indian", "other"]})})
    return out
by_eth_age = {
    "chinese": lang_rows(L_CH, lambda r: {"english": r[0], "mandarin": r[1], "chinese_dialects": r[2], "other": r[3]}),
    "malay": lang_rows(L_MA, lambda r: {"english": r[0], "malay": r[1], "other": r[2]}),
    "indian": lang_rows(L_IN, lambda r: {"english": r[0], "malay": r[1], "tamil": r[2], "other_indian": r[3], "other": r[4]}),
    "others": lang_rows(L_OT, lambda r: {"english": r[0], "mandarin": r[1], "malay": r[2], "other": r[3]}),
}
LANGS = ["english", "mandarin", "chinese_dialects", "malay", "tamil", "other_indian", "other"]
def fl(d):
    return norm({k: d.get(k, 0) for k in LANGS})
by_nat = {
    "bangladesh": fl({"other_indian": 0.95, "english": 0.05}),
    "india": fl({"other_indian": 0.45, "tamil": 0.25, "english": 0.30}),
    "china": fl({"mandarin": 0.92, "chinese_dialects": 0.05, "english": 0.03}),
    "philippines": fl({"other": 0.7, "english": 0.3}),
    "indonesia": fl({"other": 0.75, "malay": 0.2, "english": 0.05}),
    "myanmar": fl({"other": 0.95, "english": 0.05}),
    "vietnam": fl({"other": 0.95, "english": 0.05}),
    "east_asia": fl({"other": 0.7, "mandarin": 0.15, "english": 0.15}),
    "western": fl({"english": 0.7, "other": 0.3}),
    "other": fl({"english": 0.5, "other": 0.5}),
    "other_asia": fl({"other": 0.8, "tamil": 0.1, "english": 0.1}),
}
write("language.json", table(
    "sg-language", "Langue la plus parlée à la maison, par ethnie et âge (résidents) ; par nationalité (non-résidents, hypothèse)",
    {"labels": {"english": "English", "mandarin": "Mandarin", "chinese_dialects": "a Chinese dialect (Hokkien, Teochew, Cantonese…)", "malay": "Malay", "tamil": "Tamil", "other_indian": "another Indian or South Asian language", "other": "another language"}, "byEthnicityAge": by_eth_age, "byNationality": by_nat},
    [S_C02003x], 2025, assumption=True,
    justification="Résidents : GHS 2025, C020030 à C020033 (par ethnie et âge, 18-19 ans = ligne 15-19, 75-79 ans des « Others » lissée : petites cases). Non-résidents : langue du pays d'origine (hypothèse, docs/research/socle-sg.md § 4) ; les Malaisiens suivent la table de leur ethnie.",
))

# ─── Éducation ────────────────────────────────────────────────────────────────
EDU = {  # C020018, % hommes / % femmes : below, secondary, post-secondary, diploma, university
    (15, 19): ((5.9, 1.4), (24.1, 44.6), (57.6, 41.9), (12.9, 10.8), (0.0, 0.0)),
    (20, 24): ((2.5, 2.8), (12.5, 10.8), (31.2, 18.3), (48.7, 35.2), (5.1, 33.2)),
    (25, 29): ((2.7, 2.0), (6.2, 4.6), (10.8, 6.0), (28.3, 21.4), (52.0, 65.9)),
    (30, 34): ((2.3, 2.4), (6.8, 5.7), (8.0, 5.1), (24.5, 20.9), (58.4, 65.9)),
    (35, 39): ((2.8, 3.2), (7.2, 7.1), (10.2, 5.9), (20.4, 22.1), (59.3, 61.6)),
    (40, 44): ((4.5, 4.9), (8.8, 9.1), (8.6, 6.6), (22.4, 20.9), (55.7, 58.6)),
    (45, 49): ((5.7, 7.6), (10.3, 11.7), (8.9, 7.3), (23.2, 23.7), (51.9, 49.7)),
    (50, 54): ((10.7, 11.6), (12.3, 16.8), (11.6, 10.6), (19.2, 21.1), (46.2, 39.8)),
    (55, 59): ((15.1, 21.3), (18.6, 21.4), (12.5, 14.7), (17.6, 17.3), (36.2, 25.3)),
    (60, 64): ((28.8, 31.3), (20.1, 26.5), (13.5, 14.7), (13.9, 11.8), (23.7, 15.7)),
    (65, 69): ((35.4, 42.0), (22.7, 26.7), (15.0, 15.0), (11.1, 7.6), (15.8, 8.8)),
    (70, 74): ((42.4, 52.6), (23.1, 22.3), (12.9, 12.8), (9.2, 5.1), (12.4, 7.2)),
    (75, 79): ((51.5, 63.3), (20.7, 19.0), (11.1, 10.2), (7.3, 3.3), (9.5, 4.1)),
}
EDU_KEYS = ["below_secondary", "secondary", "post_secondary", "diploma", "degree"]
edu_res = []
for a, b in ALL_BANDS:
    key = (15, 19) if a == 18 else (a, b)
    row = EDU[key]
    edu_res.append({"from": a, "to": b, "shares": norm({k: (row[i][0] + row[i][1]) / 2 for i, k in enumerate(EDU_KEYS)})})
def ed(d):
    return norm({k: d.get(k, 0) for k in EDU_KEYS})
edu_pass = {
    "ep": ed({"degree": 0.9, "diploma": 0.1}),
    "spass": ed({"degree": 0.45, "diploma": 0.45, "post_secondary": 0.1}),
    "wp_cmp": ed({"below_secondary": 0.3, "secondary": 0.35, "post_secondary": 0.27, "diploma": 0.08}),
    "wp_other": ed({"below_secondary": 0.2, "secondary": 0.35, "post_secondary": 0.33, "diploma": 0.12}),
    "mdw": ed({"below_secondary": 0.25, "secondary": 0.7, "post_secondary": 0.05}),
    "dependant": ed({"degree": 0.65, "diploma": 0.2, "post_secondary": 0.1, "secondary": 0.05}),
    "student": ed({"post_secondary": 0.5, "diploma": 0.2, "degree": 0.3}),
}
write("education.json", table(
    "sg-education", "Plus haut diplôme par âge (résidents) ; par pass (non-résidents, hypothèse)",
    {"labels": {"below_secondary": "Below secondary", "secondary": "Secondary", "post_secondary": "Post-secondary (ITE, Nitec, A-level)", "diploma": "Diploma or professional qualification", "degree": "University degree"}, "residents": edu_res, "byPass": edu_pass},
    [S_C020018], 2025, assumption=True,
    justification="Résidents : GHS 2025, C020018 (moyenne hommes-femmes ; 18-19 ans = ligne 15-19, hors étudiants à temps plein). Non-résidents : hypothèses fondées sur les critères des pass (EP : diplôme universitaire ; S Pass : diploma ou plus ; WP : secondaire ou technique), docs/research/socle-sg.md § 9.",
))

# ─── Géographie : planning areas × type de logement ───────────────────────────
AREAS = [  # région, nom, HDB 1-2R, 3R, 4R, 5R/Exec, condo, landed, autres (C020125)
    ("CR", "Bishan", 1080, 4560, 26510, 24130, 20280, 10220, 760), ("CR", "Bukit Merah", 17670, 32240, 45400, 28850, 19780, 500, 1760),
    ("CR", "Bukit Timah", 170, 840, 2330, 3230, 45200, 33310, 810), ("CR", "Downtown Core", 0, 0, 550, 0, 4320, 0, 360),
    ("CR", "Geylang", 8230, 26040, 35190, 14310, 25380, 6090, 2400), ("CR", "Kallang", 10470, 23750, 29110, 13760, 21560, 1320, 1750),
    ("CR", "Marine Parade", 2990, 5680, 4430, 5000, 19950, 9040, 400), ("CR", "Newton", 0, 0, 0, 0, 9120, 580, 410),
    ("CR", "Novena", 1480, 7180, 7500, 4370, 23890, 7970, 780), ("CR", "Orchard", 0, 0, 0, 0, 1350, 0, 100),
    ("CR", "Outram", 4210, 4340, 4500, 2020, 1460, 0, 420), ("CR", "Queenstown", 6800, 27490, 28160, 14490, 19280, 3490, 1780),
    ("CR", "River Valley", 0, 0, 0, 0, 11890, 740, 70), ("CR", "Rochor", 700, 3940, 3740, 730, 2930, 120, 630),
    ("CR", "Singapore River", 0, 0, 0, 0, 4500, 0, 130), ("CR", "Southern Islands", 0, 0, 0, 0, 2040, 610, 30),
    ("CR", "Tanglin", 0, 30, 160, 230, 19720, 4260, 230), ("CR", "Toa Payoh", 10550, 36220, 43250, 25340, 19810, 5310, 1750),
    ("ER", "Bedok", 10290, 50710, 63630, 43070, 61430, 42620, 2630), ("ER", "Changi", 0, 310, 0, 10, 10, 340, 1290),
    ("ER", "Pasir Ris", 1160, 780, 36060, 58680, 39750, 6850, 970), ("ER", "Tampines", 8430, 33620, 110180, 94710, 37160, 4340, 1660),
    ("NR", "Mandai", 0, 0, 0, 0, 1310, 750, 60), ("NR", "Sembawang", 9060, 4910, 38910, 40490, 15000, 4110, 870),
    ("NR", "Woodlands", 13190, 19060, 102330, 100370, 17250, 920, 1330), ("NR", "Yishun", 12100, 38650, 101280, 49210, 21020, 5570, 910),
    ("NER", "Ang Mo Kio", 11120, 52320, 41690, 21390, 14500, 15770, 1930), ("NER", "Hougang", 6740, 24260, 80940, 51220, 38410, 21890, 3770),
    ("NER", "Punggol", 15120, 15930, 81890, 65220, 25210, 370, 400), ("NER", "Sengkang", 12370, 11920, 100680, 98960, 41400, 1540, 730),
    ("NER", "Serangoon", 1510, 8900, 28430, 19840, 21170, 35960, 820), ("WR", "Bukit Batok", 9060, 27630, 56940, 36260, 29390, 5480, 1080),
    ("WR", "Bukit Panjang", 3370, 9430, 52680, 47110, 20050, 3150, 570), ("WR", "Choa Chu Kang", 5390, 6820, 76490, 72020, 23900, 2340, 590),
    ("WR", "Clementi", 2380, 23630, 28610, 15780, 26760, 5580, 1500), ("WR", "Jurong East", 2090, 16020, 23580, 24340, 6160, 0, 760),
    ("WR", "Jurong West", 8820, 30490, 94270, 97410, 17630, 4100, 1130), ("WR", "Tengah", 4180, 2340, 9150, 7120, 150, 0, 0),
    # Zones industrielles ou peu peuplées (< 1 000 résidents, omises par C020125) : dortoirs seulement
    ("WR", "Tuas", 0, 0, 0, 0, 0, 0, 0), ("WR", "Pioneer", 0, 0, 0, 0, 0, 0, 0), ("WR", "Boon Lay", 0, 0, 0, 0, 0, 0, 0),
    ("NR", "Sungei Kadut", 0, 0, 0, 0, 0, 0, 0), ("NR", "Lim Chu Kang", 0, 0, 0, 0, 0, 0, 0), ("NER", "Seletar", 0, 0, 0, 0, 0, 0, 0),
]
DW = ["hdb_1_2", "hdb_3", "hdb_4", "hdb_5_exec", "condo", "landed", "other"]
def code(name):
    return name.lower().replace(" ", "_")
areas = [{"code": code(n), "name": n, "region": r, "residents": dict(zip(DW, vals))} for r, n, *vals in AREAS]
AGE_DW = {  # M810381 (juin 2026), % par tranche : 1-2R, 3R, 4R, 5R/Exec, condo, landed, autres ; total en tête
    "total": (4.9, 12.9, 32.2, 25.5, 17.8, 5.8, 0.9),
    (15, 19): (3.6, 9.2, 28.8, 28.9, 22.1, 7.0, 0.4), (20, 24): (4.2, 10.3, 29.5, 30.0, 18.5, 7.0, 0.5),
    (25, 29): (4.1, 11.6, 34.4, 28.7, 14.8, 5.9, 0.4), (30, 34): (3.1, 11.4, 39.9, 25.9, 14.7, 4.3, 0.5),
    (35, 39): (2.7, 11.4, 36.8, 24.9, 19.8, 3.9, 0.5), (40, 44): (3.3, 11.3, 32.5, 23.6, 24.4, 4.4, 0.5),
    (45, 49): (3.7, 12.2, 30.6, 23.6, 24.2, 5.2, 0.6), (50, 54): (4.0, 13.4, 29.2, 24.8, 22.1, 5.8, 0.6),
    (55, 59): (4.9, 14.7, 30.1, 25.9, 17.8, 5.9, 0.7), (60, 64): (6.4, 16.1, 32.1, 25.5, 13.1, 5.8, 0.9),
    (65, 69): (7.9, 16.9, 32.3, 25.0, 10.5, 6.2, 1.2), (70, 74): (8.9, 18.0, 31.9, 23.4, 9.3, 6.8, 1.7),
    (75, 79): (9.0, 19.4, 30.2, 21.9, 9.1, 7.9, 2.5),
}
age_factor = []
for a, b in ALL_BANDS:
    row = AGE_DW[(15, 19) if a == 18 else (a, b)]
    age_factor.append({"from": a, "to": b, "factors": {k: round(row[i] / AGE_DW["total"][i], 3) for i, k in enumerate(DW)}})
def dwl(d):
    return norm({k: d.get(k, 0) for k in ["hdb_1_2", "hdb_3", "hdb_4", "hdb_5_exec", "condo", "landed", "dormitory", "other"]})
foreign_dw = {  # HYPOTHÈSE (docs/research/socle-sg.md § 6.3)
    "wp_cmp": dwl({"dormitory": 0.85, "hdb_3": 0.03, "hdb_4": 0.07, "hdb_5_exec": 0.03, "other": 0.02}),
    "wp_other": dwl({"dormitory": 0.30, "hdb_3": 0.20, "hdb_4": 0.25, "hdb_5_exec": 0.10, "condo": 0.02, "other": 0.13}),
    "mdw": dwl({"other": 1}),
    "spass": dwl({"dormitory": 0.10, "hdb_3": 0.20, "hdb_4": 0.28, "hdb_5_exec": 0.12, "condo": 0.27, "other": 0.03}),
    "ep": dwl({"hdb_3": 0.06, "hdb_4": 0.14, "hdb_5_exec": 0.10, "condo": 0.62, "landed": 0.08}),
    "dependant": dwl({"hdb_3": 0.05, "hdb_4": 0.15, "hdb_5_exec": 0.13, "condo": 0.55, "landed": 0.12}),
    "student": dwl({"hdb_3": 0.15, "hdb_4": 0.20, "hdb_5_exec": 0.10, "condo": 0.10, "other": 0.45}),
}
dorm_areas = {"tuas": 25, "pioneer": 12, "boon_lay": 8, "jurong_west": 10, "sungei_kadut": 12, "woodlands": 8, "mandai": 5, "lim_chu_kang": 4, "changi": 6, "tampines": 5, "pasir_ris": 3, "seletar": 2}
write("geography.json", table(
    "sg-geography", "Planning areas : résidents par type de logement ; logement et zones des non-résidents",
    {
        "dwellingLabels": {"hdb_1_2": "HDB 1- or 2-room flat", "hdb_3": "HDB 3-room flat", "hdb_4": "HDB 4-room flat", "hdb_5_exec": "HDB 5-room or executive flat", "condo": "condominium or private apartment", "landed": "landed house", "dormitory": "foreign workers' dormitory", "other": "other housing (shophouse, quarters, hostel…)"},
        "areas": areas,
        "foreignDwelling": foreign_dw,
        "dormitoryAreas": dorm_areas,
        "residentDwellingAgeFactor": age_factor,
    },
    [S_C020125, S_M810381, S_DORM, src("URA", "Master Plan 2019: planning areas and regions", 2019, "https://www.ura.gov.sg/Corporate/Planning/Master-Plan")],
    2025, assumption=True,
    justification="Résidents : effectifs officiels par planning area et type de logement (GHS 2025, C020125) et structure par âge du type de logement (M810381, en facteurs multiplicatifs). Non-résidents : aucune donnée publiée ; logement par pass en hypothèse (≈ 450 000 lits de dortoirs occupés à ≈ 95 %, MDW chez l'employeur, EP surtout en condo), zones des dortoirs en hypothèse (Tuas, Jurong, Sungei Kadut, Woodlands, Mandai, Changi), docs/research/socle-sg.md § 5-6.",
))

# ─── Régions (table commune) ──────────────────────────────────────────────────
REGION_NAMES = {"CR": "Central Region", "ER": "East Region", "NR": "North Region", "NER": "North-East Region", "WR": "West Region"}
reg_pop = {r: 0 for r in REGION_NAMES}
for a in areas:
    reg_pop[a["region"]] += sum(a["residents"].values())
write("regions.json", table(
    "sg-regions", "Résidents par planning region",
    {"regions": [{"code": c, "name": n, "population": reg_pop[c]} for c, n in REGION_NAMES.items()]},
    [S_C020125], 2025,
    notes="Population résidente (citoyens et PR) ; les non-résidents sont répartis par leur logement (dortoirs à l'ouest et au nord surtout).",
))

# ─── Activité ─────────────────────────────────────────────────────────────────
LFPR = {  # (M, F) LFPR %, chômage % (MOM LF 2025, A4-A5)
    (20, 24): ((53.0, 5.9), (55.1, 9.4)), (25, 29): ((87.0, 7.2), (93.0, 3.4)), (30, 34): ((96.2, 3.0), (90.6, 3.1)),
    (35, 39): ((96.4, 2.3), (90.3, 2.8)), (40, 44): ((97.2, 2.2), (85.7, 2.7)), (45, 49): ((95.6, 2.5), (81.7, 3.1)),
    (50, 54): ((94.2, 2.9), (78.6, 3.3)), (55, 59): ((87.5, 3.6), (69.0, 2.8)), (60, 64): ((79.1, 3.4), (58.0, 2.6)),
    (65, 69): ((60.2, 2.2), (41.0, 2.3)), (70, 74): ((36.0, 2.4), (22.0, 2.7)), (75, 79): ((20.0, 2.4), (12.0, 2.7)),
}
# Part des inactifs : en études, à la retraite (dont « trop âgé, santé » après 60 ans), autres (foyer, soins) — MOM L7
INACT = {(20, 24): (0.92, 0.0), (25, 29): (0.64, 0.0), (30, 34): (0.11, 0.0), (35, 39): (0.11, 0.0), (40, 44): (0.03, 0.0), (45, 49): (0.03, 0.005),
         (50, 54): (0.01, 0.06), (55, 59): (0.006, 0.16), (60, 64): (0.0, 0.63), (65, 69): (0.0, 0.63), (70, 74): (0.0, 0.81), (75, 79): (0.0, 0.81)}
NSF_2024 = 0.176  # part des hommes de 20-24 ans en NSF (moyenne 20 ans 55 %, 21 ans 25 %, 22 ans 8 %)
act = [{"from": 18, "to": 19,
        "M": norm({"employed": 15, "unemployed": 2, "student": 75, "retired": 0, "inactive": 8}),
        "F": norm({"employed": 17, "unemployed": 2, "student": 78, "retired": 0, "inactive": 3})}]
for b in BANDS5:
    row = {}
    for i, sex in enumerate(["M", "F"]):
        L, u = LFPR[b][i]
        emp = L * (1 - u / 100)
        une = L * u / 100
        ina = 100 - L
        if sex == "M" and b == (20, 24):
            # MOM compte les NSF parmi les occupés : on les retire (ils sont tirés à part)
            emp = (emp - NSF_2024 * 100) / (1 - NSF_2024)
            une = une / (1 - NSF_2024)
            ina = 100 - emp - une
        stu, ret = INACT[b]
        if b == (55, 59) and sex == "F":
            ret = 0.12
        row[sex] = norm({"employed": emp, "unemployed": une, "student": ina * stu, "retired": ina * ret, "inactive": ina * (1 - stu - ret)})
    act.append({"from": b[0], "to": b[1], **row})
write("activity.json", table(
    "sg-activity", "Situation d'activité des résidents par âge et sexe ; service national ; emploi des dépendants",
    {
        "residents": act,
        "nationalService": [{"from": 18, "to": 19, "share": 0.5}, {"from": 20, "to": 20, "share": 0.55}, {"from": 21, "to": 21, "share": 0.25}, {"from": 22, "to": 22, "share": 0.08}],
        "dependantEmployed": {"M": 0.4, "F": 0.2},
    },
    [S_LF, S_MINDEF], 2025, assumption=True,
    justification="Taux d'activité et de chômage par âge et sexe : MOM, Labour Force in Singapore 2025 (A4, A5) ; 70-74 et 75-79 ans répartis autour du taux des 70 ans et plus (29,3 % des hommes, 17,5 % des femmes). Inactifs ventilés par motif (L7) : études, retraite (y compris « trop âgé ou santé » après 60 ans), autres (foyer, soins). Service national : ≈ 44 % des hommes citoyens et PR de 18-21 ans en NSF, déduit des « Others » de la table D5 et réparti par âge (hypothèse) ; les NSF, comptés par MOM parmi les occupés, sont retirés des 20-24 ans. 18-19 ans hors NSF : ≈ 75 % en études (hypothèse). Dépendants en emploi : 16 % des LTVP travaillent (MHA 2021), hypothèse 20 % des femmes et 40 % des hommes dépendants.",
))

# ─── Professions (SSOC) ───────────────────────────────────────────────────────
SSOC = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
BY_EDU = {  # HYPOTHÈSE : profession selon le diplôme, ajustée au sexe ; cible : marges MOM D1 (PMET 64 %)
    "degree": [28, 47, 16, 3.5, 4, 0, 0.5, 0.5, 0.5],
    "diploma": [14, 18, 36, 12, 13, 0, 2.5, 2.5, 2],
    "post_secondary": [8, 5, 26, 16, 22, 0.2, 7, 10, 5.8],
    "secondary": [8, 2, 15, 14, 24, 0.3, 7, 14, 15.7],
    "below_secondary": [5, 1, 6, 6, 17, 0.5, 7, 19, 38.5],
}
SEX_ADJ = {"M": [1.15, 0.95, 0.9, 0.45, 0.85, 1.5, 1.8, 1.9, 0.85], "F": [0.85, 1.05, 1.1, 1.6, 1.15, 0.5, 0.25, 0.15, 1.15]}
occ_res = {e: {s: norm({c: v[i] * SEX_ADJ[s][i] for i, c in enumerate(SSOC)}) for s in ["M", "F"]} for e, v in BY_EDU.items()}
def oc(d):
    return norm({c: d.get(c, 0) for c in SSOC})
occ_pass = {
    "ep": oc({"1": 0.35, "2": 0.50, "3": 0.15}),
    "spass": oc({"2": 0.10, "3": 0.50, "4": 0.08, "5": 0.15, "7": 0.10, "8": 0.07}),
    "wp_cmp": oc({"7": 0.45, "8": 0.25, "9": 0.30}),
    "wp_other": oc({"5": 0.30, "7": 0.10, "8": 0.30, "9": 0.30}),
    "mdw": oc({"9": 1}),
    "student": oc({"5": 0.6, "4": 0.2, "9": 0.2}),
}
write("occupation.json", table(
    "sg-occupation", "Grand groupe professionnel (SSOC) des actifs occupés : par diplôme et sexe (résidents), par pass (non-résidents)",
    {"labels": {"1": "Manager or administrator", "2": "Professional", "3": "Associate professional or technician", "4": "Clerical support worker", "5": "Service or sales worker", "6": "Agricultural or fishery worker", "7": "Craft or related trades worker", "8": "Plant or machine operator or assembler", "9": "Cleaner, labourer or related worker"},
     "residents": occ_res, "byPass": occ_pass},
    [S_LF], 2025, assumption=True,
    justification="MOM publie la profession par sexe (D1) et par âge (D5), pas par diplôme : la table diplôme × sexe → profession est une hypothèse calée pour retrouver les marges officielles (PMET 64 % des actifs occupés résidents ; employés de bureau 13 % des femmes ; opérateurs 9 % des hommes). Étrangers : selon les critères des pass (EP : cadres et professions intellectuelles ; WP CMP : ouvriers du bâtiment, opérateurs, manœuvres ; MDW : groupe 9).",
))

# ─── Revenus ──────────────────────────────────────────────────────────────────
write("earnings.json", table(
    "sg-earnings", "Revenus bruts mensuels (hors cotisation employeur CPF) : résidents par profession, étrangers par pass, retraités, étudiants, NSF",
    {
        "fullTime": {"1": {"median": 10700, "sigma": 0.5}, "2": {"median": 7900, "sigma": 0.45}, "3": {"median": 4700, "sigma": 0.38}, "4": {"median": 3400, "sigma": 0.3}, "5": {"median": 3250, "sigma": 0.35}, "6": {"median": 2900, "sigma": 0.35}, "7": {"median": 3300, "sigma": 0.3}, "8": {"median": 3100, "sigma": 0.28}, "9": {"median": 2250, "sigma": 0.28}},
        "ageFactor": [{"from": 18, "to": 19, "factor": 0.55}, {"from": 20, "to": 24, "factor": 0.65}, {"from": 25, "to": 29, "factor": 0.82}, {"from": 30, "to": 34, "factor": 0.98}, {"from": 35, "to": 39, "factor": 1.1}, {"from": 40, "to": 44, "factor": 1.16}, {"from": 45, "to": 49, "factor": 1.16}, {"from": 50, "to": 54, "factor": 1.12}, {"from": 55, "to": 59, "factor": 1.0}, {"from": 60, "to": 64, "factor": 0.85}, {"from": 65, "to": 99, "factor": 0.75}],
        "sexFactor": {"M": 1.04, "F": 0.95},
        "partTime": {"M": 0.071, "F": 0.133, "incomeFactor": 0.42},
        "passes": {
            "ep": {"median": 9200, "sigma": 0.45, "floor": 5600, "floorAgeStep": 232},
            "spass": {"median": 3800, "sigma": 0.2, "floor": 3300, "floorAgeStep": 68},
            "wp_cmp": {"median": 1350, "sigma": 0.25},
            "wp_other": {"median": 1600, "sigma": 0.25},
            "mdw": {"median": 680, "sigma": 0.12},
            "student": {"median": 1500, "sigma": 0.4},
        },
        "retired": {"below_secondary": {"median": 850, "sigma": 0.45}, "secondary": {"median": 1150, "sigma": 0.45}, "post_secondary": {"median": 1400, "sigma": 0.45}, "diploma": {"median": 1800, "sigma": 0.5}, "degree": {"median": 2700, "sigma": 0.6}},
        "student": {"median": 450, "sigma": 0.6},
        "nationalService": {"median": 840, "sigma": 0.15},
        "unemployed": {"withIncomeShare": 0.35, "income": {"median": 900, "sigma": 0.5}},
        "inactive": {"withIncomeShare": 0.4, "income": {"median": 400, "sigma": 0.7}},
    },
    [S_LF, S_EP, S_EPQS, S_WP, S_MINDEF, src("CPF Board", "Projected CPF monthly payouts at 65 and 70", 2026, "https://www.cpf.gov.sg/member/infohub/reports-and-statistics/cpf-statistics/retirement-statistics/projected-cpf-monthly-payouts-at-age-65-and-70"), S_HES],
    2025, assumption=True,
    justification="Résidents à temps plein : médianes par profession calées pour retrouver la médiane officielle (5 000 S$ hors cotisation employeur, MOM C1) et les médianes par profession (C2) une fois le facteur d'âge et la composition par diplôme appliqués, facteur d'âge tiré des médianes par âge (C4) adouci (la composition par profession porte une partie de l'écart), dispersion calée sur les centiles P10-P90 (2 080 et 13 780 S$) ; temps partiel 7,1 % des hommes, 13,3 % des femmes, médiane 1 600 S$. EP : salaire minimal 5 600 S$ à 23 ans, 10 700 S$ à 45 ans (MOM), médiane des nouvelles demandes 9 200 S$ en 2025. S Pass : minimum 3 300 S$ (4 800 S$ à 45 ans), médiane supposée 3 800 S$. Work Permit : médiane officielle 1 100 S$ en 2020, actualisée et heures supplémentaires comprises (hypothèse 1 350-1 600 S$). MDW : 600-750 S$ selon la nationalité (sources secondaires). Retraités : revenu en espèces (CPF LIFE ≈ 760 S$ médian projeté, aide des enfants ≈ 500 S$, loyers et placements selon le diplôme), hypothèse de synthèse (HES 2023, table 18010). NSF : 790 à 1 530 S$ (MINDEF, 2025).",
))

write("cpf.json", table(
    "sg-cpf", "CPF : cotisation salariale (citoyens et PR) et part des prêts immobiliers payée par le compte ordinaire",
    {
        "employeeRate": [{"from": 18, "to": 55, "rate": 0.20}, {"from": 56, "to": 60, "rate": 0.18}, {"from": 61, "to": 65, "rate": 0.125}, {"from": 66, "to": 70, "rate": 0.075}, {"from": 71, "to": 99, "rate": 0.05}],
        "ordinaryWageCeiling": 8000,
        "noEmployeeBelow": 500,
        "fullRateFrom": 750,
        "hdbLoanCpfShare": 0.85,
        "privateLoanCpfShare": 0.5,
    },
    [S_CPF, S_MND_LOAN], 2026, assumption=True,
    justification="Taux et plafonds officiels 2026 (CPF Board). Prêt HDB : 70 % des emprunteurs paient entièrement par le CPF, 16 % en partie (MND, 2018) ; ≈ 8 acheteurs de BTO sur 10 sans espèces : part payée par le CPF supposée à 85 %. Prêts privés (mensualités plus élevées que le flux du compte ordinaire) : hypothèse 50 %. Les taux réduits des PR de 1re et 2e années ne sont pas modélisés.",
))

write("tax-benefits.json", table(
    "sg-tax-benefits", "Impôt sur le revenu des résidents fiscaux et transferts publics en espèces",
    {
        "brackets": [{"upTo": 20000, "rate": 0}, {"upTo": 30000, "rate": 0.02}, {"upTo": 40000, "rate": 0.035}, {"upTo": 80000, "rate": 0.07}, {"upTo": 120000, "rate": 0.115}, {"upTo": 160000, "rate": 0.15}, {"upTo": 200000, "rate": 0.18}, {"upTo": 240000, "rate": 0.19}, {"upTo": 280000, "rate": 0.195}, {"upTo": 320000, "rate": 0.2}, {"upTo": 500000, "rate": 0.22}, {"upTo": 1000000, "rate": 0.23}, {"upTo": None, "rate": 0.24}],
        "reliefs": 1000,
        "householdTransfers": {"cuts": [1300, 2300, 3400, 5200], "perMember": [120, 95, 75, 55, 35]},
        "silverSupport": {"monthly": 290, "maxIncomePerCapita": 1500, "fromAge": 65},
        "workfare": {"monthly": 140, "fromAge": 30, "maxIncome": 3000},
    },
    [S_IRAS, S_KHIT, S_SSS, S_GSTV], 2026, assumption=True,
    justification="Barème officiel des résidents (IRAS, YA2024 et suivants) ; seul l'Earned Income Relief (1 000 S$) est déduit en plus du CPF (abattements familiaux non modélisés : impôt un peu surestimé pour les parents). Transferts non ciblés par membre et par mois (GST Voucher cash, U-Save, CDC et SG60 Vouchers), concentrés sur les bas revenus, en hypothèse : SingStat publie 7 300 S$ par membre et par an de transferts dont 1 891 S$ de contributions régulières, mais pas leur ventilation par décile. Silver Support : 215 à 360 S$ par mois selon le logement (CPF Board), moyenne retenue 290 S$. Workfare : jusqu'à 4 900 S$ par an dont 40 % en espèces, moyenne retenue 140 S$ par mois.",
))

# ─── Ménage ───────────────────────────────────────────────────────────────────
MAR = {  # C020009, tous résidents, % : H (célib., marié, veuf, div.), F (…)
    (15, 19): ((100, 0, 0, 0), (100, 0, 0, 0)), (20, 24): ((99.0, 0.9, 0.1, 0.0), (97.2, 2.7, 0.1, 0.0)),
    (25, 29): ((85.9, 13.9, 0.0, 0.3), (73.4, 26.0, 0.1, 0.5)), (30, 34): ((47.7, 51.7, 0.1, 0.6), (34.8, 63.7, 0.1, 1.4)),
    (35, 39): ((24.4, 73.7, 0.2, 1.7), (20.4, 76.3, 0.2, 3.2)), (40, 44): ((15.8, 80.3, 0.2, 3.6), (15.6, 79.0, 0.3, 5.1)),
    (45, 49): ((13.9, 82.1, 0.3, 3.8), (14.1, 77.1, 1.0, 7.8)), (50, 54): ((10.9, 83.5, 0.5, 5.1), (13.2, 75.8, 1.9, 9.2)),
    (55, 59): ((10.8, 83.0, 1.0, 5.3), (11.7, 75.1, 3.4, 9.8)), (60, 64): ((9.2, 82.5, 2.1, 6.2), (12.5, 71.5, 7.5, 8.5)),
    (65, 69): ((9.2, 83.1, 3.5, 4.2), (11.8, 68.2, 12.9, 7.2)), (70, 74): ((5.5, 83.3, 7.7, 3.6), (10.0, 60.7, 22.8, 6.5)),
    (75, 79): ((3.9, 83.6, 9.1, 3.5), (8.2, 52.8, 34.3, 4.7)),
}
KIDS_AT_HOME = {(15, 19): 0.2, (20, 24): 0.3, (25, 29): 0.35, (30, 34): 0.55, (35, 39): 0.78, (40, 44): 0.86, (45, 49): 0.86, (50, 54): 0.78, (55, 59): 0.65, (60, 64): 0.5, (65, 69): 0.38, (70, 74): 0.32, (75, 79): 0.3}
SINGLE_WITH_PARENTS = {(15, 19): 0.97, (20, 24): 0.95, (25, 29): 0.915, (30, 34): 0.9, (35, 39): 0.8, (40, 44): 0.75, (45, 49): 0.7, (50, 54): 0.55, (55, 59): 0.4, (60, 64): 0.25, (65, 69): 0.1, (70, 74): 0.05, (75, 79): 0.02}
LONE_PARENT = {b: (0.5 if b[0] < 55 else 0.4 if b[0] < 70 else 0.35) for b in MAR}
hh = []
for a, b in ALL_BANDS:
    key = (15, 19) if a == 18 else (a, b)
    row = {}
    for i, sex in enumerate(["M", "F"]):
        s_, m_, w_, d_ = MAR[key][i]
        k = KIDS_AT_HOME[key]
        wp = SINGLE_WITH_PARENTS[key]
        lp = LONE_PARENT[key] * (0.6 if sex == "M" else 1.0)
        row[sex] = norm({
            "couple_with_children": m_ * k,
            "couple_no_child": m_ * (1 - k),
            "with_parents": s_ * wp,
            "alone": s_ * (1 - wp) * 0.55 + (w_ + d_) * (1 - lp) * 0.6,
            "other": s_ * (1 - wp) * 0.45 + (w_ + d_) * (1 - lp) * 0.4,
            "single_parent": (w_ + d_) * lp,
        })
    hh.append({"from": a, "to": b, **row})
def hht(d):
    return norm({k: d.get(k, 0) for k in ["alone", "couple_no_child", "couple_with_children", "single_parent", "with_parents", "other"]})
write("household.json", table(
    "sg-household", "Type de ménage par âge et sexe (résidents) et par pass (non-résidents) ; enfants ; employées de maison",
    {
        "residents": hh,
        "children": {"one": 0.276, "two": 0.44, "threePlus": 0.284},
        "firstBirthAge": {"M": 34.5, "F": 32.2},
        "byPass": {
            "wp_cmp": hht({"other": 0.97, "couple_no_child": 0.03}),
            "wp_other": hht({"other": 0.9, "couple_no_child": 0.05, "couple_with_children": 0.05}),
            "mdw": hht({"other": 1}),
            "spass": hht({"alone": 0.2, "other": 0.45, "couple_no_child": 0.2, "couple_with_children": 0.15}),
            "ep": hht({"alone": 0.3, "other": 0.15, "couple_no_child": 0.2, "couple_with_children": 0.35}),
            "dependant": hht({"couple_no_child": 0.32, "couple_with_children": 0.63, "other": 0.05}),
            "student": hht({"other": 0.7, "alone": 0.1, "with_parents": 0.2}),
        },
        "mdwByDwelling": {"hdb_1_2": 0.03, "hdb_3": 0.09, "hdb_4": 0.15, "hdb_5_exec": 0.25, "condo": 0.33, "landed": 0.55, "other": 0.05},
    },
    [S_C020009, S_M810891, S_C020011, S_PIB, src("HOME", "Migrant domestic workers: making them count", 2024, "https://www.home.org.sg/our-updates/2024/11/19/migrant-domestic-workers-making-them-count")],
    2025, assumption=True,
    justification="Construit à partir de l'état matrimonial par âge et sexe (C020009) : mariés → couple, avec enfant au foyer selon l'âge (hypothèse calée sur les 47,6 % de ménages « couple avec enfants », M810651) ; célibataires → chez leurs parents (91,5 % des 25-34 ans sans conjoint ni enfant, 78,3 % des 35-49 ans, M810891), sinon seuls ou en colocation ; veufs et divorcés → parent isolé, seuls ou avec d'autres. Nombre d'enfants : femmes non célibataires (C020011, 1, 2, 3 et plus parmi celles qui ont des enfants). Âge à la première naissance : 32,2 ans pour les mères (Population in Brief 2026), +2,3 ans pour les pères (hypothèse). Étrangers : la plupart des WP ne peuvent pas faire venir leur famille ; EP et S Pass (au-delà d'un seuil de salaire) le peuvent. Employées de maison : ≈ 19 % des ménages résidents (estimation d'ONG « 1 sur 5 » et effectifs MOM), plus fréquent en condo et landed (hypothèse).",
))

write("housing.json", table(
    "sg-housing", "Statut d'occupation des ménages par type de logement ; prêts en cours ; étrangers",
    {
        "residentTenure": {
            "hdb_1_2": {"owner": 0.484, "owner_mortgage": 0, "renter_private": 0.04, "renter_social": 0.476, "free": 0},
            "hdb_3": {"owner": 0.956, "owner_mortgage": 0, "renter_private": 0.036, "renter_social": 0.005, "free": 0.003},
            "hdb_4": {"owner": 0.969, "owner_mortgage": 0, "renter_private": 0.026, "renter_social": 0, "free": 0.005},
            "hdb_5_exec": {"owner": 0.979, "owner_mortgage": 0, "renter_private": 0.018, "renter_social": 0, "free": 0.003},
            "condo": {"owner": 0.869, "owner_mortgage": 0, "renter_private": 0.116, "renter_social": 0, "free": 0.015},
            "landed": {"owner": 0.915, "owner_mortgage": 0, "renter_private": 0.059, "renter_social": 0, "free": 0.026},
            "other": {"owner": 0.4, "owner_mortgage": 0, "renter_private": 0.4, "renter_social": 0, "free": 0.2},
        },
        "mortgageByAge": [{"from": 18, "to": 39, "share": 0.85}, {"from": 40, "to": 54, "share": 0.55}, {"from": 55, "to": 64, "share": 0.2}, {"from": 65, "to": 99, "share": 0.05}],
        "foreignTenure": {
            "ep": {"owner": 0.15, "owner_mortgage": 0, "renter_private": 0.85, "renter_social": 0, "free": 0},
            "spass": {"owner": 0.03, "owner_mortgage": 0, "renter_private": 0.97, "renter_social": 0, "free": 0},
            "dependant": {"owner": 0.1, "owner_mortgage": 0, "renter_private": 0.9, "renter_social": 0, "free": 0},
            "wp_cmp": {"owner": 0, "owner_mortgage": 0, "renter_private": 1, "renter_social": 0, "free": 0},
            "wp_other": {"owner": 0, "owner_mortgage": 0, "renter_private": 0.85, "renter_social": 0, "free": 0.15},
            "student": {"owner": 0, "owner_mortgage": 0, "renter_private": 0.7, "renter_social": 0, "free": 0.3},
            "mdw": {"owner": 0, "owner_mortgage": 0, "renter_private": 0, "renter_social": 0, "free": 1},
        },
    },
    [S_C020065, src("PMO / MND", "Written answers on HDB flats and private properties with outstanding mortgage loans", 2022, "https://leaderoftheopposition.sg/2022/11/29/change-in-share-of-private-residential-properties-and-hdb-flats-with-outstanding-mortgage-loans-since-2008-global-financial-crisis")],
    2025, assumption=True,
    justification="Parts de propriétaires et de locataires par type de logement : GHS 2025, C020065 (91,2 % de ménages propriétaires) ; locataires des 1-2 pièces HDB surtout en location publique (hypothèse). Prêts en cours : 42 % des propriétaires HDB et 62 % des propriétaires privés en 2022 (réponses au Parlement), répartis par âge en hypothèse (85 % avant 40 ans, 5 % après 65 ans). Étrangers : ne peuvent pas acheter de HDB ; propriétaires dans le privé en hypothèse.",
))

write("costs.json", table(
    "sg-costs", "Dépenses du ménage (S$ par mois) : logement, charges, alimentation, transport, santé, envois d'argent",
    {
        "mortgage": {"hdb_1_2": {"median": 350, "sigma": 0.3}, "hdb_3": {"median": 750, "sigma": 0.3}, "hdb_4": {"median": 1250, "sigma": 0.3}, "hdb_5_exec": {"median": 1600, "sigma": 0.3}, "condo": {"median": 4200, "sigma": 0.4}, "landed": {"median": 7000, "sigma": 0.45}, "other": {"median": 1500, "sigma": 0.5}},
        "rentWhole": {"hdb_1_2": {"median": 2330, "sigma": 0.12}, "hdb_3": {"median": 2800, "sigma": 0.12}, "hdb_4": {"median": 3400, "sigma": 0.12}, "hdb_5_exec": {"median": 3600, "sigma": 0.12}, "condo": {"median": 4000, "sigma": 0.35}, "landed": {"median": 8000, "sigma": 0.4}, "other": {"median": 2500, "sigma": 0.4}},
        "rentRoom": {"median": 900, "sigma": 0.25},
        "rentShared": {"median": 450, "sigma": 0.3},
        "rentSocial": {"median": 120, "sigma": 0.6},
        "conservancy": {"hdb_1_2": 35, "hdb_3": 60, "hdb_4": 75, "hdb_5_exec": 95, "condo": 350, "landed": 50, "other": 30},
        "utilities": {"hdb_1_2": 85, "hdb_3": 135, "hdb_4": 180, "hdb_5_exec": 210, "condo": 230, "landed": 430, "other": 120},
        "foodPerUc": 480,
        "transportPerUc": 120,
        "carShareByDwelling": {"hdb_1_2": 0.042, "hdb_3": 0.13, "hdb_4": 0.271, "hdb_5_exec": 0.452, "condo": 0.639, "landed": 0.853, "other": 0.1},
        "carMonthly": {"median": 1900, "sigma": 0.3},
        "healthInsurancePerUc": 150,
        "otherCurrentPerUc": 300,
        "currentIncomeElasticity": 0.35,
        "remittanceShare": {"wp_cmp": 0.6, "wp_other": 0.45, "mdw": 0.7, "spass": 0.2, "ep": 0.1, "dependant": 0, "student": 0},
        "withParentsContribution": 0.15,
        "adultChildContribution": 400,
        "dormitoryLiving": 300,
        "liveInLiving": 120,
    },
    [S_HES, S_HDBRENT, S_MND_LOAN, S_PTC, src("DOS", "Household Expenditure Survey 2023: households owning a car by dwelling (18013)", 2023, f"{TB}/CT/18013"), src("TWC2", "Struggles and sacrifices as cost of living rises", 2023, "https://twc2.org.sg/2023/08/01/struggles-and-sacrifices-as-cost-of-living-rises/")],
    2025, assumption=True,
    justification="Loyers HDB entiers : médianes 2025 par type (HDB, data.gov.sg) ; chambres et condos : annonces et contrats URA (sources de marché). Mensualités de prêt HDB : 600-1 900 S$ selon le type (MND et hypothèse 2025), payées surtout par le CPF (cpf.json). Dépenses courantes contraintes par adulte-équivalent tirées du HES 2023 (alimentation à domicile, hawker, food court et fast-food ≈ 960 S$ par ménage, hors restaurants et voyages qui relèvent du reste-à-vivre ; santé et assurances payées pour moitié par MediSave, transports en commun ≈ 120 S$ par adulte : pass mensuel 122 S$ ; colocation des WP hors dortoir ≈ 450 S$ le lit en chambre partagée, hypothèse), voiture : 36 % des ménages (HES 2023, par logement), coût ≈ 1 900-2 700 S$ par mois (hypothèse, COE 2025-2026). Enfants adultes au foyer : participation de 400 S$ par mois (hypothèse, cohérente avec la contribution de 15 % du revenu net d'un jeune adulte chez ses parents et les 513 S$ mensuels de contributions des enfants aux ménages de seniors, HES 2023). Envois d'argent : 60-80 % du revenu net chez les WP de la construction, 70-90 % chez les MDW, 25-50 % chez les S Pass (hypothèses, TWC2 et sources secondaires).",
))

# ─── Numérique ────────────────────────────────────────────────────────────────
write("digital.json", table(
    "sg-digital", "Équipement et usages numériques par âge (adultes)",
    {"bands": [
        {"from": 18, "to": 29, "smartphone": 0.998, "computer": 0.85, "tablet": 0.55, "internet": 0.99, "socialDaily": 0.8, "socialAny": 0.95},
        {"from": 30, "to": 39, "smartphone": 0.998, "computer": 0.86, "tablet": 0.62, "internet": 0.99, "socialDaily": 0.7, "socialAny": 0.92},
        {"from": 40, "to": 49, "smartphone": 0.995, "computer": 0.83, "tablet": 0.66, "internet": 0.99, "socialDaily": 0.62, "socialAny": 0.88},
        {"from": 50, "to": 59, "smartphone": 0.995, "computer": 0.76, "tablet": 0.56, "internet": 0.985, "socialDaily": 0.52, "socialAny": 0.8},
        {"from": 60, "to": 69, "smartphone": 0.94, "computer": 0.58, "tablet": 0.45, "internet": 0.96, "socialDaily": 0.4, "socialAny": 0.65},
        {"from": 70, "to": 79, "smartphone": 0.82, "computer": 0.38, "tablet": 0.3, "internet": 0.92, "socialDaily": 0.25, "socialAny": 0.45},
    ]},
    [S_IMDA, S_REUTERS], 2024, assumption=True,
    justification="Smartphone par âge (IMDA 2024 : 99,8 % des 18-39 ans, 99,5 % des 40-59 ans, 88,9 % des 60 ans et plus, découpé 94 % / 82 %), accès internet des ménages 98,5 % (93,9 % des ménages de seniors), ordinateur portable dans 81 % et tablette dans 69 % des ménages : passage à l'individu et au découpage par âge en hypothèse. Réseaux sociaux (Facebook, Instagram, TikTok) par âge : hypothèse (Reuters 2025 ne donne que des taux tous âges : Facebook 58 %, Instagram 54 %, TikTok 37 %).",
))

def item(id_, cat, offers, household, pen, el, basis, requires=None, requires_item=None):
    it = {"id": id_, "category": cat, "household": household, "incomeElasticity": el, "basis": basis,
          "penetration": [{"from": 18, "to": 29, "p": pen[0]}, {"from": 30, "to": 49, "p": pen[1]}, {"from": 50, "to": 64, "p": pen[2]}, {"from": 65, "to": 79, "p": pen[3]}],
          "offers": [{"name": n, "monthlyEur": p, "weight": w} for n, p, w in offers]}
    if requires:
        it["requires"] = requires
    if requires_item:
        it["requiresItem"] = requires_item
    return it
subs = [
    item("mobile", "mobile", [("SIM-only mobile plan (MVNO)", 10, 45), ("5G SIM-only plan", 20, 30), ("Telco mobile plan", 45, 25)], False, [0.99, 0.99, 0.98, 0.95], 0.0, "prix sourcés (WhistleOut 2026 : MVNO 5-12 S$, 5G 15-25 S$, opérateurs historiques 30-120 S$) ; part par gamme en hypothèse (cohérente avec 85 S$ de mobile par ménage, HES 2023)"),
    item("fibre", "internet", [("Home fibre broadband", 35, 60), ("Home fibre broadband", 45, 30), ("Home fibre broadband", 60, 10)], True, [0.9, 0.93, 0.93, 0.85], 0.1, "prix sourcés (offres 1 Gbit/s 30-50 S$, SingSaver 2026) ; 98,5 % des ménages ont internet, dont une part par le mobile seul (hypothèse)", requires="internet"),
    item("netflix", "video", [("Netflix Basic", 15.98, 35), ("Netflix Standard", 22.98, 45), ("Netflix Premium", 29.98, 20)], True, [0.45, 0.45, 0.3, 0.15], 0.4, "prix sourcés (Netflix, avril 2025) ; pénétration hypothèse (≈ 40 % des ménages ; dépense moyenne de streaming 8,80 S$ par ménage, HES 2023, partage et offres groupées)", requires="internet"),
    item("disney", "video", [("Disney+ Standard", 18.98, 70), ("Disney+ Premium", 22.98, 30)], True, [0.15, 0.18, 0.1, 0.05], 0.4, "prix sourcés (Disney+, novembre 2025) ; pénétration hypothèse (≈ 15 % des ménages)", requires="internet"),
    item("spotify", "music", [("Spotify Premium Individual", 11.98, 60), ("Spotify Premium Duo", 16.98, 10), ("Spotify Premium Family", 20.98, 10), ("Spotify Premium Student", 6.48, 20)], False, [0.25, 0.14, 0.07, 0.03], 0.3, "prix sourcés (Spotify SG) ; pénétration hypothèse (20-25 % des 18-39 ans, ≈ 10 % des 40-59 ans)", requires="smartphone"),
    item("youtube", "video", [("YouTube Premium", 15.98, 80), ("YouTube Premium Family", 31.98, 20)], False, [0.12, 0.1, 0.06, 0.03], 0.3, "prix sourcés (hausse de septembre 2026) ; pénétration hypothèse (8-10 %)", requires="internet"),
    item("icloud", "cloud storage", [("iCloud+ 50 GB", 1.48, 40), ("iCloud+ 200 GB", 3.98, 40), ("iCloud+ 2 TB", 13.98, 20)], False, [0.4, 0.4, 0.3, 0.15], 0.2, "prix sourcés (Apple) ; pénétration hypothèse (≈ 35 % des adultes, la moitié des smartphones sont des iPhone)", requires="smartphone"),
    item("amazon", "shopping", [("Amazon Prime", 4.99, 1)], False, [0.12, 0.12, 0.08, 0.03], 0.3, "prix sourcé (2025) ; pénétration hypothèse (≈ 10 %)", requires="internet"),
    item("grab", "delivery", [("GrabUnlimited", 6.99, 1)], False, [0.12, 0.08, 0.04, 0.01], 0.4, "prix et pénétration en hypothèse (aucun prix officiel trouvé, 3-8 S$ selon un agrégateur)", requires="smartphone"),
    item("gym", "sport", [("Gym membership", 95, 70), ("ActiveSG monthly gym pass", 30, 30)], False, [0.18, 0.15, 0.08, 0.04], 0.8, "prix sourcés (Anytime Fitness 80-100 S$, ActiveSG 15-30 S$) ; pénétration hypothèse (≈ 15 % des 20-49 ans en salle privée, ≈ 10 % ActiveSG)"),
    item("news", "news", [("The Straits Times digital", 29.9, 1)], False, [0.04, 0.08, 0.12, 0.12], 0.5, "prix non officiel (agrégateur, 2026) ; 17 % des internautes paient pour de l'information en ligne (Reuters 2026), répartis par âge en hypothèse", requires="internet"),
]
write("subscriptions.json", table(
    "sg-subscriptions", "Abonnements courants à Singapour : prix mensuels en S$ (TTC) et taux de détention par âge",
    {"items": subs},
    [S_NETFLIX, S_SPOTIFY, S_DISNEY, S_MOBILE, S_FIBRE, S_REUTERS, S_HES], assumption=True,
    justification="Prix relevés sur les sites des services ou des comparateurs (2025-2026, docs/research/socle-sg.md § 11). Les taux de détention ne sont pas publiés : hypothèses, sauf l'achat d'information (Reuters) et la dépense moyenne de streaming (HES 2023). Le champ « monthlyEur » porte le montant dans la devise du pack (S$), nom de champ historique.",
))

# ─── Psychographie (même modèle que la France, libellés anglais) ──────────────
fr = json.load(open(os.path.join(HERE, "../fr/psychographics.json"), encoding="utf-8"))
labels_en = {
    "enthousiaste": "enthusiastic, likes trying things and talking about them", "curieux": "curious, likes to understand, compare and look things up",
    "a_l_aise": "comfortable, confident in their choices, settled in life", "jovial": "cheerful, good-humoured, takes things lightly",
    "serein": "serene, calm, content with what they have", "occupe": "very busy, rushed, always between two things",
    "factuel": "matter-of-fact, sober", "pragmatique": "pragmatic, organised, careful with spending",
    "indifferent": "indifferent to novelties, attached to their habits", "mefiant": "wary, on the defensive",
    "fatigue": "weary, worn out by daily life", "inquiet": "worried about the future", "ironique": "ironic, a little disillusioned",
}
data = fr["data"]
for t in data["tones"]:
    t["label"] = labels_en[t["id"]]
write("psychographics.json", table(
    "sg-psychographics", "Traits psychographiques : profil d'adoption, sensibilité au prix, scepticisme, tonalité des récits",
    data, [S_ROGERS, S_IMDA], assumption=True,
    justification="Mêmes paramètres que le socle France (packs/fr/psychographics.json), faute de mesure singapourienne : parts de Rogers 2,5/13,5/34/34/16 %, latente techno décroissante avec l'âge et croissante avec le niveau de vie, sensibilité au prix décroissante avec le niveau de vie et croissante avec la tension budgétaire. Libellés des tonalités traduits en anglais. À recalibrer.",
))

# ─── Prénoms (HYPOTHÈSE) ──────────────────────────────────────────────────────
def short(name):
    n = name.strip()
    for sep in [" bin ", " binte ", " binti ", " s/o ", " d/o ", " a/l ", " a/p "]:
        if sep in n:
            n = n.split(sep)[0]
    return n

CH_SURNAMES = ["Tan", "Lim", "Lee", "Ng", "Ong", "Wong", "Goh", "Chua", "Chan", "Koh", "Teo", "Ang", "Yeo", "Tay", "Ho", "Low", "Toh", "Sim", "Chong", "Chia"]
def chinese_display(full):
    parts = full.split()
    if parts[0] in CH_SURNAMES:  # « Tan Ah Kow », « Tan Siew Hoon » : nom complet
        return full
    if len(parts) >= 2 and parts[1] in CH_SURNAMES:  # « Jason Tan Wei Ming » → « Jason Tan »
        return f"{parts[0]} {parts[1]}"
    return full

N = {
    ("chinese", "M", 0): "Tan Ah Kow, Lim Kim Huat, Ng Boon Heng, Ong Teck Seng, Goh Chin Huat, Lee Kok Wah, Chua Beng Hock, Koh Soon Lee, Teo Ah Seng, Wong Kum Fatt, Chan Wai Keong, Yeo Hock Chye, Tay Eng Soon, Low Kian Seng, Sim Ah Huat, Ho Yew Kong, Peter Tan Chee Keong, David Lim Swee Hock, Richard Ng, Michael Goh, Francis Ong, Henry Lee, Raymond Teo, Patrick Chua, Robert Koh, Anthony Wong, William Chan",
    ("chinese", "M", 1): "Jason Tan Wei Ming, Kelvin Lim Chee Wei, Desmond Ng Kok Leong, Alvin Ong Boon Kiat, Eric Goh, Benjamin Lee, Gary Chua, Terence Koh, Daniel Teo, Kenneth Wong, Edwin Chan, Melvin Yeo, Derrick Tay, Andy Low, Vincent Sim, Marcus Ho, Shawn Tan, Jeremy Lim, Leonard Ng, Clarence Ong, Wilson Goh, Eugene Lee, Ivan Chua, Benny Koh, Nicholas Teo",
    ("chinese", "M", 2): "Ryan Tan Jun Jie, Ethan Lim Zhi Hao, Javier Ng Jia Hui, Lucas Ong Yi Xuan, Bryan Goh Jun Wei, Ian Lee Kai Wen, Darren Chua Zheng Yang, Joshua Koh Wei Jie, Matthew Teo, Gabriel Wong, Caleb Chan, Isaac Yeo, Nathan Tay, Elijah Low, Aaron Sim, Dylan Ho, Jayden Tan, Brandon Lim, Sean Ng, Zachary Ong, Marcus Goh Yu Xiang, Glenn Teo",
    ("chinese", "F", 0): "Tan Siew Hoon, Lim Bee Lian, Ng Ah Moi, Ong Lay Choo, Goh Swee Lan, Lee Mei Ling, Chua Geok Hwa, Koh Poh Choo, Teo Lay Hong, Wong Siew Kim, Chan Kwai Fong, Yeo Bee Hoon, Tay Chwee Lian, Low Siok Eng, Sim Gek Choo, Ho Mui Keow, Mary Tan, Jenny Lim, Susan Ng, Doris Ong, Betty Goh, Helen Lee, Irene Chua, Lily Koh, Grace Teo, Margaret Wong, Agnes Chan",
    ("chinese", "F", 1): "Michelle Lim Hui Ling, Jasmine Tan Pei Shan, Angeline Ng, Serene Ong Siew Ling, Cheryl Goh, Joanne Lee, Shirley Chua, Wendy Koh, Doreen Teo, Karen Wong, Evelyn Chan, Elaine Yeo, Jacqueline Tay, Felicia Low, Pauline Sim, Sharon Ho, Valerie Tan, Adeline Lim, Rachel Ng, Vivian Ong, Germaine Goh, Audrey Lee, Esther Chua, Yvonne Koh, Priscilla Teo",
    ("chinese", "F", 2): "Chloe Lim Xin Yi, Rachel Tan Hui Min, Natalie Ng Jia Yi, Sarah Ong Wen Qi, Charlotte Goh, Megan Lee Shu Ting, Nicole Chua, Valerie Koh Yu Ting, Ashley Teo, Hannah Wong, Abigail Chan, Isabelle Yeo, Claire Tay, Gwendolyn Low, Vanessa Sim, Amanda Ho, Joey Tan, Samantha Lim, Kimberly Ng, Clarissa Ong, Kaelyn Teo",
    ("malay", "M", 0): "Abdul Rahman bin Osman, Mohamed Yusof bin Ahmad, Ismail bin Hassan, Ahmad bin Salleh, Osman bin Ali, Hamzah bin Ibrahim, Yaacob bin Mohd Noor, Sulaiman bin Abdullah, Jamaludin bin Kassim, Zainal bin Ariffin, Rahim bin Jaafar, Salleh bin Ismail, Hashim bin Yusof, Abu Bakar bin Hussein, Kamaruddin bin Mahmood, Ibrahim bin Sapari, Aziz bin Rahmat, Rosli bin Ahmad, Mansor bin Hamid, Hussin bin Omar, Daud bin Musa, Samad bin Kadir, Latiff bin Ismail",
    ("malay", "M", 1): "Mohamed Faizal bin Abdul Rahman, Muhammad Hafiz bin Ismail, Mohd Rizal bin Osman, Azman bin Hamzah, Khairul Anuar bin Yusof, Noor Azman bin Salleh, Shahrul Nizam bin Ali, Fadli bin Ibrahim, Zulkifli bin Hashim, Mohammad Iskandar bin Kassim, Hairul bin Jamal, Saiful Bahri bin Ahmad, Norman bin Abdullah, Rahmat bin Sulaiman, Firdaus bin Abu Bakar, Ridzuan bin Zainal, Faizal bin Daud, Azhar bin Mansor, Shamsul bin Kamaruddin, Effendy bin Latiff, Suhaimi bin Jaafar",
    ("malay", "M", 2): "Muhammad Danial bin Mohamed Faizal, Muhammad Haziq bin Azman, Muhammad Irfan bin Rizal, Muhammad Aqil bin Khairul, Ahmad Syafiq bin Zulkifli, Muhammad Amirul bin Hafiz, Adam Rayyan bin Fadli, Ariff bin Saiful, Muhammad Iman bin Hairul, Harith bin Ridzuan, Imran bin Firdaus, Aidil bin Azhar, Muhammad Faris bin Norman, Hakim bin Rahmat, Luqman bin Effendy, Afiq bin Hamid, Nabil bin Iskandar, Ilyas bin Faizal, Danish bin Shamsul, Aliff bin Zainal",
    ("malay", "F", 0): "Siti Aminah binte Hassan, Fatimah binte Ahmad, Rokiah binte Osman, Zainab binte Ismail, Aishah binte Salleh, Maimunah binte Ali, Khadijah binte Ibrahim, Halimah binte Yusof, Rahmah binte Jaafar, Salmah binte Kassim, Mariam binte Abdullah, Zaleha binte Hamid, Jamilah binte Musa, Asmah binte Said, Hasnah binte Omar, Rohani binte Mahmood, Norma binte Rahim, Hamidah binte Daud, Ramlah binte Ariffin, Kalsom binte Sapari, Normah binte Latiff",
    ("malay", "F", 1): "Norhayati binte Abdul Rahman, Nurul Huda binte Ismail, Siti Nurhaliza binte Osman, Suhaila binte Ahmad, Noraini binte Hamzah, Rosnah binte Yusof, Juliana binte Salleh, Haslinda binte Ali, Norazlina binte Ibrahim, Zuraidah binte Hashim, Nurhayati binte Kassim, Faridah binte Jamal, Rahayu binte Abdullah, Noor Aisyah binte Sulaiman, Hidayah binte Abu Bakar, Syazwani binte Zainal, Liyana binte Rahim, Suriani binte Daud, Azizah binte Mansor, Nadiah binte Kamaruddin, Marlina binte Latiff",
    ("malay", "F", 2): "Nur Aisyah binte Mohamed Faizal, Nur Syafiqah binte Azman, Nurul Ain binte Rizal, Siti Nur Alya binte Khairul, Nur Izzati binte Zulkifli, Nur Atiqah binte Hafiz, Alya Qistina binte Fadli, Nur Farhana binte Shahrul, Aqilah binte Saiful, Nur Hidayah binte Hairul, Syafiqah binte Ridzuan, Nadhirah binte Firdaus, Insyirah binte Azhar, Nur Amirah binte Norman, Hannah binte Rahmat, Sofea binte Effendy, Zahra binte Hamid, Nabilah binte Iskandar, Dayana binte Hasbullah, Qistina binte Faizal, Iman binte Azhar",
    ("indian", "M", 0): "Ramasamy s/o Muthu, Krishnan s/o Subramaniam, Govindasamy s/o Perumal, Rajendran s/o Arumugam, Selvaraj s/o Kandasamy, Murugesan s/o Ponnusamy, Nadarajah s/o Velu, Balakrishnan s/o Raman, Gopal s/o Sinnathamby, Maniam s/o Karuppiah, Thangaraju s/o Veerasamy, Sivalingam s/o Ramu, George Thomas, Joseph Mathew, Gurdev Singh, Harbans Singh, Mohamed Ibrahim s/o Abdul Kader, Jayakumar s/o Rajoo",
    ("indian", "M", 1): "Suresh Kumar s/o Rajendran, Ravi Chandran s/o Krishnan, Ganesh s/o Selvaraj, Vijay s/o Murugesan, Ramesh s/o Balakrishnan, Senthil Kumar s/o Gopal, Prakash s/o Nadarajah, Anand s/o Maniam, Kumar s/o Thangaraju, Saravanan s/o Sivalingam, Kannan s/o Govindasamy, Mohan s/o Ramasamy, Rajesh s/o Jayakumar, Sanjay Nair, Arvind Menon, Jaspal Singh, Kuldip Singh, Dinesh s/o Raman",
    ("indian", "M", 2): "Arjun s/o Suresh Kumar, Rishi s/o Ravi Chandran, Karthik s/o Ganesh, Vikram s/o Vijay, Pravin s/o Ramesh, Naveen s/o Senthil Kumar, Darshan s/o Prakash, Rohan s/o Anand, Kishore s/o Kumar, Harish s/o Kannan, Aravind s/o Mohan, Sachin s/o Rajesh, Adithya Nair, Rahul Menon, Gurpreet Singh, Amrit Singh, Muhammad Irfan s/o Shamsul Ariff, Sharvin s/o Dinesh, Akash s/o Kalai",
    ("indian", "F", 0): "Lakshmi d/o Krishnan, Saraswathy d/o Ramasamy, Kamala d/o Muthu, Pushpa d/o Subramaniam, Meenakshi d/o Perumal, Valli d/o Arumugam, Rajeswari d/o Kandasamy, Saroja d/o Velu, Indrani d/o Govindasamy, Mary Joseph, Annamma Thomas, Jaswant Kaur, Gurmit Kaur, Fatimah Bee d/o Abdul Kader, Vasantha d/o Maniam, Kalaiselvi d/o Nadarajah",
    ("indian", "F", 1): "Kavitha d/o Rajendran, Shanthi d/o Krishnan, Malathi d/o Selvaraj, Revathi d/o Murugesan, Geetha d/o Balakrishnan, Vasuki d/o Gopal, Sangeetha d/o Nadarajah, Anitha d/o Maniam, Uma d/o Thangaraju, Jayanthi d/o Sivalingam, Priya Nair, Deepa Menon, Harpreet Kaur, Manjit Kaur, Jennifer Fernandez, Sumathi d/o Kannan, Selvi d/o Jayakumar, Farah Banu d/o Abdul Rahim",
    ("indian", "F", 2): "Priya d/o Suresh Kumar, Divya d/o Ravi Chandran, Shalini d/o Ganesh, Nisha d/o Vijay, Keerthana d/o Ramesh, Harini d/o Senthil Kumar, Sneha d/o Prakash, Kavya d/o Anand, Swathi d/o Kumar, Deepika d/o Saravanan, Janani d/o Kannan, Sruthi d/o Mohan, Anjali Nair, Meera Menon, Simran Kaur, Navneet Kaur, Aisha Banu d/o Shamsul Ariff, Varsha d/o Kalai",
    ("others", "M", 9): "Desmond De Souza, Gerald Pereira, Kevin Rodrigues, Shaun Oliveiro, Clement D'Cruz, Mark Fernandez, Brian Scully, Daniel Martens, Joshua Schoon, Ryan Danker, Nathaniel Gomes, Jerome Theseira, Mark Anthony Santos, Joel Reyes",
    ("others", "F", 9): "Melissa De Souza, Gwendolyn Pereira, Andrea Rodrigues, Sheryl D'Cruz, Natasha Fernandez, Christine Martens, Leanne Danker, Bernadette Gomes, Rebecca Theseira, Patricia Westerhout, Maria Cristina Dela Cruz, Joanna Garcia",
    ("bangladesh", "M", 9): "Md. Rahim Uddin, Mohammad Hossain, Abdul Karim, Rubel Mia, Md. Alamgir Hossain, Sumon Ahmed, Shohag Mia, Md. Jahangir Alam, Rasel Sheikh, Md. Shahidul Islam, Kamrul Hasan, Md. Abul Kalam, Mizanur Rahman, Rakib Hasan, Habibur Rahman, Md. Sohel Rana, Masud Rana, Faruk Hossain, Shafiqul Islam, Nur Alam",
    ("bangladesh", "F", 9): "Nasrin Akter, Rokeya Begum, Shirin Akter, Taslima Begum",
    ("india_wp", "M", 9): "Murugan Selvam, Karthik Raja, Arun Kumar, Prakash Murugesan, Vignesh Pandian, Sakthivel Ramasamy, Manikandan Velu, Ramesh Kannan, Balamurugan Arumugam, Senthil Perumal, Muthukumar Raju, Suresh Ponnusamy, Ajith Kumar, Dinesh Babu, Gopi Krishnan, Raja Sekar, Sathish Kumar, Vinoth Kumar, Elango Durai",
    ("india_wp", "F", 9): "Selvi Murugan, Pandeeswari Raju, Muthulakshmi Velu, Kalaivani Selvam",
    ("india_pro", "M", 9): "Rahul Sharma, Arvind Kumar, Vikram Reddy, Amit Gupta, Rohit Agarwal, Sanjay Iyer, Karthik Subramanian, Nikhil Jain, Ankit Verma, Siddharth Rao, Pranav Kulkarni, Varun Mehta, Rajat Singh, Abhishek Mishra, Vivek Nair",
    ("india_pro", "F", 9): "Priya Nair, Ananya Iyer, Sneha Patel, Pooja Sharma, Divya Reddy, Neha Gupta, Kavya Rao, Shruti Agarwal, Meghna Menon, Aishwarya Krishnan, Ritu Jain, Swati Kulkarni, Nandini Shah, Deepa Pillai, Anjali Verma",
    ("china", "M", 9): "Wang Wei, Zhang Lei, Li Qiang, Liu Yang, Chen Jie, Yang Fan, Zhao Peng, Huang Hao, Zhou Jian, Wu Bin, Xu Ming, Sun Hao, Ma Jun, Zhu Tao, Hu Bo, Guo Liang, He Xin, Lin Feng, Gao Yu, Luo Kai",
    ("china", "F", 9): "Li Na, Wang Fang, Zhang Min, Liu Jing, Chen Xiaoyan, Yang Li, Zhao Yan, Huang Ting, Zhou Yu, Wu Xue, Xu Qian, Sun Lei, Ma Li, Zhu Hong, Hu Mei, Guo Jing, He Yun, Lin Xiao, Gao Shan, Luo Yi",
    ("philippines", "M", 9): "Mark Anthony Santos, John Paul Reyes, Jerome Dela Cruz, Christian Bautista, Ramon Garcia, Joel Mendoza, Ronald Villanueva, Arnel Aquino, Jayson Ramos, Rey Castillo",
    ("philippines", "F", 9): "Maria Cristina Santos, Jocelyn Reyes, Marites Dela Cruz, Rowena Garcia, Analyn Bautista, Jennylyn Mendoza, Lorna Villanueva, Mary Grace Aquino, Rhea Ramos, Joy Castillo, Liza Fernandez, Cherry Ann Torres, Rosalie Flores, Mylene Navarro, Divina Pascual",
    ("indonesia", "M", 9): "Agus Santoso, Budi Hartono, Eko Prasetyo, Joko Susilo, Rudi Hermawan",
    ("indonesia", "F", 9): "Siti Rohmah, Sri Wahyuni, Sumiati, Dewi Lestari, Tri Handayani, Ernawati, Yuliana, Nur Hasanah, Suryani, Rina Wati, Endang Susilowati, Wahyuningsih, Siti Khotimah, Lestari, Indah Permatasari, Fitri Yani, Ani Rahmawati, Sulastri, Kartini, Puji Astuti",
    ("myanmar", "M", 9): "Aung Ko Ko, Zaw Min Htet, Kyaw Zin Oo, Min Thu, Htet Aung",
    ("myanmar", "F", 9): "Thandar Aye, Khin Myo Win, Nwe Nwe Oo, Aye Aye Mon, Su Su Hlaing, Ei Ei Phyo, May Thu Zar, Hnin Wai",
    ("western", "M", 9): "James Wilson, Oliver Smith, Thomas Brown, Daniel Taylor, Matthew Johnson, Michael Davis, Benjamin Clarke, Andrew Thompson, Pierre Martin, Julien Dubois, Lukas Müller, Jan de Vries",
    ("western", "F", 9): "Sophie Williams, Emma Brown, Charlotte Taylor, Emily Johnson, Hannah Smith, Laura Wilson, Rebecca Clarke, Claire Martin, Camille Bernard, Anna Schmidt, Sanne Jansen",
    ("east_asia", "M", 9): "Kenji Tanaka, Hiroshi Sato, Min-jun Kim, Ji-hoon Park, Takumi Yamamoto, Seung-ho Lee",
    ("east_asia", "F", 9): "Yuki Suzuki, Ayaka Watanabe, Ji-yeon Lee, Seo-yeon Choi, Mei Nakamura, Hye-jin Kang",
    ("vietnam", "M", 9): "Nguyen Van Minh, Tran Duc Anh, Le Hoang Nam, Pham Quoc Bao",
    ("vietnam", "F", 9): "Nguyen Thi Lan, Tran Thu Trang, Le Thi Hoa, Pham Ngoc Anh, Vu Thanh Huong",
    ("thailand", "M", 9): "Somchai Wongsakul, Anan Chaiyaporn, Prasert Srisuk, Kittipong Boonmee",
    ("thailand", "F", 9): "Siriporn Kaewkla, Nattaya Thongdee, Ploy Rattanakorn, Malee Suksan",
}
COHORTS = {0: (1900, 1969), 1: (1970, 1989), 2: (1990, 2010), 9: (1900, 2010)}
cohorts = []
for (group, sex, k), names in N.items():
    lst = [n.strip() for n in names.split(",") if n.strip()]
    disp = []
    for n in lst:
        d = chinese_display(n) if group == "chinese" else short(n)
        if d not in disp:
            disp.append(d)
    a, b = COHORTS[k]
    cohorts.append({"birthFrom": a, "birthTo": b, "sex": sex, "group": group, "names": [[n, round(1 + 0.6 * (len(disp) - i) / len(disp), 3)] for i, n in enumerate(disp)]})
write("first-names.json", table(
    "sg-first-names", "Noms d'usage par ethnie ou nationalité, sexe et génération",
    {"cohorts": cohorts},
    [src("ICA", "Name registration conventions (English name, dialect or Hanyu Pinyin romanisation, bin/binte, s/o d/o)", 2025, "https://www.ica.gov.sg/")],
    assumption=True,
    justification="Aucune statistique officielle des prénoms n'est publiée à Singapour : listes de formes usuelles réalistes par ethnie, sexe et génération (romanisation dialectale avant les années 1980, prénom anglais et Hanyu Pinyin ensuite ; « bin / binte » et « s/o / d/o » retirés du nom d'usage), et pour les principales nationalités étrangères, docs/research/socle-sg.md § 10. Poids légèrement décroissants dans l'ordre des listes.",
    notes="Le nom d'usage est celui par lequel la personne est désignée au quotidien (« Jason Tan », « Tan Siew Hoon », « Nur Aisyah », « Suresh Kumar »).",
))

print("Tables écrites dans", HERE)
