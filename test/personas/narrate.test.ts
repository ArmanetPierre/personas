import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine";
import type { Backend, BackendRequest } from "../../src/engine/types";
import type { Persona } from "../../src/db/schema";
import {
  buildNarrativePrompt,
  checkNarrative,
  countAmounts,
  frequencyReport,
  HIGH_SKEPTICISM,
  matchBatch,
  narratePersonas,
  OPENING_ANGLES,
} from "../../src/personas/narrate";
import { loadPack } from "../../src/personas/pack";
import { drawPersonas } from "../../src/personas/sampler";

const pack = loadPack("fr");
const personas = drawPersonas(pack, 99, 12).map(
  (p) => ({ ...p, narrative: null, narrativeBackend: null, narrativeModel: null, narrativeAt: null, createdAt: "" }) as Persona,
);

/** Récit factice valide (≈ 90 mots) pour une persona. */
function fakeNarrative(p: Persona): string {
  const filler = "Elle fait ses courses le samedi au marché, garde un carnet de comptes dans la cuisine et surveille son compte avant chaque dépense. ".repeat(4);
  return `${p.firstName}, ${p.age} ans, vit sa vie sans bruit. ${filler}`.trim();
}

function fakeBackend(handler: (req: BackendRequest, call: number) => string) {
  let call = 0;
  const requests: BackendRequest[] = [];
  const backend: Backend = {
    name: "claude-cli",
    model: "fake",
    concurrency: 2,
    async checkAvailability() {
      return { ok: true, detail: "simulé" };
    },
    async generate(req) {
      requests.push(req);
      return { text: handler(req, call++), model: "fake", usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  return { backend, requests };
}

const idsIn = (req: BackendRequest) => [...req.messages.at(-1)!.content.matchAll(/### id: (\S+)/g)].map((m) => m[1]!);

describe("contrôle de cohérence", () => {
  const p = personas[0]!;
  it("accepte un récit conforme", () => {
    expect(checkNarrative(pack, p, fakeNarrative(p))).toEqual([]);
  });
  it("rejette un âge contradictoire", () => {
    const bad = fakeNarrative(p).replace(`${p.age} ans`, `${p.age + 7} ans`);
    expect(checkNarrative(pack, p, bad).join()).toMatch(/âge contradictoire/);
  });
  it("rejette une grande ville d'une autre région comme lieu de vie", () => {
    const other = pack.cityIndex.find((c) => c.region !== p.region)!;
    const bad = fakeNarrative(p).replace("vit sa vie sans bruit", `habite à ${other.name}`);
    expect(checkNarrative(pack, p, bad).join()).toMatch(/ville hors région/);
    const ok = fakeNarrative(p).replace("vit sa vie sans bruit", `est originaire de ${other.name}`);
    expect(checkNarrative(pack, p, ok)).toEqual([]);
  });
  it("rejette plus d'un montant chiffré", () => {
    const one = fakeNarrative(p).replace("vit sa vie sans bruit", "paie 45 € de box");
    expect(checkNarrative(pack, p, one)).toEqual([]);
    const two = fakeNarrative(p).replace("vit sa vie sans bruit", "paie 45 € de box et 1 437 euros de loyer");
    expect(checkNarrative(pack, p, two).join()).toMatch(/2 montants/);
    expect(countAmounts("12,99 €/mois, 2 000 € et 3 euros")).toBe(3);
  });

  it("rejette les formules-modèles et les clichés numériques", () => {
    for (const bad of ["Son irritant : le bruit.", "Ce qui l'agace, c'est le bus.", "Sa contrainte principale reste le temps.", "Elle oublie ses mots de passe.", "Les mises à jour l'énervent."]) {
      const n = fakeNarrative(p).replace("vit sa vie sans bruit.", `vit sa vie sans bruit. ${bad}`);
      expect(checkNarrative(pack, p, n).join(), bad).toMatch(/formule interdite/);
    }
  });

  it("n'accepte la publicité que pour une persona au scepticisme élevé", () => {
    const pub = fakeNarrative(p).replace("vit sa vie sans bruit", "jette la publicité sans la lire");
    const confiant = { ...p, skepticism: HIGH_SKEPTICISM - 0.2 };
    const mefiant = { ...p, skepticism: HIGH_SKEPTICISM + 0.1 };
    expect(checkNarrative(pack, confiant, pub).join()).toMatch(/publicité/);
    expect(checkNarrative(pack, mefiant, pub)).toEqual([]);
    const netflix = fakeNarrative(p).replace("vit sa vie sans bruit", "regarde Netflix avec pub et démarche des clients");
    expect(checkNarrative(pack, confiant, netflix)).toEqual([]);
  });

  it("rejette un récit trop court", () => {
    expect(checkNarrative(pack, p, `${p.firstName}, ${p.age} ans, rien.`).join()).toMatch(/longueur/);
  });
});

describe("rapport de fréquence", () => {
  it("compte les récits contenant les expressions suivies et les 4-grammes répétés", () => {
    const texts = [
      "Paul aime la pêche. Son irritant : la publicité.",
      "Anne lit le soir. Ce qui l'agace : la publicité à la radio.",
      "Marc jardine le dimanche et lit le soir au calme.",
    ];
    const r = frequencyReport(texts);
    expect(r.narratives).toBe(3);
    expect(r.tracked.publicit).toBe(2);
    expect(r.tracked.irritant).toBe(1);
    expect(r.tracked.agace).toBe(1);
    // Un 4-gramme n'est compté qu'une fois par récit
    expect(frequencyReport(["elle lit le soir, elle lit le soir", "puis elle lit le soir"]).topNgrams[0]).toEqual(["elle lit le soir", 2]);
  });
});

describe("appariement des lots", () => {
  it("sépare acceptés, absents et inattendus", () => {
    const batch = personas.slice(0, 3);
    const out = matchBatch(pack, batch, {
      items: [
        { id: batch[0]!.id, narrative: fakeNarrative(batch[0]!) },
        { id: "inconnu", narrative: "x" },
        { id: ` ${batch[2]!.id} `, narrative: fakeNarrative(batch[2]!) },
      ],
    });
    expect([...out.accepted.keys()]).toEqual([batch[0]!.id, batch[2]!.id]);
    expect(out.missing).toEqual([batch[1]!.id]);
    expect(out.unexpected).toEqual(["inconnu"]);
  });

  it("donne à chaque persona d'un lot de 10 un angle d'entrée différent", () => {
    const prompt = buildNarrativePrompt(pack, personas.slice(0, 10));
    const angles = [...prompt.matchAll(/ puis entrer par (.+?) ; finir/g)].map((m) => m[1]);
    expect(angles).toHaveLength(10);
    expect(new Set(angles).size).toBe(10);
    expect(angles.every((a) => (OPENING_ANGLES as readonly string[]).includes(a!))).toBe(true);
  });

  it("ne mentionne la méfiance envers la publicité dans la fiche que si le scepticisme est élevé", () => {
    for (const p of personas) {
      const card = buildNarrativePrompt(pack, [p]);
      expect(card.includes("publicité")).toBe(p.skepticism >= HIGH_SKEPTICISM);
    }
  });

  it("le prompt contient chaque id et les attributs clés", () => {
    const prompt = buildNarrativePrompt(pack, personas.slice(0, 2));
    for (const p of personas.slice(0, 2)) {
      expect(prompt).toContain(`### id: ${p.id}`);
      expect(prompt).toContain(`${p.age} ans`);
    }
  });
});

describe("narratePersonas (backend simulé)", () => {
  it("traite par lots, enregistre au fil de l'eau et redemande une fois les récits manquants ou rejetés", async () => {
    const byId = new Map(personas.map((p) => [p.id, p]));
    const { backend, requests } = fakeBackend((req, call) => {
      const ids = idsIn(req);
      // Premier appel : un récit absent et un récit à l'âge faux ; ensuite tout est correct.
      const items = ids
        .filter((id, i) => !(call === 0 && i === 0))
        .map((id, i) => {
          const p = byId.get(id)!;
          const n = fakeNarrative(p);
          return { id, narrative: call === 0 && i === 0 ? n.replace(`${p.age} ans`, "99 ans") : n };
        });
      return JSON.stringify({ items });
    });
    const saved = new Map<string, string>();
    const res = await narratePersonas(new Engine(backend), pack, personas, {
      batchSize: 5,
      save: (id, n) => saved.set(id, n),
    });
    expect(saved.size).toBe(personas.length);
    expect(res.stillMissing.size).toBe(0);
    expect(res.batches).toBe(4); // 3 lots + 1 reprise
    expect(requests.length).toBe(4);
    const retryIds = idsIn(requests.find((r) => r.messages.at(-1)!.content.includes("rejetée"))!);
    expect(retryIds.length).toBe(2);
    expect(res.usage.outputTokens).toBe(200);
  });

  it("s'arrête proprement sur une limite d'usage sans prendre de nouveaux lots", async () => {
    let calls = 0;
    const backend: Backend = {
      name: "claude-cli",
      model: "fake",
      concurrency: 1,
      async checkAvailability() {
        return { ok: true, detail: "simulé" };
      },
      async generate() {
        calls++;
        throw new Error("claude a renvoyé une erreur : Claude AI usage limit reached|1760000000");
      },
    };
    const res = await narratePersonas(new Engine(backend), pack, personas, { batchSize: 3, save: () => {} });
    expect(res.aborted).toMatch(/usage limit/);
    expect(calls).toBe(1);
    expect(res.stillMissing.size).toBe(personas.length);
  });

  it("abandonne après une reprise et signale les personas restantes", async () => {
    const { backend } = fakeBackend(() => JSON.stringify({ items: [{ id: "autre", narrative: "x" }] }));
    const saved: string[] = [];
    const res = await narratePersonas(new Engine(backend), pack, personas.slice(0, 3), {
      save: (id) => saved.push(id),
    });
    expect(saved).toEqual([]);
    expect(res.stillMissing.size).toBe(3);
  });
});
