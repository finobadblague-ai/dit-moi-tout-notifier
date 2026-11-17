/* Vérifie les parties en cours et prévient les joueurs qui attendent (notification du téléphone et/ou mail).
   Lancé toutes les 5 minutes par GitHub Actions (voir .github/workflows/notify.yml). */
'use strict';
const L = require('./lib');

async function run(d) {
  const now = d.now, o = { graceMs: d.graceMin * 60000, remindMs: d.remindHours * 3600000 };
  const games = await d.db.collection('games').where('status', '==', 'playing').get();
  const live = new Set(), out = [];
  for (const doc of games.docs) {
    const code = doc.id, g = doc.data(); live.add(code);
    const stRef = d.db.collection('push_state').doc(code), stSnap = await stRef.get();
    const r = L.decide(g, stSnap.exists ? stSnap.data() : null, now, o);
    if (r.act === 'clear') { if (stSnap.exists) await stRef.delete(); continue; }
    if (r.act === 'notify' || r.act === 'remind' || r.act === 'nudge') {
      let tx = r.act === 'notify' ? L.TEXTS.notify : r.act === 'remind' ? L.TEXTS.remind : L.TEXTS.nudge;
      if (r.act === 'nudge') {
        const by = (g.players || []).find((p) => p.id === r.by);
        tx = { title: tx.title, body: tx.body.replace('{by}', (by && by.name) || 'Un joueur') };
      }
      const sent = await d.send(code, r.actor, tx);
      out.push({ code: code, act: r.act, sent: sent });
    }
    if (r.act !== 'none') await stRef.set(r.state);
  }
  /* états d'anciennes parties (terminées ou abandonnées) */
  const states = await d.db.collection('push_state').get();
  for (const s of states.docs) if (!live.has(s.id)) await s.ref.delete();
  return out;
}

function main() {
  const admin = require('firebase-admin'), webpush = require('web-push');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://scene-secrete.web.app', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
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
        await webpush.sendNotification(JSON.parse(p.sub), JSON.stringify({ title: text.title, body: text.body, code: code }), { TTL: 3 * 24 * 3600, urgency: 'high' });
        done.push('push');
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await ref.update({ sub: admin.firestore.FieldValue.delete() });
        else console.error('push', code, e.statusCode || e.message);
      }
    }
    if (p.email && mailer) {
      try {
        await mailer.sendMail({ from: '"La Scène secrète" <' + process.env.GMAIL_USER + '>', to: p.email, subject: text.title, text: text.body + (site ? '\n\n' + site : '') });
        done.push('mail');
      } catch (e) { console.error('mail', code, e.message); }
    }
    return done;
  }
  return run({ db: db, send: send, now: Date.now(), graceMin: 10, remindHours: 48 })
    .then((r) => { console.log(new Date().toISOString(), JSON.stringify(r)); });
}

module.exports = { run: run };
if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
