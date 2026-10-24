#!/usr/bin/env python3
"""
Noms d'usage du socle États-Unis (packs/us/first-names.json et packs/us/surnames.json), construits à partir de
trois sources publiques, sans liste écrite à la main :
  1. SSA, prénoms des cartes de Social Security par année de naissance et sexe (fichiers yobAAAA.txt de
     « Baby Names from Social Security Card Applications - National Data », 1946-2008) ;
  2. Tzioumis (2018), « Demographic aspects of first names » (Harvard Dataverse, doi:10.7910/DVN/TYJKEZ) :
     part de chaque groupe (Hispanic, White, Black, API, AIAN, 2+ races) parmi les adultes portant ce prénom ;
  3. Census Bureau, « Frequently Occurring Surnames from the 2010 Census » (même découpage par groupe).
Prénom d'une génération et d'un groupe : poids SSA de la génération × part du groupe pour ce prénom (règle de Bayes :
P(prénom | groupe, génération) ∝ P(prénom | génération) × P(groupe | prénom)). Personnes nées à l'étranger (Hispanic,
Asian) : effectifs adultes de Tzioumis × part du groupe (prénoms donnés hors des États-Unis, absents des fichiers SSA).
Nom de famille : effectif du recensement 2010 × part du groupe.
Usage : python3 -I packs/us/build-names.py <dossier yob*.txt> <firstnames.csv (Tzioumis)> <Names_2010Census.csv>
"""
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SSA_DIR, TZ, SUR = sys.argv[1], sys.argv[2], sys.argv[3]
COHORTS = [(1946, 1955), (1956, 1965), (1966, 1975), (1976, 1985), (1986, 1995), (1996, 2008)]
GROUPS = {"white": ["pctwhite"], "black": ["pctblack"], "hispanic": ["pcthispanic"], "asian": ["pctapi"], "other": ["pctaian", "pct2prace"]}
TOP_FIRST = 80
TOP_FOREIGN = 150
TOP_SUR = 250

def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0  # « (S) » : valeur masquée du recensement

# SSA : effectifs par prénom, sexe, cohorte ; part féminine sur toute la période
ssa = {}
sex_tot = {}
for (a, b) in COHORTS:
    for y in range(a, b + 1):
        with open(os.path.join(SSA_DIR, f"yob{y}.txt"), encoding="utf-8") as f:
            for line in f:
                name, sex, n = line.strip().split(",")
                key = (a, sex)
                ssa.setdefault(key, {})
                ssa[key][name.upper()] = ssa[key].get(name.upper(), 0) + int(n)
                st = sex_tot.setdefault(name.upper(), {"F": 0, "M": 0})
                st[sex] += int(n)
display_first = {}
for (a, sex), d in ssa.items():
    pass
# casse d'origine (SSA) : « Mary », « DeShawn »
for y in (1960, 1985, 2000):
    with open(os.path.join(SSA_DIR, f"yob{y}.txt"), encoding="utf-8") as f:
        for line in f:
            name = line.split(",")[0]
            display_first.setdefault(name.upper(), name)

tz = {}
with open(TZ, encoding="utf-8") as f:
    for r in csv.DictReader(f):
        tz[r["firstname"].strip().upper()] = {k: num(r[k]) / 100 for k in ["pctwhite", "pctblack", "pcthispanic", "pctapi", "pctaian", "pct2prace"]} | {"obs": num(r["obs"])}

def first_display(n):
    return display_first.get(n, n.capitalize())

def top(weights, k):
    items = sorted(((n, w) for n, w in weights.items() if w > 0), key=lambda x: -x[1])[:k]
    if not items:
        return []
    m = items[0][1]
    return [[first_display(n), round(w / m * 100, 2)] for n, w in items]

