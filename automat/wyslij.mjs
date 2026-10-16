// Codzienne powiadomienia: uruchamiane co godzinę przez GitHub Actions.
// Dla każdego gospodarstwa, gdy w Polsce minie ustawiona godzina, wysyła listę zadań na wszystkie telefony.
import admin from "firebase-admin";
import { alerts, calfAlerts, cfgOf, todayISO, kiedy, zadania } from "../web/logic.mjs";

const APP_URL = process.env.APP_URL || "";
const FORCE = process.env.WYMUS === "1";
if (!process.env.FIREBASE_SA) { console.log("Brak klucza FIREBASE_SA – pomijam."); process.exit(0); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();
const today = todayISO();
const hourNow = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
console.log(`Dziś ${today}, godzina w Polsce: ${hourNow}${FORCE ? " (wymuszone)" : ""}`);

const farms = await db.collection("gospodarstwa").listDocuments();
let sent = 0;
for (const ref of farms) {
  const farm = (await ref.get()).data() || {};
  const cfg = cfgOf((await ref.collection("ustawienia").doc("glowne").get()).data());
  if (!FORCE && (hourNow < cfg.hour || farm.ostatnio === today)) continue;

  const cows = (await ref.collection("krowy").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const phones = (await ref.collection("telefony").get()).docs.filter((p) => p.data().token);
  if (!FORCE) await ref.set({ ostatnio: today }, { merge: true });

  const calves = (await ref.collection("mlodziez").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const list = [...alerts(cows, cfg, 1, 7, today), ...calfAlerts(calves, cfg, 1, today, 7)].sort((x, y) => (x.sort ?? x.n) - (y.sort ?? y.n));
  if (!phones.length || (!list.length && !FORCE)) continue;

  const title = list.length ? `Obora: ${list.length} ${zadania(list.length)}` : "Obora: nic do zrobienia";
  let body = list.slice(0, 6).map((a) => `${a.cow.kolczyk}${a.cow.nazwa ? " (" + a.cow.nazwa + ")" : ""}: ${a.title} ${kiedy(a.n)}`).join("\n") || "Na dziś brak zadań.";
  if (list.length > 6) body += `\n…i jeszcze ${list.length - 6}`;

  const res = await admin.messaging().sendEachForMulticast({
    tokens: phones.map((p) => p.data().token),
    webpush: {
      notification: { title, body, icon: APP_URL + "ikona-192.png", badge: APP_URL + "odznaka-96.png", tag: "obora-dzienne", renotify: true },
      fcmOptions: APP_URL ? { link: APP_URL } : undefined,
    },
  });
  sent += res.successCount;
  // usuń telefony, które odinstalowały aplikację
  await Promise.all(res.responses.map((r, i) => {
    const code = r.error?.code || "";
    if (!r.success && /registration-token-not-registered|invalid-registration-token/.test(code)) return phones[i].ref.delete();
    if (!r.success) console.log("Błąd wysyłki:", code);
  }));
}
console.log(`Wysłano powiadomień: ${sent}`);
process.exit(0);
