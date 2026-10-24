import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { accountStatus } from "../hub/auth";
import { HubClient } from "../hub/client";
import { errorText, t } from "./i18n";

/** Compte du Hub connecté (GET /v1/me) : personas hub whoami [--json]. Le jeton n'est jamais affiché. */

const { values } = parseArgs({ options: { json: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.log(t.hub.whoamiUsage);
  process.exit(0);
}
loadDotEnv();
try {
  const s = await accountStatus(new HubClient());
  if (values.json) {
    console.log(JSON.stringify({ hubUrl: s.hubUrl, connected: !!s.me, tokenSource: s.tokenSource, rejected: s.rejected, ...(s.offline && { offline: s.offline }), me: s.me }, null, 1));
  } else if (!s.tokenStored) {
    console.log(t.hub.notLoggedIn);
    process.exitCode = 2;
  } else if (s.rejected) {
    console.log(t.hub.tokenRejected);
    process.exitCode = 2;
  } else if (!s.me) {
    console.log(t.hub.whoamiOffline(s.offline ?? "", s.lastKnown?.namespace ?? "?"));
    process.exitCode = 1;
  } else {
    console.log(t.hub.hubUrl(s.hubUrl));
    console.log(t.hub.whoami(s.me.displayName ?? s.me.githubLogin ?? s.me.namespace, s.me.namespace, s.me.role, s.me.scopes.join(", "), t.hub.personalTokenSources[s.tokenSource ?? ""] ?? "-"));
  }
} catch (err) {
  console.error(t.common.error(errorText(err)));
  process.exitCode = 1;
}
