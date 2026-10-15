import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc, getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import * as L from "./logic.mjs";

export const APP_VERSION = "1.2";
const $ = (id) => document.getElementById(id);
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
$("ver").textContent = `Wersja ${APP_VERSION}`;

// ---------------- instalacja i aktualizacje ----------------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
if (isIOS && !standalone) $("iosBar").hidden = false;

let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("installBar").hidden = false; });
$("installBtn").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("installBar").hidden = true; };
window.addEventListener("appinstalled", () => { $("installBar").hidden = true; });

let swReg = null;
let refreshing = false;
function showUpdate(worker) {
  $("updBar").hidden = false;
  $("updBtn").onclick = () => { $("updBtn").disabled = true; $("updBtn").textContent = "Instaluję…"; worker.postMessage("AKTUALIZUJ"); };
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!refreshing) { refreshing = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js").then((reg) => {
    swReg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(w);
      });
    });
    // sprawdzaj nowe wersje przy każdym powrocie do aplikacji
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
}
$("checkUpd").onclick = async () => {
  if (!swReg) { status("Aktualizacje działają po zainstalowaniu aplikacji."); return; }
  status("Sprawdzam…");
  try { await swReg.update(); } catch {}
  setTimeout(() => { if ($("updBar").hidden) status(`Masz najnowszą wersję (${APP_VERSION}).`); else status("Jest nowa wersja – naciśnij Aktualizuj na górze."); }, 2500);
};

