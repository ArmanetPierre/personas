import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useDict } from "./i18n";
import { chartsDict } from "./i18n/charts";

/** Tâche détachée du tableau de bord (src/web/launcher.ts) : état lu par /api/jobs/:key. */
export interface JobState {
  key: string;
  pid: number | null;
  alive: boolean;
  startedAt: string | null;
  log: string;
}

/**
 * Suivi d'une tâche : relit l'état toutes les 3 s tant qu'elle tourne, et appelle `onDone` à la fin
 * (une seule fois par lancement). `initial` vient de la route qui renvoie le résultat en cache.
 */
export function useJob(key: string | null, initial: JobState | null | undefined, onDone: () => void) {
  const [job, setJob] = useState<JobState | null>(initial ?? null);
  const done = useRef(onDone);
  done.current = onDone;
  const was = useRef(Boolean(initial?.alive));
  useEffect(() => {
    if (initial) {
      setJob(initial);
      was.current = was.current || initial.alive;
    }
  }, [initial]);
  useEffect(() => {
    if (!key || !job?.alive) return;
    const t = setInterval(async () => {
      try {
        const j = await api<JobState>(`/jobs/${key}`);
        setJob(j);
        if (was.current && !j.alive) {
          was.current = false;
          done.current();
        }
      } catch {
        // nouvel essai au tour suivant
      }
    }, 3000);
    return () => clearInterval(t);
  }, [key, job?.alive]);
  const started = (j: { key: string; startedAt: string; pid: number }) => {
    was.current = true;
    setJob({ key: j.key, pid: j.pid, alive: true, startedAt: j.startedAt, log: "" });
  };
  return { job, started };
}

export function useElapsedSince(since: string | null | undefined, active: boolean): string {
  const t = useDict(chartsDict).jobs;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!since) return "";
  const s = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  return s < 60 ? t.seconds(s) : t.minutes(Math.floor(s / 60), String(s % 60).padStart(2, "0"));
}

/** Panneau d'une tâche en cours ou terminée en échec : temps écoulé, dernière ligne du journal, journal complet. */
export function JobPanel({ job, label, hint }: { job: JobState | null; label: string; hint?: string }) {
  const t = useDict(chartsDict).jobs;
  const elapsed = useElapsedSince(job?.startedAt, Boolean(job?.alive));
  if (!job) return null;
  const lines = job.log.split("\n").filter((l) => l.trim());
  const failed = !job.alive && /Échec|Error|erreur/i.test(lines.slice(-3).join(" "));
  if (!job.alive && !failed) return null;
  return (
    <div className={job.alive ? "panel" : "error-box"} style={{ marginTop: 12 }} role="status">
      {job.alive ? (
        <div className="working">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <b>{label}</b>
            {elapsed && <span className="muted num">{t.since(elapsed)}</span>}
            {lines.length > 0 && <span className="small ink2">{t.lastLine(lines.at(-1)!.slice(0, 160))}</span>}
          </span>
        </div>
      ) : (
        <p>{t.failed(lines.slice(-2).join(" "))}</p>
      )}
      {hint && job.alive && <p className="small muted" style={{ marginTop: 6 }}>{hint}</p>}
      {job.log && (
        <details style={{ marginTop: 8 }}>
          <summary className="small ink2" style={{ cursor: "pointer" }}>{t.log}</summary>
          <pre className="log">{job.log}</pre>
        </details>
      )}
    </div>
  );
}