cohorts = []
for g, cols in GROUPS.items():
    for sex in ("M", "F"):
        for (a, b) in COHORTS:
            w = {}
            for n, c in ssa[(a, sex)].items():
                t = tz.get(n)
                if not t:
                    continue
                share = sum(t[c2] for c2 in cols)
                w[n] = c * share
            cohorts.append({"birthFrom": 1900 if a == COHORTS[0][0] else a, "birthTo": 2010 if b == COHORTS[-1][1] else b, "sex": sex, "group": g, "names": top(w, TOP_FIRST)})
    if g in ("hispanic", "asian"):
        for sex in ("M", "F"):
            w = {}
            for n, t in tz.items():
                st = sex_tot.get(n)
                if not st or st[sex] < 0.9 * (st["F"] + st["M"]):
                    continue  # prénom mixte ou absent des fichiers SSA : sexe incertain
                w[n] = t["obs"] * sum(t[c2] for c2 in cols)
            cohorts.append({"birthFrom": 1900, "birthTo": 2010, "sex": sex, "group": f"{g}_foreign_born", "names": top(w, TOP_FOREIGN * (3 if g == "asian" else 1))})

S_SSA = {"org": "Social Security Administration", "title": "Baby Names from Social Security Card Applications - National Data (yob1946-yob2008)", "year": 2024, "url": "https://www.ssa.gov/oact/babynames/limits.html", "detail": "fichiers yobAAAA.txt (copie identique publiée dans github.com/wesm/pydata-book, datasets/babynames : ssa.gov refuse les téléchargements automatisés)"}
S_TZ = {"org": "Konstantinos Tzioumis (Harvard Dataverse)", "title": "Data for: Demographic aspects of first names (Scientific Data 5, 180025)", "year": 2018, "url": "https://doi.org/10.7910/DVN/TYJKEZ", "detail": "4 250 prénoms, part de chaque groupe parmi les adultes demandeurs de prêt immobilier (HMDA 2007-2010)"}
ASIAN_ORIGIN_WEIGHTS = {"south_asian": 5094694 + 624982 + 308332 + 259874 + 63896, "chinese": 4503523 + 299993, "filipino": 3262427, "vietnamese": 1981019, "korean": 1567452, "japanese": 751663,
                        "other": 21333453 - (5094694 + 624982 + 308332 + 259874 + 63896 + 4503523 + 299993 + 3262427 + 1981019 + 1567452 + 751663)}
S_SUR = {"org": "U.S. Census Bureau", "title": "Frequently Occurring Surnames from the 2010 Census", "year": 2016, "url": "https://www.census.gov/topics/population/genealogy/data/2010_surnames.html", "detail": "162 253 noms (100 occurrences et plus), part par groupe (pctwhite, pctblack, pctapi, pctaian, pct2prace, pcthispanic)"}


