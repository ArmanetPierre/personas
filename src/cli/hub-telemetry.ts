import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { readHubSettings, setTelemetry } from "../hub/settings";
import { TELEMETRY_EXAMPLE } from "../hub/telemetry";
import { errorText, t } from "./i18n";

/**
 * Télémétrie opt-in (docs/plateforme.md § 11.2), désactivée par défaut.
 *
 *   personas hub telemetry on|off|status [--json]
 */

const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } } });
const action = positionals[0] ?? "status";
if (values.help || !["on", "off", "status"].includes(action)) {
  console.log(t.hub.telemetryUsage);
  process.exit(values.help ? 0 : 2);
}
loadDotEnv();
try {
  const s = action === "status" ? readHubSettings() : setTelemetry(action === "on");
  if (values.json) {
    console.log(JSON.stringify({ enabled: s.telemetry.enabled, pending: s.telemetry.pending.length, example: TELEMETRY_EXAMPLE }, null, 1));
  } else if (action === "on") {
    console.log(t.hub.telemetryOn);
    console.log(JSON.stringify(TELEMETRY_EXAMPLE, null, 1));
  } else if (action === "off") {
    console.log(t.hub.telemetryOff);
  } else {
    console.log(t.hub.telemetryStatus(s.telemetry.enabled, s.telemetry.pending.length));
  }
} catch (err) {
  console.error(t.common.error(errorText(err)));
  process.exitCode = 1;
}
