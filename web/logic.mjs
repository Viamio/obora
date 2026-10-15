// Wspólna logika terminów – używa jej aplikacja (przeglądarka) i automat powiadomień (GitHub Actions).
// Daty jako tekst "rrrr-mm-dd". Liczone w strefie Europe/Warsaw.

export const GESTATION = 280;
export const CYCLE = 21;
export const DEFAULT_CFG = { dry: 60, move: 10, check: 35, vwp: 60, ahead: 3, hour: 6 };
const DAY = 86400000;

export function todayISO(tz = "Europe/Warsaw") {
  // "sv-SE" daje format rrrr-mm-dd
  return new Date().toLocaleDateString("sv-SE", { timeZone: tz });
}
const P = (s) => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); if (!y || !m || !d) return null; return Date.UTC(y, m - 1, d); };
const iso = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (s, n) => { const t = P(s); return t == null ? null : iso(t + n * DAY); };
export const daysBetween = (a, b) => Math.round((P(b) - P(a)) / DAY);
export function fmt(s) { if (!s) return "—"; const [y, m, d] = s.split("-"); return `${d}.${m}.${y}`; }
export function dni(n) { n = Math.abs(n); return n === 1 ? "1 dzień" : `${n} dni`; }
export function kiedy(n) { return n === 0 ? "dziś" : n === 1 ? "jutro" : n > 0 ? `za ${dni(n)}` : `${dni(n)} temu`; }
export function zadania(n) {
  const m10 = n % 10, m100 = n % 100;
  if (n === 1) return "zadanie";
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return "zadania";
  return "zadań";
}
export function cfgOf(d) { return { ...DEFAULT_CFG, ...(d || {}) }; }

/** Ciąża trwa: zacielenie późniejsze niż ostatnie wycielenie i nie stwierdzono "niecielna". */
export function pregnant(c) {
  if (!c.zacielenie || c.cielna === "nie") return false;
  return !c.wycielenie || c.zacielenie > c.wycielenie;
}
export const due = (c) => (pregnant(c) ? addDays(c.zacielenie, GESTATION) : null);
export const dryDate = (c, cfg) => { const d = due(c); return d ? addDays(d, -cfg.dry) : null; };
export const moveDate = (c, cfg) => { const d = due(c); return d ? addDays(d, -cfg.move) : null; };
export const checkDate = (c, cfg) => (pregnant(c) && !c.cielna ? addDays(c.zacielenie, cfg.check) : null);
export function nextRuja(c, today = todayISO()) {
  if (!c.ruja || (c.cielna === "tak" && pregnant(c))) return null;
  let r = addDays(c.ruja, CYCLE);
  while (r < today) r = addDays(r, CYCLE);
  return r;
}
export function insemDate(c, cfg) {
  if (!c.wycielenie) return null;
  if (c.zacielenie && c.zacielenie > c.wycielenie) return null;
  return addDays(c.wycielenie, cfg.vwp);
}

/** Lista zadań posortowana od najpilniejszych. */
export function alerts(cows, cfg, ahead, dueAhead, today = todayISO()) {
  const out = [];
  const push = (c, kind, date, title, sub, limit = ahead) => {
    if (!date) return;
    const n = daysBetween(today, date);
    if (n <= limit) out.push({ cow: c, kind, date, n, title, sub });
  };
  for (const c of cows) {
    push(c, "insem", insemDate(c, cfg), "Zacielić", `Gotowa od ${fmt(insemDate(c, cfg))} (${cfg.vwp} dni po wycieleniu)`);
    push(c, "ruja", nextRuja(c, today), "Spodziewana ruja", `${fmt(nextRuja(c, today))} (21 dni od poprzedniej)`);
    push(c, "check", checkDate(c, cfg), "Sprawdzić czy cielna", `${fmt(checkDate(c, cfg))} (${cfg.check} dni po zacieleniu)`);
    if (!c.zasuszona) push(c, "dry", dryDate(c, cfg), "Zasuszyć", `${fmt(dryDate(c, cfg))} (${cfg.dry} dni przed porodem)`);
    if (!c.przegnana) push(c, "move", moveDate(c, cfg), "Przegnać na porodówkę", `${fmt(moveDate(c, cfg))} (${cfg.move} dni przed porodem)`);
    const d = due(c);
    if (d) {
      const n = daysBetween(today, d);
      push(c, "due", d, n < 0 ? "Po terminie wycielenia" : "Wycielenie", `Termin ${fmt(d)}`, dueAhead);
    }
  }
  return out.sort((a, b) => a.n - b.n);
}