# ─── Origines asiatiques (hypothèse de rattachement des noms, sans statistique officielle) ───
# Un nom typique d'une origine est réservé aux personas de cette origine ; les noms non rattachés (prénoms
# anglais, noms de famille partagés comme Lee, Lim, Han) servent à toutes les origines.
ORIGIN_SURNAMES = {
    "chinese": "Chen Wang Li Zhang Liu Huang Zhao Wu Zhou Xu Sun Ma Zhu Hu Guo He Lin Luo Gao Liang Zheng Xie Tang Feng Deng Cao Peng Zeng Xiao Tian Dong Pan Yuan Cai Jiang Yu Du Ye Cheng Wei Su Ding Ren Shen Yao Fu Zhong Wong Chan Leung Chow Cheung Ng Tse Fong Mak Kwok Yee Louie Yip Lai Tsai Hsu Chang Chiu Chu Kuo Tseng Hung Hsieh Fung Tam Lau Yuen Szeto Chou Kao Hsiao Chien Chiang Tsang Yeung Kwan Tsui Lo Mok Choy Leong Chin Tan Teng Gu Qian Xia Bai Shi Hou Lei Long Duan Hao Kong Shao Mao Qiu Qin Jia Xue Yan Zou Wan Lui Toy Quan Woo Moy".split(),
    "korean": "Kim Park Choi Jung Kang Cho Yoon Jang Shin Oh Seo Kwon Hwang Ahn Yoo Hong Jeon Ko Moon Son Bae Baek Nam Shim Noh Ha Kwak Sung Cha Joo Min Ryu Na Chae Won Chun Pyo Jeong Lim Yun Rhee Byun Suh Paik Choe Chong".split(),
    "vietnamese": "Nguyen Tran Le Pham Huynh Hoang Phan Vu Vo Dang Bui Do Ngo Duong Truong Dinh Mai Ta Trinh Luong Doan Quach Thai Diep Tong Nong Kieu Luu Lieu Vuong Trieu Chau".split(),
    "south_asian": "Patel Singh Shah Kumar Sharma Gupta Reddy Desai Mehta Rao Jain Joshi Kaur Khan Ali Ahmed Hussain Iyer Nair Pillai Menon Agarwal Bhatt Chopra Malhotra Kapoor Verma Mishra Thakkar Trivedi Parikh Modi Amin Chandra Das Ghosh Banerjee Mukherjee Chatterjee Bose Sinha Srinivasan Krishnan Raman Subramanian Naidu Varghese Mathew Choudhury Chowdhury Rahman Hossain Begum Chaudhry Qureshi Siddiqui Syed Ahmad Hassan Iqbal Akhtar Malik Butt Mohammed Mohammad Shaikh Ansari Pandey Tiwari Yadav Chaudhary Bhatia Arora Sethi Sandhu Gill Dhillon Grewal Sidhu Bajwa Thapa Gurung Patil Kulkarni Deshpande Naik Prasad Murthy Narayan Venkatesh Ramesh Raju Babu Shetty Kamath Bhat Dutta Sen Roy Saha Paul Dey Basu Goswami Mahajan Bansal Goyal Mittal Garg Aggarwal Khanna Saxena Srivastava Tripathi Dubey Ahuja Bedi Chawla Dhawan Grover Kohli Luthra Oberoi Sachdev Suri Tandon Vohra Walia Batra Bhalla Chadha Kalra".split(),
    "filipino": "Santos Reyes Cruz Bautista Ocampo Mendoza Aquino Ramos Villanueva Castillo Domingo Mercado Pascual Manalo Soriano Tolentino Dizon Mariano Samson Rosales Agustin Sy Go Dela Cruz Delos Santos Macaraeg Manalang Pangilinan Dimaculangan Mangubat Abad Abella Bernardo Cabrera Corpuz Dumlao Esguerra Galang Ignacio Lacson Lagman Lualhati Magno Mallari Manuel Natividad Pagdanganan Panganiban Quiambao Rivera Salvador Tan Valencia Ventura Viray Yap".split(),
    "japanese": "Tanaka Yamamoto Nakamura Suzuki Watanabe Sato Takahashi Kobayashi Ito Kato Yoshida Yamada Sasaki Yamaguchi Matsumoto Inoue Kimura Hayashi Shimizu Yamasaki Mori Abe Ikeda Hashimoto Ishikawa Ogawa Okada Hasegawa Fujita Goto Kondo Murakami Endo Aoki Sakamoto Fujii Nishimura Fukuda Ota Miura Takeuchi Nakajima Okamoto Matsuda Nakano Harada Ono Tamura Takeda Ueda Morita Hara Shibata Sakai Kudo Yokoyama Miyazaki Uchida Takano Ando Higa Oshiro Kaneshiro Nakamoto Shimabukuro Arakaki Tamashiro Yamashita Kawamoto Nishimoto Miyamoto Fujimoto Okimoto Nakagawa Uyeda Hirano Kawakami".split(),
}
# Prénoms des personnes nées à l'étranger rattachés à une origine (les autres, souvent anglais, servent à toutes)
ORIGIN_FIRST = {
    "chinese": "Wei Hong Xin Ying Jing Ming Jun Yan Li Hui Mei Feng Hao Tao Bin Qing Xiao Yu Lei Jian Yong Hua Ping Gang Ling Xiaoyan Yi Chun Fang Juan Min Na Yun Zhen Jie Peng Qiang Bo Chao Rui Shan Ning Kai Lin Qi Hai Xiang Yang Liang Zhong Guang Wen Tian Jin Cheng".split(),
    "korean": "Young Soon Myung Sung Jong Kyung Jae Seung Hyun Eun Ji Hee Sang Kwang Byung Chong Jung Soo Yong Ok Hae Jin In Mi Kyu Jun Su Dong Ho Hye Seon Sook Ja Bok".split(),
    "vietnamese": "Thanh Minh Hung Tuan Duc Cuong Vinh Hoang Huy Trung Phong Quang Binh Tri Nam Son Long Hai Dung Khanh Thuy Ngoc Hanh Thu Trang Hang Lien Loan Nga Yen Huong Linh Phuong Hoa Hien Xuan Tam Tuyet Van Quan Tung Bao Hieu Thao Diep Nhung Oanh Hue Chau Uyen Kim Lan Mai Dao Nhan Thien Toan Kiet Nhi Vy Tien".split(),
    "south_asian": "Amit Anil Sunil Vijay Ravi Ramesh Suresh Ashok Deepak Rakesh Ajay Srinivas Anand Manish Ashish Manoj Arun Satish Sanjay Rajesh Raj Mahesh Rahul Vikram Sandeep Prakash Venkat Krishna Sameer Nitin Vinod Mohan Muhammad Mohammad Mohammed Abdul Syed Imran Asif Priya Jyoti Usha Asha Lakshmi Anita Sunita Neha Pooja Rekha Meena Shanti Kavita Sangeeta Geeta Rani Sushma Padma Radha Sita Nisha Divya Swati Archana Deepa Smita Shilpa Fatima Ayesha Nasreen Shabnam Parveen Rajendra Narendra Dinesh Naresh Mukesh Hemant Pradeep Rajiv Sanjeev Vivek Gaurav Kiran Sunil Vishal Harish Girish Jagdish Bharat Hari Gopal Shyam Ram Raju Babu Kumar Arvind Ashwin Karthik Siddharth Varun Rohit Ankit Sachin Pankaj Alok Amitabh Rupa Seema Uma Veena Vandana Manju Savita Kamala Indira Shobha Aruna Hema Leela Malini Nirmala Pushpa Sarita Shweta Sneha Anjali Ritu Preeti Rashmi Sapna".split(),
    "filipino": "Maria Jose Juan Rosa Carmen Ana Antonio Manuel Eduardo Ricardo Roberto Fernando Carlos Mario Ramon Ernesto Alfredo Armando Romeo Danilo Erlinda Corazon Zenaida Imelda Myrna Rodolfo Marites Maricel Rowena Arnel Jojo Rey Ferdinand Leonila Teresita Remedios Perla Nenita Lorna Gemma Marilou Evangeline Rosario Lourdes Rogelio Wilfredo Reynaldo Edgardo Rolando Virgilio Leonardo Florencio Teodoro Danica Mylene Marivic Jocelyn Josefina Felicidad Milagros Leticia Luzviminda Estrella Precious Divina Maribel Rodrigo Benigno".split(),
    "japanese": "Hiroshi Takashi Kenji Yuki Keiko Yoko Akiko Kazuo Masao Tomoko Naoko Mariko Satoshi Kenichi Hideo Yoshiko Michiko Sachiko Noriko Kiyoshi Makoto Shigeru Tadashi Toshio Hiroko Emiko Fumiko Kazuko Masako Reiko Junko Yumiko Ayako Haruki Daisuke Ryo Taro Akira Osamu".split(),
}
ASIAN_ORIGINS = ["south_asian", "chinese", "filipino", "vietnamese", "korean", "japanese", "other"]
# Noms partagés entre origines (romanisations communes) ; noms hmong : « other »
SHARED_SURNAMES = {"LEE": ["chinese", "korean", "other"], "YANG": ["chinese", "korean", "other"], "LAM": ["chinese", "vietnamese"], "HO": ["chinese", "vietnamese", "korean"],
                   "CHUNG": ["korean", "chinese"], "LU": ["chinese", "vietnamese"], "LY": ["vietnamese", "chinese"], "HAN": ["korean", "chinese"], "SONG": ["korean", "chinese"],
                   "LIM": ["korean", "chinese", "filipino"], "TAN": ["chinese", "filipino"], "CHANG": ["chinese", "korean", "other"], "LIN": ["chinese"], "TRUONG": ["vietnamese"],
                   "VANG": ["other"], "XIONG": ["other"], "THAO": ["other"], "LOR": ["other"], "MOUA": ["other"], "HER": ["other"], "VUE": ["other"], "KHANG": ["other"], "YANG ": ["other"]}
