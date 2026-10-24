#!/usr/bin/env python3
"""
Construit les tables du socle États-Unis (packs/us/*.json) à partir du relevé de l'ACS 2024 1-year et du
recensement 2020 (docs/research/socle-us-data/acs-2024.json, produit par packs/us/fetch-acs.py) et des chiffres
relevés dans docs/research/socle-us.md (CPS 2025, CPS ASEC 2026, IRS, HHS, USDA, KFF, CMS, BLS CE 2024, Pew…).
Les chiffres officiels sont recopiés ou agrégés ; les hypothèses sont marquées `assumption: true` avec leur
justification. Relancer : python3 -I packs/us/build-tables.py, puis npx tsx packs/us/calibrate.ts (niveau de vie).
Les noms (first-names.json, surnames.json) sont construits à part : packs/us/build-names.py.
"""
import json
import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ACS = json.load(open(os.path.join(HERE, "..", "..", "docs", "research", "socle-us-data", "acs-2024.json"), encoding="utf-8"))


def src(org, title, year, url, detail=None):
    s = {"org": org, "title": title, "year": year, "url": url}
    if detail:
        s["detail"] = detail
    return s


def acs_src(table, title):
    return src("U.S. Census Bureau", f"American Community Survey 2024 1-year, {table}: {title}", 2024, f"https://data.census.gov/table/ACSDT1Y2024.{table}")


S_B01001 = acs_src("B01001", "Sex by Age (nation and states)")
S_B03002 = acs_src("B03002", "Hispanic or Latino Origin by Race (nation and states)")
S_B01001R = acs_src("B01001H, B01001I, B01001B, B01001D", "Sex by Age by race and Hispanic origin")
S_B05003 = acs_src("B05003, B05003H, B05003I, B05003B, B05003D", "Sex by Age by Nativity and Citizenship Status")
S_B16005 = acs_src("B16005, B16006, B16007", "Language spoken at home by nativity, Hispanic origin and age")
S_B15001 = acs_src("B15001", "Sex by Age by Educational Attainment, 18 years and over")
S_C15002 = acs_src("C15002H, C15002I, C15002B, C15002D", "Sex by Educational Attainment, 25 years and over, by race and Hispanic origin")
S_B09021 = acs_src("B09021", "Living Arrangements of Adults 18 Years and Over by Age")
S_B12002 = acs_src("B12002", "Sex by Marital Status by Age")
S_B11005 = acs_src("B11005", "Households by Presence of People Under 18 Years by Household Type")
S_B25007 = acs_src("B25007", "Tenure by Age of Householder")
S_B25027 = acs_src("B25027", "Mortgage Status by Age of Householder")
S_B25003 = acs_src("B25003H, B25003I, B25003B, B25003D", "Tenure by race and Hispanic origin of householder")
S_B25032 = acs_src("B25032", "Tenure by Units in Structure")
S_B25063 = acs_src("B25063, B25064", "Gross Rent (distribution, median by state)")
S_B25087 = acs_src("B25087, B25088", "Selected Monthly Owner Costs (distribution, median by state and mortgage status)")
S_B25044 = acs_src("B25044", "Tenure by Vehicles Available")
S_B14004 = acs_src("B14004", "Sex by College or Graduate School Enrollment by Age")
S_C24010 = acs_src("C24010", "Sex by Occupation for the Civilian Employed Population")
S_B24080 = acs_src("B24080", "Sex by Class of Worker")
S_B27010 = acs_src("B27010", "Types of Health Insurance Coverage by Age")
S_B19001 = acs_src("B19013, B19080", "Median household income, household income quintile limits")
S_DEC = src("U.S. Census Bureau", "2020 Census Demographic and Housing Characteristics (DHC), P2: Urban and Rural", 2020, "https://data.census.gov/table/DECENNIALDHC2020.P2")
S_CPS03 = src("Bureau of Labor Statistics", "CPS 2025 annual averages, table 3: employment status by age, sex and race", 2025, "https://www.bls.gov/cps/cpsaat03.htm", "moyennes sur 11 mois (octobre 2025 non collecté)")
S_CPS07 = src("Bureau of Labor Statistics", "CPS 2025 annual averages, table 7: employment status by educational attainment", 2025, "https://www.bls.gov/cps/cpsaat07.htm")
S_CPS08 = src("Bureau of Labor Statistics", "CPS 2025 annual averages, table 8: employed persons by full- and part-time status and sex", 2025, "https://www.bls.gov/cps/cpsaat08.htm")
S_CPS11 = src("Bureau of Labor Statistics", "CPS 2025 annual averages, table 11: employed persons by detailed occupation and sex", 2025, "https://www.bls.gov/cps/cpsaat11.htm")
S_CPS39 = src("Bureau of Labor Statistics", "CPS 2025 annual averages, table 39: median weekly earnings of full-time wage and salary workers by occupation and sex", 2025, "https://www.bls.gov/cps/cpsaat39.htm")
S_WKYENG = src("Bureau of Labor Statistics", "Usual Weekly Earnings of Wage and Salary Workers, Third Quarter 2026 (tables 3 and 5)", 2026, "https://www.bls.gov/news.release/wkyeng.t05.htm")
S_EP = src("Bureau of Labor Statistics", "Employment Projections: Education pays (earnings and unemployment by educational attainment, 2025)", 2025, "https://www.bls.gov/emp/tables/unemployment-earnings-education.htm")
S_CPS15 = src("Bureau of Labor Statistics", "CPS 2025 annual averages, tables 12 and 15 (class of worker), series LNU02048984 (incorporated self-employed)", 2025, "https://www.bls.gov/cps/cpsaat15.htm")
S_ENROLL = src("U.S. Census Bureau", "School Enrollment in the United States: October 2024 (CPS), table 1", 2024, "https://www2.census.gov/programs-surveys/demo/tables/school-enrollment/2024/2024-cps/enroll01_2024_01.xlsx")
S_ASEC = src("U.S. Census Bureau", "Income in the United States: 2025 (P60-289, CPS ASEC 2026), tables 1, 6 and 11", 2026, "https://www2.census.gov/programs-surveys/demo/tables/p60/289/")
S_PINC08 = src("U.S. Census Bureau", "CPS ASEC 2026, PINC-08: source of income, people 65 and over", 2026, "https://www2.census.gov/programs-surveys/cps/tables/pinc-08/2026/pinc08_1_8_1.xlsx")
S_SSA = src("Social Security Administration", "Monthly Statistical Snapshot, July 2026 (average retired-worker benefit, SSI)", 2026, "https://www.ssa.gov/policy/docs/quickfacts/stat_snapshot/2026-07.html", "non ouvert (ssa.gov refuse l'accès automatisé) : chiffre relevé dans les résultats de recherche")
S_DOL = src("U.S. Department of Labor, ETA", "Unemployment Insurance Data Summary, Q2 2026", 2026, "https://oui.doleta.gov/unemploy/data_summary/SummaryTables.xlsx")
S_IRS = src("Internal Revenue Service", "Rev. Proc. 2025-32: tax year 2026 inflation adjustments (incl. One Big Beautiful Bill Act amendments)", 2025, "https://www.irs.gov/pub/irs-drop/rp-25-32.pdf")
S_IRS_SENIOR = src("Internal Revenue Service", "Enhanced deduction for seniors (2025-2028)", 2025, "https://www.irs.gov/newsroom/check-your-eligibility-for-the-new-enhanced-deduction-for-seniors")
S_IRS_SE = src("Internal Revenue Service", "Self-employment tax (Social Security and Medicare taxes); Topic 560 Additional Medicare Tax", 2026, "https://www.irs.gov/businesses/small-businesses-self-employed/self-employment-tax-social-security-and-medicare-taxes")
S_TF = src("Tax Foundation", "Facts & Figures 2026, table 11: state individual income tax rates and brackets (as of April 28, 2026)", 2026, "https://taxfoundation.org/wp-content/uploads/2026/05/TaxFoundation_FactsFigures26-5-28.pdf")
S_HHS = src("HHS ASPE", "2026 Poverty Guidelines", 2026, "https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines")
S_SNAP = src("USDA Food and Nutrition Service", "SNAP Cost-of-Living Adjustment FY2027 (allotments, income limits, deductions)", 2026, "https://fns-prod.azureedge.us/snap/allotment/cola")
S_SNAP_RATE = src("USDA Food and Nutrition Service", "Trends in SNAP Participation Rates FY2020 and FY2022", 2024, "https://fns-prod.azureedge.us/research/snap/national-participation-rates/fy20and22")
S_KFF_EXP = src("KFF", "Status of State Medicaid Expansion Decisions (October 2026)", 2026, "https://www.kff.org/medicaid/issue-brief/status-of-state-medicaid-expansion-decisions/")
S_P60_291 = src("U.S. Census Bureau", "Health Insurance Coverage in the United States: 2025 (P60-291)", 2026, "https://www2.census.gov/library/publications/2026/demo/p60-291.pdf")
S_KFF_EHBS = src("KFF", "2025 Employer Health Benefits Survey", 2025, "https://www.kff.org/health-costs/2025-employer-health-benefits-survey/")
S_KFF_ACA = src("KFF", "What we know so far about 2026 ACA Marketplace enrollment, premiums and deductibles", 2026, "https://www.kff.org/affordable-care-act/what-we-know-so-far-about-2026-aca-marketplace-enrollment-premiums-and-deductibles/")
S_CMS_MED = src("CMS", "2026 Medicare Parts A & B premiums and deductibles; Medicare Advantage and Part D 2026", 2025, "https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles")
S_NHE = src("CMS", "National Health Expenditure Fact Sheet (2024)", 2025, "https://www.cms.gov/data-research/statistics-trends-and-reports/national-health-expenditure-data/nhe-fact-sheet")
S_CE = src("Bureau of Labor Statistics", "Consumer Expenditure Survey 2024, table 1101 (income quintiles) and table 1300 (age of reference person)", 2025, "https://www.bls.gov/cex/tables/calendar-year/mean-item-share-average-standard-error/cu-income-quintiles-before-taxes-2024.xlsx")
S_EXPERIAN = src("Experian", "State of the Automotive Finance Market Q2 2026", 2026, "https://us-preview.experian.com/content/dam/noindex/na/us/automotive/finance-trends/2026/experian-safm-q2-2026.pdf")
S_SHED = src("Federal Reserve Board", "Economic Well-Being of U.S. Households in 2025 (SHED), credit section", 2026, "https://www.federalreserve.gov/publications/2026-economic-well-being-of-us-households-in-2025-credit.htm")
S_FSA = src("U.S. Department of Education, FSA", "FSA Data Center update (GENERAL-26-38)", 2026, "https://fsapartners.ed.gov/knowledge-center/library/electronic-announcements/2026-06-23/federal-student-aid-posts-updated-reports-fsa-data-center")
S_PEW_MOBILE = src("Pew Research Center", "Mobile Fact Sheet (2026)", 2026, "https://www.pewresearch.org/internet/fact-sheet/mobile/")
S_PEW_BB = src("Pew Research Center", "Internet, Broadband Fact Sheet (2026)", 2026, "https://www.pewresearch.org/internet/fact-sheet/internet-broadband/")
S_PEW_SM = src("Pew Research Center", "Social Media Fact Sheet (2026); Americans' Social Media Use 2025", 2026, "https://www.pewresearch.org/internet/fact-sheet/social-media/")
S_PEW_STREAM = src("Pew Research Center", "83% of U.S. adults use streaming services; far fewer subscribe to cable or satellite TV", 2025, "https://www.pewresearch.org/short-reads/2025/07/01/83-of-us-adults-use-streaming-services-far-fewer-subscribe-to-cable-or-satellite-tv/")
S_PEW_AI = src("Pew Research Center", "Americans and AI 2026, appendix (ChatGPT and other chatbots by age)", 2026, "https://www.pewresearch.org/internet/2026/06/17/americans-and-ai-appendix-detailed-chart-and-tables/markdown")
S_HFA = src("Health & Fitness Association", "81 million Americans were members of a fitness facility in 2025 (2026 Consumer Report)", 2026, "https://www.healthandfitness.org/81-million-americans-were-members-of-a-fitness-facility-in-2025-new-hfa-report-finds/")
S_REUTERS = src("Reuters Institute", "Digital News Report 2026: United States", 2026, "https://reutersinstitute.politics.ox.ac.uk/digital-news-report/2026/united-states")
S_NETFLIX = src("FOX 5 New York", "Netflix raising prices again on all plans (March 2026)", 2026, "https://www.fox5ny.com/news/netflix-raising-prices-again-all-plans-how-much-more-youll-be-paying")
S_DISNEY = src("12 On Your Side (Gray TV)", "Disney+ and Hulu are raising streaming prices again (September 2026)", 2026, "https://www.12onyourside.com/2026/09/23/disney-hulu-are-raising-streaming-prices-again/")
S_PEACOCK = src("9to5Mac", "Peacock is the latest streaming service to increase prices (August 2026)", 2026, "https://9to5mac.com/2026/08/18/peacock-is-the-latest-streaming-service-to-increase-prices-details-here/")
S_SPOTIFY = src("9to5Google", "Spotify US price increase on all plans (January 2026)", 2026, "https://9to5google.com/2026/01/15/spotify-us-subscribers-price-hike-all-plans-2026/")
S_ICLOUD = src("Apple", "iCloud+ plans and pricing (United States)", 2026, "https://support.apple.com/en-us/108047")
S_M365 = src("Microsoft", "Compare all Microsoft 365 plans (United States)", 2026, "https://www.microsoft.com/en-us/microsoft-365/buy/compare-all-microsoft-365-products")
S_CLAUDE = src("Anthropic", "Claude pricing", 2026, "https://claude.com/pricing")
S_DELOITTE = src("Deloitte", "Digital Media Trends: Digital Media Monitor (fall 2026)", 2026, "https://www.deloitte.com/us/en/insights/industry/technology/digital-media-trends-consumption-habits-survey/digital-media-monitor-dashboard.html")
S_BROADBAND = src("Benton Institute (BroadbandNow survey)", "The cost of staying connected in 2026", 2026, "https://www.benton.org/headlines/cost-staying-connected-2026")
S_MOBILE = src("US Mobile", "Best cell phone plans, August 2026 (carrier and prepaid prices)", 2026, "https://www.usmobile.com/blog/best-cell-phone-plans-august-2026/")
S_ROGERS = src("Everett M. Rogers", "Diffusion of Innovations (5th edition)", 2003, "https://en.wikipedia.org/wiki/Diffusion_of_innovations")


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


