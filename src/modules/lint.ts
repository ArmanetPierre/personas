import { parse as parseYaml } from "yaml";
import type { ModuleDef } from "./schema";

/**
 * Lint de sécurité d'un module (docs/plateforme.md § 11.3 et § 11.4), partagé par le runner (validation locale,
 * acceptation d'un brouillon, téléchargement depuis le Hub, publication) et par le Hub (publication).
 *
 * Un module est du YAML déclaratif, sans code. Ce lint vise ce qui reste :
 * 1. l'injection de prompt : les libellés et les lignes de fiche entrent dans la fiche d'étude envoyée au LLM ;
 * 2. le contournement de l'anti-complaisance : affirmations comportementales (« paie toujours », « adore tous
 *    les nouveaux produits ») et attributs qui doublent les psychographies du socle (scepticisme, sensibilité
 *    au prix), que les modules ne peuvent pas toucher ;
 * 3. le déni de service : tailles et profondeurs bornées ;
 * 4. les attributs sensibles (RGPD art. 9) : `sensitive: true` et `sensitive_justification` exigés.
 *
 * Signature stable (importée par le Hub) : `lintModule(input) → { errors, warnings }`. Le lint ne remplace pas
 * la validation (schéma zod et contrôles sémantiques, src/modules/registry.ts) : il marche sur l'objet brut,
 * même invalide, et ne lève jamais.
 */

export interface Issue {
  /** Règle (stable) : `too_long`, `multiline`, `hidden_chars`, `url`, `markup`, `instruction`, `second_person`, `imperative`, `behavior`, `psychographic`, `sensitive`, `size`, `depth`, `yaml`. */
  code: string;
  /** Chemin dans le module (`attributes.2.values.0.label`), vide pour le module entier. */
  path: string;
  message: string;
}

export interface LintResult {
  errors: Issue[];
  warnings: Issue[];
}

// ─── Limites (déni de service, § 11.3.3) ────────────────────────────────────

export const LINT_LIMITS = {
  /** Texte YAML (même plafond que la publication, src/hub/contract.ts). */
  yamlBytes: 256 * 1024,
  attributes: 80,
  enumValues: 300,
  setItems: 150,
  tables: 150,
  tableEntries: 1000,
  conditions: 200,
  card: 60,
  segments: 40,
  requires: 20,
  eligibilityHelpers: 50,
  validationChecks: 100,
  sources: 200,
  /** Profondeur d'imbrication de l'objet (expressions, conditions, tables imbriquées). */
  depth: 32,
  /** Nombre total de nœuds (objets, tableaux, valeurs). */
  nodes: 50_000,
  /** Alias YAML (`*ancre`) : refusés au-delà (bombes d'alias). */
  yamlAliases: 50,
} as const;

/** Longueurs maximales des textes, par champ. */
export const TEXT_LIMITS = {
  label: 120,
  short_label: 40,
  description: 1500,
  attrLabel: 160,
  attrDescription: 600,
  valueLabel: 200,
  cardLine: 300,
  displayTemplate: 200,
  displayEmpty: 120,
  segmentLabel: 120,
  subscriptionName: 80,
  unit: 40,
  helper: 600,
  justification: 4000,
  sourceText: 2000,
  docLabel: 300,
} as const;

// ─── Normalisation ──────────────────────────────────────────────────────────

