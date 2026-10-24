import type { Persona } from "../../db/schema";
import { extraOf } from "../../personas/describe";

/**
 * Vérification légère des faits personnels affirmés dans une réponse (enfants, conjoint,
 * entreprise, statut d'emploi), comparés à la fiche et au récit. Volontairement prudente :
 * on ne signale que des mentions explicites à la première personne, et un fait présent
 * dans le récit est toujours accepté.
 */

export interface FactIssue {
  code: "invented_child" | "child_gender_mismatch" | "invented_partner" | "invented_business" | "invented_job_status";
  detail: string;
}

/** Textes libres d'une réponse, quelle que soit sa forme. */
export function answerTexts(answer: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(answer);
  return out.join("\n").replace(/’/g, "'");
}

const SON = /\b(mon|mes) fils\b/i;
const DAUGHTER = /\b(ma|mes) filles?\b/i;
const CHILD = /\b(mes (enfants|gosses|gamins|gamines|ados|petits)|mon (enfant|bébé|gosse|gamin|ado)|ma (gamine|môme)|mon môme)\b/i;
const HUSBAND = /\b(mon mari|mon époux|mon compagnon|mon conjoint)\b/i;
const WIFE = /\b(ma femme|mon épouse|ma compagne|ma conjointe)\b/i;
const OWN_BUSINESS =
  /\b(ma propre (boîte|entreprise|société|affaire|structure)|mon (propre )?commerce|mon cabinet|mon entreprise à moi|je suis (mon propre patron|ma propre patronne|à mon compte|indépendante?|freelance|auto-?entrepreneuse?|micro-?entrepreneuse?|cheffe? d'entreprise|gérante? de)|j'ai (déjà )?(créé|monté|lancé|fondé) (ma|mon|une) (boîte|entreprise|société|affaire|start-?up))/i;
const WORK_TIES = /(?<!(ancien|anciens|anciennes|ex-|ex) )\b(mon patron|ma patronne|mon employeur|mes collègues|mon chef|ma cheffe|ma hiérarchie)\b/i;
const SAYS_RETIRED = /\bje suis (à la retraite|retraitée?)\b/i;
const SAYS_UNEMPLOYED = /\bje suis (au chômage|demandeuse d'emploi|demandeur d'emploi|sans emploi)\b/i;
const SAYS_STUDENT = /\bje suis (étudiante?|en études)\b/i;

const SELF_EMPLOYED_RE = /indépendant|chef|cheffe|artisan|commerçant|libéral|exploitant|freelance|dirigeant|gérant|fondat|auto-?entrepreneur|micro-?entrepreneur|à son compte/i;

export function checkFacts(answer: unknown, p: Persona, locale: "fr" | "en" = "fr"): FactIssue[] {
  if (locale === "en") return checkFactsEn(answer, p);
  const text = answerTexts(answer);
  const narrative = (p.narrative ?? "").replace(/’/g, "'");
  const x = extraOf(p);
  const issues: FactIssue[] = [];
  const quote = (re: RegExp) => `« ${re.exec(text)?.[0] ?? ""} »`;

  // Enfants
  const nKids = x.childrenAges?.length ?? 0;
  const narrKids = /\b(enfants?|fils|fille|filles|bébé|ados?)\b/i.test(narrative);
  const mentionsKid = SON.test(text) || DAUGHTER.test(text) || CHILD.test(text);
  if (mentionsKid && nKids === 0 && !narrKids) {
    issues.push({ code: "invented_child", detail: `${quote(SON.test(text) ? SON : DAUGHTER.test(text) ? DAUGHTER : CHILD)} : ta fiche n'indique aucun enfant.` });
  } else if (nKids <= 1) {
    const narrSon = /\b(son|un|leur) fils\b/i.test(narrative);
    const narrDaughter = /\b(sa|une|leur) fille\b/i.test(narrative);
    if (SON.test(text) && narrDaughter && !narrSon) {
      issues.push({ code: "child_gender_mismatch", detail: `${quote(SON)} : ton portrait parle de ta fille.` });
    } else if (DAUGHTER.test(text) && narrSon && !narrDaughter) {
      issues.push({ code: "child_gender_mismatch", detail: `${quote(DAUGHTER)} : ton portrait parle de ton fils.` });
    }
  }

  // Conjoint
  const partner = x.partner;
  const narrPartner = /\b(conjoint|conjointe|compagnon|compagne|mari|époux|épouse|femme de|en couple)\b/i.test(narrative);
  for (const [re, sex] of [[HUSBAND, "M"], [WIFE, "F"]] as const) {
    if (!re.test(text)) continue;
    if (!partner && !narrPartner) issues.push({ code: "invented_partner", detail: `${quote(re)} : ta fiche n'indique pas de conjoint.` });
    else if (partner && partner.sex !== sex && /mari|époux|femme|épouse/i.test(quote(re))) {
      issues.push({ code: "invented_partner", detail: `${quote(re)} : ta fiche indique ${partner.sex === "F" ? "une conjointe" : "un conjoint"}.` });
    }
  }

  // Entreprise à soi
  const selfEmployed =
    p.pcs === "2" ||
    // Le libellé de situation porte aussi le statut imposé par un module (« … — freelance en micro-entreprise »).
    SELF_EMPLOYED_RE.test(p.occupation) ||
    /\b(sa|son) (propre )?(boîte|entreprise|société|commerce|cabinet|affaire)\b|à son compte|indépendant|freelance/i.test(narrative);
  if (OWN_BUSINESS.test(text) && !selfEmployed) {
    issues.push({ code: "invented_business", detail: `${quote(OWN_BUSINESS)} : ta fiche ne dit pas que tu es à ton compte ou que tu as une entreprise.` });
  }

  // Statut d'emploi
  const status = p.activityStatus ?? "";
  if (["retired", "unemployed", "inactive"].includes(status) && WORK_TIES.test(text) && !/collègue|patron|employeur|chef/i.test(narrative)) {
    issues.push({ code: "invented_job_status", detail: `${quote(WORK_TIES)} : tu n'es pas en emploi.` });
  }
  if (SAYS_RETIRED.test(text) && status !== "retired") issues.push({ code: "invented_job_status", detail: `${quote(SAYS_RETIRED)} : tu n'es pas à la retraite.` });
  if (SAYS_UNEMPLOYED.test(text) && status !== "unemployed") issues.push({ code: "invented_job_status", detail: `${quote(SAYS_UNEMPLOYED)} : tu n'es pas au chômage.` });
  if (SAYS_STUDENT.test(text) && status !== "student") issues.push({ code: "invented_job_status", detail: `${quote(SAYS_STUDENT)} : tu n'es pas étudiant·e.` });
  return issues;
}

// ─── Anglais (études en locale `en`) ──────────────────────────────────────────

const SON_EN = /\b(my|our) sons?\b/i;
const DAUGHTER_EN = /\b(my|our) daughters?\b/i;
const CHILD_EN = /\b(my|our) (kids?|children|child|baby|toddler|teenagers?|teens?|little ones?)\b/i;
const HUSBAND_EN = /\b(my husband|my hubby|my boyfriend)\b/i;
const WIFE_EN = /\b(my wife|my missus|my girlfriend)\b/i;
const PARTNER_EN = /\b(my partner|my spouse|my other half)\b/i;
const OWN_BUSINESS_EN =
  /\b(my own (business|company|firm|shop|stall|start-?up)|my (business|company|shop|stall|start-?up)\b|i('m| am) (self-employed|my own boss|a freelancer|freelancing|running my own)|i (run|own|started|founded|set up) (a|my|our) (business|company|shop|stall|start-?up|firm))/i;
const WORK_TIES_EN = /(?<!(former|ex-|old) )\b(my boss|my employer|my colleagues|my manager|my supervisor|my co-?workers)\b/i;
const SAYS_RETIRED_EN = /\bi('m| am) (retired|a retiree)\b/i;
const SAYS_UNEMPLOYED_EN = /\bi('m| am) (unemployed|out of work|between jobs|jobless)\b/i;
const SAYS_STUDENT_EN = /\bi('m| am) (a )?(full-time )?(student|studying)\b/i;
const SELF_EMPLOYED_EN = /self-employed|own account|freelance|business owner|proprietor|hawker stall owner|employer/i;

/** Même contrôle que la version française, sur des réponses en anglais ; détails en anglais. */
function checkFactsEn(answer: unknown, p: Persona): FactIssue[] {
  const text = answerTexts(answer);
  const narrative = (p.narrative ?? "").replace(/’/g, "'");
  const x = extraOf(p) as ReturnType<typeof extraOf> & { nationalService?: boolean };
  const issues: FactIssue[] = [];
  const quote = (re: RegExp) => `“${re.exec(text)?.[0] ?? ""}”`;

  const nKids = x.childrenAges?.length ?? 0;
  const narrKids = /\b(child|children|kids?|sons?|daughters?|baby|teens?)\b/i.test(narrative);
  const mentionsKid = SON_EN.test(text) || DAUGHTER_EN.test(text) || CHILD_EN.test(text);
  if (mentionsKid && nKids === 0 && !narrKids) {
    issues.push({ code: "invented_child", detail: `${quote(SON_EN.test(text) ? SON_EN : DAUGHTER_EN.test(text) ? DAUGHTER_EN : CHILD_EN)}: your profile shows no child.` });
  } else if (nKids <= 1) {
    const narrSon = /\b(his|her|their|a) son\b/i.test(narrative);
    const narrDaughter = /\b(his|her|their|a) daughter\b/i.test(narrative);
    if (SON_EN.test(text) && narrDaughter && !narrSon) issues.push({ code: "child_gender_mismatch", detail: `${quote(SON_EN)}: your portrait talks about your daughter.` });
    else if (DAUGHTER_EN.test(text) && narrSon && !narrDaughter) issues.push({ code: "child_gender_mismatch", detail: `${quote(DAUGHTER_EN)}: your portrait talks about your son.` });
  }

  const partner = x.partner;
  const narrPartner = /\b(husband|wife|partner|spouse|boyfriend|girlfriend|married)\b/i.test(narrative);
  for (const [re, sex] of [[HUSBAND_EN, "M"], [WIFE_EN, "F"], [PARTNER_EN, null]] as const) {
    if (!re.test(text)) continue;
    if (!partner && !narrPartner) issues.push({ code: "invented_partner", detail: `${quote(re)}: your profile shows no partner.` });
    else if (partner && sex && partner.sex !== sex) issues.push({ code: "invented_partner", detail: `${quote(re)}: your profile shows ${partner.sex === "F" ? "a female partner" : "a male partner"}.` });
  }

  const selfEmployed =
    SELF_EMPLOYED_EN.test(p.occupation) || /\b(his|her|their) (own )?(business|company|shop|stall|firm)\b|self-employed|freelance/i.test(narrative);
  if (OWN_BUSINESS_EN.test(text) && !selfEmployed) {
    issues.push({ code: "invented_business", detail: `${quote(OWN_BUSINESS_EN)}: your profile does not say you are self-employed or own a business.` });
  }

  const status = p.activityStatus ?? "";
  if (["retired", "unemployed", "inactive"].includes(status) && !x.nationalService && WORK_TIES_EN.test(text) && !/colleague|boss|employer|manager/i.test(narrative)) {
    issues.push({ code: "invented_job_status", detail: `${quote(WORK_TIES_EN)}: you are not in employment.` });
  }
  if (SAYS_RETIRED_EN.test(text) && status !== "retired") issues.push({ code: "invented_job_status", detail: `${quote(SAYS_RETIRED_EN)}: you are not retired.` });
  if (SAYS_UNEMPLOYED_EN.test(text) && status !== "unemployed") issues.push({ code: "invented_job_status", detail: `${quote(SAYS_UNEMPLOYED_EN)}: you are not unemployed.` });
  if (SAYS_STUDENT_EN.test(text) && status !== "student") issues.push({ code: "invented_job_status", detail: `${quote(SAYS_STUDENT_EN)}: you are not a student.` });
  return issues;
}