def norm(d, nd=4):
    t = sum(d.values())
    return {k: round(v / t, nd) for k, v in d.items()} if t else d


def us(table_):
    return list(ACS[f"{table_}@us"]["rows"].values())[0]


def states(table_):
    return ACS[f"{table_}@state"]["rows"]


def age_range(label):
    """« 22 to 24 years » → (22, 24) ; « 18 and 19 years » → (18, 19) ; « 85 years and over » → (85, 99)."""
    m = re.search(r"(\d+) (?:to|and) (\d+) years", label)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"(\d+) years and over", label)
    if m:
        return int(m.group(1)), 99
    m = re.search(r"Under (\d+) years", label)
    if m:
        return 0, int(m.group(1)) - 1
    m = re.search(r"(\d+) years", label)
    if m:
        return int(m.group(1)), int(m.group(1))
    return None


def overlap(a, b):
    return max(0, min(a[1], b[1]) - max(a[0], b[0]) + 1) / (a[1] - a[0] + 1)


def by_age(rows, prefix, bands):
    """Somme les effectifs « prefix!!<âge> » d'une table sexe × âge dans les tranches demandées (âges uniformes dans une case)."""
    out = [0.0] * len(bands)
    for label, v in rows.items():
        if not label.startswith(prefix + "!!") or label.count("!!") != prefix.count("!!") + 1:
            continue
        r = age_range(label[len(prefix) + 2:])
        if not r:
            continue
        for i, b in enumerate(bands):
            out[i] += v * overlap(r, b)
    return out


BANDS = [(18, 19), (20, 24), (25, 29), (30, 34), (35, 39), (40, 44), (45, 49), (50, 54), (55, 59), (60, 64), (65, 69), (70, 74), (75, 79)]
SEXES = [("M", "Male"), ("F", "Female")]

# ─── Âge × sexe ───────────────────────────────────────────────────────────────
b01 = us("B01001")
age_sex = {s: by_age(b01, f"Total!!{lab}", BANDS) for s, lab in SEXES}
write("age-sex.json", table("us-age-sex", "Adultes de 18 à 79 ans par âge et sexe (ensemble de la population résidente)",
    {"bands": [{"from": a, "to": b, "M": round(age_sex["M"][i]), "F": round(age_sex["F"][i])} for i, (a, b) in enumerate(BANDS)]},
    [S_B01001], 2024, notes="Population résidente totale (ménages et collectivités : résidences universitaires, établissements pour personnes âgées, prisons), tranches de l'ACS 2024."))

# ─── Géographie : États, régions, divisions ──────────────────────────────────
STATE_META = {
    # nom : (code, région, division)
    "Alabama": ("AL", "S", "east_south_central"), "Alaska": ("AK", "W", "pacific"), "Arizona": ("AZ", "W", "mountain"), "Arkansas": ("AR", "S", "west_south_central"),
    "California": ("CA", "W", "pacific"), "Colorado": ("CO", "W", "mountain"), "Connecticut": ("CT", "NE", "new_england"), "Delaware": ("DE", "S", "south_atlantic"),
    "District of Columbia": ("DC", "S", "south_atlantic"), "Florida": ("FL", "S", "south_atlantic"), "Georgia": ("GA", "S", "south_atlantic"), "Hawaii": ("HI", "W", "pacific"),
    "Idaho": ("ID", "W", "mountain"), "Illinois": ("IL", "MW", "east_north_central"), "Indiana": ("IN", "MW", "east_north_central"), "Iowa": ("IA", "MW", "west_north_central"),
    "Kansas": ("KS", "MW", "west_north_central"), "Kentucky": ("KY", "S", "east_south_central"), "Louisiana": ("LA", "S", "west_south_central"), "Maine": ("ME", "NE", "new_england"),
    "Maryland": ("MD", "S", "south_atlantic"), "Massachusetts": ("MA", "NE", "new_england"), "Michigan": ("MI", "MW", "east_north_central"), "Minnesota": ("MN", "MW", "west_north_central"),
    "Mississippi": ("MS", "S", "east_south_central"), "Missouri": ("MO", "MW", "west_north_central"), "Montana": ("MT", "W", "mountain"), "Nebraska": ("NE", "MW", "west_north_central"),
    "Nevada": ("NV", "W", "mountain"), "New Hampshire": ("NH", "NE", "new_england"), "New Jersey": ("NJ", "NE", "middle_atlantic"), "New Mexico": ("NM", "W", "mountain"),
    "New York": ("NY", "NE", "middle_atlantic"), "North Carolina": ("NC", "S", "south_atlantic"), "North Dakota": ("ND", "MW", "west_north_central"), "Ohio": ("OH", "MW", "east_north_central"),
    "Oklahoma": ("OK", "S", "west_south_central"), "Oregon": ("OR", "W", "pacific"), "Pennsylvania": ("PA", "NE", "middle_atlantic"), "Rhode Island": ("RI", "NE", "new_england"),
    "South Carolina": ("SC", "S", "south_atlantic"), "South Dakota": ("SD", "MW", "west_north_central"), "Tennessee": ("TN", "S", "east_south_central"), "Texas": ("TX", "S", "west_south_central"),
    "Utah": ("UT", "W", "mountain"), "Vermont": ("VT", "NE", "new_england"), "Virginia": ("VA", "S", "south_atlantic"), "Washington": ("WA", "W", "pacific"),
    "West Virginia": ("WV", "S", "south_atlantic"), "Wisconsin": ("WI", "MW", "east_north_central"), "Wyoming": ("WY", "W", "mountain"),
}
NON_EXPANSION = {"AL", "FL", "GA", "KS", "MS", "SC", "TN", "TX", "WI", "WY"}
# Taux d'impôt de l'État appliqué au revenu imposable fédéral : taux marginal d'un célibataire entre 50 000 et
# 75 000 $ de revenu imposable (Tax Foundation, avril 2026), ramené vers un taux moyen pour les barèmes progressifs
# (× 0,85), plus l'impôt local moyen sur le revenu là où il existe (MD, NY, OH, PA, KY, IN : Tax Foundation).
STATE_MARGINAL = {
    "AL": 5.0, "AK": 0, "AZ": 2.5, "AR": 3.9, "CA": 8.0, "CO": 4.4, "CT": 5.5, "DE": 5.55, "DC": 6.5, "FL": 0, "GA": 5.19, "HI": 7.6, "ID": 5.3, "IL": 4.95,
    "IN": 2.95, "IA": 3.8, "KS": 5.58, "KY": 3.5, "LA": 3.0, "ME": 6.75, "MD": 4.75, "MA": 5.0, "MI": 4.25, "MN": 6.8, "MS": 4.0, "MO": 4.7, "MT": 5.65,
    "NE": 4.55, "NV": 0, "NH": 0, "NJ": 5.525, "NM": 4.9, "NY": 5.4, "NC": 3.99, "ND": 1.95, "OH": 2.75, "OK": 4.5, "OR": 8.75, "PA": 3.07, "RI": 3.75,
    "SC": 5.21, "SD": 0, "TN": 0, "TX": 0, "UT": 4.45, "VT": 6.6, "VA": 5.75, "WA": 0, "WV": 4.22, "WI": 5.3, "WY": 0,
}
FLAT = {"AZ", "CO", "GA", "ID", "IL", "IN", "IA", "KY", "LA", "MI", "MS", "NC", "OH", "PA", "UT"}
LOCAL = {"MD": 2.4, "NY": 1.6, "OH": 1.2, "PA": 0.99, "KY": 0.93, "IN": 0.35, "MI": 0.16, "MO": 0.18, "OR": 0.18, "AL": 0.07, "IA": 0.08}

b01s = states("B01001")
rent = states("B25064")
own = states("B25088")
p2 = ACS["DEC2020.P2@state"]["rows"]
geo_states = []
for name, (code, region, division) in STATE_META.items():
    rows = b01s[name]
    adults = sum(sum(by_age(rows, f"Total!!{lab}", [(18, 79)])) for _, lab in SEXES)
    pr = p2[name]
    rural = pr[" !!Total!!Rural"] / pr[" !!Total"]
    o = own[name]
    rate = STATE_MARGINAL[code] * (1 if code in FLAT else 0.85) + LOCAL.get(code, 0)
    geo_states.append({
        "code": code, "name": name, "region": region, "division": division, "adults": round(adults), "rural": round(rural, 3),
        "medianGrossRent": rent[name]["Median gross rent"],
        "ownerCostsMortgage": o["Median selected monthly owner costs (dollars) --!!Housing units with a mortgage (dollars)"],
        "ownerCostsNoMortgage": o["Median selected monthly owner costs (dollars) --!!Housing units without a mortgage (dollars)"],
        "medicaidExpansion": code not in NON_EXPANSION, "stateTaxRate": round(rate / 100, 4),
    })
REGION_LABELS = {"NE": "Northeast", "MW": "Midwest", "S": "South", "W": "West"}
DIVISION_LABELS = {"new_england": "New England", "middle_atlantic": "Middle Atlantic", "east_north_central": "East North Central", "west_north_central": "West North Central",
                   "south_atlantic": "South Atlantic", "east_south_central": "East South Central", "west_south_central": "West South Central", "mountain": "Mountain", "pacific": "Pacific"}
