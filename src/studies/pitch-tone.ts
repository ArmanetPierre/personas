/**
 * Ton d'un pitch (expérience du 2026-10-15) : un pitch commercial ou survendu fausse le test de
 * l'idée (frein « confiance » 27 % → 55 % → 93 %, mais « ne paierait jamais » 53 % → 45 % → 30 % :
 * le ton ancre les prix). Ce module donne, sans appel au modèle :
 * - un score lexical de ton (0 : factuel, 100 : survendu), utilisé par le garde-fou de création d'étude ;
 * - l'extraction des faits vérifiables (nombres, prix, durées, lieux) pour contrôler une neutralisation.
 *
 * Extension prévue : un protocole « test de message », où le ton devient l'objet du test (versions
 * `pitchOriginal` et `pitch`, ou plusieurs tons, sur le même échantillon). Voir docs/architecture-v2.md.
 */

export const TONE_CATEGORIES = [
  "superlative",
  "unverifiable_promise",
  "social_proof",
  "urgency",
  "price_judgment",
  "injunction",
  "emotional",
] as const;
export type ToneCategory = (typeof TONE_CATEGORIES)[number];

export const TONE_CATEGORY_LABELS: Record<ToneCategory, string> = {
  superlative: "Superlatif",
  unverifiable_promise: "Promesse invérifiable",
  social_proof: "Preuve sociale non sourcée",
  urgency: "Urgence",
  price_judgment: "Jugement de valeur sur le prix",
  injunction: "Injonction",
  emotional: "Émotion orientée",
};

