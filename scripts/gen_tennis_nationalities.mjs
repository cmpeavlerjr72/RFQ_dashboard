// Generate public/tennis_nationalities.js — a STATIC name -> country map so
// tennis flags render even when the live ESPN scoreboard context is missing
// a fixture (or failed to load at all). Names on the dashboard resolve from
// Kalshi's own market data, so a name-keyed static map closes the flag gap
// without any code-collision risk.
//
// Source: ESPN atp/wta scoreboards swept over a wide date window (tournament
// payloads carry athlete.flag.href per competitor). Values are ESPN's
// 3-letter country tokens; the URL builder lives in the generated module.
//
// Run:  node dashboard/scripts/gen_tennis_nationalities.mjs
// (from the repo root; rerun every few weeks or when new names show up bare)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normAthleteName, allCompetitions } from "../public/teams.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "tennis_nationalities.js");
const DAYS_BACK = 30, DAYS_FWD = 7;

const dates = [];
for (let off = -DAYS_BACK; off <= DAYS_FWD; off++) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + off);
  dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
}

const byName = {};          // normalized full name -> country token
const byLast = {};          // normalized last word  -> token (unique only)
const lastClaim = {};       // last-word key -> full name that claimed it
const lastContested = new Set();
let players = 0;

for (const sport of ["atp", "wta"]) {
  for (const d of dates) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/tennis/${sport}/scoreboard?dates=${d}&limit=300`;
    let j;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      j = await r.json();
    } catch {
      continue;
    }
    for (const ev of j?.events || []) {
      for (const comp of allCompetitions(ev)) {
        for (const c of comp.competitors || []) {
          const display = c?.athlete?.displayName || c?.athlete?.fullName
            || c?.athletes?.[0]?.displayName || "";
          const href = c?.athlete?.flag?.href || c?.athletes?.[0]?.flag?.href || "";
          const tok = (href.match(/countries\/500\/([a-z]{2,4})\.png/i) || [])[1];
          if (!display || !tok) continue;
          const full = normAthleteName(display);
          if (!full) continue;
          if (!(full in byName)) players++;
          byName[full] = tok.toLowerCase();
          const words = display.trim().split(/\s+/);
          const lastK = normAthleteName(words[words.length - 1]);
          if (lastK && lastK !== full) {
            if (lastClaim[lastK] !== undefined && lastClaim[lastK] !== full) {
              lastContested.add(lastK);
            } else {
              lastClaim[lastK] = full;
              byLast[lastK] = tok.toLowerCase();
            }
          }
        }
      }
    }
    await new Promise((res) => setTimeout(res, 120));   // polite pacing
  }
}

// Merge unique last-word keys; full-name keys always win.
for (const [k, v] of Object.entries(byLast)) {
  if (!lastContested.has(k) && !(k in byName)) byName[k] = v;
}

const stamp = new Date().toISOString().slice(0, 10);
const body = `// AUTO-GENERATED ${stamp} by scripts/gen_tennis_nationalities.mjs — do not edit.
// STATIC tennis nationality map: normalized athlete name (accent/case/punct-
// free, word-order-free — see normAthleteName in teams.js) -> ESPN 3-letter
// country token. Includes unique last-word keys ("tabur" as well as
// "clementtabur"). Used by tennisPlayerFlag as the flag fallback when the
// live ESPN fixture context is missing — the NAME is already resolved from
// Kalshi's own market data, so a name-keyed lookup carries no collision risk.
// Regenerate: node dashboard/scripts/gen_tennis_nationalities.mjs
export const TENNIS_NATIONALITY = ${JSON.stringify(byName)};

export function tennisNationalityFlagUrl(tok) {
  return tok ? \`https://a.espncdn.com/i/teamlogos/countries/500/\${tok}.png\` : "";
}
`;
writeFileSync(OUT, body);
console.log(`wrote ${OUT}: ${players} players, ${Object.keys(byName).length} keys`);