write("geography.json", table("us-geography", "États : adultes de 18 à 79 ans, part rurale, loyers et coûts des propriétaires, Medicaid, impôt de l'État",
    {"regionLabels": REGION_LABELS, "divisionLabels": DIVISION_LABELS, "states": geo_states},
    [S_B01001, S_DEC, S_B25063, S_B25087, S_KFF_EXP, S_TF], 2024, assumption=True,
    justification="Effectifs, part rurale (recensement 2020, définition de 2020), loyers bruts médians et coûts mensuels médians des propriétaires (ACS 2024, charges, taxe foncière, assurance et énergie compris) et extension de Medicaid (KFF, octobre 2026) sont recopiés. Le taux d'impôt de l'État est une approximation : taux marginal d'un célibataire pour 50 000 à 75 000 $ de revenu imposable (Tax Foundation, barèmes au 28 avril 2026), multiplié par 0,85 pour les barèmes progressifs (taux moyen), appliqué au revenu imposable fédéral, plus l'impôt local moyen (Maryland, New York, Ohio, Pennsylvanie…). Ni les crédits propres aux États ni les impôts locaux des villes (New York City) ne sont modélisés.",
    notes="Régions et divisions du Census Bureau. Puerto Rico exclu."))
regions_pop = {}
for s in geo_states:
    regions_pop[s["region"]] = regions_pop.get(s["region"], 0) + s["adults"]
write("regions.json", table("us-regions", "Régions du Census Bureau (adultes de 18 à 79 ans)",
    {"regions": [{"code": k, "name": REGION_LABELS[k], "population": v} for k, v in regions_pop.items()]}, [S_B01001], 2024))

# ─── Race et origine hispanique ─────────────────────────────────────────────
RACES = ["white", "black", "hispanic", "asian", "other"]


def race_shares(rows):
    tot = rows["Total"]
    w = rows["Total!!Not Hispanic or Latino!!White alone"]
    b = rows["Total!!Not Hispanic or Latino!!Black or African American alone"]
    h = rows["Total!!Hispanic or Latino"]
    a = rows["Total!!Not Hispanic or Latino!!Asian alone"]
    return {"white": w / tot, "black": b / tot, "hispanic": h / tot, "asian": a / tot, "other": (tot - w - b - h - a) / tot}


by_state = {}
b03s = states("B03002")
for name, (code, _, _) in STATE_META.items():
    by_state[code] = {k: round(v, 4) for k, v in race_shares(b03s[name]).items()}
nat_share = race_shares(us("B03002"))
# Profils d'âge : B01001H (blancs non hispaniques), I (hispaniques), B (noirs), D (asiatiques) ; « other » : reste
RB = [(18, 19), (20, 24), (25, 29), (30, 34), (35, 44), (45, 54), (55, 64), (65, 74), (75, 79)]
prof = {}
for r, t in [("white", "B01001H"), ("hispanic", "B01001I"), ("black", "B01001B"), ("asian", "B01001D")]:
    rows = us(t)
    prof[r] = [sum(x) for x in zip(*(by_age(rows, f"Total!!{lab}", RB) for _, lab in SEXES))]
total_prof = [sum(x) for x in zip(*(by_age(b01, f"Total!!{lab}", RB) for _, lab in SEXES))]
# B01001B et B01001D comptent aussi les Hispanic de ces races : profils normalisés, niveaux de B03002
adult_tot = sum(total_prof)
level = {}
for r in ["white", "hispanic", "black", "asian"]:
    level[r] = sum(prof[r])
known = {r: [prof[r][i] * (nat_share[r] * sum(total_prof) / level[r]) * 1.0 for i in range(len(RB))] for r in level}
# niveau adulte de chaque groupe : parts B03002 (tous âges) corrigées par le rapport adultes/total du groupe
age_factor = []
shares_adult = {}
for r in level:
    shares_adult[r] = None
rows_all = {r: prof[r] for r in level}
# part du groupe dans chaque tranche, renormalisée pour que la moyenne adulte vaille la part adulte du groupe
cells = []
for i, (a, b) in enumerate(RB):
    sh = {r: rows_all[r][i] / total_prof[i] for r in level}
    # correction : Black et Asian comptent aussi des Hispanic (≈ 3 % et 1,4 %)
    sh["black"] *= nat_share["black"] / (us("B03002")["Total!!Not Hispanic or Latino!!Black or African American alone"] / us("B03002")["Total"] + us("B03002")["Total!!Hispanic or Latino!!Black or African American alone"] / us("B03002")["Total"])
    sh["asian"] *= nat_share["asian"] / (nat_share["asian"] + us("B03002")["Total!!Hispanic or Latino!!Asian alone"] / us("B03002")["Total"])
    sh["other"] = max(0.01, 1 - sum(sh.values()))
    cells.append(sh)
adult_mean = {r: sum(cells[i][r] * total_prof[i] for i in range(len(RB))) / adult_tot for r in RACES}
# facteur d'âge relatif à la part du groupe dans toute la population (les tables par État sont tous âges)
age_factor = [{"from": a, "to": b, "factors": {r: round(cells[i][r] / nat_share[r], 3) for r in RACES}} for i, (a, b) in enumerate(RB)]
write("race.json", table("us-race", "Race et origine hispanique (catégories OMB regroupées) par État et facteur d'âge",
    {"labels": {"white": "White (non-Hispanic)", "black": "Black or African American (non-Hispanic)", "hispanic": "Hispanic or Latino (any race)", "asian": "Asian (non-Hispanic)", "other": "American Indian, Alaska Native, Pacific Islander, other race or multiracial (non-Hispanic)"},
     "byState": by_state, "ageFactor": age_factor},
    [S_B03002, S_B01001R], 2024,
    notes="Tirage : P(race | État, âge) ∝ part de la race dans l'État (tous âges, B03002) × facteur d'âge national (part du groupe dans la tranche / part du groupe dans toute la population ; B01001H, I, B, D, les profils Black et Asian corrigés des Hispanic de ces races). Le groupe « other » regroupe AIAN, NHPI, autre race et deux races ou plus (non hispaniques). Approximation : la structure par âge d'un groupe est la même dans tous les États."))

# ─── Nativité ────────────────────────────────────────────────────────────────
def nativity(rows):
    out = {"us_born": 0, "naturalized": 0, "noncitizen": 0}
    for _, lab in SEXES:
        p = f"Total!!{lab}!!18 years and over"
        out["us_born"] += rows[f"{p}!!Native"]
        out["naturalized"] += rows[f"{p}!!Foreign-born!!Naturalized U.S. citizen"]
        out["noncitizen"] += rows[f"{p}!!Foreign-born!!Not a U.S. citizen"]
    return out


nat_counts = {"white": nativity(us("B05003H")), "hispanic": nativity(us("B05003I")), "black": nativity(us("B05003B")), "asian": nativity(us("B05003D"))}
tot_n = nativity(us("B05003"))
nat_counts["other"] = {k: max(1, tot_n[k] - sum(nat_counts[r][k] for r in ["white", "hispanic", "black", "asian"])) for k in tot_n}
write("nativity.json", table("us-nativity", "Adultes nés aux États-Unis, naturalisés ou non citoyens, par race et origine hispanique",
    {"labels": {"us_born": "born in the United States", "naturalized": "born abroad, naturalized U.S. citizen", "noncitizen": "born abroad, not a U.S. citizen"},
     "byRace": {r: norm(v) for r, v in nat_counts.items()}},
    [S_B05003], 2024,
    notes="Adultes de 18 ans et plus (B05003 par race). Black et Asian : race seule, Hispanic compris (écart négligeable) ; « other » : total moins les quatre groupes. Les natifs comprennent les personnes nées à Puerto Rico ou à l'étranger de parents américains. Approximation : pas de modulation par âge (l'ACS 1-year ne croise pas finement nativité et âge par race)."))

# ─── Langue parlée à la maison ───────────────────────────────────────────────
LANG = {
    "white:us_born": {"english": 0.975, "spanish": 0.008, "other_indo_european": 0.014, "asian_pacific": 0.001, "other": 0.002},
    "white:foreign_born": {"english": 0.40, "spanish": 0.03, "other_indo_european": 0.45, "asian_pacific": 0.01, "other": 0.11},
    "black:us_born": {"english": 0.982, "spanish": 0.008, "other_indo_european": 0.004, "asian_pacific": 0.001, "other": 0.005},
    "black:foreign_born": {"english": 0.45, "spanish": 0.02, "other_indo_european": 0.23, "asian_pacific": 0.0, "other": 0.30},
    "hispanic:us_born": {"english": 0.38, "spanish": 0.61, "other_indo_european": 0.005, "asian_pacific": 0.0, "other": 0.005},
    "hispanic:foreign_born": {"english": 0.06, "spanish": 0.93, "other_indo_european": 0.005, "asian_pacific": 0.0, "other": 0.005},
    "asian:us_born": {"english": 0.65, "spanish": 0.005, "other_indo_european": 0.11, "asian_pacific": 0.225, "other": 0.01},
    "asian:foreign_born": {"english": 0.17, "spanish": 0.005, "other_indo_european": 0.26, "asian_pacific": 0.55, "other": 0.015},
    "other:us_born": {"english": 0.90, "spanish": 0.04, "other_indo_european": 0.01, "asian_pacific": 0.03, "other": 0.02},
    "other:foreign_born": {"english": 0.40, "spanish": 0.20, "other_indo_european": 0.05, "asian_pacific": 0.20, "other": 0.15},
}
b16005 = us("B16005")
b16006 = us("B16006")
write("language.json", table("us-language", "Langue parlée à la maison par race et nativité",
    {"labels": {"english": "English only", "spanish": "Spanish", "other_indo_european": "another Indo-European language (e.g. French, German, Russian, Hindi, Portuguese)", "asian_pacific": "an Asian or Pacific Island language (e.g. Chinese, Vietnamese, Tagalog, Korean)", "other": "another language (e.g. Arabic, Amharic, Somali)"},
     "byGroup": LANG},
    [S_B16005], 2024, assumption=True,
    justification=f"L'ACS publie la langue par nativité (B16005 : nés à l'étranger {b16005['Total!!Foreign born!!Speak only English'] / b16005['Total!!Foreign born']:.1%} « English only », espagnol {b16005['Total!!Foreign born!!Speak Spanish'] / b16005['Total!!Foreign born']:.1%} ; natifs {b16005['Total!!Native!!Speak only English'] / b16005['Total!!Native']:.1%} « English only ») et pour les Hispanic (B16006 : {b16006['Total!!Speak Spanish'] / b16006['Total']:.1%} parlent espagnol à la maison, 5 ans et plus), pas le croisement race × nativité. Les parts par groupe sont des hypothèses construites pour retrouver ces marges chez les adultes (les langues indiennes comptent parmi les langues indo-européennes) ; contrôle : personas:validate.",
    notes="Langue autre que l'anglais parlée à la maison (variable « language spoken at home ») : la plupart des personnes concernées parlent aussi anglais."))

# ─── Diplôme ─────────────────────────────────────────────────────────────────
EDU = ["below_hs", "high_school", "some_college", "associate", "bachelor", "graduate"]
EDU_MAP = {"Less than 9th grade": "below_hs", "9th to 12th grade, no diploma": "below_hs", "High school graduate (includes equivalency)": "high_school",
           "Some college, no degree": "some_college", "Associate's degree": "associate", "Bachelor's degree": "bachelor", "Graduate or professional degree": "graduate"}
b15 = us("B15001")
EB = [("18 to 24 years", 18, 24), ("25 to 34 years", 25, 34), ("35 to 44 years", 35, 44), ("45 to 64 years", 45, 64), ("65 years and over", 65, 79)]
edu_bands = []
for lab, a, b in EB:
    row = {"from": a, "to": b}
    for s, slab in SEXES:
        d = {k: 0.0 for k in EDU}
        for src_lab, k in EDU_MAP.items():
            d[k] += b15[f"Total!!{slab}!!{lab}!!{src_lab}"]
        row[s] = norm(d)
    edu_bands.append(row)
