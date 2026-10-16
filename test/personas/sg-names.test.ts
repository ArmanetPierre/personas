import { describe, expect, it } from "vitest";
import { SOCLE_FIELDS } from "../../src/modules/migrate";
import type { SgPack } from "../../src/personas/countries/sg/pack";
import { loadPack } from "../../src/personas/pack";
import { drawPersona, drawPersonas } from "../../src/personas/sampler";
import { resolveSoclePack } from "../../src/population/target";

/**
 * Socle Singapour sg-2026.2 : le nom d'usage suit la religion (tirée avant lui) en plus de l'ethnie ou de
 * la nationalité. sg-2026.1 (packs/sg) reste tiré à l'identique.
 */

const v1 = loadPack("sg") as SgPack;
const v2 = loadPack("sg-2026.2") as SgPack;

// Marqueurs nets (prénom ou nom) d'une religion ; les noms neutres (Daniel, Adam, Kumar, Raj…) n'y sont pas.
const MUSLIM = ["Mohamed", "Muhammad", "Mohammad", "Mohammed", "Mohd", "Md.", "Abdul", "Abdullah", "Abdulloh", "Ahmad", "Ahmed", "Syed", "Sheik", "Sharifah", "Nur", "Nurul", "Noor", "Siti", "Fathima", "Fatimah", "Fatima", "Ayesha", "Aisyah", "Aishah", "Aisha", "Khadijah", "Begum", "Beevi", "Banu", "Hussain", "Hossain", "Rahman", "Khan", "Ibrahim", "Ismail", "Farhan", "Imran", "Yusuf", "Omar", "Karim", "Akter", "Uddin", "Islam"];
const HINDU = ["Krishnan", "Krishna", "Ramasamy", "Govindasamy", "Murugan", "Murugesan", "Ganesh", "Lakshmi", "Muthulakshmi", "Saraswathy", "Meenakshi", "Parvathi", "Shiva", "Siva", "Sivalingam", "Deepika", "Kavya", "Anjali", "Devi", "Sita", "Radha", "Das", "Saha", "Sharma", "Iyer", "Verma", "Gupta", "Agarwal", "Mishra", "Kulkarni", "Reddy", "Rao", "Nair", "Menon", "Balakrishnan", "Gopal", "Jain"];
const CHRISTIAN = ["Joshua", "Joseph", "Mary", "Maria", "Peter", "Paul", "John", "Christian", "Christina", "Christine", "Anthony", "Antony", "Xavier", "Arokiasamy", "Arockia", "Theresa", "Teresa", "Agnes", "Philomena", "Samuel", "Timothy", "Esther", "Ruth", "Jacob", "Mathew", "Matthew", "Mathews", "Thomas", "Varghese", "Kurian", "D'Souza", "D'Silva", "Fernandes", "Fernandez", "Pereira", "Rodrigues", "D'Cruz", "Santos", "Yohanes", "Yohana", "Petrus", "Caleb", "Elijah", "Isaac", "Gabriel", "Abigail", "Priscilla", "Deborah", "Grace", "Stephen"];
const MULTI = { christian: ["De Souza", "Dela Cruz"] };

const tokens = (name: string) => new Set(name.split(/\s+/));
const has = (name: string, list: string[], multi: string[] = []) => {
  const t = tokens(name);
  return list.filter((w) => t.has(w)).concat(multi.filter((m) => name.includes(m)));
};

function violations(pack: typeof v2, seeds: number[], n: number) {
  const out: string[] = [];
  let count = 0;
  for (const seed of seeds) {
    for (const p of drawPersonas(pack, seed, n)) {
      count++;
      const rel = (p.extra as unknown as { religion: string }).religion;
      const name = p.firstName ?? "";
      const muslim = has(name, MUSLIM);
      const hindu = has(name, HINDU);
      const christian = has(name, CHRISTIAN, MULTI.christian);
      const bad =
        rel === "islam" ? [...hindu, ...christian]
        : [...muslim, ...(rel === "christianity" ? hindu : []), ...(rel === "hinduism" ? christian : [])];
      if (bad.length) out.push(`${p.id} ${rel} « ${name} » (${bad.join(", ")})`);
    }
  }
  return { out, count };
}

