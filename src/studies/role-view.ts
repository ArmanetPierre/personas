import type { Project } from "../db/schema";
import { priceColumns, type ProjectExtra } from "./project";
import type { RolePrompt } from "./protocols/concept-price";
import { rolePricing, roleUsage, type RoleSpec } from "./roles";

/**
 * Vue d'un rôle : le projet tel que ce rôle le voit (pitch, prix, offre gratuite), et les paramètres du
 * prompt. Le prompt, le schéma, les paliers et les contrôles se calculent ensuite sur cette vue, avec les
 * fonctions du protocole (src/studies/protocols/concept-price.ts).
 */
export function roleProject(project: Project, role: RoleSpec): Project {
  const extra = (project.extra ?? {}) as ProjectExtra;
  let view: Project = { ...project, pitch: role.pitch?.trim() ?? project.pitch };
  if (role.freeOffer !== undefined) view = { ...view, freeOffer: role.freeOffer };
  if (role.price) {
    const cols = priceColumns({ price: role.price, ...(role.priceTiers && { priceTiers: role.priceTiers }), ...(role.freeOffer !== undefined && { freeOffer: role.freeOffer }) });
    const { pricing: _p, priceTiers: _t, ...rest } = extra;
    view = { ...view, priceEur: cols.priceEur, pricePeriod: cols.pricePeriod, freeOffer: role.freeOffer !== undefined ? role.freeOffer : cols.freeOffer, extra: { ...rest, ...cols.extra } };
  } else if (role.priceTiers) {
    view = { ...view, extra: { ...extra, priceTiers: role.priceTiers } };
  }
  return view;
}

export function rolePrompt(role: RoleSpec, roles: RoleSpec[]): RolePrompt {
  const dep = role.dependsOn ? roles.find((r) => r.id === role.dependsOn!.role) : undefined;
  return {
    id: role.id,
    perspective: role.perspective,
    label: role.label,
    intro: role.intro ?? null,
    pricing: rolePricing(role),
    usage: roleUsage(role),
    offerNote: role.offerNote ?? null,
    dependsOnLabel: dep?.label ?? null,
  };
}