# facteur race : C15002 (25+) rapporté à l'ensemble des 25+ (B15001)
G4 = {"below_hs": "Less than high school diploma", "high_school": "High school graduate (includes equivalency)", "some_college": "Some college or associate's degree", "associate": "Some college or associate's degree", "bachelor": "Bachelor's degree or higher", "graduate": "Bachelor's degree or higher"}
all25 = {g: 0.0 for g in set(G4.values())}
for lab, a, b in EB[1:]:
    for _, slab in SEXES:
        for src_lab, k in EDU_MAP.items():
            all25[G4[k]] += b15[f"Total!!{slab}!!{lab}!!{src_lab}"]
all25 = norm(all25, 6)
race_factor = {}
for r, t in [("white", "C15002H"), ("hispanic", "C15002I"), ("black", "C15002B"), ("asian", "C15002D")]:
    rows = us(t)
    g = {k: sum(rows[f"Total!!{slab}!!{k}"] for _, slab in SEXES) for k in all25}
    g = norm(g, 6)
    race_factor[r] = {e: round(g[G4[e]] / all25[G4[e]], 3) for e in EDU}
# « other » : moyenne pondérée inconnue ; facteur intermédiaire (AIAN, NHPI, multiracial)
race_factor["other"] = {"below_hs": 1.15, "high_school": 1.05, "some_college": 1.12, "associate": 1.12, "bachelor": 0.8, "graduate": 0.8}
write("education.json", table("us-education", "Plus haut diplôme par âge et sexe ; facteur par race et origine hispanique",
    {"labels": {"below_hs": "No high school diploma", "high_school": "High school diploma or GED", "some_college": "Some college, no degree", "associate": "Associate degree", "bachelor": "Bachelor's degree", "graduate": "Graduate or professional degree"},
     "byAgeSex": edu_bands, "raceFactor": race_factor},
    [S_B15001, S_C15002], 2024,
    notes="Tirage : P(diplôme | âge, sexe, race) ∝ P(diplôme | âge, sexe) (B15001) × facteur de la race (part du groupe de diplôme chez les 25 ans et plus de cette race / part chez tous les 25 ans et plus, C15002 ; même facteur pour « some college » et « associate », pour « bachelor » et « graduate »). Facteur du groupe « other » : hypothèse intermédiaire. Les 18-24 ans inscrits dans le supérieur sont comptés « some college »."))

# ─── Activité ────────────────────────────────────────────────────────────────
# CPS 2025 (table 3) : taux d'activité (LFPR) et taux d'emploi (EPOP), en %, par tranche et sexe
CPS = {  # tranche : (LFPR M, EPOP M, LFPR F, EPOP F)
    (18, 19): (49.3, 42.2, 48.9, 43.0), (20, 24): (73.2, 66.5, 69.5, 64.4), (25, 29): (87.8, 83.2, 77.8, 74.2), (30, 34): (91.0, 87.6, 78.0, 75.0),
    (35, 44): (90.7, 87.9, 78.2, 75.4), (45, 54): (87.9, 85.2, 77.3, 75.0), (55, 59): (80.6, 78.4, 69.5, 67.6), (60, 64): (63.8, 61.7, 53.9, 52.3),
    (65, 69): (38.1, 36.9, 28.9, 28.1), (70, 74): (22.3, 21.5, 15.7, 15.1), (75, 79): (14.0, 13.5, 8.8, 8.5),
}
# Inscrits (statut « student ») : CPS octobre 2024 (18-19 : 66,1 %, 20-21 : 51,1 %, 22-24 : 26,4 % ; hommes 40,5 %, femmes
# 49,2 % des 18-24) ; 25 ans et plus : inscrits dans le supérieur (B14004) sans emploi (35 % des inscrits, hypothèse)
b14 = us("B14004")
def enr_rate(slab, lab):
    e = b14[f"Total!!{slab}!!Enrolled in public college or graduate school!!{lab}"] + b14[f"Total!!{slab}!!Enrolled in private college or graduate school!!{lab}"]
    return e / (e + b14[f"Total!!{slab}!!Not enrolled in college or graduate school!!{lab}"])
enr25 = {s: enr_rate(slab, "25 to 34 years") for s, slab in SEXES}
enr35 = {s: enr_rate(slab, "35 years and over") for s, slab in SEXES}
SEXF = {"M": 40.5 / 44.8, "F": 49.2 / 44.8}
def student_share(a, b, s):
    if b <= 19:
        return 0.661 * SEXF[s]
    if b <= 24:
        return (2 * 0.511 + 3 * 0.264) / 5 * SEXF[s]
    if b <= 29:
        return enr25[s] * 1.4 * 0.35
    if b <= 34:
        return enr25[s] * 0.6 * 0.35
    if b <= 44:
        return enr35[s] * 2.0 * 0.35
    if b <= 54:
        return enr35[s] * 1.0 * 0.35
    return enr35[s] * 0.25 * 0.35
act_rows, enr_rows = [], []
for (a, b), (lm, em, lf, ef) in CPS.items():
    row, er = {"from": a, "to": b}, {"from": a, "to": b}
    for s, L, E in (("M", lm, em), ("F", lf, ef)):
        L, E = L / 100, E / 100
        st = student_share(a, b, s)
        es, us_ = (0.42, 0.05) if b <= 24 else (0.0, 0.08)
        emp = (E - st * es) / (1 - st)
        une = max(0.0, (L - E - st * us_) / (1 - st))
        row[s] = {"employed": round(emp, 4), "unemployed": round(une, 4), "nilf": round(1 - emp - une, 4)}
        er[s] = round(st, 4)
    act_rows.append(row)
    enr_rows.append(er)
write("activity.json", table("us-activity", "Situation d'activité par âge et sexe (hors étudiants), études en cours, effet du diplôme, retraite",
    {"byAgeSex": act_rows, "enrolled": enr_rows, "enrolledEmployedShare": 0.42,
     "educationEmployment": {"below_hs": round(44.5 / 61.4, 3), "high_school": round(54.5 / 61.4, 3), "some_college": round(58.5 / 61.4, 3), "associate": round(63.2 / 61.4, 3), "bachelor": round(69.7 / 61.4, 3), "graduate": round(71.0 / 61.4, 3)},
     "educationEnrollment": {"below_hs": 0.9, "high_school": 0.55, "some_college": 1.6, "associate": 0.7, "bachelor": 0.7, "graduate": 1.0},
     "retiredShareOfNilf": [{"from": 18, "to": 49, "share": 0.01}, {"from": 50, "to": 54, "share": 0.12}, {"from": 55, "to": 59, "share": 0.35}, {"from": 60, "to": 64, "share": 0.62}, {"from": 65, "to": 69, "share": 0.92}, {"from": 70, "to": 79, "share": 0.97}]},
    [S_CPS03, S_CPS07, S_ENROLL, S_B14004], 2025, assumption=True,
    justification="Taux d'activité et d'emploi du CPS 2025 par âge et sexe (30-34 ans : interpolé entre 25-29 et 25-34 ; 75-79 ans : 75 ans et plus relevé de 65 %). Statut « student » : inscrits de 18 à 24 ans (CPS octobre 2024) ; à partir de 25 ans, inscrits dans le supérieur (ACS B14004) sans emploi, soit 35 % d'entre eux (hypothèse). Les 42 % d'étudiants de moins de 25 ans qui travaillent (petits emplois) sont retirés des actifs occupés pour garder le taux d'emploi publié. Effet du diplôme : rapport des taux d'emploi des 25 ans et plus par diplôme (CPS 2025, table 7), appliqué de 25 à 64 ans et renormalisé par âge et sexe. Part des retraités parmi les inactifs : hypothèse (BLS ne la publie pas ; ≈ 45 % des inactifs de 55-64 ans se disaient retraités dans les anciennes données ASEC, quasi tous après 65 ans).",
    notes="Le reste des inactifs (« inactive ») : foyer, soins à un proche, invalidité."))

# ─── Professions ─────────────────────────────────────────────────────────────
OCC = ["management", "business_finance", "computer_engineering_science", "education_legal_community_arts", "healthcare_practitioners", "service", "sales", "office_admin", "farming", "construction", "installation_repair", "production", "transportation"]
# CPS 2025 table 11 : effectifs (milliers) et part de femmes
CPS11 = {"management": [(20876, 41.8)], "business_finance": [(10173, 53.2)], "computer_engineering_science": [(6711, 27.5), (3675, 19.3), (1858, 49.4)],
         "education_legal_community_arts": [(2846, 69.0), (1880, 56.0), (9452, 74.4), (3504, 50.4)], "healthcare_practitioners": [(10364, 75.3)], "service": [(27230, 57.8)],
         "sales": [(14159, 47.4)], "office_admin": [(16444, 70.5)], "farming": [(1000, 26.8)], "construction": [(8490, 4.3)], "installation_repair": [(5060, 4.7)], "production": [(7889, 28.4)], "transportation": [(11881, 21.5)]}
occ_sex = {"M": {}, "F": {}}
for o, parts in CPS11.items():
    occ_sex["F"][o] = sum(n * w / 100 for n, w in parts)
    occ_sex["M"][o] = sum(n * (1 - w / 100) for n, w in parts)
# Diplôme par profession (hypothèse construite d'après BLS Employment Projections, table 5.3, agrégée) : parts
EDU_BY_OCC = {
    "management": [0.03, 0.14, 0.15, 0.08, 0.38, 0.22], "business_finance": [0.01, 0.08, 0.12, 0.08, 0.48, 0.23], "computer_engineering_science": [0.01, 0.05, 0.09, 0.07, 0.45, 0.33],
    "education_legal_community_arts": [0.01, 0.06, 0.09, 0.05, 0.37, 0.42], "healthcare_practitioners": [0.0, 0.04, 0.08, 0.20, 0.35, 0.33], "service": [0.16, 0.36, 0.22, 0.09, 0.13, 0.04],
    "sales": [0.07, 0.28, 0.22, 0.08, 0.28, 0.07], "office_admin": [0.05, 0.30, 0.25, 0.12, 0.23, 0.05], "farming": [0.35, 0.35, 0.14, 0.05, 0.09, 0.02], "construction": [0.22, 0.45, 0.17, 0.08, 0.07, 0.01],
    "installation_repair": [0.09, 0.42, 0.23, 0.14, 0.10, 0.02], "production": [0.16, 0.45, 0.18, 0.09, 0.10, 0.02], "transportation": [0.16, 0.45, 0.20, 0.07, 0.10, 0.02],
}
# P(occ | diplôme, sexe) ∝ P(occ | sexe) × P(diplôme | occ), puis ajustement itératif (IPF) pour retrouver P(occ | sexe)
# compte tenu du diplôme des actifs occupés (diplôme des 25-64 ans × effet du diplôme sur l'emploi)
edu_emp = {}
for s, slab in SEXES:
    d = {k: 0.0 for k in EDU}
    for lab in ["25 to 34 years", "35 to 44 years", "45 to 64 years"]:
        for src_lab, k in EDU_MAP.items():
            d[k] += b15[f"Total!!{slab}!!{lab}!!{src_lab}"]
    f = {"below_hs": 44.5, "high_school": 54.5, "some_college": 58.5, "associate": 63.2, "bachelor": 69.7, "graduate": 71.0}
    edu_emp[s] = norm({k: v * f[k] for k, v in d.items()}, 6)
by_edu_sex = {e: {} for e in EDU}
for s in ("M", "F"):
    target = norm(occ_sex[s], 6)
    w = {o: 1.0 for o in OCC}
    for _ in range(200):
        cond = {e: norm({o: target[o] * EDU_BY_OCC[o][i] * w[o] for o in OCC}, 8) for i, e in enumerate(EDU)}
        got = {o: sum(edu_emp[s][e] * cond[e][o] for e in EDU) for o in OCC}
        for o in OCC:
            w[o] *= target[o] / got[o]
    for e in EDU:
        by_edu_sex[e][s] = norm(cond[e], 4)
