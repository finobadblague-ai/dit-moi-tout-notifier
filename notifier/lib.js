/* Règles de notification, sans dépendance, pour pouvoir les tester. */
'use strict';

/* Qui doit jouer maintenant ? (même règle que dans l'application) */
function actorOf(g) {
  var a = actorOf0(g);
  return a && g.gone && g.gone[a] ? null : a; /* celui qui a supprimé la partie n'est plus prévenu */
}
function actorOf0(g) {
  if (!g || g.status !== 'playing') return null;
  if (g.phase === 'perform') return (g.pending && g.pending.to) || null;
  if (g.phase === 'qa') return (g.q && g.q.to) || null;
  if (g.phase === 'show') return (g.pending && g.pending.askIdx) || null;
  return g.turn || null;
}

/* Que faire pour cette partie, sachant l'état mémorisé de la dernière vérification ?
   - On ne prévient qu'après `graceMs` sans activité, pour ne pas déranger quelqu'un qui joue en direct.
   - Le rappel part `remindMs` après la dernière alerte ou la dernière activité, la plus récente des deux.
   Renvoie { act: 'clear' | 'none' | 'track' | 'notify' | 'remind', state } (state = à enregistrer, sauf pour 'clear'/'none'). */
function decide(g, st, now, o) {
  var actor = actorOf(g);
  if (!actor) return { act: 'clear' };
  var fresh = !st || st.gid !== g.gid || st.actor !== actor;
  var cur = fresh ? { actor: actor, gid: g.gid, notified: false, lastSent: 0, nudgeAt: (st && st.gid === g.gid && st.nudgeAt) || 0 } : st;
  /* Relance demandée avec le bouton : on prévient tout de suite, une seule fois par demande. */
  var nd = g.nudge;
  if (nd && nd.to === actor && nd.at > (cur.nudgeAt || 0) && now - nd.at < 24 * 3600000) {
    return { act: 'nudge', actor: actor, by: nd.by, state: { actor: actor, gid: g.gid, notified: true, lastSent: now, nudgeAt: nd.at } };
  }
  var at = g.at || 0;
  if (!cur.notified) {
    if (now - at >= o.graceMs) return { act: 'notify', actor: actor, state: { actor: actor, gid: g.gid, notified: true, lastSent: now, nudgeAt: cur.nudgeAt || 0 } };
    return { act: fresh ? 'track' : 'none', actor: actor, state: cur };
  }
  if (now - Math.max(cur.lastSent || 0, at) >= o.remindMs) return { act: 'remind', actor: actor, state: { actor: actor, gid: g.gid, notified: true, lastSent: now, nudgeAt: cur.nudgeAt || 0 } };
  return { act: 'none', actor: actor, state: cur };
}

var TEXTS = {
  notify: { title: 'La Scène secrète', body: 'C’est à vous de jouer.' },
  nudge: { title: 'La Scène secrète', body: '{by} t’attend : c’est à toi de jouer.' },
  remind: { title: 'La Scène secrète', body: 'On vous attend toujours : c’est à vous de jouer.' }
};

module.exports = { actorOf: actorOf, decide: decide, TEXTS: TEXTS };
