import { Link } from "wouter";
import { useApi, type PersonaCard } from "../api";
import { useDict } from "../i18n";
import { personasDict } from "../i18n/personas";
import { ErrorBox, Loading } from "../ui";
import { PersonaCardView } from "./PersonaCard";

export function PersonaPage({ id }: { id: string }) {
  const { data, error } = useApi<PersonaCard>(`/personas/${encodeURIComponent(id)}`);
  const t = useDict(personasDict);
  return (
    <>
      <div className="crumbs">
        <Link href="/personas">{t.crumb}</Link>
        <span>/</span>
        <span className="num">{id}</span>
      </div>
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && (
        <div className="panel" style={{ maxWidth: 860 }}>
          <PersonaCardView p={data} />
        </div>
      )}
    </>
  );
}