COW = {  # private, nonprofit, government, self_employed
    "management": (0.74, 0.07, 0.07, 0.12), "business_finance": (0.74, 0.06, 0.12, 0.08), "computer_engineering_science": (0.75, 0.05, 0.12, 0.08),
    "education_legal_community_arts": (0.22, 0.18, 0.48, 0.12), "healthcare_practitioners": (0.56, 0.27, 0.10, 0.07), "service": (0.66, 0.07, 0.18, 0.09),
    "sales": (0.80, 0.02, 0.01, 0.17), "office_admin": (0.70, 0.09, 0.17, 0.04), "farming": (0.62, 0.01, 0.05, 0.32), "construction": (0.66, 0.01, 0.07, 0.26),
    "installation_repair": (0.80, 0.02, 0.07, 0.11), "production": (0.89, 0.01, 0.03, 0.07), "transportation": (0.82, 0.01, 0.10, 0.07),
}
tot_occ = {o: occ_sex["M"][o] + occ_sex["F"][o] for o in OCC}
cow_tot = [sum(tot_occ[o] * COW[o][i] for o in OCC) / sum(tot_occ.values()) for i in range(4)]
write("occupation.json", table("us-occupation", "Grands groupes de professions (SOC 2018) par diplôme et sexe ; statut de l'emploi par profession",
    {"labels": {"management": "Manager", "business_finance": "Business and financial operations", "computer_engineering_science": "Computer, engineering or science occupation",
                "education_legal_community_arts": "Education, legal, community service, arts or media occupation", "healthcare_practitioners": "Healthcare practitioner or technician",
                "service": "Service worker (healthcare support, protective service, food service, cleaning, personal care)", "sales": "Sales worker", "office_admin": "Office and administrative support worker",
                "farming": "Farming, fishing or forestry worker", "construction": "Construction or extraction worker", "installation_repair": "Installation, maintenance or repair worker",
                "production": "Production worker", "transportation": "Transportation or material moving worker"},
     "byEducationSex": by_edu_sex, "classOfWorker": {o: dict(zip(["private", "nonprofit", "government", "self_employed"], COW[o])) for o in OCC}},
    [S_CPS11, S_C24010, S_B24080, S_CPS15], 2025, assumption=True,
    justification=f"Effectifs par profession et sexe : CPS 2025 (table 11), recopiés. Le croisement avec le diplôme n'est pas publié sous cette forme : P(profession | diplôme, sexe) ∝ P(profession | sexe) × P(diplôme | profession), où P(diplôme | profession) est une hypothèse agrégée d'après BLS Employment Projections (table 5.3 « educational attainment for workers 25 years and older by detailed occupation »), puis ajustement itératif pour retrouver les marges par sexe. Statut de l'emploi par profession : hypothèse calée sur les totaux (CPS 2025 : indépendants 6,0 % non constitués en société + 4,2 % en société, administrations 13,4 % ; ACS B24080 : associations ≈ 9 %) ; total du modèle : privé {cow_tot[0]:.1%}, associations {cow_tot[1]:.1%}, administrations {cow_tot[2]:.1%}, indépendants {cow_tot[3]:.1%}."))

# ─── Revenus ─────────────────────────────────────────────────────────────────
# Salaire hebdomadaire médian des temps plein (CPS 2025, table 39) : (effectif, tous, hommes, femmes)
CPS39 = {"management": [(15585, 1847, 2000, 1602)], "business_finance": [(8463, 1652, 1828, 1507)],
         "computer_engineering_science": [(6297, 2015, 2138, 1828), (3459, 1930, 2007, 1649), (1656, 1560, 1731, 1405)],
         "education_legal_community_arts": [(2234, 1252, 1356, 1225), (1463, 1933, 2687, 1592), (7535, 1250, 1467, 1172), (1853, 1413, 1501, 1348)],
         "healthcare_practitioners": [(7988, 1534, 1840, 1464)], "service": [(16040, 790, 891, 732)], "sales": [(9021, 1112, 1258, 906)], "office_admin": [(12812, 981, 1113, 945)],
         "farming": [(727, 729, 781, 656)], "construction": [(6364, 1096, 1105, 977)], "installation_repair": [(4273, 1180, 1185, 1091)], "production": [(6913, 969, 1034, 795)], "transportation": [(8788, 895, 940, 754)]}
UPRATE = 1232 / 1204  # médiane T3 2026 / moyenne 2025 (wkyeng)
SIGMA = 0.42
full_time = {}
for o, parts in CPS39.items():
    n = sum(p[0] for p in parts)
    m = sum(p[0] * p[2] for p in parts) / n
    f = sum(p[0] * p[3] for p in parts) / n
    full_time[o] = {"M": {"median": round(m * 52 / 12 * UPRATE), "sigma": SIGMA}, "F": {"median": round(f * 52 / 12 * UPRATE), "sigma": SIGMA}}
# Fichier de construction, hors du pack (il ne fait pas partie des tables tirées ni de l'empreinte du pack)
EARN_CAL_FILE = os.path.join(HERE, "..", "..", "docs", "research", "socle-us-data", "earnings-calibration.json")
EARN_CAL = json.load(open(EARN_CAL_FILE)) if os.path.exists(EARN_CAL_FILE) else {"scale": 1.0, "sigma": SIGMA, "lowerSigma": SIGMA}
for o in full_time:
    for s in ("M", "F"):
        full_time[o][s] = {"median": round(full_time[o][s]["median"] * EARN_CAL["scale"]), "sigma": EARN_CAL["sigma"]}
write("earnings.json", table("us-earnings", "Revenus mensuels bruts : salaires des temps plein par profession et sexe, effets de l'âge et du diplôme, temps partiel, retraites, allocations",
    {"fullTime": full_time, "lowerSigma": EARN_CAL["lowerSigma"],
     "ageFactor": [{"from": 18, "to": 19, "factor": 0.66}, {"from": 20, "to": 24, "factor": 0.76}, {"from": 25, "to": 34, "factor": 0.92}, {"from": 35, "to": 44, "factor": 1.04}, {"from": 45, "to": 54, "factor": 1.04}, {"from": 55, "to": 64, "factor": 1.02}, {"from": 65, "to": 79, "factor": 0.98}],
     "educationFactor": {"below_hs": 0.86, "high_school": 0.9, "some_college": 0.94, "associate": 0.98, "bachelor": 1.14, "graduate": 1.32},
     "partTime": {"M": 0.124, "F": 0.231, "incomeFactor": 0.42},
     "selfEmployedSigma": 0.6,
     "retired": {"below_hs": {"median": 1650, "sigma": 0.45}, "high_school": {"median": 2450, "sigma": 0.5}, "some_college": {"median": 2800, "sigma": 0.5}, "associate": {"median": 2900, "sigma": 0.5}, "bachelor": {"median": 3850, "sigma": 0.55}, "graduate": {"median": 4900, "sigma": 0.55}},
     "student": {"withIncomeShare": 0.42, "income": {"median": 1100, "sigma": 0.55}},
     "unemployed": {"withIncomeShare": 0.24, "income": {"median": 2170, "sigma": 0.25}},
     "inactive": {"withIncomeShare": 0.38, "income": {"median": 1250, "sigma": 0.35}}},
    [S_CPS39, S_WKYENG, S_EP, S_CPS08, S_ASEC, S_PINC08, S_SSA, S_DOL], 2026, assumption=True,
    justification=f"Médianes hebdomadaires des temps plein par profession et sexe (CPS 2025, table 39 ; groupes fusionnés pondérés par les effectifs) × 52/12, actualisées au 3e trimestre 2026 (× {UPRATE:.3f}, médiane de 1 232 $ par semaine) et recalées sur la distribution publiée (facteur {EARN_CAL['scale']}, dispersion {EARN_CAL['sigma']} au-dessus de la médiane et {EARN_CAL['lowerSigma']} au-dessous, la distribution publiée étant asymétrique : docs/research/socle-us-data/earnings-calibration.json, contrôlé par packs/us/calibrate.ts ; cible P10 / P50 / P90 = 634 / 1 232 / 2 919 $ par semaine, wkyeng T3 2026). Effets de l'âge et du diplôme à profession donnée : hypothèses déduites des médianes par âge (wkyeng table 3) et par diplôme (Education pays 2025), atténuées car une partie de l'écart passe par la profession. Temps partiel : 12,4 % des hommes et 23,1 % des femmes en emploi (CPS 2025, table 8), revenu ≈ 42 % d'un temps plein (hypothèse). Retraités : Social Security (2 086 $ en moyenne pour un retraité, juillet 2026), pensions et retraits de comptes (29 % et 18,5 % des 65 ans et plus, PINC-08) : médianes par diplôme en hypothèse, relevées de 5 % car l'ASEC sous-déclare les revenus de retraite (Census CES-WP-24-32) et les retraits d'épargne ne sont pas modélisés autrement. Chômeurs : 24 % indemnisés (DOL, T2 2026), 500 $ par semaine en moyenne. Inactifs : pensions d'invalidité (SSDI, SSI) pour 38 % (hypothèse)."))

# ─── Impôts, crédits, SNAP ──────────────────────────────────────────────────
def brackets(th):
    rates = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37]
    out = []
    for i, r in enumerate(rates):
        out.append({"upTo": th[i + 1] if i + 1 < len(th) else None, "rate": r})
    return out
write("tax.json", table("us-tax", "Impôt fédéral sur le revenu 2026, FICA, crédits d'impôt (CTC, EITC), seuil de pauvreté, SNAP",
    {"brackets": {"single": brackets([0, 12400, 50400, 105700, 201775, 256225, 640600]), "joint": brackets([0, 24800, 100800, 211400, 403550, 512450, 768700])},
     "standardDeduction": {"single": 16100, "joint": 32200, "headOfHousehold": 24150, "extra65": 1650, "seniorDeduction": 6000, "seniorPhaseOutSingle": 75000, "seniorPhaseOutJoint": 150000},
     "fica": {"socialSecurityRate": 0.062, "wageBase": 184500, "medicareRate": 0.0145, "additionalMedicareRate": 0.009, "additionalThresholdSingle": 200000, "additionalThresholdJoint": 250000, "selfEmployedFactor": 0.9235},
     "childTaxCredit": {"perChild": 2200, "refundableMax": 1700, "refundableRate": 0.15, "refundableFloor": 2500, "phaseOutSingle": 200000, "phaseOutJoint": 400000, "phaseOutRate": 0.05},
     "eitc": [
         {"children": 0, "phaseInRate": 0.0765, "earnedAmount": 8680, "maxCredit": 664, "phaseOutRate": 0.0765, "phaseOutSingle": 10860, "phaseOutJoint": 18140},
         {"children": 1, "phaseInRate": 0.34, "earnedAmount": 13020, "maxCredit": 4427, "phaseOutRate": 0.1598, "phaseOutSingle": 23890, "phaseOutJoint": 31160},
         {"children": 2, "phaseInRate": 0.40, "earnedAmount": 18290, "maxCredit": 7316, "phaseOutRate": 0.2106, "phaseOutSingle": 23890, "phaseOutJoint": 31160},
         {"children": 3, "phaseInRate": 0.45, "earnedAmount": 18290, "maxCredit": 8231, "phaseOutRate": 0.2106, "phaseOutSingle": 23890, "phaseOutJoint": 31160}],
     "poverty": {"base": 15960, "perPerson": 5680},
     "snap": {"maxAllotment": [306, 562, 808, 1023], "perExtraPerson": 225, "grossLimitPoverty": 1.3, "benefitReduction": 0.3, "standardDeduction": 217, "participation": 0.8}},
    [S_IRS, S_IRS_SENIOR, S_IRS_SE, S_HHS, S_SNAP, S_SNAP_RATE], 2026,
    notes="Barème 2026 (Rev. Proc. 2025-32, après l'OBBBA) : le barème « single » sert aussi aux chefs de famille (head of household), avec leur déduction standard. Déduction des seniors de 6 000 $ par personne de 65 ans et plus (2025-2028), réduite de 6 % du revenu au-delà de 75 000 / 150 000 $. Taux d'entrée et de sortie de l'EITC : taux légaux (IRC § 32). FICA des indépendants : 15,3 % de 92,35 % du revenu, sans la déduction de la moitié (approximation). SNAP FY2027 (depuis le 1er octobre 2026), règle simplifiée : revenu brut sous 130 % du seuil, allocation = maximum − 30 % du revenu net (déduction standard, 20 % des revenus du travail ; pas de déduction de logement) ; recours de 80 % (88 % des éligibles en 2022, effectifs en baisse en 2026). Ni impôt sur les plus-values, ni déductions détaillées, ni crédits des États."))