/** Minuscules, sans accents, apostrophes et espaces normalisés : les motifs s'écrivent sans accents. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/[  ]/g, " ")
    .toLowerCase();
}

const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

// ─── Motifs ─────────────────────────────────────────────────────────────────

const URL_RE = /\b(?:https?|ftp|file|data|javascript|mailto):|\bwww\.|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|ai|fr|sg|xyz|co|app|dev|info|biz|me|ly|gg|ru|cn|uk|de|eu|be|ch|ca|us)(?![a-z0-9-])/i;

const MARKUP: Array<[RegExp, string]> = [
  [/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i, "balise HTML"],
  [/<!--|-->/, "commentaire HTML"],
  [/<\|[^|<>]{1,40}\|>|<<\/?sys>>|\[\/?(?:inst|sys|system)\]/i, "balise de rôle"],
  [/(?:^|\n)\s*(?:system|assistant|user|human|developer|systeme|utilisateur)\s*:/i, "préfixe de rôle"],
  [/(?:^|\n)\s{0,3}#{1,6}\s/, "titre markdown"],
  [/```|~~~/, "bloc de code markdown"],
  [/\*\*[^*\n]+\*\*|__[^_\n]+__/, "gras markdown"],
  [/\[[^\]\n]*\]\([^)\n]*\)/, "lien markdown"],
  [/(?:^|\n)\s*>\s/, "citation markdown"],
  [/\{\{|\}\}|\$\{/, "gabarit de code"],
];

/** Consignes adressées au modèle (FR et EN), sur le texte normalisé. Erreur partout. */
const INSTRUCTION: RegExp[] = [
  // EN
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|these|those|your|system)\b.{0,40}\b(?:instructions?|rules?|prompts?|directions?|guidelines?|constraints?|context|messages?)\b/,
  /\bignore (?:previous|prior|above|all|the above|everything)\b/,
  /\byou (?:must|should|shall|will|are now|have to|need to|may not|can ?not|can't|won't|always|never)\b/,
  /\b(?:act|behave|respond|answer|reply|speak|write) as (?:if|though|a|an|the)\b/,
  /\bpretend (?:to be|you|that)\b/,
  /\brole-?play\b/,
  /\bfrom now on\b/,
  /\bsystem prompt\b/,
  /\bnew instructions?\b/,
  /\bjailbreak\b|\bdeveloper mode\b|\bdan mode\b/,
  /\b(?:always|only|never) (?:answer|respond|reply|say|output|rate|choose|pick)\b/,
  /\b(?:answer|respond|reply)(?: with| only| in)? (?:yes|no|positively|favou?rably)\b/,
  /\b(?:do not|don't|never) (?:mention|reveal|tell|object|refuse|question|criticize|criticise)\b/,
  // FR (sans accents)
  /\b(?:ignore[sz]?|oublie[sz]?|ne tiens pas compte|ne tenez pas compte|fais abstraction|faites abstraction)\b.{0,40}\b(?:instructions?|consignes?|regles?|prompts?|contexte|messages?|ce qui precede|precedente?s?|ci-dessus)\b/,
  /\b(?:tu dois|vous devez|tu es desormais|tu es maintenant|vous etes desormais|vous etes maintenant|il faut que tu|tu ne dois|vous ne devez|tu vas)\b/,
  /\b(?:reponds|repondez)\b/,
  /\b(?:agis|agissez|comporte-toi|comportez-vous|fais comme si|faites comme si|fais semblant|faites semblant|joue le role|jouez le role|incarnez)\b/,
  /\b(?:a partir de maintenant|desormais,? (?:tu|vous)|prompt systeme|nouvelles? (?:instructions|consignes)|(?:instructions?|consignes?) precedentes?)\b/,
  /\b(?:dis|dites) (?:oui|non|toujours|que)\b/,
  /\b(?:toujours|uniquement|seulement) (?:repondre|dire oui|accepter|noter|choisir)\b/,
  /\bn'(?:oublie|oubliez) pas\b/,
  /\bne (?:mentionne|mentionnez|revele|revelez|dis|dites) (?:pas|jamais|rien)\b/,
];

/** Deuxième personne (le modèle ou le lecteur interpellé). Erreur dans les libellés et la fiche. */
const SECOND_PERSON: RegExp[] = [/(?<![\w-])(?:tu|toi|tes|vous|votre|vos)(?![\w-])/, /(?<![\w-])(?:you|your|yours|yourself|yourselves)(?![\w-])/];

/** Impératif en tête de phrase (formes sans ambiguïté avec la 3e personne). Erreur dans les libellés et la fiche. */
const IMPERATIVE_AT_START = new RegExp(
  "(?:^|[.!?;:\\n«\"(]\\s*)(?:" +
    [
      // FR : formes en -ez et 2e personne du singulier distinctes de la 3e
      "repondez|reponds|ignorez|ignore|oubliez|considerez|imaginez|acceptez|achetez|payez|notez|choisissez|choisis|dites|dis|faites|fais|soyez|sois|agissez|agis|ecrivez|ecris|evaluez|donnez|indiquez|precisez|supposez|retenez|pensez|adoptez|soutenez",
      // EN
      "disregard|forget|respond|answer|reply|pretend|say|remember|assume|consider|tell|give|choose|behave|act as",
    ].join("|") +
    ")(?![\\w-])",
);

