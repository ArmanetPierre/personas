import type { ReactNode } from "react";
import { Link } from "wouter";
import { intlLocale, useDict, useLocale, type Locale } from "../i18n";
import { hostedDict } from "../i18n/hosted";
import privacyEn from "../legal/privacy.en.md?raw";
import privacyFr from "../legal/privacy.fr.md?raw";
import termsEn from "../legal/terms.en.md?raw";
import termsFr from "../legal/terms.fr.md?raw";
import { parseLegal } from "../legal/parse";

/**
 * Pages légales du service hébergé (/confidentialite, /conditions), rédigées en Markdown (web/src/legal/) et
 * rendues ici en éléments React : titres, paragraphes, listes, gras, code, liens. Pas de HTML injecté.
 */

const TEXTS: Record<"privacy" | "terms", Record<Locale, string>> = {
  privacy: { fr: privacyFr, en: privacyEn },
  terms: { fr: termsFr, en: termsEn },
};

/** Gras, code et liens d'une ligne. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={k++}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<code key={k++}>{m[2]}</code>);
    else if (m[3] !== undefined && m[4] !== undefined)
      out.push(
        m[4].startsWith("/") ? (
          <Link key={k++} href={m[4]}>
            {m[3]}
          </Link>
        ) : (
          <a key={k++} href={m[4]} target="_blank" rel="noopener noreferrer">
            {m[3]}
          </a>
        ),
      );
    else if (m[5] !== undefined)
      out.push(
        <a key={k++} href={`mailto:${m[5]}`}>
          {m[5]}
        </a>,
      );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function LegalPage({ doc }: { doc: "privacy" | "terms" }) {
  const { locale } = useLocale();
  const t = useDict(hostedDict).legal;
  const { version, title, blocks } = parseLegal(TEXTS[doc][locale]);
  return (
    <article className="legal">
      <h1>{title}</h1>
      {version && <p className="small muted" style={{ marginTop: 8 }}>{t.version(new Date(`${version}T12:00:00`).toLocaleDateString(intlLocale(locale), { day: "numeric", month: "long", year: "numeric" }))}</p>}
      <div className="legal-body">
        {blocks.map((b, i) =>
          b.type === "ul" ? (
            <ul key={i}>
              {b.items.map((li, j) => (
                <li key={j}>{inline(li)}</li>
              ))}
            </ul>
          ) : b.type === "h2" ? (
            <h2 key={i}>{inline(b.text)}</h2>
          ) : (
            <p key={i}>{inline(b.text)}</p>
          ),
        )}
      </div>
    </article>
  );
}