# ─── Ménage ──────────────────────────────────────────────────────────────────
b09 = us("B09021")
b12 = us("B12002")
def b09_share(band, cat):
    return b09[f"Total!!{band}!!{cat}"] / b09[f"Total!!{band}"]
B09 = {"18 to 34 years": (18, 34), "35 to 64 years": (35, 64), "65 years and over": (65, 79)}
def b09_band(a):
    for k, (x, y) in B09.items():
        if x <= a <= y:
            return k
# mariés (conjoint présent) par âge et sexe (B12002)
def married(slab, a, b):
    tot = sum(by_age(b12, f"Total!!{slab}!!{m}", [(a, b)])[0] for m in ["Never married", "Now married!!Married, spouse present", "Now married!!Married, spouse absent!!Separated", "Now married!!Married, spouse absent!!Other", "Divorced", "Widowed"])
    mar = by_age(b12, f"Total!!{slab}!!Now married!!Married, spouse present", [(a, b)])[0]
    return mar / tot
# gradients au sein des tranches de B09021 (hypothèses), renormalisés sur la tranche
WITH_PARENTS = {(18, 19): 0.78, (20, 24): 0.52, (25, 29): 0.25, (30, 34): 0.14, (35, 39): 0.085, (40, 44): 0.065, (45, 49): 0.05, (50, 54): 0.04, (55, 59): 0.03, (60, 64): 0.022, (65, 69): 0.004, (70, 74): 0.003, (75, 79): 0.002}
COHAB_W = {(18, 19): 0.35, (20, 24): 1.0, (25, 29): 1.45, (30, 34): 1.25, (35, 39): 1.3, (40, 44): 1.15, (45, 49): 1.0, (50, 54): 0.9, (55, 59): 0.8, (60, 64): 0.7, (65, 69): 1.2, (70, 74): 1.0, (75, 79): 0.7}
ALONE_W = {(18, 19): 0.15, (20, 24): 0.7, (25, 29): 1.25, (30, 34): 1.15, (35, 39): 0.75, (40, 44): 0.8, (45, 49): 0.9, (50, 54): 1.05, (55, 59): 1.25, (60, 64): 1.4, (65, 69): 0.8, (70, 74): 1.0, (75, 79): 1.3}
KIDS = {(18, 19): 0.3, (20, 24): 0.38, (25, 29): 0.48, (30, 34): 0.64, (35, 39): 0.75, (40, 44): 0.72, (45, 49): 0.58, (50, 54): 0.36, (55, 59): 0.15, (60, 64): 0.06, (65, 69): 0.02, (70, 74): 0.01, (75, 79): 0.01}
SINGLE_PARENT = {"F": {(18, 19): 0.02, (20, 24): 0.07, (25, 29): 0.11, (30, 34): 0.13, (35, 39): 0.13, (40, 44): 0.12, (45, 49): 0.09, (50, 54): 0.05, (55, 59): 0.02, (60, 64): 0.01, (65, 69): 0.005, (70, 74): 0.003, (75, 79): 0.002},
                 "M": {(18, 19): 0.003, (20, 24): 0.01, (25, 29): 0.02, (30, 34): 0.03, (35, 39): 0.035, (40, 44): 0.035, (45, 49): 0.03, (50, 54): 0.02, (55, 59): 0.01, (60, 64): 0.005, (65, 69): 0.002, (70, 74): 0.001, (75, 79): 0.001}}
def renorm(w, cat, which):
    """Gradient w par tranche, rapporté au niveau de la tranche de B09021 (moyenne pondérée par la population)."""
    out = {}
    for band_label, (x, y) in B09.items():
        bands = [b for b in BANDS if x <= b[0] and b[1] <= y]
        pops = [age_sex["M"][BANDS.index(b)] + age_sex["F"][BANDS.index(b)] for b in bands]
        mean = sum(w[b] * p for b, p in zip(bands, pops)) / sum(pops)
        lvl = b09_share(band_label, cat)
        for b in bands:
            out[b] = w[b] * lvl / mean
    return out
wp = renorm(WITH_PARENTS, "Child of householder", "wp")
cohab = renorm(COHAB_W, "Householder living with unmarried partner or unmarried partner of householder", "c")
alone = renorm(ALONE_W, "Lives alone", "a")
hh_rows = []
for b in BANDS:
    row = {"from": b[0], "to": b[1]}
    for s, slab in SEXES:
        mar = married(slab, b[0], b[1])
        couple = min(0.9, mar + cohab[b])
        kids = KIDS[b] if s == "F" else KIDS[(b[0], b[1])] * 0.85 if b[0] < 30 else KIDS[b]
        sp = SINGLE_PARENT[s][b]
        wpar = wp[b]
        al = alone[b] * (1.15 if (s == "F" and b[0] >= 65) else 0.85 if (s == "M" and b[0] >= 65) else 1)
        other = max(0.02, 1 - couple - sp - wpar - al)
        row[s] = norm({"alone": al, "couple_no_child": couple * (1 - kids), "couple_with_children": couple * kids, "single_parent": sp, "with_parents": wpar, "other": other})
    hh_rows.append(row)
b11 = us("B11005")
write("household.json", table("us-household", "Type de ménage par âge et sexe ; enfants ; mariage parmi les couples",
    {"types": hh_rows, "children": {"one": 0.41, "two": 0.37, "threePlus": 0.22}, "firstBirthAge": {"M": 30.0, "F": 27.5},
     "adultChildAtHome": [{"from": 18, "to": 39, "share": 0.0}, {"from": 40, "to": 44, "share": 0.12}, {"from": 45, "to": 49, "share": 0.25}, {"from": 50, "to": 54, "share": 0.32}, {"from": 55, "to": 59, "share": 0.3}, {"from": 60, "to": 64, "share": 0.22}, {"from": 65, "to": 69, "share": 0.13}, {"from": 70, "to": 79, "share": 0.07}],
     "sameEducationPartner": 0.6,
     "propertyIncome": {"base": 0.2, "olderBonus": 0.1, "incomeSlope": 0.15, "max": 0.75, "amount": {"median": 700, "sigma": 1.25}, "incomeElasticity": 1.3},
     "marriedShareOfCouples": [{"from": 18, "to": 24, "share": 0.35}, {"from": 25, "to": 29, "share": 0.55}, {"from": 30, "to": 34, "share": 0.7}, {"from": 35, "to": 44, "share": 0.82}, {"from": 45, "to": 64, "share": 0.9}, {"from": 65, "to": 79, "share": 0.95}]},
    [S_B09021, S_B12002, S_B11005], 2024, assumption=True,
    justification=f"Construit à partir de l'ACS 2024 : mariés avec conjoint présent par âge et sexe (B12002), puis, par tranche de B09021 (18-34, 35-64, 65 ans et plus), cohabitation hors mariage, vie seule et vie chez ses parents (« child of householder » : {b09_share('18 to 34 years', 'Child of householder'):.1%} des 18-34 ans), répartis entre les tranches de 5 ans selon des gradients d'âge en hypothèse et recalés sur le niveau de chaque tranche. Enfants de moins de 18 ans au foyer selon l'âge (hypothèse ; {b11['Total!!Households with one or more people under 18 years'] / b11['Total']:.1%} des ménages ont un mineur, B11005), familles monoparentales en hypothèse (surtout des mères). Nombre d'enfants : 41 / 37 / 22 % (1, 2, 3 et plus), âge moyen à la première naissance 27,5 ans (CDC). « other » : colocation, autres membres de la famille. Enfant adulte (18-34 ans) au foyer de couples et de parents seuls de 40 ans et plus : hypothèse calée sur les {b09['Total!!Child of householder'] / 1e6:.1f} millions d'adultes « child of householder » (B09021). Homogamie : 60 % des conjoints ont le diplôme de la persona (hypothèse). Revenus du patrimoine (intérêts, dividendes, loyers) : probabilité croissante avec l'âge et le revenu, montant log-normal très dispersé (hypothèses calées sur la distribution du revenu des ménages, CPS ASEC 2026)."))

# ─── Logement ────────────────────────────────────────────────────────────────
b25007 = us("B25007")
def own_share(labs):
    o = sum(b25007[f"Total!!Owner occupied!!Householder {l}"] for l in labs)
    r = sum(b25007[f"Total!!Renter occupied!!Householder {l}"] for l in labs)
    return round(o / (o + r), 3)
owner_by_age = [{"from": 18, "to": 24, "share": own_share(["15 to 24 years"])}, {"from": 25, "to": 34, "share": own_share(["25 to 34 years"])}, {"from": 35, "to": 44, "share": own_share(["35 to 44 years"])},
                {"from": 45, "to": 54, "share": own_share(["45 to 54 years"])}, {"from": 55, "to": 59, "share": own_share(["55 to 59 years"])}, {"from": 60, "to": 64, "share": own_share(["60 to 64 years"])},
                {"from": 65, "to": 74, "share": own_share(["65 to 74 years"])}, {"from": 75, "to": 79, "share": own_share(["75 to 84 years"])}]
b25027 = us("B25027")
def mort(lab):
    w = b25027[f"Total!!Housing units with a mortgage!!Householder {lab}"]
    return round(w / (w + b25027[f"Total!!Housing units without a mortgage!!Householder {lab}"]), 3)
mortgage_by_age = [{"from": 18, "to": 34, "share": mort("15 to 34 years")}, {"from": 35, "to": 44, "share": mort("35 to 44 years")}, {"from": 45, "to": 54, "share": mort("45 to 54 years")},
                   {"from": 55, "to": 59, "share": mort("55 to 59 years")}, {"from": 60, "to": 64, "share": mort("60 to 64 years")}, {"from": 65, "to": 74, "share": mort("65 to 74 years")}, {"from": 75, "to": 79, "share": mort("75 years and over")}]
total_own = b25007["Total!!Owner occupied"] / b25007["Total"]
race_odds = {}
for r, t in [("white", "B25003H"), ("hispanic", "B25003I"), ("black", "B25003B"), ("asian", "B25003D")]:
    rows = us(t)
    p = rows["Total!!Owner occupied"] / rows["Total"]
    # cotes relatives atténuées (exposant 0,7) : une partie de l'écart passe par l'âge et le revenu, déjà modélisés
    race_odds[r] = round(((p / (1 - p)) / (total_own / (1 - total_own))) ** 0.7, 3)
race_odds["other"] = 0.8
b25032 = us("B25032")
def dw(t):
    p = f"Total!!{t}-occupied housing units!!"
    g = lambda *ls: sum(b25032[p + l] for l in ls)
    return norm({"single_family": g("1, detached"), "townhouse": g("1, attached"), "small_multifamily": g("2", "3 or 4"), "apartment": g("5 to 9", "10 to 19", "20 to 49", "50 or more"), "mobile_home": g("Mobile home", "Boat, RV, van, etc.")})
def lognormal_sigma(rows, prefix):
    """Écart-type logarithmique déduit de l'écart interquartile d'une distribution par tranches de montant."""
    bins = []
    for label, v in rows.items():
        if not label.startswith(prefix + "!!"):
            continue
        s = label[len(prefix) + 2:].replace(",", "").replace("$", "")
        m = re.match(r"(\d+) to (\d+)", s)
        if m:
            bins.append((float(m.group(1)), float(m.group(2)) + 1, v))
        elif s.startswith("Less than"):
            bins.append((0.0, float(re.findall(r"\d+", s)[0]), v))
        elif "or more" in s:
            lo = float(re.findall(r"\d+", s)[0])
            bins.append((lo, lo * 1.6, v))
    bins.sort()
    tot = sum(b[2] for b in bins)
    def q(f):
        acc = 0
        for lo, hi, v in bins:
            if acc + v >= f * tot:
                return lo + (hi - lo) * (f * tot - acc) / v
            acc += v
    return math.log(q(0.75) / q(0.25)) / 1.349, q(0.5)