/** Contexte d'économie ou d'habitude (le contraire de la complaisance) : « achète toujours en promotion », « paie toujours en espèces ». */
const SAFE_CONTEXT = /\b(?:promo|promotions?|soldes?|reduction|rabais|moins cher|le moins cher|d'occasion|bon plan|la meme|le meme|les memes|au meme endroit|en retard|en especes|en liquide|par carte|par cheque|comptant|ses factures|son loyer|en magasin|discount|on sale|cheapest|second-hand|secondhand|used|coupon|bargain|the same|same brand|in cash|by card|late)\b/;

/** Affirmations comportementales qui court-circuitent l'anti-complaisance (brief : budget, alternatives, inertie). */
const BEHAVIOR: RegExp[] = [
  // FR
  /\b(?:paie|paye|payent|paient|achete|achetent|accepte|acceptent|souscrit|souscrivent|s'abonne|s'abonnent|s'inscrit|adhere|commande|adopte|adoptent|craque|cede|investit|depense|essaie|teste|dit oui|repond oui)\b[^.;\n]{0,30}\b(?:toujours|systematiquement|sans hesiter|sans hesitation|sans reflechir|sans discuter|sans condition|a coup sur|quoi qu'il|tout de suite|immediatement|n'importe quel(?:le)? prix|a tous les coups|a chaque fois|forcement|volontiers tout)\b/,
  /\b(?:toujours|systematiquement)\b[^.;\n]{0,20}\b(?:pret|prete|prets|pretes|partant|partante|d'accord|enthousiaste|enthousiastes|convaincue?s?|emballee?s?)\b/,
  /\badorent?\b[^.;\n]{0,25}\b(?:tous|toutes|tout ce qui|les nouveaux|les nouvelles|la nouveaute|les nouveautes|nouveaux produits|nouvelles applis?|nouvelles offres)\b/,
  /\bprete?s? a payer\b[^.;\n]{0,20}\b(?:n'importe|tout|le prix fort|sans limite|sans compter)\b/,
  /\b(?:insensibles?|indifferente?s?) (?:au|aux) prix\b/,
  /\b(?:le prix|les prix|l'argent|le cout) (?:n'est|ne sont|ne compte|ne comptent|ne pose|importe peu|n'a pas d'importance|n'est jamais)\b/,
  /\bbudget (?:illimite|sans limite|infini)\b|\bsans (?:aucune )?(?:contrainte|limite) (?:de budget|budgetaire|financiere)\b/,
  /\b(?:jamais|aucune?) (?:d'objections?|objections?|sceptique|mefiante?|reticente?|d'hesitation|hesitation)\b|\bsans (?:aucune )?objection\b/,
  /\bachet(?:eur|euse|e) compulsi/,
  /\b(?:dit|disent|repond|repondent) oui a tout\b|\bse laisse (?:toujours|facilement) convaincre\b|\bconvaincue?s? d'avance\b/,
  // EN
  /\b(?:always|readily|happily|instantly|immediately|automatically|eagerly|definitely|certainly|gladly)\b[^.;\n]{0,20}\b(?:buys?|pays?|purchases?|subscribes?|signs? up|says yes|accepts?|agrees?|adopts?|upgrades?|orders?|spends?|invests?|converts?|tries)\b/,
  /\b(?:buys?|pays?|purchases?|subscribes? to|accepts?) (?:anything|everything|whatever|at any price|regardless of (?:the )?price)\b/,
  /\bloves? (?:all|every|any|each) new\b|\bloves? new (?:products|apps|things|gadgets|services|offers)\b/,
  /\bmoney is no (?:object|issue|problem)\b|\b(?:price|cost) (?:is|does)(?: not|n't| never) [^.;\n]{0,15}\b(?:issue|concern|object|matter|problem)/,
  /\b(?:not|never) price[- ]sensitive\b|\bprice[- ]insensitive\b|\bunlimited budget\b/,
  /\bnever (?:objects|hesitates|complains|says no|refuses|resists)\b|\bsays yes to (?:everything|anything|all)\b|\bno objections?\b/,
  /\bwilling to pay (?:anything|any price|whatever|top dollar|more for everything)\b/,
];

/**
 * Psychographies du socle (scepticisme, sensibilité au prix, tonalité du récit) : un module ne les double ni ne
 * les modifie. Nommer la notion est une erreur ; un adjectif (« sceptique envers l'IA ») est un avertissement,
 * une attitude propre au domaine restant possible.
 */
const PSYCHO_TEXT = /\b(?:scepticisme|skepticism|scepticism|sensibilite (?:au|aux) prix|price[- ]sensitivity|consentement a payer|disposition a payer|willingness to pay|propension a (?:acheter|payer)|propensity to (?:buy|pay)|intention d'achat|purchase intent(?:ion)?)\b/;
const PSYCHO_WEAK_TEXT = /\b(?:sceptiques?|skeptical|sceptical)\b/;
/** Clés qui doublent une psychographie (clé entière, ou notion de prix et d'intention d'achat). */
const PSYCHO_KEYS = new Set(["skepticism", "scepticism", "scepticisme", "skeptic", "sceptic", "tone", "narrative_tone", "price_sensitivity", "sensibilite_prix", "sensibilite_au_prix"]);
const PSYCHO_KEY = /(?:^|_)(?:price_sensitiv\w*|sensibilite_(?:au_)?prix|willingness_to_pay|wtp|consentement_a_payer|purchase_intent\w*|intention_(?:d_)?achat|propensity_to_(?:buy|pay))(?:_|$)/;
const PSYCHO_WEAK_KEY = /skeptic|sceptic/;
/** Variables psychographiques du socle (aucune n'est exposée aux modules ; refus explicite). */
const PSYCHO_SOCLE_VARS = /^socle\.(?:skepticism|scepticism|price_?sensitivity|pricesensitivity|narrative_?tone|tone|psychographics?)$/i;

// ─── Attributs sensibles (§ 11.4) ───────────────────────────────────────────

export type SensitiveCategory = "ethnicity" | "religion" | "health" | "sexual_orientation" | "political_opinion" | "trade_union";

export const SENSITIVE_CATEGORY_LABELS: Record<SensitiveCategory, string> = {
  ethnicity: "ethnie",
  religion: "religion",
  health: "santé",
  sexual_orientation: "orientation sexuelle",
  political_opinion: "opinions politiques",
  trade_union: "appartenance syndicale",
};

/** Mots-clés (texte normalisé) par catégorie ; `except` : expressions courantes qui ne relèvent pas de la catégorie. */
const SENSITIVE_TEXT: Array<{ cat: SensitiveCategory; re: RegExp; except?: RegExp }> = [
  { cat: "ethnicity", re: /\b(?:ethnie|ethnies|ethnique|ethniques|ethnicite|ethnicity|ethnic|racial|raciale|raciales|raciaux|origine ethnique|couleur de peau|skin colou?r)\b/ },
  {
    cat: "religion",
    re: /\b(?:religions?|religieu(?:x|se|ses)|religious|faith|croyant(?:e|s|es)?|believer|worship|islam|musulman(?:e|s|es)?|muslims?|chretien(?:ne|s|nes)?|christian(?:s|ity)?|catholique|catholic|protestant(?:e|s|es)?|juif|juive|juifs|juives|jewish|judaisme|judaism|hindou(?:e|s|es)?|hindus?|hinduism|bouddhis(?:te|tes|me)|buddhis(?:t|ts|m)|sikh(?:s|isme|ism)?|taois(?:te|me)|taois(?:t|m)|athee|atheist|halal|casher|kasher|kosher|ramadan|careme|mosquee|mosque|eglise|church|synagogue)\b/,
  },
  {
    cat: "health",
    re: /\b(?:sante|health|maladies?|disease|illness|malade|handicap(?:e|ee|s)?|disabilit(?:y|ies)|disabled|diabete|diabetes|diabetique|diabetic|cancer|vih|hiv|sida|grossesse|enceinte|pregnan(?:t|cy)|depression|mental|psychiatri(?:que|c)|chronique|chronic|obesite|obesity|imc|bmi|allergi(?:e|es|que|c|y)|traitement medical|medical condition|pathologie|invalidite|addiction|toxicomanie)\b/,
    except: /\b(?:assurance sante|mutuelle(?: sante)?|complementaire sante|health insurance|health ?care spend|sante financiere|financial health|bilan de sante de l'entreprise|carte vitale|charge mentale|mental load|calcul mental|mental math)\b/,
  },
  { cat: "sexual_orientation", re: /\b(?:orientation sexuelle|sexual orientation|sexualite|sexuality|homosexuel(?:le|s|les)?|homosexual|heterosexuel(?:le|s|les)?|heterosexual|bisexuel(?:le|s|les)?|bisexual|gay|gays|lesbienne?s?|lesbian|lgbt\w*|queer|transgenre|transgender|non-binaire|non-binary)\b/ },
  {
    cat: "political_opinion",
    re: /\b(?:opinions? politiques?|political|politique|politiques|vote|votes|voter|votent|electeur|electrice|electeurs|elector|voters?|election|elections|parti politique|political party|partisan(?:e|s)?|militant(?:e|s|es)? politique|sympathisant(?:e|s)?|left-wing|right-wing|extreme (?:gauche|droite)|far-(?:left|right))\b/,
    except: /\bpolitiques? (?:tarifaires?|commerciales?|de prix|de retour|de remboursement|d'entreprise|de l'entreprise|de confidentialite|de teletravail|internes?|rh|salariales?|de securite|publiques? de l'emploi)\b|\b(?:company|privacy|return|refund|pricing) polic/,
  },
  { cat: "trade_union", re: /\b(?:syndicats?|syndique(?:e|s|es)?|syndicale?s?|syndicaux|syndicalisme|syndicaliste|trade unions?|labou?r unions?|union members?|union membership|unionized|unionised)\b/ },
];

/** Jetons de clés (`religion_level`, `health_status`) qui désignent une catégorie sensible. */
const SENSITIVE_KEY: Array<{ cat: SensitiveCategory; re: RegExp }> = [
  { cat: "ethnicity", re: /(?:^|_)(?:ethni\w*|race|racial)(?:_|$)/ },
  { cat: "religion", re: /(?:^|_)(?:relig\w*|faith|halal|kosher|casher|worship)(?:_|$)/ },
  { cat: "health", re: /(?:^|_)(?:health\w*|sante|disease|illness|disab\w*|handicap\w*|diabet\w*|pregnan\w*|chronic\w*|medical\w*|bmi|imc)(?:_|$)/ },
  { cat: "sexual_orientation", re: /(?:^|_)(?:sexual\w*|sexuel\w*|orientation|lgbt\w*)(?:_|$)/ },
  { cat: "political_opinion", re: /(?:^|_)(?:politic\w*|politique\w*|vote\w*|voting|party_affiliation)(?:_|$)/ },
  { cat: "trade_union", re: /(?:^|_)(?:syndic\w*|union_member\w*|unioni[sz]ed|trade_union)(?:_|$)/ },
];

/** Variables du socle relevant d'une catégorie sensible (socle Singapour : `ethnicity`, `religion`). */
export const SENSITIVE_SOCLE_VARS: Record<string, SensitiveCategory> = { ethnicity: "ethnicity", religion: "religion" };

// ─── Parcours ───────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

/** Champ de texte et son usage : `prompt` (atteint la fiche d'étude ou un prompt), `doc` (documentation, UI). */
type Kind = "label" | "prose" | "doc" | "expr";

class Linter {
  errors: Issue[] = [];
  warnings: Issue[] = [];
  err(code: string, path: string, message: string) {
    if (!this.errors.some((e) => e.code === code && e.path === path)) this.errors.push({ code, path, message });
  }
  warn(code: string, path: string, message: string) {
    if (!this.warnings.some((e) => e.code === code && e.path === path)) this.warnings.push({ code, path, message });
  }

  /**
   * Contrôle d'un texte. `label` : libellé ou ligne de fiche (une ligne, règles strictes) ; `prose` : description
   * (plusieurs lignes admises, 2e personne en avertissement) ; `doc` : justification, sources, changelog,
   * libellés de validation (consignes et balisage refusés, le reste en avertissement) ; `expr` : filtre prêt à l'emploi.
   */
  text(value: unknown, path: string, kind: Kind, max: number) {
    if (value === undefined || value === null) return;
    if (typeof value !== "string") return;
    const s = value;
    if (s.length > max) this.err("too_long", path, `${s.length} caractères (maximum ${max})`);
    if (HIDDEN.test(s)) this.err("hidden_chars", path, "caractères invisibles ou de contrôle (texte caché, inversion de sens)");
    if ((kind === "label" || kind === "expr") && /[\r\n]/.test(s)) this.err("multiline", path, "un libellé ou une ligne de fiche tient sur une seule ligne");
    const n = normalizeText(s);
    for (const [re, what] of MARKUP) {
      if (re.test(n)) {
        this.err("markup", path, `balisage refusé (${what}) : un module ne contient que du texte brut`);
        break;
      }
    }
    if (URL_RE.test(n)) {
      if (kind === "doc") this.warn("url", path, "adresse web dans le texte : les sources vont dans `sources` (champ url)");
      else this.err("url", path, "adresse web refusée dans un libellé, une description ou une ligne de fiche");
    }
    for (const re of INSTRUCTION) {
      if (re.test(n)) {
        this.err("instruction", path, `consigne adressée au modèle (« ${excerpt(s, n, re)} ») : un module décrit la personne, il ne donne pas d'ordre`);
        break;
      }
    }
    if (kind === "label" || kind === "prose") {
      for (const re of SECOND_PERSON) {
        if (re.test(n)) {
          const msg = `deuxième personne (« ${excerpt(s, n, re)} ») : écrire à la troisième personne, sans s'adresser au modèle ni au lecteur`;
          if (kind === "label") this.err("second_person", path, msg);
          else this.warn("second_person", path, msg);
          break;
        }
      }
      if (kind === "label" && IMPERATIVE_AT_START.test(n)) this.err("imperative", path, `impératif en tête de phrase (« ${excerpt(s, n, IMPERATIVE_AT_START)} ») : un libellé décrit, il n'ordonne pas`);
    }
    if (kind !== "expr" && !SAFE_CONTEXT.test(n)) {
      for (const re of BEHAVIOR) {
        if (re.test(n)) {
          const msg = `affirmation comportementale qui court-circuite l'anti-complaisance (« ${excerpt(s, n, re)} ») : la décision d'achat se mesure dans l'étude, elle ne se déclare pas dans un module`;
          if (kind === "doc") this.warn("behavior", path, msg);
          else this.err("behavior", path, msg);
          break;
        }
      }
    }
    if ((kind === "label" || kind === "prose") && PSYCHO_TEXT.test(n)) {
      this.err("psychographic", path, `psychographie du socle (« ${excerpt(s, n, PSYCHO_TEXT)} ») : scepticisme et sensibilité au prix viennent du socle, un module ne les modifie pas`);
    } else if ((kind === "label" || kind === "prose") && PSYCHO_WEAK_TEXT.test(n)) {
      this.warn("psychographic", path, `« ${excerpt(s, n, PSYCHO_WEAK_TEXT)} » : vérifier qu'il s'agit d'une attitude propre au domaine, pas du scepticisme général du socle`);
    }
  }
}

/** Extrait du texte d'origine qui correspond au motif (même position : la normalisation garde la longueur, hors accents combinés). */
function excerpt(orig: string, norm: string, re: RegExp): string {
  const m = re.exec(norm);
  if (!m) return orig.slice(0, 40);
  const flat = orig.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const src = flat.length === norm.length ? flat : norm;
  return src.slice(m.index, m.index + m[0].length).replace(/^[^\p{L}]+/u, "").trim().slice(0, 60);
}

/** Libellé genré (`{M, F}`) ou simple. */
function labels(x: unknown): string[] {
  if (typeof x === "string") return [x];
  if (isObj(x)) return Object.values(x).filter((v): v is string => typeof v === "string");
  return [];
}

/** Chaînes et clés d'objet d'un sous-arbre (références d'attributs, noms de conditions). */
function collectStrings(x: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof x === "string") out.add(x);
  else if (Array.isArray(x)) for (const v of x) collectStrings(v, out);
  else if (isObj(x)) {
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      collectStrings(v, out);
    }
  }
  return out;
}

/** Profondeur et nombre de nœuds (déni de service). */
function measure(x: unknown, depth = 1, acc = { depth: 0, nodes: 0 }): { depth: number; nodes: number } {
  acc.nodes++;
  if (depth > acc.depth) acc.depth = depth;
  if (acc.nodes > LINT_LIMITS.nodes * 2 || depth > LINT_LIMITS.depth * 2) return acc;
  if (Array.isArray(x)) for (const v of x) measure(v, depth + 1, acc);
  else if (isObj(x)) for (const v of Object.values(x)) measure(v, depth + 1, acc);
  return acc;
}

/** Catégories sensibles d'un texte. */
function sensitiveInText(s: string): SensitiveCategory[] {
  const n = normalizeText(s);
  const out: SensitiveCategory[] = [];
  for (const { cat, re, except } of SENSITIVE_TEXT) {
    const cleaned = except ? n.replace(new RegExp(except.source, "g"), " ") : n;
    if (re.test(cleaned)) out.push(cat);
  }
  return out;
}

function sensitiveInKey(key: string): SensitiveCategory[] {
  const k = normalizeText(key);
  return SENSITIVE_KEY.filter(({ re }) => re.test(k)).map(({ cat }) => cat);
}

export interface SensitiveAttribute {
  key: string;
  /** Catégories détectées (mots-clés de la clé ou des libellés, variables sensibles du socle lues). */
  categories: SensitiveCategory[];
  /** Pourquoi : `key`, `label`, `socle.religion`… */
  reasons: string[];
  /** Déclaré `sensitive: true` dans le module. */
  declared: boolean;
  justification: string | null;
}

/**
 * Attributs sensibles d'un module (détectés ou déclarés) : sert au lint, au badge « sensible » et à l'exclusion
 * du choix automatique (docs/plateforme.md § 11.4).
 */
export function sensitiveAttributes(module: Obj | ModuleDef): SensitiveAttribute[] {
  const raw = module as Obj;
  const conditions = isObj(raw.conditions) ? raw.conditions : {};
  const out: SensitiveAttribute[] = [];
  for (const a of arr(raw.attributes)) {
    if (!isObj(a)) continue;
    const key = str(a.key) ?? "?";
    const cats = new Set<SensitiveCategory>();
    const reasons = new Set<string>();
    for (const c of sensitiveInKey(key)) {
      cats.add(c);
      reasons.add("clé");
    }
    const texts = [...labels(a.label), ...arr(a.values).flatMap((v) => (isObj(v) ? labels(v.label) : [])), ...arr(a.items).flatMap((i) => (isObj(i) ? [str(i.label), str(i.card_label)].filter((x): x is string => !!x) : [])), ...(isObj(a.labels) ? labels(a.labels) : [])];
    for (const t of texts) {
      for (const c of sensitiveInText(t)) {
        cats.add(c);
        reasons.add("libellé");
      }
    }
    // Variables sensibles du socle lues par l'attribut, directement ou par une condition nommée
    const seen = new Set<string>();
    const scan = (x: unknown) => {
      for (const s of collectStrings(x)) {
        const m = /^socle\.([a-z_]+)$/.exec(s);
        if (m && SENSITIVE_SOCLE_VARS[m[1]!]) {
          cats.add(SENSITIVE_SOCLE_VARS[m[1]!]!);
          reasons.add(s);
        }
        if (conditions[s] !== undefined && !seen.has(s)) {
          seen.add(s);
          scan(conditions[s]);
        }
      }
    };
    const TEXT_FIELDS = new Set(["label", "description", "justification", "sources", "display", "sensitive_justification"]);
    scan(Object.fromEntries(Object.entries(a).filter(([k]) => !TEXT_FIELDS.has(k))));
    const declared = a.sensitive === true;
    if (cats.size || declared) out.push({ key, categories: [...cats], reasons: [...reasons], declared, justification: str(a.sensitive_justification)?.trim() || null });
  }
  return out;
}

/** Vrai si le module porte au moins un attribut sensible (détecté ou déclaré) : badge et exclusion du choix automatique. */
export function isSensitiveModule(module: Obj | ModuleDef): boolean {
  return sensitiveAttributes(module).length > 0;
}

/**
 * Lint de sécurité d'un module : texte YAML (taille et alias contrôlés avant lecture) ou module déjà lu.
 * N'échoue jamais : un YAML illisible donne une erreur `yaml`.
 */
export function lintModule(input: string | ModuleDef): LintResult {
  const L = new Linter();
  let raw: unknown = input;
  if (typeof input === "string") {
    const bytes = Buffer.byteLength(input, "utf8");
    if (bytes > LINT_LIMITS.yamlBytes) {
      L.err("size", "", `YAML de ${Math.round(bytes / 1024)} Kio (maximum ${LINT_LIMITS.yamlBytes / 1024} Kio)`);
      return { errors: L.errors, warnings: L.warnings };
    }
    try {
      raw = parseYaml(input, { maxAliasCount: LINT_LIMITS.yamlAliases, uniqueKeys: true });
    } catch (err) {
      L.err("yaml", "", `YAML illisible ou refusé : ${(err as Error).message.split("\n")[0]}`);
      return { errors: L.errors, warnings: L.warnings };
    }
  }
  if (!isObj(raw)) {
    L.err("yaml", "", "un module est un objet YAML");
    return { errors: L.errors, warnings: L.warnings };
  }
  const m = raw;

  // ── Tailles et profondeur (§ 11.3.3)
  const size = measure(m);
  if (size.depth > LINT_LIMITS.depth) L.err("depth", "", `imbrication trop profonde (${size.depth} niveaux, maximum ${LINT_LIMITS.depth}) : expressions ou conditions à simplifier`);
  if (size.nodes > LINT_LIMITS.nodes) L.err("size", "", `module trop volumineux (${size.nodes} nœuds, maximum ${LINT_LIMITS.nodes})`);
  const count = (x: unknown) => (Array.isArray(x) ? x.length : isObj(x) ? Object.keys(x).length : 0);
  const cap = (path: string, x: unknown, max: number, what: string) => {
    const c = count(x);
    if (c > max) L.err("size", path, `${c} ${what} (maximum ${max})`);
  };
  cap("attributes", m.attributes, LINT_LIMITS.attributes, "attributs");
  cap("tables", m.tables, LINT_LIMITS.tables, "tables");
  cap("conditions", m.conditions, LINT_LIMITS.conditions, "conditions");
  cap("card", m.card, LINT_LIMITS.card, "lignes de fiche");
  cap("segments", m.segments, LINT_LIMITS.segments, "segments");
  cap("requires", m.requires, LINT_LIMITS.requires, "dépendances");
  cap("eligibility_helpers", m.eligibility_helpers, LINT_LIMITS.eligibilityHelpers, "filtres prêts à l'emploi");
  cap("sources", m.sources, LINT_LIMITS.sources, "sources");
  if (isObj(m.validation)) {
    const v = m.validation;
    const n = count(v.margins) + count(v.plausibility) + count(v.shares);
    if (n > LINT_LIMITS.validationChecks) L.err("size", "validation", `${n} contrôles de validation (maximum ${LINT_LIMITS.validationChecks})`);
  }
  if (isObj(m.tables)) {
    for (const [name, t] of Object.entries(m.tables)) {
      if (!isObj(t)) continue;
      cap(`tables.${name}`, t.values ?? t.bands, LINT_LIMITS.tableEntries, "entrées");
      L.text(t.label, `tables.${name}.label`, "doc", TEXT_LIMITS.docLabel);
      L.text(t.justification, `tables.${name}.justification`, "doc", TEXT_LIMITS.justification);
    }
  }

  // ── Module
  L.text(m.label, "label", "label", TEXT_LIMITS.label);
  L.text(m.short_label, "short_label", "label", TEXT_LIMITS.short_label);
  L.text(m.description, "description", "prose", TEXT_LIMITS.description);
  for (const [i, c] of arr(m.changelog).entries()) for (const [j, ch] of arr(isObj(c) ? c.changes : []).entries()) L.text(ch, `changelog.${i}.changes.${j}`, "doc", TEXT_LIMITS.sourceText);
  if (isObj(m.sources)) {
    for (const [k, s] of Object.entries(m.sources)) {
      if (!isObj(s)) continue;
      // Les sources portent une URL par construction (champ `url`) : seuls les textes libres sont contrôlés, sans la règle URL.
      for (const f of ["org", "title", "detail"] as const) {
        const v = str(s[f]);
        if (v === undefined) continue;
        L.text(v.replace(URL_RE, " "), `sources.${k}.${f}`, "doc", TEXT_LIMITS.sourceText);
      }
    }
  }
  for (const [k, e] of Object.entries(isObj(m.eligibility_helpers) ? m.eligibility_helpers : {})) L.text(e, `eligibility_helpers.${k}`, "expr", TEXT_LIMITS.helper);

  // ── Attributs
  for (const [i, a] of arr(m.attributes).entries()) {
    if (!isObj(a)) continue;
    const at = `attributes.${i}`;
    const key = str(a.key) ?? "";
    L.text(a.label, `${at}.label`, "label", TEXT_LIMITS.attrLabel);
    if (isObj(a.label)) for (const [g, l] of Object.entries(a.label)) L.text(l, `${at}.label.${g}`, "label", TEXT_LIMITS.attrLabel);
    L.text(a.description, `${at}.description`, "prose", TEXT_LIMITS.attrDescription);
    L.text(a.justification, `${at}.justification`, "doc", TEXT_LIMITS.justification);
    L.text(a.unit, `${at}.unit`, "label", TEXT_LIMITS.unit);
    L.text(a.sensitive_justification, `${at}.sensitive_justification`, "doc", TEXT_LIMITS.justification);
    if (isObj(a.display)) {
      L.text(a.display.template, `${at}.display.template`, "label", TEXT_LIMITS.displayTemplate);
      L.text(a.display.empty, `${at}.display.empty`, "label", TEXT_LIMITS.displayEmpty);
      L.text(a.display.separator, `${at}.display.separator`, "label", 10);
    }
    if (isObj(a.labels)) for (const [k, l] of Object.entries(a.labels)) L.text(l, `${at}.labels.${k}`, "label", TEXT_LIMITS.valueLabel);
    cap(`${at}.values`, a.values, LINT_LIMITS.enumValues, "valeurs");
    for (const [j, v] of arr(a.values).entries()) {
      if (!isObj(v)) continue;
      if (typeof v.label === "string") L.text(v.label, `${at}.values.${j}.label`, "label", TEXT_LIMITS.valueLabel);
      else if (isObj(v.label)) for (const [g, l] of Object.entries(v.label)) L.text(l, `${at}.values.${j}.label.${g}`, "label", TEXT_LIMITS.valueLabel);
    }
    cap(`${at}.items`, a.items, LINT_LIMITS.setItems, "options");
    for (const [j, it] of arr(a.items).entries()) {
      if (!isObj(it)) continue;
      L.text(it.label, `${at}.items.${j}.label`, "label", TEXT_LIMITS.valueLabel);
      L.text(it.card_label, `${at}.items.${j}.card_label`, "label", TEXT_LIMITS.valueLabel);
      if (isObj(it.subscription)) L.text(it.subscription.name, `${at}.items.${j}.subscription.name`, "label", TEXT_LIMITS.subscriptionName);
    }
    if (typeof a.max_items === "number" && a.max_items > LINT_LIMITS.setItems) L.err("size", `${at}.max_items`, `max_items ${a.max_items} (maximum ${LINT_LIMITS.setItems})`);

    // Psychographies : clé et variables du socle
    const k = normalizeText(key);
    if (PSYCHO_KEYS.has(k) || PSYCHO_KEY.test(k)) {
      L.err("psychographic", `${at}.key`, `« ${key} » double une psychographie du socle (scepticisme, sensibilité au prix, tonalité) ou la décision mesurée par l'étude : un module ne la modifie pas`);
    } else if (PSYCHO_WEAK_KEY.test(k)) {
      L.warn("psychographic", `${at}.key`, `« ${key} » : vérifier qu'il s'agit d'une attitude propre au domaine, pas du scepticisme général du socle`);
    }
    for (const s of collectStrings(a)) if (PSYCHO_SOCLE_VARS.test(s)) L.err("psychographic", at, `« ${s} » : les psychographies du socle ne sont pas exposées aux modules`);
  }
  for (const s of collectStrings({ c: m.conditions, o: m.socle_overrides })) if (PSYCHO_SOCLE_VARS.test(s)) L.err("psychographic", "conditions", `« ${s} » : les psychographies du socle ne sont pas exposées aux modules`);
  if (isObj(m.socle_overrides)) {
    for (const k of Object.keys(m.socle_overrides)) {
      if (PSYCHO_KEYS.has(k) || PSYCHO_KEY.test(k) || PSYCHO_WEAK_KEY.test(k)) L.err("psychographic", `socle_overrides.${k}`, "un module ne remplace pas les psychographies du socle");
    }
  }

  // ── Fiche
  for (const [i, c] of arr(m.card).entries()) {
    if (typeof c === "string") L.text(c, `card.${i}`, "label", TEXT_LIMITS.cardLine);
    else if (isObj(c)) L.text(c.template, `card.${i}.template`, "label", TEXT_LIMITS.cardLine);
  }
  for (const [i, s] of arr(m.segments).entries()) if (isObj(s)) L.text(s.label, `segments.${i}.label`, "label", TEXT_LIMITS.segmentLabel);
  if (isObj(m.validation)) {
    for (const part of ["margins", "plausibility", "shares"] as const) {
      for (const [i, v] of arr(m.validation[part]).entries()) {
        if (!isObj(v)) continue;
        L.text(v.title ?? v.label, `validation.${part}.${i}.${v.title !== undefined ? "title" : "label"}`, "doc", TEXT_LIMITS.docLabel);
      }
    }
  }

  // ── Attributs sensibles (§ 11.4)
  for (const s of sensitiveAttributes(m)) {
    const idx = arr(m.attributes).findIndex((a) => isObj(a) && a.key === s.key);
    const at = `attributes.${idx}`;
    const cats = s.categories.map((c) => SENSITIVE_CATEGORY_LABELS[c]).join(", ");
    if (s.categories.length && !s.declared) {
      L.err("sensitive", `${at}.sensitive`, `attribut « ${s.key} » sensible (${cats} ; détecté par : ${s.reasons.join(", ")}) : déclarer \`sensitive: true\` et une \`sensitive_justification\` d'usage (RGPD art. 9)`);
    } else if (s.declared && (!s.justification || s.justification.length < 20)) {
      L.err("sensitive", `${at}.sensitive_justification`, `attribut « ${s.key} » déclaré sensible : \`sensitive_justification\` exigée (au moins 20 caractères : pourquoi cet attribut est nécessaire, quels stéréotypes sont évités)`);
    }
  }
  return { errors: L.errors, warnings: L.warnings };
}

/** Texte d'une liste de problèmes (CLI, messages d'erreur). */
export function formatIssues(issues: Issue[]): string {
  return issues.map((i) => `  - ${i.path ? `${i.path} : ` : ""}${i.message} [${i.code}]`).join("\n");
}