describe("socle Singapour sg-2026.2 : nom d'usage selon la religion", () => {
  it("manifeste : sg-2026.2 hérite de packs/sg, `sg` pointe vers sg-2026.2", () => {
    expect(v2.manifest).toMatchObject({ country: "SG", version: "sg-2026.2", extends: "sg", generator: "sg", locale: "en", currency: "SGD", rngStreams: "module" });
    expect(v2.socle).toBe("sg");
    expect(v2.manifest.changelog?.[0]?.version).toBe("sg-2026.2");
    expect(resolveSoclePack("sg").manifest.version).toBe("sg-2026.2");
    expect(v1.manifest.version).toBe("sg-2026.1");
    expect(drawPersona(v2, 42, 7).id).toBe("sg-2026.2-s42-0008");
  });

  it("aucune persona musulmane au nom hindou ou chrétien, ni l'inverse (5 000 tirages)", () => {
    const { out, count } = violations(v2, [1, 7, 42, 2026, 5], 1000);
    expect(count).toBe(5000);
    expect(out).toEqual([]);
  });

  it("le défaut existait en sg-2026.1 (contrôle du test)", () => {
    expect(violations(v1, [1, 7, 42, 2026, 5], 1000).out.length).toBeGreaterThan(20);
  });

  it("Sikhs : Singh ou Kaur ; Indiens musulmans : noms musulmans ; Chinois musulmans : nom musulman + nom chinois", () => {
    const ps = [1, 7, 42, 2026, 5].flatMap((s) => drawPersonas(v2, s, 1000));
    const x = (p: (typeof ps)[number]) => p.extra as unknown as { religion: string; ethnicity: string };
    const sikh = ps.filter((p) => x(p).religion === "sikhism" && x(p).ethnicity === "indian");
    expect(sikh.length).toBeGreaterThan(10);
    expect(sikh.every((p) => /\b(Singh|Kaur)\b/.test(p.firstName ?? ""))).toBe(true);
    const indianMuslim = ps.filter((p) => x(p).religion === "islam" && x(p).ethnicity === "indian");
    expect(indianMuslim.length).toBeGreaterThan(50);
    expect(indianMuslim.filter((p) => has(p.firstName ?? "", MUSLIM).length).length / indianMuslim.length).toBeGreaterThan(0.6);
    const chineseChristian = ps.filter((p) => x(p).religion === "christianity" && x(p).ethnicity === "chinese" && (p.extra as unknown as { nationality: string | null }).nationality === null);
    expect(chineseChristian.length).toBeGreaterThan(100);
  });

  it("chaque groupe × sexe × religion possible trouve des noms dans son groupe (aucun repli sur un autre groupe)", () => {
    const E = v2.ethnicity.data;
    const R = v2.religion.data.byGroup;
    const cohorts = v2.firstNames.data.cohorts;
    const missing: string[] = [];
    const check = (group: string, religions: Record<string, number>) => {
      for (const [rel, w] of Object.entries(religions)) {
        if (w <= 0) continue;
        for (const sex of ["M", "F"] as const) {
          const cs = cohorts.filter((c) => c.sex === sex && c.group === group);
          if (!cs.some((c) => c.religions?.includes(rel)) && !cs.some((c) => !c.religions)) missing.push(`${group}/${sex}/${rel}`);
        }
      }
    };
    for (const eth of ["chinese", "malay", "indian", "others"]) check(eth, R[eth]!);
    for (const nat of E.nationalities) {
      const groups = new Set([nat.names, ...Object.values(nat.namesByEthnicity ?? {}), ...Object.values(nat.namesByPass ?? {})]);
      const eths = Object.keys(nat.ethnicity);
      for (const g of groups) check(g, R[nat.code] ?? Object.assign({}, ...eths.map((e) => R[e])));
    }
    expect(missing).toEqual([]);
  });

  it("seul le nom d'usage change entre sg-2026.1 et sg-2026.2 à graine et rang égaux", () => {
    let renamed = 0;
    for (let i = 0; i < 1500; i++) {
      const a = drawPersona(v1, 42, i);
      const b = drawPersona(v2, 42, i);
      for (const f of SOCLE_FIELDS) if (f !== "firstName") expect(b[f]).toEqual(a[f]);
      expect(b.extra).toEqual(a.extra);
      if (a.firstName !== b.firstName) renamed++;
    }
    expect(renamed).toBeGreaterThan(100);
  });
});
