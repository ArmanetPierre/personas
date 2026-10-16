import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Route, Switch } from "wouter";
import "./styles.css";
import { ComparePage } from "./pages/Compare";
import { ModulePage } from "./pages/Module";
import { ModulesPage, NewModulePage } from "./pages/Modules";
import { PersonaPage } from "./pages/Persona";
import { PersonasPage } from "./pages/Personas";
import { ProtocolReviewPage } from "./pages/ProjectP1";
import { ProjectPitchReviewPage } from "./pages/ProjectPitch";
import { ProjectOfferPage, ProjectOverviewPage, ProjectProtocolPage, ProjectStudiesPage, ProjectTargetPage } from "./pages/ProjectHub";
import { ProjectsPage } from "./pages/Projects";
import { ResponsePage } from "./pages/Response";
import { StudyBrakesPage, StudyOverviewPage, StudyPricePage, StudyReactionsPage, StudyRecommendationsPage, StudySegmentsPage, StudyTechPage, StudyVerbatimsPage } from "./pages/StudyHub";
import { Layout } from "./ui";
import { LocaleKeyed, LocaleProvider, useDict } from "./i18n";
import { commonDict } from "./i18n/common";

function NotFound() {
  const t = useDict(commonDict).notFound;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="lede" style={{ marginTop: 12 }}>{t.body}</p>
    </>
  );
}

function App() {
  return (
    <LocaleProvider>
    <Layout>
      <LocaleKeyed>
      <Switch>
        <Route path="/" component={ProjectsPage} />
        <Route path="/projets/:id/protocole/revue">{(p) => <ProtocolReviewPage id={p.id} />}</Route>
        <Route path="/projets/:id/protocole">{(p) => <ProjectProtocolPage key={p.id} id={p.id} />}</Route>
        <Route path="/projets/:id/cible">{(p) => <ProjectTargetPage key={p.id} id={p.id} />}</Route>
        <Route path="/projets/:id/offre/pitch">{(p) => <ProjectPitchReviewPage key={p.id} id={p.id} />}</Route>
        <Route path="/projets/:id/offre">{(p) => <ProjectOfferPage key={p.id} id={p.id} />}</Route>
        <Route path="/projets/:id/etudes">{(p) => <ProjectStudiesPage key={p.id} id={p.id} />}</Route>
        <Route path="/projets/:id">{(p) => <ProjectOverviewPage key={p.id} id={p.id} />}</Route>
        <Route path="/etudes/:id/reponses/:personaId">{(p) => <ResponsePage studyId={p.id} personaId={p.personaId} />}</Route>
        <Route path="/etudes/:id/recommandations">{(p) => <StudyRecommendationsPage key={p.id} id={p.id} />}</Route>
        <Route path="/etudes/:id/reactions">{(p) => <StudyReactionsPage key={p.id} id={p.id} />}</Route>
        <Route path="/etudes/:id/segments">{(p) => <StudySegmentsPage key={p.id} id={p.id} />}</Route>
        <Route path="/etudes/:id/prix">{(p) => <StudyPricePage key={p.id} id={p.id} />}</Route>
        <Route path="/etudes/:id/freins">{(p) => <StudyBrakesPage key={p.id} id={p.id} />}</Route>
        <Route path="/etudes/:id/verbatims">{(p) => <StudyVerbatimsPage key={p.id} id={p.id} />}</Route>
        <Route path="/etudes/:id/technique">{(p) => <StudyTechPage key={p.id} id={p.id} />}</Route>
        <Route path="/etudes/:id">{(p) => <StudyOverviewPage key={p.id} id={p.id} />}</Route>
        <Route path="/comparer" component={ComparePage} />
        <Route path="/personas/:id">{(p) => <PersonaPage id={p.id} />}</Route>
        <Route path="/personas" component={PersonasPage} />
        <Route path="/modules" component={ModulesPage} />
        <Route path="/modules/nouveau" component={NewModulePage} />
        <Route path="/modules/:id">{(p) => <ModulePage key={p.id} id={p.id} />}</Route>
        <Route path="/brouillons/:id">{(p) => <ModulePage key={`brouillon-${p.id}`} id={p.id} draft />}</Route>
        <Route component={NotFound} />
      </Switch>
      </LocaleKeyed>
    </Layout>
    </LocaleProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