rent_sigma_nat, rent_med = lognormal_sigma(us("B25063"), "Total!!With cash rent")
own_sigma_nat, own_med = lognormal_sigma(us("B25087"), "Total!!Housing units with a mortgage")
# dispersion entre États (médianes pondérées par les adultes), retirée de la dispersion nationale
def between(key):
    w = [(s["adults"], math.log(s[key])) for s in geo_states]
    tw = sum(x for x, _ in w)
    m = sum(x * y for x, y in w) / tw
    return math.sqrt(sum(x * (y - m) ** 2 for x, y in w) / tw)
# … et la part expliquée par le revenu (élasticité × écart-type du log du niveau de vie relatif, ≈ 0,6)
rent_sigma = round(math.sqrt(max(0.05, rent_sigma_nat ** 2 - between("medianGrossRent") ** 2 - (0.3 * 0.6) ** 2)), 3)
own_sigma = round(math.sqrt(max(0.05, own_sigma_nat ** 2 - between("ownerCostsMortgage") ** 2 - (0.45 * 0.6) ** 2)), 3)
b25063 = us("B25063")
write("housing.json", table("us-housing", "Statut d'occupation, prêts, type de logement et dispersion des coûts du logement",
    {"ownerByAge": owner_by_age, "ownerRaceOdds": race_odds, "ownerIncomeSlope": 0.75, "mortgageByAge": mortgage_by_age,
     "social": {"maxRelativeIncome": 0.55, "share": 0.3, "rentIncomeShare": 0.3, "minRent": 50},
     "noCashRent": round(b25063["Total!!No cash rent"] / b25063["Total"], 3),
     "dwellingByTenure": {"owner": dw("Owner"), "renter": dw("Renter")},
     "ruralDwellingFactor": {"single_family": 1.15, "townhouse": 0.5, "small_multifamily": 0.5, "apartment": 0.3, "mobile_home": 3.0},
     "dwellingCostFactor": {"single_family": 1.08, "townhouse": 1.0, "small_multifamily": 0.85, "apartment": 0.95, "mobile_home": 0.55},
     "mobileHomeIncomeExponent": 1.5,
     "rentSigma": rent_sigma, "ownerCostSigma": own_sigma, "incomeElasticity": 0.3, "ownerIncomeElasticity": 0.45, "maxCostShare": 0.5, "ruralCostFactor": 0.85},
    [S_B25007, S_B25027, S_B25003, S_B25032, S_B25063, S_B25087], 2024, assumption=True,
    justification=f"Propriétaires par âge du titulaire (B25007 ; {total_own:.1%} des ménages), prêts en cours par âge (B25027), type de logement par statut (B25032), part des locataires sans loyer (B25063) : recopiés. Cotes de propriété par race (B25003) atténuées (exposant 0,7), pente sur le niveau de vie (0,75 par log), ménages seuls, colocataires et ruraux : hypothèses calées sur la part de propriétaires. Mobile homes : poids divisé par (niveau de vie relatif)^1,5 (logement des ménages modestes), coût relatif 0,55 (maison individuelle 1,08, petit collectif 0,85 : hypothèses). Logement social ou bon de logement (≈ 4,5 millions de ménages aidés par HUD, ≈ 10 % des locataires) : 30 % des locataires dont le niveau de vie est inférieur à 0,55 fois la médiane, loyer de 30 % du revenu (règle HUD). Coûts : médiane de l'État (B25064, B25088) × (niveau de vie relatif)^0,3 (locataires) ou ^0,45 (propriétaires : le prix du logement acheté suit le revenu) × 0,85 en zone rurale, plafonné à 50 % du revenu brut du ménage, dispersion log-normale déduite de l'écart interquartile national (loyers {rent_sigma_nat:.2f}, mensualités {own_sigma_nat:.2f}) diminué de la dispersion entre États et de la part due au revenu.",
    notes="Les coûts de l'ACS comprennent l'énergie et l'eau (gross rent, selected monthly owner costs : prêt, taxe foncière, assurance, charges, énergie)."))

# ─── Assurance santé ─────────────────────────────────────────────────────────
# Couverture principale par âge (ACS 2024, B27010) : une seule couverture → elle ; combinaisons → employeur si
# l'employeur en fait partie, Medicare si Medicare en fait partie, autres combinaisons publiques → Medicaid,
# autres combinaisons (« other coverage combinations ») partagées entre employeur et Medicaid.
b27 = us("B27010")
def coverage(band):
    p = f"Total!!{band}!!"
    g = lambda l: b27.get(p + l, 0.0)
    one = p + "With one type of health insurance coverage!!"
    two = "With two or more types of health insurance coverage!!"
    c = {"employer": g("With one type of health insurance coverage!!With employer-based health insurance only") + g(two + "With employer-based and direct-purchase coverage") + g(two + "With employer-based and Medicare coverage") + g(two + "Other private only combinations"),
         "marketplace": g("With one type of health insurance coverage!!With direct-purchase health insurance only"),
         "medicaid": g("With one type of health insurance coverage!!With Medicaid/means-tested public coverage only") + g(two + "Other public only combinations"),
         "medicare": g("With one type of health insurance coverage!!With Medicare coverage only") + g(two + "With Medicare and Medicaid/means-tested public coverage") + g(two + "With direct-purchase and Medicare coverage"),
         "military": g("With one type of health insurance coverage!!With TRICARE/military health coverage only") + g("With one type of health insurance coverage!!With VA Health Care only"),
         "uninsured": g("No health insurance coverage")}
    other = g(two + "Other coverage combinations")
    c["employer"] += other * 0.5
    c["medicaid"] += other * 0.5
    return norm(c)
# 65 ans et plus : le modèle les met tous sous Medicare (99 % ont une couverture, Medicare presque toujours) : pas de contrôle
HEALTH_VALIDATION = {"19-34": coverage("19 to 34 years"), "35-64": coverage("35 to 64 years")}
write("health.json", table("us-health", "Couverture santé principale, primes et reste à charge",
    {"labels": {"employer": "employer-sponsored health plan", "marketplace": "individual plan bought on the ACA Marketplace or directly", "medicaid": "Medicaid", "medicare": "Medicare", "military": "TRICARE or VA health care", "uninsured": "no health insurance"},
     "employerFullTime": 0.8, "employerPartTime": 0.24, "employerSelfEmployed": 0.12, "employerIncomeSlope": 0.1, "spouseCoverage": 0.78, "parentsPlanUnder26": 0.6,
     "medicaidTakeUp": 0.95, "medicaidNonExpansion": 0.45, "medicaidMaxPoverty": 1.9, "marketplace": 0.4, "military": 0.035, "retireeEmployer": 0.35,
     "premium": {"employer": 120, "marketplace": 178, "medicaid": 0, "medicare": 225, "military": 25, "uninsured": 0},
     "familyPremiumExtra": 350,
     "outOfPocket": {"employer": 110, "marketplace": 150, "medicaid": 15, "medicare": 140, "military": 40, "uninsured": 95},
     "validation": HEALTH_VALIDATION},
    [S_P60_291, S_B27010, S_KFF_EHBS, S_KFF_ACA, S_CMS_MED, S_NHE, S_KFF_EXP], 2025, assumption=True,
    justification="Modèle de couverture : Medicare à 65 ans ; assurance de l'employeur pour 76 % des salariés à temps plein et 24 % des temps partiel (KFF 2025 : 80 % des salariés éligibles, 76 % d'entre eux souscrivent), modulée par le revenu ; conjoint couvert par le plan de l'autre ; jeunes de moins de 26 ans par celui des parents ; Medicaid sous 138 % du seuil de pauvreté dans les 41 États qui l’ont étendu (le modèle retient 190 % du seuil mensuel, les revenus fluctuant dans l’année et les personnes handicapées, enceintes ou parents ayant des plafonds plus hauts ; recours 95 %), moins souvent ailleurs (45 %, parents et invalides surtout) ; Marketplace ; sinon sans assurance. Probabilités calées sur l'ACS 2024 (B27010) et le rapport P60-291 (2025 : 11,0 % des 19-64 ans sans assurance, 14,5 % des 19-25 ans). Coûts mensuels : cotisation salariale moyenne 120 $ (1 440 $ par an, famille 6 850 $, KFF 2025), prime nette moyenne Marketplace 178 $ en 2026 après la fin des aides renforcées (KFF), Medicare 225 $ (Part B 202,90 $ ; Medicare Advantage 14 $ en moyenne pour 55 % des bénéficiaires, Part D 34,50 $ ou Medigap pour les autres), reste à charge moyen ≈ 1 632 $ par personne et par an (CMS NHE 2024) réparti selon la couverture (franchise moyenne de 1 886 $ chez l'employeur, 3 786 $ au Marketplace)."))

# ─── Dépenses ────────────────────────────────────────────────────────────────
write("costs.json", table("us-costs", "Dépenses courantes, voitures, garde d'enfants, prêts étudiants",
    {"foodPerUc": 450, "otherCurrentPerUc": 330, "transitPerUc": 60, "currentIncomeElasticity": 0.5,
     "noVehicle": {"owner": round(2879504 / 86635506, 3), "renter": round(8431169 / 46101640, 3), "ruralFactor": 0.5},
     "secondVehicle": 0.65, "vehicleRunning": {"median": 240, "sigma": 0.35}, "carLoan": {"share": 0.42, "payment": {"median": 560, "sigma": 0.35}},
     "childcare": {"share": 0.55, "monthly": {"median": 1000, "sigma": 0.4}},
     "studentLoan": {"byAge": [{"from": 18, "to": 29, "share": 0.25}, {"from": 30, "to": 44, "share": 0.22}, {"from": 45, "to": 59, "share": 0.15}, {"from": 60, "to": 79, "share": 0.05}],
                     "educationFactor": {"below_hs": 0.1, "high_school": 0.45, "some_college": 1.2, "associate": 1.2, "bachelor": 1.35, "graduate": 1.7}, "payment": {"median": 300, "sigma": 0.5}},
     "withParentsContribution": 0.15, "roommateRentShare": 0.55},
    [S_CE, S_B25044, S_EXPERIAN, S_SHED, S_FSA], 2024, assumption=True,
    justification="Dépenses moyennes de l'enquête Consumer Expenditure 2024 (BLS) ramenées à l'adulte-équivalent (2,4 personnes par ménage, ≈ 1,75 adulte-équivalent) : alimentation 10 169 $ par an et par ménage (à domicile 6 224, au dehors 3 945) → ≈ 480 $ par mois et par adulte-équivalent en moyenne, 450 $ retenus (les ménages aisés, plus dépensiers, pèsent sur la moyenne) ; dépenses courantes hors logement, santé, transport, téléphone et abonnements (entretien du foyer, équipement, habillement, soins, loisirs hors audiovisuel, divers) ≈ 13 000 $ par ménage, dont environ la moitié retenue comme contrainte → 330 $ ; élasticité au niveau de vie 0,5 (le quintile du haut dépense 2 à 4 fois plus que celui du bas). Voitures : ménages sans voiture (B25044 : 3,3 % des propriétaires, 18,3 % des locataires ; moitié moins en zone rurale), coût d'usage par véhicule (essence 2 411, entretien 984, assurance 1 993 $ par ménage et par an, 1,9 véhicule) ≈ 240 $ par mois, prêt auto pour 42 % des ménages motorisés, mensualité médiane 560 $ (Experian T2 2026 : 765 $ neuf, 542 $ occasion). Garde d'enfants de moins de 5 ans quand tous les adultes travaillent : 55 % paient, ≈ 1 000 $ par mois (hypothèse). Prêts étudiants : 25 % des 18-29 ans, 22 % des 30-44 ans, 15 % des 45-59 ans, 5 % des 60 ans et plus (SHED 2025), modulés par le diplôme ; 45 % des emprunteurs n'ont pas de mensualité à payer (SHED 2025) ; mensualité médiane ≈ 300 $ (hypothèse, aucune statistique officielle)."))