# Prénoms anglais ou non rattachés : poids relatif dans chaque origine (les Philippins portent surtout des prénoms
# anglais ou espagnols, les Sud-Asiatiques nés à l'étranger surtout des prénoms indiens, pakistanais ou bangladais)
UNTAGGED_FIRST_WEIGHT = {"south_asian": 0.08, "chinese": 0.35, "filipino": 1.0, "vietnamese": 0.35, "korean": 0.35, "japanese": 0.35, "other": 1.0}
sur_origin = {n.upper().replace(" ", ""): [o] for o, ns in ORIGIN_SURNAMES.items() for n in ns} | SHARED_SURNAMES
first_origin = {n.upper(): o for o, ns in ORIGIN_FIRST.items() for n in ns}
asian_fb = [c for c in cohorts if c["group"] == "asian_foreign_born"]
for c in asian_fb:
    for o in ASIAN_ORIGINS:
        keep = []
        for n, w in c["names"]:
            tag = first_origin.get(n.upper())
            if tag == o:
                keep.append([n, w])
            elif tag is None:
                keep.append([n, round(w * UNTAGGED_FIRST_WEIGHT[o], 3)])
        cohorts.append({**c, "group": f"asian_foreign_born:{o}", "names": keep})
cohorts = [c for c in cohorts if c["group"] != "asian_foreign_born"]

