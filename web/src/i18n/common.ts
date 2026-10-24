import { defineDict } from "./index";

/** Textes communs : coquille, navigation, statuts, états de chargement. */
export const commonDict = defineDict(
  {
    nav: { projects: "Projets", compare: "Comparer des études", personas: "Personas", modules: "Modules", main: "Navigation principale", setup: "Configurer le moteur" },
    brandHome: "Personas, accueil",
    theme: { label: "Thème", auto: "Auto", light: "Clair", dark: "Sombre" },
    loading: "Chargement",
    status: {
      draft: "Brouillon",
      running: "En cours",
      paused: "En pause",
      completed: "Terminée",
      failed: "Échec",
      interrupted: "Interrompue",
    } as Record<string, string>,
    notFound: { title: "Page introuvable", body: "Cette adresse ne correspond à aucun écran. Revenir à la liste des projets depuis le menu." },
    apiError: (status: number) => `Erreur ${status}`,
  },
  {
    nav: { projects: "Projects", compare: "Compare studies", personas: "Personas", modules: "Modules", main: "Main navigation", setup: "Configure the engine" },
    brandHome: "Personas, home",
    theme: { label: "Theme", auto: "Auto", light: "Light", dark: "Dark" },
    loading: "Loading",
    status: {
      draft: "Draft",
      running: "Running",
      paused: "Paused",
      completed: "Completed",
      failed: "Failed",
      interrupted: "Interrupted",
    },
    notFound: { title: "Page not found", body: "This address does not match any screen. Go back to the project list from the menu." },
    apiError: (status: number) => `Error ${status}`,
  },
);
