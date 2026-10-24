import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * Ressources statiques des pages publiques : une feuille de style (jetons partagés avec le tableau de
 * bord, web/src/tokens.css, puis hub.css) et les polices variables du tableau de bord, servies par le
 * Hub lui-même (CSP : style-src et font-src 'self', aucun style en ligne).
 */

const ROOT = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

/** Polices servies : sous-ensembles latin et latin étendu, comme le tableau de bord. */
const FONT_PACKAGES = {
  "Bricolage Grotesque Variable": { pkg: "@fontsource-variable/bricolage-grotesque", stem: "bricolage-grotesque", weight: "200 800" },
  "Public Sans Variable": { pkg: "@fontsource-variable/public-sans", stem: "public-sans", weight: "100 900" },
} as const;
const SUBSETS = {
  latin: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
} as const;

export interface Asset {
  body: Uint8Array;
  type: string;
  etag: string;
}

const digest = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex").slice(0, 16);

function loadFonts(): Map<string, Asset> {
  const out = new Map<string, Asset>();
  for (const { pkg, stem } of Object.values(FONT_PACKAGES)) {
    const dir = join(dirname(require.resolve(`${pkg}/package.json`)), "files");
    for (const subset of Object.keys(SUBSETS)) {
      const name = `${stem}-${subset}-wght-normal.woff2`;
      const body = readFileSync(join(dir, name));
      out.set(name, { body, type: "font/woff2", etag: `"${digest(body)}"` });
    }
  }
  return out;
}

function fontFaces(): string {
  return Object.entries(FONT_PACKAGES)
    .flatMap(([family, { stem, weight }]) =>
      Object.entries(SUBSETS).map(
        ([subset, range]) =>
          `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weight};src:url(/assets/fonts/${stem}-${subset}-wght-normal.woff2) format("woff2-variations");unicode-range:${range}}`,
      ),
    )
    .join("\n");
}

/** Largeurs des barres en classes (w-0 à w-100) : pas d'attribut style, donc pas de 'unsafe-inline'. */
const widthClasses = () => Array.from({ length: 101 }, (_, i) => `.w-${i}{width:${i}%}`).join("");

export function buildCss(): string {
  const tokens = readFileSync(join(ROOT, "web/src/tokens.css"), "utf8");
  const hub = readFileSync(join(import.meta.dirname, "hub.css"), "utf8");
  return `${fontFaces()}\n${tokens}\n${hub}\n${widthClasses()}\n`;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#17202a"/><g fill="#c4c8c1"><circle cx="16" cy="9" r="3"/><circle cx="23" cy="9" r="3"/><circle cx="9" cy="16" r="3"/><circle cx="16" cy="16" r="3"/><circle cx="23" cy="16" r="3"/></g><circle cx="9" cy="9" r="3" fill="#3987e5"/></svg>`;

export function loadAssets() {
  const css = buildCss();
  const cssBody = new TextEncoder().encode(css);
  const cssHash = digest(cssBody);
  const files = new Map<string, Asset>();
  files.set("hub.css", { body: cssBody, type: "text/css; charset=utf-8", etag: `"${cssHash}"` });
  for (const [name, a] of loadFonts()) files.set(`fonts/${name}`, a);
  const fav = new TextEncoder().encode(FAVICON);
  files.set("favicon.svg", { body: fav, type: "image/svg+xml", etag: `"${digest(fav)}"` });
  const js = new TextEncoder().encode(readFileSync(join(import.meta.dirname, "device.js"), "utf8"));
  const jsHash = digest(js);
  files.set("device.js", { body: js, type: "text/javascript; charset=utf-8", etag: `"${jsHash}"` });
  return { files, cssHref: `/assets/hub.css?v=${cssHash}`, faviconHref: "/assets/favicon.svg", deviceJsHref: `/assets/device.js?v=${jsHash}` };
}