// ---------------- Firebase ----------------
const cfgFb = self.OBORA_FIREBASE || {};
if (!cfgFb.apiKey) {
  $("cfgErr").hidden = false;
  throw new Error("Brak konfiguracji Firebase");
}
const fbApp = initializeApp(cfgFb);
let db;
try { db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch { db = initializeFirestore(fbApp, {}); }

const farmDoc = (f) => doc(db, "gospodarstwa", f);
const cowsCol = (f) => collection(db, "gospodarstwa", f, "krowy");
const cfgDocRef = (f) => doc(db, "gospodarstwa", f, "ustawienia", "glowne");

function newCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint32Array(12));
  const s = [...r].map((x) => abc[x % abc.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const cleanCode = (s) => s.trim().toUpperCase().replace(/\s+/g, "");
const validCode = (s) => /^[A-Z0-9-]{12,40}$/.test(s);

// ---------------- stan ----------------
let farm = LS.get("obora_farm");
let cows = [];
let cfg = L.cfgOf();
let editId = null, confirmId = null;
let unsub = [];
let loaded = false;
const NO_PLACE = "__brak";
let place = LS.get("obora_miejsce") || "";   // "" = wszystkie
const placeOf = (c) => (c.miejsce || "").trim();
const visible = () => !place ? cows : cows.filter((c) => (place === NO_PLACE ? !placeOf(c) : placeOf(c) === place));

function status(t) { $("status").textContent = t; }

// ---------------- ekran startowy ----------------
function showSetup() {
  $("setup").hidden = false; $("app").hidden = true;
}
$("createFarm").onclick = async () => {
  const code = newCode();
  $("createFarm").disabled = true;
  try {
    await setDoc(farmDoc(code), { utworzono: Date.now() });
  } catch (e) {
    $("createFarm").disabled = false;
    $("joinErr").textContent = "Nie udało się założyć gospodarstwa. Sprawdź internet."; $("joinErr").hidden = false;
    return;
  }
  $("newCode").textContent = code; $("newCodeBox").hidden = false; $("createFarm").hidden = true;
  $("newCodeOk").onclick = () => start(code);
};
$("joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = cleanCode($("joinCode").value);
  const err = (t) => { $("joinErr").textContent = t; $("joinErr").hidden = false; };
  if (!validCode(code)) return err("Kod ma co najmniej 12 znaków, np. ABCD-EFGH-JKLM.");
  $("joinBtn").disabled = true; $("joinBtn").textContent = "Sprawdzam…";
  try {
    const s = await getDoc(farmDoc(code));
    if (s.exists()) start(code); else err("Nie ma gospodarstwa z takim kodem. Sprawdź litery.");
  } catch { err("Brak połączenia z internetem. Spróbuj ponownie."); }
  $("joinBtn").disabled = false; $("joinBtn").textContent = "Połącz z gospodarstwem";
});

function start(code) {
  farm = code; LS.set("obora_farm", code);
  $("setup").hidden = true; $("app").hidden = false;
  $("farmCode").textContent = code;
  unsub.forEach((u) => u()); unsub = [];
  unsub.push(onSnapshot(cowsCol(code), (snap) => {
    cows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loaded = true;
    status(snap.metadata.fromCache ? "Bez internetu – zmiany wyślą się później." : "");
    render();
  }, () => status("Brak dostępu do bazy. Sprawdź internet.")));
  unsub.push(onSnapshot(cfgDocRef(code), (s) => {
    cfg = L.cfgOf(s.data());
    const active = document.activeElement?.id || "";
    if (!active.startsWith("set")) showCfg();
    updatePreview(); render();
  }, () => {}));
  showCfg(); updatePreview(); render();
  refreshNotifBar();
  if (pushPossible() && Notification.permission === "granted") registerPush(false);
}

// ---------------- powiadomienia ----------------
function pushPossible() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
function refreshNotifBar() {
  const bar = $("notifBar"), p = bar.querySelector("p");
  if (!pushPossible()) {
    if (isIOS && !standalone) {
      p.innerHTML = "<b>Powiadomienia na iPhonie</b> działają po dodaniu aplikacji do ekranu początkowego (instrukcja wyżej) i otwarciu jej z ikony.";
      $("notifBtn").hidden = true; bar.hidden = false;
    } else bar.hidden = true;
    return;
  }
  bar.hidden = Notification.permission === "granted";
  if (Notification.permission === "denied") {
    p.innerHTML = "<b>Powiadomienia są zablokowane.</b> Włącz je w ustawieniach telefonu dla tej aplikacji.";
    $("notifBtn").hidden = true;
  }
}
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
async function registerPush(interactive) {
  try {
    if (!pushPossible() || !(await isSupported())) { if (interactive) status("Ten telefon lub przeglądarka nie obsługuje powiadomień."); return false; }
    if (!self.OBORA_VAPID) { if (interactive) status("Powiadomienia nie są jeszcze skonfigurowane."); return false; }
    const reg = swReg || (await navigator.serviceWorker.ready);
    const token = await getToken(getMessaging(fbApp), { vapidKey: self.OBORA_VAPID, serviceWorkerRegistration: reg });
    if (!token || !farm) return false;
    await setDoc(doc(db, "gospodarstwa", farm, "telefony", await sha(token)), {
      token, zmieniono: Date.now(), ios: isIOS,
    });
    if (interactive) status("Powiadomienia włączone. Codziennie rano dostaniesz listę zadań.");
    return true;
  } catch (e) {
    if (interactive) status("Nie udało się włączyć powiadomień. Spróbuj ponownie.");
    return false;
  }
}
$("notifBtn").onclick = async () => {
  const p = await Notification.requestPermission();
  refreshNotifBar();
  if (p === "granted") await registerPush(true);
};
$("testNotif").onclick = async () => {
  if (!pushPossible() || Notification.permission !== "granted") { status("Najpierw włącz powiadomienia (przycisk „Włącz” na górze)."); $("notifBar").hidden = false; return; }
  const list = L.alerts(cows, cfg, 1, 7);
  const reg = swReg || (await navigator.serviceWorker.ready);
  await reg.showNotification(list.length ? `Obora: ${list.length} ${L.zadania(list.length)}` : "Obora: nic do zrobienia", {
    body: list.slice(0, 6).map((a) => `${a.cow.kolczyk}: ${a.title} ${L.kiedy(a.n)}`).join("\n") || "Na dziś brak zadań.",
    icon: "ikona-192.png", badge: "odznaka-96.png", tag: "obora-test",
  });
  status("Wysłano – sprawdź pasek powiadomień.");
};

// ---------------- zapis ----------------
function rowData(c) { const { id, ...r } = c; return r; }
async function writeCow(id, data) {
  data.termin = L.due(data) || "";
  data.zmieniono = Date.now();
  // nie czekamy na serwer – bez zasięgu zapis trafia do kolejki
  setDoc(doc(cowsCol(farm), id), data).catch(() => status("Nie udało się zapisać. Sprawdź internet."));
}
function patch(c, changes, msg) { writeCow(c.id, { ...rowData(c), ...changes }); status(msg); }

// ---------------- widok ----------------
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function btn(text, cls, fn) { const b = el("button", cls, text); b.type = "button"; b.onclick = fn; return b; }

function renderAlerts() {
  const box = $("alerts"); box.replaceChildren();
  const today = L.todayISO();
  const vis = visible();
  const list = L.alerts(vis, cfg, cfg.ahead, 14, today);
  if (!list.length) {
    box.append(el("div", "empty", vis.length ? `Nic do zrobienia w najbliższych ${L.dni(cfg.ahead)}.` : "Tu pojawią się zadania: zacielenie, ruja, badanie cielności, zasuszenie, porodówka i wycielenie."));
    return;
  }
  for (const a of list) {
    const c = a.cow;
    const cls = a.kind === "due" || (a.n <= 0 && a.kind === "check") ? "soon" : a.n <= 0 ? "warn" : "";
    const row = el("div", "alert " + cls);
    const t = el("div", "atxt");
    t.append(el("b", null, `${a.title} ${L.kiedy(a.n)}`), el("small", null, a.sub));
    const ab = el("div", "abtns");
    row.append(el("span", "tag", c.kolczyk), t, ab);
    const zacielona = () => { startEdit(c, { zacielenie: today, ruja: today }); status("Wpisz, jakim bykiem zacielona, i naciśnij Zapisz."); $("byk").focus(); };
    if (a.kind === "check") ab.append(btn("Cielna", "okbtn", () => patch(c, { cielna: "tak" }, `${c.kolczyk}: cielna`)), btn("Niecielna", "nobtn", () => patch(c, { cielna: "nie" }, `${c.kolczyk}: niecielna`)));
    if (a.kind === "dry") ab.append(btn("Zasuszona", "okbtn", () => patch(c, { zasuszona: true }, `${c.kolczyk}: zasuszona`)));
    if (a.kind === "move") ab.append(btn("Przegnana", "okbtn", () => patch(c, { przegnana: true }, `${c.kolczyk}: na porodówce`)));
    if (a.kind === "ruja") ab.append(btn("Grzeje się dziś", "nobtn", () => patch(c, { ruja: today }, `${c.kolczyk}: ruja zapisana`)), btn("Zacielona dziś", "okbtn", zacielona));
    if (a.kind === "insem") ab.append(btn("Zacielona dziś", "okbtn", zacielona));
    if (a.kind === "due") ab.append(btn("Wycieliła się", "okbtn", () => patch(c, { wycielenie: today, zacielenie: "", byk: "", ruja: "", cielna: "", zasuszona: false, przegnana: false }, `${c.kolczyk}: wycielenie zapisane`)));
    box.append(row);
  }
}

function renderPlaces() {
  const nav = $("places");
  const counts = new Map();
  let none = 0;
  for (const c of cows) { const p = placeOf(c); if (p) counts.set(p, (counts.get(p) || 0) + 1); else none++; }
  if (place && place !== NO_PLACE && !counts.has(place)) { place = ""; LS.set("obora_miejsce", null); }
  if (place === NO_PLACE && !none) { place = ""; LS.set("obora_miejsce", null); }
  nav.replaceChildren();
  nav.hidden = counts.size === 0;
  const chip = (label, key, n) => {
    const b = el("button", "place" + (place === key ? " on" : ""));
    b.type = "button"; b.setAttribute("aria-pressed", place === key);
    b.append(document.createTextNode(label), el("b", null, String(n)));
    b.onclick = () => {
      place = key; LS.set("obora_miejsce", key || null);
      if (!editId) $("miejsce").value = key && key !== NO_PLACE ? key : "";
      render();
    };
    return b;
  };
  nav.append(chip("Wszystkie", "", cows.length));
  [...counts.keys()].sort((a, b) => a.localeCompare(b, "pl")).forEach((p) => nav.append(chip(p, p, counts.get(p))));
  if (none && counts.size) nav.append(chip("Bez miejsca", NO_PLACE, none));
  const pl = $("placeList"); pl.replaceChildren(...[...counts.keys()].map((n) => { const o = document.createElement("option"); o.value = n; return o; }));
}

function fillBulls() {
  const names = [...new Set(cows.flatMap((c) => [c.ojciec, c.byk]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const dl = $("bykList"); dl.replaceChildren(...names.map((n) => { const o = document.createElement("option"); o.value = n; return o; }));
}

function render() {
  renderPlaces();
  renderAlerts();
  fillBulls();
  const vis = visible();
  const q = $("szukaj").value.trim().toUpperCase();
  const list = $("list");
  const sorted = [...vis].sort((a, b) => {
    const da = L.due(a), db_ = L.due(b);
    if (da && db_) return da < db_ ? -1 : 1;
    if (da) return -1; if (db_) return 1;
    return (a.kolczyk || "").localeCompare(b.kolczyk || "");
  }).filter((c) => !q || [c.kolczyk, c.ojciec, c.byk, c.miejsce].some((x) => (x || "").toUpperCase().includes(q)));

  const today = L.todayISO();
  $("sAll").textContent = vis.length;
  $("sPreg").textContent = vis.filter((c) => L.pregnant(c)).length;
  $("sSoon").textContent = vis.filter((c) => { const d = L.due(c); if (!d) return false; const n = L.daysBetween(today, d); return n >= 0 && n <= 30; }).length;

  list.replaceChildren();
  if (!loaded) { list.append(el("div", "empty", "Ładowanie stada…")); return; }
  if (!cows.length) { list.append(el("div", "empty", "Brak krów. Wpisz numer kolczyka i daty w formularzu powyżej.")); return; }
  if (!sorted.length) { list.append(el("div", "empty", q ? "Brak krowy pasującej do wyszukiwania." : "W tym miejscu nie ma krów.")); return; }

  for (const c of sorted) {
    const due = L.due(c);
    const card = el("article", "cow");
    const top = el("div", "cowtop");
    const left = el("div"); left.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap";
    left.append(el("span", "tag", c.kolczyk));
    if (placeOf(c)) left.append(el("span", "loc", placeOf(c)));
    if (c.zacielenie && (L.pregnant(c) || c.cielna === "nie")) {
      const chip = el("span", "chip", c.cielna === "tak" ? "Cielna ✓" : c.cielna === "nie" ? "Niecielna" : "Do sprawdzenia");
      if (c.cielna === "tak") chip.classList.add("yes"); if (c.cielna === "nie") chip.classList.add("no");
      left.append(chip);
    }
    const pill = el("span", "pill");
    if (!due) { pill.classList.add("none"); pill.textContent = c.cielna === "nie" ? "Do ponownego krycia" : "Niezacielona"; }
    else {
      const n = L.daysBetween(today, due);
      if (n < 0) { pill.classList.add("warn"); pill.textContent = `Po terminie ${L.dni(n)}`; }
      else if (n === 0) { pill.classList.add("soon"); pill.textContent = "Poród dziś"; }
      else { if (n <= 30) pill.classList.add("soon"); pill.textContent = `Poród za ${L.dni(n)}`; }
    }
    top.append(left, pill);

    const dl = el("dl");
    const items = [
      ["Po byku", c.ojciec || "—"],
      ["Zacielona bykiem", c.byk || "—"],
      ["Ost. wycielenie", L.fmt(c.wycielenie)],
      ["Ostatnia ruja", L.fmt(c.ruja)],
      ["Następna ruja", L.fmt(L.nextRuja(c, today))],
      ["Zacielenie", L.fmt(c.zacielenie)],
      ["Sprawdzić cielność", L.fmt(L.checkDate(c, cfg))],
      ["Zasuszenie", c.zasuszona ? "zrobione" : L.fmt(L.dryDate(c, cfg))],
      ["Na porodówkę", c.przegnana ? "zrobione" : L.fmt(L.moveDate(c, cfg))],
      ["Termin porodu", L.fmt(due)],
    ];
    for (const [k, v] of items) {
      const w = el("div"); const dd = el("dd", k === "Termin porodu" && due ? "big" : null, v);
      w.append(el("dt", null, k), dd); dl.append(w);
    }
    card.append(top, dl);

    const btns = el("div", "cowbtns");
    if (confirmId === c.id) {
      const q2 = el("span", "note", "Usunąć tę krowę?"); q2.style.alignSelf = "center";
      btns.append(q2, btn("Nie", "ghost", () => { confirmId = null; render(); }), btn("Tak, usuń", "del", () => removeCow(c.id)));
    } else {
      if (c.zacielenie && c.cielna) btns.append(btn("Cofnij badanie", "ghost", () => patch(c, { cielna: "" }, `${c.kolczyk}: wynik cofnięty`)));
      btns.append(btn("Edytuj", "ghost", () => startEdit(c)), btn("Usuń", "ghost", () => { confirmId = c.id; render(); }));
    }
    card.append(btns);
    list.append(card);
  }
}

// ---------------- formularz ----------------
function updatePreview() {
  const z = $("zacielenie").value, r = $("ruja").value;
  const due = z ? L.addDays(z, L.GESTATION) : null;
  $("dueOut").textContent = due ? L.fmt(due) : "—";
  $("checkOut").textContent = z ? `${L.fmt(L.addDays(z, cfg.check))} (+${cfg.check} dni)` : "—";
  $("dryOut").textContent = due ? `${L.fmt(L.addDays(due, -cfg.dry))} (${cfg.dry} dni przed)` : "—";
  $("moveOut").textContent = due ? `${L.fmt(L.addDays(due, -cfg.move))} (${cfg.move} dni przed)` : "—";
  $("rujaOut").textContent = r ? L.fmt(L.addDays(r, L.CYCLE)) : "—";
}
function resetForm() {
  editId = null; $("form").reset(); updatePreview();
  if (place && place !== NO_PLACE) $("miejsce").value = place;
  $("formTitle").textContent = "Dodaj krowę"; $("saveBtn").textContent = "Zapisz krowę";
  $("cancelBtn").hidden = true; $("err").hidden = true;
}
function startEdit(c, preset = {}) {
  editId = c.id;
  const v = { ...c, ...preset };
  $("kolczyk").value = v.kolczyk || ""; $("wycielenie").value = v.wycielenie || ""; $("ruja").value = v.ruja || ""; $("zacielenie").value = v.zacielenie || "";
  $("ojciec").value = v.ojciec || ""; $("miejsce").value = v.miejsce || ""; $("byk").value = preset.zacielenie && preset.zacielenie !== c.zacielenie ? "" : (v.byk || "");
  updatePreview();
  $("formTitle").textContent = "Edytuj krowę"; $("saveBtn").textContent = "Zapisz zmiany"; $("cancelBtn").hidden = false;
  $("form").scrollIntoView({ behavior: "smooth", block: "start" });
}
["zacielenie", "ruja"].forEach((id) => $(id).addEventListener("input", updatePreview));
$("szukaj").addEventListener("input", render);
$("cancelBtn").onclick = resetForm;
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const showErr = (t) => { $("err").textContent = t; $("err").hidden = false; };
  const kolczyk = $("kolczyk").value.trim().toUpperCase().replace(/\s+/g, "");
  const wycielenie = $("wycielenie").value, ruja = $("ruja").value, zacielenie = $("zacielenie").value;
  const ojciec = $("ojciec").value.trim(), byk = $("byk").value.trim(), miejsce = $("miejsce").value.trim().replace(/\s+/g, " ");
  if (!kolczyk) return showErr("Wpisz numer kolczyka.");
  if (cows.some((c) => c.kolczyk === kolczyk && c.id !== editId)) return showErr("Krowa z tym kolczykiem już jest w stadzie. Użyj „Edytuj”.");
  const old = cows.find((c) => c.id === editId);
  const same = old && old.zacielenie === zacielenie;
  const data = {
    kolczyk, miejsce, ojciec, wycielenie, ruja, zacielenie, byk: zacielenie ? byk : "",
    cielna: same ? old.cielna || "" : "",
    zasuszona: same ? !!old.zasuszona : false,
    przegnana: same ? !!old.przegnana : false,
  };
  const id = editId || "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  writeCow(id, data);
  status(editId ? `Zapisano zmiany: ${kolczyk}` : `Dodano: ${kolczyk}`);
  resetForm();
});
function removeCow(id) {
  confirmId = null;
  deleteDoc(doc(cowsCol(farm), id)).catch(() => status("Nie udało się usunąć."));
  if (editId === id) resetForm();
  status("Usunięto krowę.");
}

// ---------------- ustawienia ----------------
const SET = { setDry: "dry", setMove: "move", setCheck: "check", setVwp: "vwp", setAhead: "ahead", setHour: "hour" };
const LIM = { dry: [1, 120], move: [1, 60], check: [1, 120], vwp: [1, 200], ahead: [0, 30], hour: [0, 23] };
function showCfg() { for (const [id, k] of Object.entries(SET)) $(id).value = cfg[k]; }
let cfgTimer = null;
for (const id of Object.keys(SET)) $(id).addEventListener("input", () => {
  const next = { ...cfg };
  for (const [i, k] of Object.entries(SET)) {
    const n = parseInt($(i).value, 10);
    if (Number.isFinite(n)) next[k] = Math.min(LIM[k][1], Math.max(LIM[k][0], n));
  }
  cfg = next; updatePreview(); render();
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => {
    setDoc(cfgDocRef(farm), cfg).then(() => { $("setMsg").textContent = "Zapisano. Obowiązuje na wszystkich telefonach."; })
      .catch(() => { $("setMsg").textContent = "Nie udało się zapisać ustawień."; });
  }, 700);
});
$("copyCode").onclick = async () => {
  try { await navigator.clipboard.writeText(farm); status("Skopiowano kod."); }
  catch { const r = document.createRange(); r.selectNodeContents($("farmCode")); getSelection().removeAllRanges(); getSelection().addRange(r); }
};
$("leaveBtn").onclick = () => {
  const box = $("leaveBox"); box.replaceChildren();
  box.append(el("p", "hint", "Ten telefon odłączy się od stada. Dane zostaną w bazie – wrócisz do nich, wpisując kod."),
    btn("Nie", "ghost", () => location.reload()),
    btn("Odłącz", "del", () => { LS.set("obora_farm", null); location.reload(); }));
};

// ---------------- start ----------------
if (farm) start(farm); else showSetup();
// odśwież terminy po północy / po powrocie do aplikacji
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && farm) render(); });