with open(os.path.join(HERE, "first-names.json"), "w", encoding="utf-8") as f:
    json.dump({
        "id": "us-first-names",
        "title": "Prénoms par groupe (race et origine hispanique), sexe, génération ; prénoms des personnes nées à l'étranger",
        "assumption": False,
        "sources": [S_SSA, S_TZ],
        "referenceYear": 2024,
        "notes": "Construit par packs/us/build-names.py. Poids : P(prénom | génération, sexe) (SSA) × P(groupe | prénom) (Tzioumis), 80 premiers prénoms par cohorte (150 pour les personnes nées à l'étranger), normalisés à 100 pour le premier. Groupes : white, black, hispanic, asian (API), other (AIAN et deux races ou plus). « hispanic_foreign_born », « asian_foreign_born:<origine> » : prénoms des adultes de ces groupes nés à l'étranger (effectifs Tzioumis, sexe déduit des fichiers SSA quand il est sûr à 90 % ; pour les Asian, prénoms rattachés à l'origine plus prénoms non rattachés à poids réduit, voir surnames.json). Le nom de famille vient de surnames.json.",
        "data": {"cohorts": cohorts},
    }, f, ensure_ascii=False, indent=0)
    f.write("\n")

# ─── Noms de famille ───
SPECIAL = {"OBRIEN": "O'Brien", "OCONNOR": "O'Connor", "ONEILL": "O'Neill", "OCONNELL": "O'Connell", "ODONNELL": "O'Donnell", "OBRYAN": "O'Bryan", "ONEAL": "O'Neal", "OHARA": "O'Hara", "DELACRUZ": "De La Cruz", "DELEON": "De Leon", "DELAROSA": "De La Rosa", "DEJESUS": "De Jesus", "DELOSSANTOS": "De Los Santos", "DELGADO": "Delgado", "VANDYKE": "Van Dyke", "LAROSE": "LaRose"}
def sur_display(n):
    if n in SPECIAL:
        return SPECIAL[n]
    if n.startswith("MC") and len(n) > 3:
        return "Mc" + n[2:].capitalize()
    return n.capitalize()