# ─── Numérique ───────────────────────────────────────────────────────────────
write("digital.json", table("us-digital", "Équipement et usages numériques par âge (adultes)",
    {"bands": [
        {"from": 18, "to": 29, "smartphone": 0.97, "computer": 0.8, "tablet": 0.45, "internet": 0.74, "socialDaily": 0.86, "socialAny": 0.96},
        {"from": 30, "to": 49, "smartphone": 0.97, "computer": 0.84, "tablet": 0.6, "internet": 0.83, "socialDaily": 0.78, "socialAny": 0.93},
        {"from": 50, "to": 64, "smartphone": 0.91, "computer": 0.8, "tablet": 0.55, "internet": 0.83, "socialDaily": 0.64, "socialAny": 0.86},
        {"from": 65, "to": 79, "smartphone": 0.81, "computer": 0.7, "tablet": 0.5, "internet": 0.73, "socialDaily": 0.45, "socialAny": 0.7}]},
    [S_PEW_MOBILE, S_PEW_BB, S_PEW_SM], 2026, assumption=True,
    justification="Smartphone (97 / 97 / 91 / 79 %) et abonnement internet à domicile (74 / 83 / 83 / 71 %) par âge : Pew 2026 (les 65 ans et plus sont portés à 81 % et 73 % pour les 65-79 ans, plus équipés que les 80 ans et plus). Ordinateur et tablette par âge : hypothèses (Pew ne les publie plus ; ACS 2021 : 81 % des ménages ont un ordinateur, 64 % une tablette). Réseaux sociaux : hypothèses d'après Pew 2025-2026 (YouTube 95 / 91 / 85 / 65 %, Facebook 69 / 78 / 71 / 59 %, Instagram 79 / 64 / 41 / 21 % ; en ligne « presque constamment » 63 / 54 / 33 / 14 %)."))

# ─── Abonnements ─────────────────────────────────────────────────────────────
def item(id_, cat, offers, household, pen, el, basis, requires=None, requires_item=None):
    it = {"id": id_, "category": cat, "household": household, "incomeElasticity": el, "basis": basis,
          "penetration": [{"from": 18, "to": 29, "p": pen[0]}, {"from": 30, "to": 49, "p": pen[1]}, {"from": 50, "to": 64, "p": pen[2]}, {"from": 65, "to": 79, "p": pen[3]}],
          "offers": [{"name": n, "monthlyEur": p, "weight": w} for n, p, w in offers]}
    if requires:
        it["requires"] = requires
    if requires_item:
        it["requiresItem"] = requires_item
    return it
SUBS = [
    item("mobile", "mobile", [("Prepaid or low-cost carrier plan (Mint, Visible, Cricket)", 30, 0.3), ("Unlimited plan from a major carrier (T-Mobile, Verizon, AT&T)", 75, 0.55), ("Premium unlimited plan", 95, 0.15)], False, (0.97, 0.97, 0.95, 0.9), 0.0,
         "prix relevés (US Mobile, 2026 : MVNO 15-45 $, forfaits illimités des opérateurs 55-105 $ par ligne) ; répartition en hypothèse, cohérente avec 113 $ de téléphonie mobile par ménage et par mois (CE 2024)"),
    item("internet", "internet", [("Home broadband (cable or DSL)", 65, 0.5), ("Fiber home internet", 75, 0.3), ("Basic home internet", 50, 0.2)], True, (0.99, 0.99, 0.99, 0.99), 0.1,
         "prix moyen 81 $ équipement compris (BroadbandNow 2026) ; détenu par les foyers qui ont internet à domicile", requires="internet"),
    item("netflix", "video", [("Netflix Standard with ads", 8.99, 0.4), ("Netflix Standard", 19.99, 0.45), ("Netflix Premium", 26.99, 0.15)], True, (0.6, 0.65, 0.58, 0.42), 0.3,
         "prix sourcés (mars 2026) ; détention par foyer en hypothèse, sous l'usage déclaré (72 % des adultes regardent Netflix, comptes partagés compris : Pew 2025)", requires="internet"),
    item("prime", "shopping", [("Amazon Prime (annual plan)", 11.58, 0.7), ("Amazon Prime (monthly)", 14.99, 0.3)], True, (0.55, 0.65, 0.6, 0.45), 0.3,
         "prix sourcés (139 $ par an ou 14,99 $ par mois) ; détention en hypothèse (201 millions de membres, CIRP 2025 ; Prime Video regardé par 67 % des adultes, Pew 2025)"),
    item("disney", "video", [("Disney+ and Hulu bundle with ads", 12.99, 0.5), ("Disney+ with ads", 12.49, 0.3), ("Disney+ and Hulu Premium bundle", 21.99, 0.2)], True, (0.45, 0.5, 0.35, 0.2), 0.3,
         "prix sourcés (septembre 2026) ; détention en hypothèse (Disney+ regardé par 48 %, Hulu par 52 % des adultes, Pew 2025)", requires="internet"),
    item("max", "video", [("HBO Max Basic with ads", 10.99, 0.5), ("HBO Max Standard", 18.49, 0.5)], True, (0.3, 0.32, 0.25, 0.15), 0.3,
         "prix relevés (octobre 2025, non officiels) ; détention en hypothèse (Max regardé par 41 % des adultes, Pew 2025)", requires="internet"),
    item("peacock_paramount", "video", [("Peacock Premium", 12.99, 0.5), ("Paramount+ Essential", 8.99, 0.5)], True, (0.3, 0.32, 0.28, 0.2), 0.2,
         "prix relevés (Peacock août 2026, Paramount+ janvier 2026) ; détention en hypothèse (41 % et 44 % des adultes les regardent, Pew 2025)", requires="internet"),
    item("paytv", "pay TV", [("Cable or satellite TV package", 125, 0.8), ("YouTube TV", 82.99, 0.2)], True, (0.15, 0.23, 0.42, 0.6), 0.1,
         "abonnement câble ou satellite : 16 / 23 / 44 / 64 % des adultes par âge (Pew 2025) ; facture médiane 125 $ (doxo 2026), YouTube TV 82,99 $"),
    item("music", "music", [("Spotify Premium", 12.99, 0.5), ("Spotify Premium Student", 6.99, 0.1), ("Spotify Premium Family", 21.99, 0.15), ("Apple Music", 11.99, 0.25)], False, (0.42, 0.32, 0.17, 0.06), 0.3,
         "prix sourcés (Spotify février 2026, Apple Music juillet 2026) ; 51 % des 13 ans et plus paient un abonnement audio (Edison 2025), 112 millions d'abonnés à la musique en streaming (MusicWatch 2025) : détention individuelle en hypothèse", requires="smartphone"),
    item("youtube", "video", [("YouTube Premium", 15.99, 0.8), ("YouTube Premium Family", 26.99, 0.2)], False, (0.12, 0.1, 0.06, 0.03), 0.3,
         "prix relevés (avril 2026) ; détention en hypothèse", requires="internet"),
    item("cloud", "cloud storage", [("iCloud+ 50 GB", 0.99, 0.45), ("iCloud+ 200 GB", 2.99, 0.35), ("iCloud+ 2 TB", 9.99, 0.1), ("Google One 100 GB", 1.99, 0.1)], False, (0.45, 0.45, 0.33, 0.18), 0.2,
         "prix sourcés (Apple) ; détention en hypothèse (≈ la moitié des smartphones sont des iPhone)", requires="smartphone"),
    item("office", "software", [("Microsoft 365 Personal", 9.99, 0.5), ("Microsoft 365 Family", 12.99, 0.5)], False, (0.08, 0.12, 0.12, 0.1), 0.4,
         "prix sourcés (Microsoft) ; détention en hypothèse", requires="internet"),
    item("ai", "AI assistant", [("ChatGPT Plus", 20, 0.7), ("Google AI Pro", 19.99, 0.15), ("Claude Pro", 20, 0.15)], False, (0.1, 0.07, 0.04, 0.01), 0.6,
         "prix relevés (2026) ; moins de 10 % des adultes paient un assistant d'IA (Epoch AI, fin 2025 ; 4,6 % pour OpenAI), usage de ChatGPT 61 / 55 / 37 / 19 % par âge (Pew 2026) : détention en hypothèse"),
    item("gaming", "gaming", [("Xbox Game Pass Premium", 14.99, 0.35), ("Xbox Game Pass Ultimate", 22.99, 0.2), ("PlayStation Plus Essential", 10.99, 0.45)], False, (0.18, 0.13, 0.05, 0.01), 0.3,
         "prix relevés (avril et mai 2026) ; détention en hypothèse"),
    item("delivery", "delivery", [("DoorDash DashPass", 9.99, 0.4), ("Uber One", 9.99, 0.35), ("Instacart+", 9.99, 0.1), ("Walmart+", 12.95, 0.15)], False, (0.2, 0.18, 0.1, 0.04), 0.5,
         "prix relevés (2026) ; détention en hypothèse", requires="smartphone"),
    item("gym", "fitness", [("Planet Fitness Classic", 15, 0.35), ("Planet Fitness Black Card", 24.99, 0.25), ("Gym membership", 55, 0.4)], False, (0.33, 0.27, 0.22, 0.18), 0.6,
         "26,1 % des 6 ans et plus sont membres d'une salle (35,5 % des 18-24 ans, HFA 2026) ; prix Planet Fitness relevés, salle classique en hypothèse"),
    item("news", "news", [("New York Times digital subscription", 25, 0.4), ("Local newspaper digital subscription", 15, 0.35), ("Wall Street Journal digital subscription", 39, 0.25)], False, (0.1, 0.13, 0.17, 0.2), 0.6,
         "16 % des internautes ont payé pour de l'information en ligne (Reuters Institute 2026) ; prix relevés ou en hypothèse", requires="internet"),
]
write("subscriptions.json", table("us-subscriptions", "Abonnements courants aux États-Unis : prix mensuels en $ (hors taxes) et taux de détention par âge",
    {"items": SUBS},
    [S_NETFLIX, S_DISNEY, S_PEACOCK, S_SPOTIFY, S_ICLOUD, S_M365, S_CLAUDE, S_PEW_STREAM, S_PEW_AI, S_HFA, S_REUTERS, S_DELOITTE, S_BROADBAND, S_MOBILE, S_CE], 2026, assumption=True,
    justification="Prix relevés en 2026 sur les sites des services ou dans la presse spécialisée (docs/research/socle-us.md § 9). Les taux de détention par service ne sont pas publiés de façon officielle : hypothèses ancrées sur l'usage déclaré (Pew 2025), les effectifs d'abonnés publiés et la dépense de streaming (76 $ par mois par foyer abonné, Deloitte 2026). Le champ « monthlyEur » porte le montant dans la devise du pack (USD), nom de champ historique."))

# ─── Psychographie (même modèle que la France et Singapour) ────────────────
sg_psy = json.load(open(os.path.join(HERE, "..", "sg", "psychographics.json"), encoding="utf-8"))
write("psychographics.json", table("us-psychographics", "Traits psychographiques : profil d'adoption, sensibilité au prix, scepticisme, tonalité des récits",
    sg_psy["data"], [S_ROGERS, S_PEW_MOBILE], assumption=True,
    justification="Mêmes paramètres que les socles France et Singapour (socle commun, packs/fr/psychographics.json), faute de mesure américaine comparable : parts de Rogers 2,5 / 13,5 / 34 / 34 / 16 %, latente techno décroissante avec l'âge et croissante avec le niveau de vie, sensibilité au prix décroissante avec le niveau de vie et croissante avec la tension budgétaire. Libellés des tonalités en anglais (repris du socle Singapour). À recalibrer."))
print("tables écrites")