/** Marqueurs lexicaux par catégorie (texte sans accents, en minuscules). */
const MARKERS: Record<ToneCategory, RegExp[]> = {
  superlative: [
    /\ble plus [a-z]+/g,
    /\bla plus [a-z]+/g,
    /\bles plus [a-z]+/g,
    /\bmeilleure?s?\b/g,
    /\bexceptionnel(le)?s?\b/g,
    /\brevolution(naire)?s?\b/g,
    /\bincroyables?\b/g,
    /\bextraordinaires?\b/g,
    /\bjamais (vu|imagine|egale)e?s?\b/g,
    /\bd'elite\b/g,
    /\bparfait(e)?s?\b/g,
    /\bultime\b/g,
    /\bgeniale?s?\b/g,
    /\bsans egal\b/g,
    /\bunique au monde\b/g,
    /\binnovant(e)?s?\b/g,
  ],
  unverifiable_promise: [
    /\bva changer\b/g,
    /\bchanger (votre|ta) (vie|quotidien)\b/g,
    /\bretrouve[rz]? enfin\b/g,
    /\bgaranti(e)?s?\b/g,
    /\ben (deux|un|2|1) clics?\b/g,
    /\bsans (aucun )?effort\b/g,
    /\btout est gere\b/g,
    /\bplus jamais\b/g,
    /\ben toute serenite\b/g,
  ],
  social_proof: [/\badore(e)?s? par\b/g, /\btous ceux qui\b/g, /\btout le monde\b/g, /\bdes milliers\b/g, /\bplebiscite(e)?s?\b/g, /\bn ?°? ?1\b/g, /\bnumero un\b/g],
  urgency: [/\bne passez pas a cote\b/g, /\bne ratez pas\b/g, /\bdes maintenant\b/g, /\bdes aujourd'hui\b/g, /\boffre limitee\b/g, /\bderniere chance\b/g, /\bvite\b/g, /\bsans attendre\b/g],
  price_judgment: [/\bseulement\b/g, /\bimbattables?\b/g, /\bpetit prix\b/g, /\bprix (mini|cass)\w*/g, /\bmeilleur prix\b/g, /\bpour rien\b/g, /\bune affaire\b/g, /\bque \d/g],
  injunction: [/(^|[.!?]\s+)(liberez|reservez|decouvrez|profitez|essayez|rejoignez|testez|offrez|osez|adoptez|commandez|inscrivez)[- ]/g],
  emotional: [/!/g, /\benfin\b/g, /\bfini les\b/g, /\bcorvees?\b/g, /\bstress\b/g, /\breve\b/g, /\bmagique\b/g, /\bliberez-vous\b/g, /\bvotre temps libre\b/g],
};

/**
 * Marqueurs anglais (pitchs des études en locale `en`), mêmes catégories et mêmes poids. Ils couvrent
 * aussi le registre des vitrines en ligne, qui vend par comparaison chiffrée plutôt que par superlatif
 * (« −50% vs. Singapore butchers », « You pay what restaurants pay », « no middleman », « 100% whole cuts »).
 * Étalonné sur la traduction anglaise des pitchs de l'expérience (examples/pitch-tone/) et sur un pitch de vitrine du socle sg
 * (`pitchOriginal` au-dessus du seuil, `pitch` neutre en dessous).
 */
const MARKERS_EN: Record<ToneCategory, RegExp[]> = {
  superlative: [
    /\bthe (most|best|finest|greatest|smartest|easiest|simplest|fastest|cheapest) [a-z]+/g,
    /\bbest\b/g,
    /\bexceptional\b/g,
    /\brevolution(ary|ise|ize|ising|izing)?\b/g,
    /\bincredible\b/g,
    /\bamazing\b/g,
    /\bextraordinary\b/g,
    /\bunrivall?ed\b/g,
    /\bunmatched\b/g,
    /\bunparall?ell?ed\b/g,
    /\bsecond to none\b/g,
    /\bnever (seen|imagined|before)\b/g,
    /\belite\b/g,
    /\bperfect(ly)?\b/g,
    /\bultimate\b/g,
    /\bawesome\b/g,
    /\bworld-class\b/g,
    /\bpremium\b(?! (butcher|supermarket|grocer|brand|competitor|shop|store|retailer)s?\b)/g,
    /\btop[- ](quality|notch|grade|tier)\b/g,
    /\bfirst-class\b/g,
    /\bstate-of-the-art\b/g,
    /\bgame[- ]chang(er|ing)\b/g,
    /\binnovative\b/g,
    /\b[a-z]+est [a-z]+ (on|in) the (market|world|city|country|town|island)\b/g,
  ],
  unverifiable_promise: [
    /\bwill (change|transform)\b/g,
    /\b(change|transform) your (life|day|routine)\b/g,
    /\bfinally (get|enjoy|have)\b/g,
    /\bguarantee(d|s)?\b/g,
    /\bin (one|two|a few|1|2) (clicks?|taps?)\b/g,
    /\beffortless(ly)?\b/g,
    /\bhassle-free\b/g,
    /\bwe take care of everything\b/g,
    /\bnever again\b/g,
    /\bpeace of mind\b/g,
    // Désintermédiation et pureté affirmées sans preuve
    /\bno middle ?m[ae]n\b/g,
    /\bcut(ting|s)? out the middle ?m[ae]n\b/g,
    /\bdirect(ly)? from (the )?(importers?|farms?|source|factory|producers?|growers?)\b/g,
    /\b100 ?% (?!refund)[a-z]+/g,
  ],
  social_proof: [/\bloved by\b/g, /\beveryone who\b/g, /\beveryone (loves|agrees|is talking)\b/g, /\bthousands of\b/g, /\bmillions of\b/g, /\btrusted by\b/g, /#\s?1\b/g, /\bnumber one\b/g, /\bno\. ?1\b/g, /\b(as seen|featured) (on|in)\b/g, /\b(5|five)[- ]stars?\b/g],
  urgency: [
    /\bdon'?t miss\b/g,
    /\bact now\b/g,
    /\bstarting today\b/g,
    /\btoday only\b/g,
    /\blimited[- ]time\b/g,
    /\blimited (offer|stock|spots|places|edition)\b/g,
    /\bwhile (stocks?|supplies) last\b/g,
    /\bonly \d+ (left|spots|places|slots)\b/g,
    /\bselling (out )?fast\b/g,
    /\b(order|book|buy|shop|join|sign up|subscribe) (now|today)\b/g,
    /\bbefore it'?s too late\b/g,
    /\blast chance\b/g,
    /\bhurry\b/g,
    /\bright now\b/g,
    /\bwithout delay\b/g,
  ],
  price_judgment: [
    /\bonly (s?\$|us\$|€|£|\d)/g,
    /\bunbeatable\b/g,
    /\blow price\b/g,
    /\brock-bottom\b/g,
    /\bbest price\b/g,
    /\bfor next to nothing\b/g,
    /\ba steal\b/g,
    /\bbargain\b/g,
    /\bjust (s?\$|€|\d)/g,
    // Réduction chiffrée par comparaison : « −50% vs. », « 30% cheaper », « 20% off », « save up to »
    /[-−–]\s?\d+(\.\d+)?\s?% (vs\.?|versus|than|off|below|cheaper|less)/g,
    /(^|[^-−–\d.])\d+(\.\d+)?\s?% (off|cheaper|less|savings?)\b/g,
    /\bsave (up to |over |at least )?(s?\$|us\$|€|£|\d|big|more)/g,
    /\bsaves? you\b/g,
    /\b(huge|big|massive) savings?\b/g,
    /\bhalf (the )?price\b/g,
    /\bcheaper than\b/g,
    /\byou pay what [a-z ]{2,30} pay\b/g,
    /\b(wholesale|trade|factory|insider) prices?\b/g,
    /\bat cost\b/g,
  ],
  injunction: [
    /(^|[.!?]\s+)(unlock|book|discover|enjoy|try|join|test|treat yourself|dare|adopt|order|sign up|grab|elevate|upgrade|get|shop|experience|taste|start|save|say goodbye|forget|imagine|stop)[ -]/g,
  ],
  emotional: [
    /!/g,
    /\bfinally\b/g,
    /\bno more\b/g,
    /\bchores?\b/g,
    /\bstress(ful)?\b/g,
    /\bdream\b/g,
    /\bmagic(al)?\b/g,
    /\bfree yourself\b/g,
    /\byour free time\b/g,
    /\bsay goodbye to\b/g,
    /\btired of\b/g,
    /\bmouth-?watering\b/g,
    /\bindulge\b/g,
    // Anaphore « no X, no Y » (rythme de slogan)
    /\bno [a-z]+( [a-z]+)?, no [a-z]+/g,
  ],
};

/**
 * Emphase typographique (anglais seulement) : mots en capitales hors sigles courts. Compte dans
 * « emotional ». Le français n'en a pas : ses scores restent ceux de l'expérience du 2026-10-15.
 */
function capsHits(text: string): string[] {
  return [...text.matchAll(/\b\p{Lu}{2,}(?:\s+\p{Lu}{2,})+\b|\b\p{Lu}{5,}\b/gu)].map((m) => m[0]);
}

/** Poids par catégorie : les superlatifs et la preuve sociale pèsent plus que l'injonction. */
const WEIGHTS: Record<ToneCategory, number> = {
  superlative: 3,
  unverifiable_promise: 2.5,
  social_proof: 3,
  urgency: 3,
  price_judgment: 2,
  injunction: 1.5,
  emotional: 1.5,
};

export const stripAccents = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
const flat = (s: string) => stripAccents(s).toLowerCase().replace(/[’']/g, "'");

export interface LexicalTone {
  /** 0 : factuel ; 100 : survendu. */
  score: number;
  hits: Array<{ category: ToneCategory; text: string }>;
  words: number;
}

/**
 * Score lexical : somme pondérée des marqueurs pour 100 mots, ramenée sur 0-100 (saturation à 100).
 * Étalonné sur les 3 pitchs de l'expérience (examples/pitch-tone/) : factuel ≈ 0, commercial ≈ 40,
 * survendu = 100.
 */
export function lexicalTone(text: string, locale: "fr" | "en" = "fr"): LexicalTone {
  const t = flat(text);
  const markers = locale === "en" ? MARKERS_EN : MARKERS;
  const words = Math.max(1, t.split(/\s+/).filter(Boolean).length);
  const hits: LexicalTone["hits"] = [];
  let weighted = 0;
  for (const c of Object.keys(markers) as ToneCategory[]) {
    for (const re of markers[c]) {
      for (const m of t.matchAll(re)) {
        hits.push({ category: c, text: m[0].trim() });
        weighted += WEIGHTS[c];
      }
    }
  }
  if (locale === "en") {
    for (const c of capsHits(text)) {
      hits.push({ category: "emotional", text: c });
      weighted += WEIGHTS.emotional;
    }
  }
  const per100 = (weighted / words) * 100;
  return { score: Math.min(100, Math.round(per100 * 3.5)), hits, words };
}

/**
 * Seuil du garde-fou de création d'étude. Choisi sur l'expérience : le pitch commercial (score
 * lexical ≈ 40) doublait déjà le frein « confiance » (27 % → 55 %) ; le factuel est à 0.
 */
export const TONE_WARNING_THRESHOLD = 25;

export interface ToneWarning {
  score: number;
  threshold: number;
  warn: boolean;
  message: string | null;
  markers: string[];
}

export function toneWarning(pitch: string, threshold = TONE_WARNING_THRESHOLD, locale: "fr" | "en" = "fr"): ToneWarning {
  const t = lexicalTone(pitch, locale);
  const warn = t.score >= threshold;
  return {
    score: t.score,
    threshold,
    warn,
    message: warn
      ? locale === "en"
        ? `Pitch with a commercial tone (score ${t.score}/100, threshold ${threshold}): it distorts the test of the idea (more distrust, anchored prices). Propose a factual version: npm run project:neutralize-pitch -- --project <id>. You can override.`
        : `Pitch au ton commercial (score ${t.score}/100, seuil ${threshold}) : il fausse le test de l'idée (méfiance accrue, prix ancrés). Proposer une version factuelle : npm run project:neutralize-pitch -- --project <id>. Vous pouvez passer outre.`
      : null,
    markers: [...new Set(t.hits.map((h) => h.text))].slice(0, 10),
  };
}

// ─── Faits vérifiables ────────────────────────────────────────────────────────

/** Nombres (avec leur unité éventuelle), normalisés : « 1,6 Go » → « 1.6 go », « 19 € » → « 19 € ». */
export function numbersOf(text: string): string[] {
  const t = flat(text).replace(/ | /g, " ");
  const out: string[] = [];
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(€|euros?|%|h\b|heures?|min\b|minutes?|jours?|mois|ans?|go|mo|km|kg|passages?)?/g)) {
    const n = m[1]!.replace(",", ".");
    out.push(m[2] ? `${n} ${m[2].replace(/^euros?$/, "€").replace(/^heures?$/, "h").replace(/s$/, "")}` : n);
  }
  return [...new Set(out)];
}

/** Mots à majuscule hors début de phrase (lieux, marques, noms propres), ex. Paris, Mac, Teams. */
export function namesOf(text: string): string[] {
  const out = new Set<string>();
  const sentences = text.split(/(?<=[.!?:;])\s+/);
  for (const s of sentences) {
    const words = s.split(/\s+/);
    words.forEach((w, i) => {
      const c = w.replace(/^[«"(]+|[»",.;:!?)]+$/g, "");
      if (i > 0 && /^\p{Lu}[\p{L}-]{1,}/u.test(c) && !/^\p{Lu}+$/u.test(c.slice(0, 2))) out.add(c.replace(/['’].*$/, ""));
    });
  }
  return [...out];
}

/** Un terme apparaît-il dans le texte (sans accents ni casse, racine de 5 lettres pour les mots longs) ? */
export function hasTerm(text: string, term: string): boolean {
  const t = flat(text);
  const words = flat(term).split(/[^a-z0-9.]+/).filter((w) => w.length > 2);
  if (!words.length) return t.includes(flat(term));
  return words.every((w) => t.includes(w.length > 6 ? w.slice(0, 5) : w));
}

export interface FactCheck {
  ok: boolean;
  /** Nombres de l'original absents de la version neutre. */
  numbersMissing: string[];
  /** Nombres de la version neutre absents de l'original (ajout). */
  numbersAdded: string[];
  /** Noms propres et lieux de l'original absents de la version neutre. */
  namesMissing: string[];
  /** Faits listés par le modèle dont un terme clé manque dans la version neutre. */
  factsMissing: string[];
}

export function checkFacts(original: string, neutral: string, facts: Array<{ fact: string; keyTerms: string[] }> = []): FactCheck {
  const no = numbersOf(original);
  const nn = numbersOf(neutral);
  const numbersMissing = no.filter((x) => !nn.includes(x));
  const numbersAdded = nn.filter((x) => !no.includes(x));
  const namesMissing = namesOf(original).filter((n) => !hasTerm(neutral, n));
  const factsMissing = facts.filter((f) => f.keyTerms.some((k) => !hasTerm(neutral, k))).map((f) => f.fact);
  return { ok: !numbersMissing.length && !numbersAdded.length && !namesMissing.length && !factsMissing.length, numbersMissing, numbersAdded, namesMissing, factsMissing };
}
