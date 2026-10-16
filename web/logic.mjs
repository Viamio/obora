// Wspólna logika terminów – używa jej aplikacja (przeglądarka) i automat powiadomień (GitHub Actions).
// Daty jako tekst "rrrr-mm-dd". Liczone w strefie Europe/Warsaw.

export const GESTATION = 280;
export const CYCLE = 21;
export const DEFAULT_CFG = { dry: 60, move: 10, check: 30, vwp: 60, ahead: 3, hour: 6, krycie: 14, zalegle: 30, miejsca: [] };
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
export const checkDate = (c, cfg) => (pregnant(c) && !c.cielna ? addDays(c.zacielenie2 || c.zacielenie, cfg.check) : null);
/** Drugie zacielenie (powtórka po rui): drugi możliwy termin porodu. */
export const due2 = (c) => (pregnant(c) && c.zacielenie2 ? addDays(c.zacielenie2, GESTATION) : null);
/** Po którym byku cielę: termin bliższy dniu wycielenia. */
export function guessSire(c, date) {
  if (!c.zacielenie) return null;
  const d1 = addDays(c.zacielenie, GESTATION);
  if (!c.zacielenie2) return { byk: c.byk || "", which: 1 };
  const d2 = addDays(c.zacielenie2, GESTATION);
  const which = Math.abs(daysBetween(d2, date)) < Math.abs(daysBetween(d1, date)) ? 2 : 1;
  return { byk: (which === 2 ? c.byk2 : c.byk) || "", which, d1, d2 };
}
export function nextRuja(c, today = todayISO()) {
  if (!c.ruja || (c.cielna === "tak" && pregnant(c))) return null;
  let r = addDays(c.ruja, CYCLE);
  while (r < today) r = addDays(r, CYCLE);
  return r;
}
/**
 * Niecielne krowy, które biegają teraz (ruja wpisana albo spodziewana: od 1 dnia przed do 2 dni po)
 * i jeszcze nie trafiły na listę „Do zacielenia” w tej rui. Zwraca [{ cow, date }].
 */
export function rujaQueue(cows, today = todayISO()) {
  const out = [];
  for (const c of cows) {
    if (pregnant(c) && c.cielna === "tak") continue;
    const zac = pregnant(c); // zacielona, niezbadana: tylko wpisana ruja (wróciła) wrzuca na listę
    for (const date of zac ? [c.ruja] : [c.ruja, nextRuja(c, today)]) {
      if (!date) continue;
      if (c.zacielenie2 && c.zacielenie2 >= date) continue;
      const n = daysBetween(today, date);
      if (n > 1 || n < -2) continue;
      if (c.kolejkaRuja === date || (c.zacielenie && c.zacielenie >= date)) continue;
      out.push({ cow: c, date });
      break;
    }
  }
  return out;
}
export const rujaQueueId = (c, date) => `r-${c.id}-${date}`;
export function insemDate(c, cfg) {
  if (!c.wycielenie) return null;
  if (c.zacielenie && c.zacielenie > c.wycielenie) return null;
  return addDays(c.wycielenie, cfg.vwp);
}

/** Zadanie ukryte krzyżykiem – wraca dopiero, gdy zmieni się jego termin (nowy cykl). */
export const hidden = (c, kind, date) => !!(c.ukryj && c.ukryj[kind] === date);

