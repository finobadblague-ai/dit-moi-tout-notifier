/* Règles du jeu sans interface, partagées par l'application et par le programme de notification.
   (notifier/logic.js est une copie de ce fichier : gardez les deux identiques.) */
(function (root) {
  'use strict';
  var DAY = 864e5;
  var LEVELS = ['leger', 'intime', 'profond'];
  var ADULT = 'plus-secret';
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function randInt(n) {
    var c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    if (c) { var a = new Uint32Array(1); c.getRandomValues(a); return a[0] % n; }
    return Math.floor(Math.random() * n);
  }
  function rand() { return randInt(1e9) / 1e9; }
  function newCode() { var s = ''; for (var i = 0; i < 6; i++) s += CODE_CHARS[randInt(CODE_CHARS.length)]; return s; }
  function newId(n) { var A = 'abcdefghijkmnpqrstuvwxyz23456789', s = ''; for (var i = 0; i < (n || 10); i++) s += A[randInt(A.length)]; return s; }

  /* Générateur pseudo-aléatoire déterministe : tous les téléphones calculent les mêmes moments. */
  function seeded(seed) {
    var h = 1779033703 ^ seed.length;
    for (var i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
    h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909); var a = (h ^= h >>> 16) >>> 0;
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  /* Moments des questions pour tout le monde : écart aléatoire de 12 heures à 7 jours. */
  var GAP_MIN = 0.5, GAP_MAX = 7;
  function slots(game, until) {
    var r = seeded(String(game.seed) + ':slots'), out = [], t = game.createdAt;
    for (var k = 0; k < 2000; k++) { t += (GAP_MIN + r() * (GAP_MAX - GAP_MIN)) * DAY; if (t > until) break; out.push({ k: k, t: t }); }
    return out;
  }
  function dueSlot(game, now) { var s = slots(game, now); return s.length ? s[s.length - 1] : null; }
  function nextSlot(game, now) { var s = slots(game, now + 30 * DAY); for (var i = 0; i < s.length; i++) if (s[i].t > now) return s[i]; return null; }

  /* Profondeur des questions pour tout le monde : légères au début, puis de plus en plus variées. */
  function collectiveLevel(k, r) {
    if (k < 2) return 'leger';
    if (k < 5) return r() < 0.5 ? 'leger' : 'intime';
    return LEVELS[Math.floor(r() * 3)];
  }
  function pickQuestion(themes, TH, active, level, exclude, r) {
    var pool = [];
    (active || []).forEach(function (th) { var t = TH[th]; if (!t) return; (t.q[level] || []).forEach(function (q) { if (!exclude[q]) pool.push({ theme: th, text: q, level: level }); }); });
    if (!pool.length) return null;
    return pool[Math.floor((r || rand)() * pool.length)];
  }
  function byId(themes) { var o = {}; themes.forEach(function (t) { o[t.id] = t; }); return o; }
  /* Question pour tout le monde : texte au hasard (sans redite), et une fois sur deux un joueur tiré au sort. */
  function makeCollective(themes, game, k, usedTexts) {
    var TH = byId(themes), ex = {};
    (usedTexts || []).forEach(function (t) { ex[t] = 1; });
    var level = collectiveLevel(k, rand);
    var q = pickQuestion(themes, TH, game.active, level, ex) || pickQuestion(themes, TH, game.active, 'leger', ex) || pickQuestion(themes, TH, game.active, level, {});
    if (!q) return null;
    var pids = game.pids || [];
    var viewer = rand() < 0.5 && pids.length > 1 ? pids[randInt(pids.length)] : null;
    return { q: q, viewer: viewer };
  }
  function canCollective(game) { return !!game && (game.pids || []).length >= 2 && (game.active || []).length > 0; }

  /* Pour le programme de notification : qui prévenir, et de quoi, depuis la dernière vérification. */
  function events(game, questions, collectives, since) {
    var out = {};
    var add = function (pid, kind) { if (!pid) return; (out[pid] = out[pid] || {})[kind] = true; };
    (questions || []).forEach(function (q) {
      if (q.at > since && q.status === 'pending') add(q.to, 'question');
      if (q.answeredAt && q.answeredAt > since && q.status === 'answered') add(q.from, 'answer');
    });
    (collectives || []).forEach(function (c) { if (c.at > since) (game.pids || []).forEach(function (p) { if (p !== c.by) add(p, 'collective'); }); });
    return out;
  }
  var TEXTS = {
    question: 'Une nouvelle question t’attend.',
    answer: 'Quelqu’un a répondu à ta question.',
    collective: 'Une question pour tout le monde vient d’arriver.',
    remind: 'Des questions t’attendent toujours dans la partie.',
    many: 'Du nouveau t’attend dans la partie.'
  };
  function message(kinds, gameName) {
    var ks = Object.keys(kinds || {});
    if (!ks.length) return null;
    return { title: 'Dis-moi tout' + (gameName ? ' · ' + gameName : ''), body: ks.length > 1 ? TEXTS.many : TEXTS[ks[0]] };
  }

  /* Rappels : pour chaque joueur, depuis quand la plus ancienne question l'attend (questions pour lui encore sans réponse,
     questions pour tout le monde auxquelles il n'a ni répondu, ni refusé, ni gardé pour plus tard, des 14 derniers jours). */
  function waitingSince(game, questions, collectives, now) {
    var out = {}, from = now - 14 * DAY, pids = game.pids || [];
    var put = function (pid, at) { if (pids.indexOf(pid) >= 0 && at >= from && (!out[pid] || at < out[pid])) out[pid] = at; };
    (questions || []).forEach(function (q) { if (q.status === 'pending' || q.status === 'retire') put(q.to, q.at); });
    (collectives || []).forEach(function (c) {
      pids.forEach(function (p) {
        if (p === c.by || c.viewer === p) return;
        var a = (c.answers || {})[p], st = (c.priv || {})[p];
        if ((a && !a.removed) || st === 'refused' || st === 'later') return;
        put(p, c.at);
      });
    });
    return out;
  }

  /* Affinités entre chaque paire de joueurs (calculées par le programme de notification, qui seul voit les choix secrets).
     ami / amour : % de choix identiques aux questions à choix (amour : thèmes amoureux seulement), à partir de 3 questions en commun.
     compl : complicité de 0 à 100, d'après les échanges entre les deux (questions posées, réponses, questions pour tout le monde). */
  var MIN_COMMON = 3;
  function pairKey(a, b) { return a < b ? a + '__' + b : b + '__' + a; }
  function compat(game, picks, questions, collAnswers, CH) {
    var pids = (game.pids || []).slice(), out = {}, theme = {}, love = {};
    ((CH && CH.list) || []).forEach(function (c) { theme[c.id] = c.theme; });
    ((CH && CH.LOVE) || []).forEach(function (t) { love[t] = 1; });
    var pts = {}, add = function (a, b, n) { if (!a || !b || a === b) return; var k = pairKey(a, b); pts[k] = (pts[k] || 0) + n; };
    (questions || []).forEach(function (q) { add(q.from, q.to, 1); if (q.status === 'answered') add(q.from, q.to, 2); });
    var byC = {};
    (collAnswers || []).forEach(function (a) { if (!a.removed) (byC[a.cid] = byC[a.cid] || []).push(a.pid); });
    Object.keys(byC).forEach(function (c) { var l = byC[c]; for (var i = 0; i < l.length; i++) for (var j = i + 1; j < l.length; j++) add(l[i], l[j], 1); });
    for (var i = 0; i < pids.length; i++) for (var j = i + 1; j < pids.length; j++) {
      var a = pids[i], b = pids[j], pa = (picks || {})[a] || {}, pb = (picks || {})[b] || {};
      var n = 0, same = 0, ln = 0, lsame = 0;
      Object.keys(pa).forEach(function (cid) {
        if (!(cid in pb) || !(cid in theme) || pa[cid] < 0 || pb[cid] < 0) return;
        n++; if (pa[cid] === pb[cid]) same++;
        if (love[theme[cid]]) { ln++; if (pa[cid] === pb[cid]) lsame++; }
      });
      var k = pairKey(a, b);
      out[k] = {
        ami: n >= MIN_COMMON ? Math.round(100 * same / n) : null, amiN: n,
        amour: ln >= MIN_COMMON ? Math.round(100 * lsame / ln) : null, amourN: ln,
        compl: Math.round(100 * (1 - Math.exp(-(pts[k] || 0) / 20)))
      };
    }
    return out;
  }

  var L = {
    DAY: DAY, LEVELS: LEVELS, ADULT: ADULT, newCode: newCode, newId: newId, randInt: randInt, seeded: seeded,
    slots: slots, dueSlot: dueSlot, nextSlot: nextSlot, collectiveLevel: collectiveLevel, pickQuestion: pickQuestion, byId: byId,
    makeCollective: makeCollective, canCollective: canCollective, events: events, message: message, TEXTS: TEXTS,
    compat: compat, pairKey: pairKey, MIN_COMMON: MIN_COMMON, waitingSince: waitingSince
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = L; else root.DMT = L;
})(this);
