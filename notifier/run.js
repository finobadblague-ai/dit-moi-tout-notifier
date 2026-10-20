/* Programme de notification de Dis-moi tout, lancé toutes les 30 minutes par GitHub Actions (voir .github/workflows/notify.yml).
   1. Il crée les questions pour tout le monde quand leur moment est venu (même si personne n'ouvre l'appli).
   2. Il prévient chaque joueur (notification du téléphone et/ou mail) : nouvelle question, réponse reçue, question pour tout le monde.
   La nuit (22 h à 8 h, heure de Paris), il ne fait rien : tout ce qui s'est passé est envoyé le matin. */
'use strict';
const L = require('./logic');
const THEMES = require('./questions');

const QUIET_FROM = 22, QUIET_TO = 8, TZ = 'Europe/Paris';
function hourIn(now, tz) { return +new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(now)); }
function quiet(now) { const h = hourIn(now, TZ); return QUIET_FROM > QUIET_TO ? (h >= QUIET_FROM || h < QUIET_TO) : (h >= QUIET_FROM && h < QUIET_TO); }

async function ensureCollective(db, code, g, now) {
  if (!L.canCollective(g)) return null;
  const slot = L.dueSlot(g, now); if (!slot) return null;
  const cid = 's' + slot.k, gref = db.collection('games').doc(code), ref = gref.collection('collective').doc(cid);
  if ((await ref.get()).exists) return null;
  const used = (await gref.collection('collective').get()).docs.map(d => d.data().text);
  const m = L.makeCollective(THEMES, g, slot.k, used); if (!m) return null;
  /* Création en transaction : si un téléphone l'a créée au même moment, on ne l'écrase pas. */
  return db.runTransaction(async t => {
    if ((await t.get(ref)).exists) return null;
    t.set(ref, { text: m.q.text, theme: m.q.theme, level: m.q.level, at: now, by: 'notifier' });
    t.set(gref.collection('cviewer').doc(cid), { viewer: m.viewer });
    return cid;
  });
}

async function run(d) {
  const now = d.now, stRef = d.db.collection('notifier').doc('state'), st = await stRef.get();
  const since = (st.exists && st.data().last) || now - 40 * 60000;
  if ((d.quiet || quiet)(now)) return { quiet: true };
  const out = [], games = await d.db.collection('games').get();
  for (const doc of games.docs) {
    const code = doc.id, g = doc.data(), gref = doc.ref;
    try {
      const created = await ensureCollective(d.db, code, g, now);
      if (created) out.push({ code, created });
      const [qs, qa, cs] = await Promise.all([
        gref.collection('questions').where('at', '>', since).get(),
        gref.collection('questions').where('answeredAt', '>', since).get(),
        gref.collection('collective').where('at', '>', since).get()
      ]);
      const ev = L.events(g, qs.docs.concat(qa.docs).map(x => x.data()), cs.docs.map(x => x.data()), since);
      for (const pid of Object.keys(ev)) {
        const msg = L.message(ev[pid]); if (!msg) continue;
        const sent = await d.send(code, pid, msg);
        out.push({ code, pid, kinds: Object.keys(ev[pid]), sent });
      }
    } catch (e) { console.error('partie', code, e.message); }
  }
  await stRef.set({ last: now });
  return out;
}

/* Clés des notifications : créées au premier lancement et gardées dans la base (la clé privée n'est lisible que par ce programme). */
async function vapidKeys(db, webpush) {
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) return { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE };
  const ref = db.collection('notifier').doc('vapid'), s = await ref.get();
  let k = s.exists ? s.data() : null;
  if (!k) { k = webpush.generateVAPIDKeys(); await ref.set(k); }
  await db.collection('config').doc('push').set({ publicKey: k.publicKey });
  return k;
}

async function main() {
  const admin = require('firebase-admin'), webpush = require('web-push');
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  admin.initializeApp(sa ? { credential: admin.credential.cert(JSON.parse(sa)) } : { projectId: process.env.GCLOUD_PROJECT || 'demo-dmt' });
  const db = admin.firestore();
  const keys = await vapidKeys(db, webpush);
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:' + (process.env.GMAIL_USER || 'dis-moi-tout@example.com'), keys.publicKey, keys.privateKey);
  let mailer = null;
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    mailer = require('nodemailer').createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  }
  const site = process.env.SITE_URL || '';
  async function send(code, pid, text) {
    const ref = db.collection('push').doc(code + '_' + pid), snap = await ref.get();
    if (!snap.exists) return [];
    const p = snap.data(), done = [];
    if (p.sub) {
      try {
        await webpush.sendNotification(JSON.parse(p.sub), JSON.stringify({ title: text.title, body: text.body, code }), { TTL: 3 * 24 * 3600, urgency: 'normal' });
        done.push('push');
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await ref.update({ sub: admin.firestore.FieldValue.delete() });
        else console.error('push', code, e.statusCode || e.message);
      }
    }
    if (p.email && mailer) {
      try {
        await mailer.sendMail({ from: '"Dis-moi tout" <' + process.env.GMAIL_USER + '>', to: p.email, subject: text.title, text: text.body + (site ? '\n\n' + site : '') });
        done.push('mail');
      } catch (e) { console.error('mail', code, e.message); }
    }
    return done;
  }
  const r = await run({ db, send, now: Date.now() });
  console.log(new Date().toISOString(), JSON.stringify(r));
}

module.exports = { run, quiet, hourIn, ensureCollective, vapidKeys };
if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