/** Lista zadań posortowana od najpilniejszych. */
export function alerts(cows, cfg, ahead, dueAhead, today = todayISO()) {
  const out = [];
  const late = cfg.zalegle ?? 30;
  const push = (c, kind, date, title, sub, limit = ahead) => {
    if (!date || hidden(c, kind, date)) return;
    const n = daysBetween(today, date);
    if (n <= limit && n >= -late) out.push({ cow: c, kind, date, n, title, sub });
  };
  for (const c of cows) {
    push(c, "insem", insemDate(c, cfg), "Zacielić", `Gotowa od ${fmt(insemDate(c, cfg))} (${cfg.vwp} dni po wycieleniu)`);
    push(c, "ruja", nextRuja(c, today), pregnant(c) ? "Sprawdź, czy nie wróciła ruja" : "Ruja – może biegać, do zacielenia", `${fmt(nextRuja(c, today))} (21 dni od poprzedniej)`);
    push(c, "check", checkDate(c, cfg), "Sprawdzić czy cielna", `${fmt(checkDate(c, cfg))} (${cfg.check} dni po zacieleniu)`);
    if (!c.zasuszona) push(c, "dry", dryDate(c, cfg), "Zasuszyć", `${fmt(dryDate(c, cfg))} (${cfg.dry} dni przed porodem)`);
    if (!c.przegnana) push(c, "move", moveDate(c, cfg), "Przegnać na porodówkę", `${fmt(moveDate(c, cfg))} (${cfg.move} dni przed porodem)`);
    const d = due(c);
    if (d) {
      const n = daysBetween(today, d);
      push(c, "due", d, n < 0 ? "Po terminie wycielenia" : "Wycielenie", `Termin ${fmt(d)}`, dueAhead);
    }
    // karencja po wycieleniu (antybiotyk z zasuszenia)
    const k = c.karencjaKoniec;
    if (k && !c.karencjaOk && !hidden(c, "karencja", k)) {
      const n = daysBetween(today, k);
      const lek = c.karencjaLek ? `${c.karencjaLek}${c.karencjaDni ? ` (${c.karencjaDni} dni)` : ""} · ` : "";
      if (n > 0) out.push({ cow: c, kind: "karencja", date: k, n, sort: -1000 + n, title: "Karencja – nie doić do sprzedaży, koniec", sub: `${lek}do ${fmt(k)} (jeszcze ${dni(n)})` });
      else if (n >= -late) out.push({ cow: c, kind: "karencjaOk", date: k, n, sort: -900, title: "Koniec karencji – można doić", sub: `${lek}karencja skończyła się ${fmt(k)}` });
    }
  }
  return out.sort((a, b) => (a.sort ?? a.n) - (b.sort ?? b.n));
}

/** Koniec karencji po wycieleniu: od zasuszenia albo od wycielenia + liczba dni. */
export function withdrawalEnd(c, calvedOn) {
  const days = Number(c.karencja) || 0;
  if (!days) return "";
  const start = c.karencjaOd === "wycielenie" ? calvedOn : (c.zasuszonaData || calvedOn);
  return addDays(start, days);
}

// ---------------- młodzież (cielęta, jałówki) ----------------
/** Dodaje miesiące; 31 stycznia + 1 miesiąc = 28/29 lutego. */
export function addMonths(s, m) {
  if (!s) return null;
  const [y, mo, d] = s.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo - 1 + m + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, mo - 1 + m, Math.min(d, last)));
}
/** Pełne miesiące życia między datą urodzenia a dniem. */
export function monthsOld(born, today = todayISO()) {
  if (!born) return null;
  const [y1, m1, d1] = born.split("-").map(Number), [y2, m2, d2] = today.split("-").map(Number);
  let m = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) m--;
  return Math.max(0, m);
}
export function ageText(born, today = todayISO()) {
  if (!born) return "—";
  const days = daysBetween(born, today);
  if (days < 0) return "—";
  if (days < 31) return days === 1 ? "1 dzień" : `${days} dni`;
  const m = monthsOld(born, today);
  if (m < 24) return `${m} mies.`;
  const y = Math.floor(m / 12), r = m % 12;
  return (r ? `${y} l. ${r} mies.` : `${y} lat`) + ` (${m} mies.)`;
}
export const breedDate = (c, cfg) => (c.plec === "j" && c.urodzona ? addMonths(c.urodzona, cfg.krycie) : null);

/** Zadania dla młodzieży: jałówka gotowa do krycia. */
export function calfAlerts(calves, cfg, ahead, today = todayISO(), dueAhead) {
  const out = [];
  const late = cfg.zalegle ?? 30;
  const push = (c, kind, date, title, sub, limit = ahead) => {
    if (!date || hidden(c, kind, date)) return;
    const n = daysBetween(today, date);
    if (n <= limit && n >= -late) out.push({ cow: c, calf: true, kind, date, n, title, sub });
  };
  for (const c of calves) {
    // zacielona jałówka: badanie cielności, porodówka, wycielenie (bez zasuszania)
    if (c.zacielenie && c.cielna !== "nie") {
      push(c, "check", checkDate(c, cfg), "Sprawdzić czy cielna", `${fmt(checkDate(c, cfg))} (${cfg.check} dni po zacieleniu)`);
      if (!c.przegnana) push(c, "move", moveDate(c, cfg), "Przegnać na porodówkę", `${fmt(moveDate(c, cfg))} (${cfg.move} dni przed porodem)`);
      const d = due(c);
      if (d) push(c, "due", d, daysBetween(today, d) < 0 ? "Po terminie wycielenia" : "Wycielenie jałówki", `Termin ${fmt(d)}`, dueAhead ?? 14);
      continue;
    }
    const d = breedDate(c, cfg);
    push(c, "krycie", d, "Jałówka gotowa do krycia", `${fmt(d)} (${cfg.krycie} mies. od urodzenia)`);
  }
  return out.sort((a, b) => a.n - b.n);
}