rows = []
with open(SUR, encoding="utf-8") as f:
    for r in csv.DictReader(f):
        if r["name"] == "ALL OTHER NAMES":
            continue
        rows.append(r)
        if len(rows) >= 60000:
            break
groups = {}
for g, cols in GROUPS.items():
    w = {r["name"]: num(r["count"]) * sum(num(r[c]) for c in cols) / 100 for r in rows}
    items = sorted(((n, x) for n, x in w.items() if x > 0), key=lambda x: -x[1])[:TOP_SUR]
    m = items[0][1]
    if g == "asian":
        # 600 premiers noms, répartis par origine (les noms non rattachés servent à toutes les origines)
        items = sorted(((n, x) for n, x in w.items() if x > 0), key=lambda x: -x[1])[:3000]
        m = items[0][1]
        for o in ASIAN_ORIGINS:
            # noms rattachés à l'origine (ou partagés avec elle) ; « other » reçoit aussi les noms non rattachés
            groups[f"asian:{o}"] = [[sur_display(n), round(x / m * 100, 3)] for n, x in items if o in sur_origin.get(n, ["other"])][: TOP_SUR]
    groups[g] = [[sur_display(n), round(x / m * 100, 3)] for n, x in items][:TOP_SUR]
with open(os.path.join(HERE, "surnames.json"), "w", encoding="utf-8") as f:
    json.dump({
        "id": "us-surnames",
        "title": "Noms de famille par groupe (race et origine hispanique)",
        "assumption": False,
        "sources": [S_SUR, {"org": "U.S. Census Bureau", "title": "American Community Survey 2024 1-year, B02015: Asian Alone by Selected Groups", "year": 2024, "url": "https://data.census.gov/table/ACSDT1Y2024.B02015"}],
        "referenceYear": 2010,
        "notes": "Construit par packs/us/build-names.py. Personas d'origine asiatique : origine tirée selon l'ACS 2024 (B02015 : Asian alone par groupe détaillé ; south_asian = Indiens, Pakistanais, Bangladais, Népalais, Sri-Lankais ; chinese = Chinois et Taïwanais ; other = Hmong, Cambodgiens, Birmans, Thaïs, Laotiens, Afghans…), nom de famille parmi les 3 000 noms les plus fréquents chez les API, seuls ceux rattachés à cette origine ou partagés avec elle (Lee, Lam, Ho…) étant retenus, les noms non rattachés allant à « other » (dont les noms hmong) (« asian:<origine> » ; rattachement par listes de noms usuels, hypothèse), prénom des personnes nées à l'étranger : prénoms rattachés à l'origine, plus les prénoms non rattachés (souvent anglais) avec un poids réduit selon l'origine (0,08 pour les Sud-Asiatiques, 0,35 pour les Chinois, Coréens, Japonais et Vietnamiens, 1 pour les Philippins), parmi les 450 prénoms les plus fréquents des API adultes. 250 premiers noms par groupe, poids = effectif 2010 × part du groupe (60 000 noms les plus fréquents), normalisés à 100 pour le premier. Les apostrophes absentes du fichier du recensement sont rétablies pour quelques noms (O'Brien…).",
        "data": {"groups": groups, "asianOrigins": ASIAN_ORIGIN_WEIGHTS},
    }, f, ensure_ascii=False, indent=0)
    f.write("\n")
print("cohortes", len(cohorts))
