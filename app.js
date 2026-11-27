/* EXAO Arduino — appli unique pour les boîtiers du labo (Arduino Uno + shield Grove, 115 200 bauds)
   Lignes reçues de l'Arduino (une par mesure) :
     Température 3 sondes : "T;T1;T2;T3"              (°C, "NA" si sonde absente)
     Pression             : "P;pression_kPa;CAN"
     Intensité sonore     : "S;rms;crete_a_crete;moyenne"   (unités du CAN)
     Voltmètre-ampèremètre: "M;Umoy;Ueff;Imoy;Ieff;f;sat" et "CAL;zU;zI;gU;gI"
     Vitesse du son       : "T;médiane_µs;min;max;n"   (temps aller-retour, n = mesures valides)
   Commandes envoyées au voltmètre-ampèremètre : ZU, ZI, GU<gain>, GI<gain>, RAZ
   Laboratoire de physique chimie du lycée du Hainaut — Vincent Moineuse */
'use strict';

const $ = id => document.getElementById(id);
const pause = ms => new Promise(r => setTimeout(r, ms));
const msg = e => (e && e.message) ? e.message : String(e);
const store = {
  get(k, d) { try { const v = localStorage.getItem('exao.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('exao.' + k, JSON.stringify(v)); } catch (e) {} }
};
const fmt = (x, n) => (x == null || !isFinite(x)) ? '—' : x.toFixed(n).replace('.', ',');
const num = s => parseFloat(String(s).replace(',', '.'));
const moyenne = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;

/* =================== navigation =================== */
const NOMS = { temp: 'Température', pres: 'Pression', son: 'Intensité sonore', va: 'Voltmètre-ampèremètre', vit: 'Vitesse du son' };
let vue = 'accueil';
function montrer(v) {
  vue = v;
  document.querySelectorAll('.vue').forEach(s => s.hidden = s.id !== 'vue-' + v);
  document.querySelectorAll('#onglets button').forEach(b => b.classList.toggle('actif', b.dataset.vue === v));
  if (v === boitier) $('bandeau').hidden = true;
  if (modules[v]) modules[v].redessiner();
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-vue]').forEach(b => b.addEventListener('click', () => montrer(b.dataset.vue)));

/* =================== liaison série (Web Serial, ou WebUSB sur Android) =================== */
let port = null, boitier = null, nLignes = 0;
const etat = (t, ok) => { $('etat').textContent = t; $('etat').classList.toggle('ok', !!ok); };
window.addEventListener('pagehide', () => { if (port) { const p = port; port = null; p.close().catch(() => {}); } });

$('conn').onclick = async () => {
  if (port) { const p = port; port = null; try { await p.close(); } catch (e) {} return; }
  // Android (avant Android 17) ne liste pas l'USB filaire dans Web Serial : on passe par WebUSB (polyfill Google)
  const android = /Android/i.test(navigator.userAgent);
  let api = navigator.serial, voie = 'Web Serial';
  if ((android || !api) && navigator.usb && window.serialPolyfill) { api = window.serialPolyfill; voie = 'WebUSB (Android)'; }
  if (!api) {
    alert(window.isSecureContext ? "Ce navigateur ne permet pas l'accès à l'Arduino : utilisez Chrome ou Edge à jour (pas d'iPhone ni d'iPad)."
                                 : "La page doit être ouverte depuis une adresse https:// ou depuis la clé USB.");
    return;
  }
  try {
    port = await api.requestPort();
    try { await port.open({ baudRate: 115200 }); }
    catch (e1) {                                       // interface encore tenue par une session précédente : on réessaie une fois
      if (!/claim/i.test(msg(e1))) throw e1;
      await pause(1000);
      await port.open({ baudRate: 115200 });
    }
  } catch (e) {
    port = null;
    if (e && e.name === 'NotFoundError' && !voie.startsWith('WebUSB')) { etat('Non connecté (aucun port choisi)'); return; }
    etat('Erreur : ' + msg(e) +
      (voie.startsWith('WebUSB') && e && e.name === 'NotFoundError'
        ? " — aucune carte détectée : vérifiez l'adaptateur OTG (la LED ON de l'Arduino doit s'allumer). Les clones à puce CH340 ne sont pas reconnus sur Android."
        : /claim/i.test(msg(e)) ? " — la carte est occupée : fermez les autres onglets de l'appli et toute application série, débranchez puis rebranchez la carte."
        : /access|in use|occup/i.test(msg(e)) ? " — le port est occupé (moniteur série de l'IDE Arduino ou autre onglet ouvert ?)." : ''));
    return;
  }
  $('conn').textContent = 'Déconnecter';
  etat('Connecté (' + voie + ') — en attente des mesures…', true);
  boitier = null; nLignes = 0;
  let buf = '', erreurs = 0, reprises = 0;
  while (port) {
    const rs = port.readable;
    if (!rs) { if (++erreurs > 20) break; await pause(300); continue; }
    const dec = new TextDecoderStream();
    rs.pipeTo(dec.writable).catch(() => {});
    const reader = dec.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        erreurs = 0;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { recevoir(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
        if (buf.length > 500) buf = '';
      }
    } catch (e) {
      erreurs++; reprises++;
      if (port) etat(`Connecté (${voie}) — reprise après une erreur de lecture (${reprises}) : ${msg(e)}`, true);
    } finally { try { reader.releaseLock(); } catch (e) {} }
    buf = '';
    if (erreurs > 20) break;
    await pause(200);
  }
  const fin = port; port = null;
  if (fin) { try { await fin.close(); } catch (e) {} }
  $('conn').textContent = "Connecter l'Arduino";
  boitier = null; marquerBoitier();
  etat("Déconnecté — rebranchez la carte si besoin puis cliquez sur « Connecter l'Arduino »");
};

async function envoyer(txt) {
  if (!port || !port.writable) { alert("Connectez d'abord l'Arduino."); return false; }
  const w = port.writable.getWriter();
  try { await w.write(new TextEncoder().encode(txt + '\n')); return true; }
  catch (e) { alert("Envoi impossible : " + msg(e)); return false; }
  finally { w.releaseLock(); }
}

function identifier(p) {
  if (p[0] === 'T' && (p.length === 4 || p.length === 3)) return 'temp';     // 3 sondes (ou ancienne sonde unique)
  if (p[0] === 'T' && p.length === 5) return 'vit';
  if (p[0] === 'P' && p.length >= 2) return 'pres';
  if (p[0] === 'S' && p.length >= 4) return 'son';
  if ((p[0] === 'M' && p.length >= 7) || (p[0] === 'CAL' && p.length >= 5)) return 'va';
  return null;
}

function recevoir(l) {
  if (!l) return;
  nLignes++;
  $('diag').textContent = `Diagnostic : ${nLignes} ligne(s) reçue(s) — dernière : « ${l.slice(0, 48)} »`;
  const p = l.split(';');
  const id = identifier(p);
  if (!id) return;
  if (id !== boitier) {
    boitier = id; marquerBoitier();
    etat('Connecté — boîtier détecté : ' + NOMS[id], true);
    if (vue === 'accueil') montrer(id);
    else if (vue !== id) bandeau(`Boîtier « ${NOMS[id]} » détecté.`, 'Ouvrir sa page', () => montrer(id));
  }
  if (modules[id]) modules[id].ligne(p);
}

function marquerBoitier() {
  document.querySelectorAll('#onglets button, .tuile').forEach(b => b.classList.toggle('detecte', b.dataset.vue === boitier));
}
function bandeau(texte, bouton, action) {
  const b = $('bandeau');
  b.innerHTML = '';
  b.append(texte);
  const k = document.createElement('button'); k.textContent = bouton; k.onclick = () => { b.hidden = true; action(); };
  const x = document.createElement('button'); x.textContent = '✕'; x.onclick = () => { b.hidden = true; };
  b.append(k, x); b.hidden = false;
}

/* =================== outils communs =================== */
function regression(xs, ys) {
  const n = xs.length; if (n < 2) return null;
  const mx = moyenne(xs), my = moyenne(ys);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  if (sxx === 0) return null;
  const a = sxy / sxx, b = my - a * mx;
  return { a, b, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

function remplirTableau(idHead, idBody, entetes, lignes, supprimer) {
  $(idHead).innerHTML = '<tr>' + entetes.map(e => `<th>${e}</th>`).join('') + '<th></th></tr>';
  const tb = $(idBody);
  if (!lignes.length) { tb.innerHTML = `<tr><td class="vide" colspan="${entetes.length + 1}">Aucun point enregistré</td></tr>`; return; }
  tb.innerHTML = lignes.map((l, i) => '<tr>' + l.map(c => `<td>${c}</td>`).join('') +
    `<td><button class="sup" data-i="${i}" title="Supprimer ce point">✕</button></td></tr>`).join('');
  tb.querySelectorAll('.sup').forEach(b => b.onclick = () => supprimer(+b.dataset.i));
}

function exporterCSV(nom, entetes, lignes) {
  if (!lignes.length) { alert('Aucun point à exporter.'); return; }
  const cell = v => typeof v === 'number' ? (isFinite(v) ? String(+v.toPrecision(8)).replace('.', ',') : '') : String(v ?? '');
  const txt = '﻿' + [entetes, ...lignes].map(l => l.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' }));
  const d = new Date(), z = n => String(n).padStart(2, '0');
  a.download = `${nom}_${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}h${z(d.getMinutes())}.csv`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function graduations(min, max, n) {
  if (!(max > min)) { max = min + 1; min -= 1; }
  const brut = (max - min) / n, p = 10 ** Math.floor(Math.log10(brut)), r = brut / p;
  const pas = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * p;
  const d = Math.floor(min / pas) * pas, f = Math.ceil(max / pas) * pas, t = [];
  for (let v = d; v <= f + pas / 2; v += pas) t.push(+v.toPrecision(10));
  return { t, min: d, max: f, pas };
}

/* Tracé : series = [{nom, couleur, pts:[[x,y]...], ligne:true}], droite = {a,b} (optionnelle) */
function tracer(canvas, { series, xlabel, ylabel, droite, x0, y0 }) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const tous = series.flatMap(s => s.pts).filter(p => isFinite(p[0]) && isFinite(p[1]));
  g.font = '13px system-ui,sans-serif'; g.fillStyle = '#5b6475';
  if (!tous.length) { g.textAlign = 'center'; g.fillText('Le graphique apparaîtra avec les premiers points', W / 2, H / 2); return; }
  let xs = tous.map(p => p[0]), ys = tous.map(p => p[1]);
  let xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (x0) xmin = Math.min(0, xmin);
  if (y0) ymin = Math.min(0, ymin);
  if (xmax - xmin < 1e-9) { xmin -= 1; xmax += 1; }
  if (ymax - ymin < 1e-9) { const e = Math.abs(ymax) * 0.05 || 1; ymin -= e; ymax += e; }
  const gx = graduations(xmin, xmax, Math.max(3, Math.floor(W / 90))), gy = graduations(ymin, ymax, Math.max(3, Math.floor(H / 55)));
  const L = 62, R = 14, T = 26, B = 44, w = W - L - R, h = H - T - B;
  const X = x => L + (x - gx.min) / (gx.max - gx.min) * w, Y = y => T + h - (y - gy.min) / (gy.max - gy.min) * h;
  const lab = v => String(+v.toPrecision(6)).replace('.', ',');
  g.strokeStyle = '#e6eaf1'; g.lineWidth = 1; g.textAlign = 'right'; g.textBaseline = 'middle';
  gy.t.forEach(v => { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + w, Y(v)); g.stroke(); g.fillText(lab(v), L - 6, Y(v)); });
  g.textAlign = 'center'; g.textBaseline = 'top';
  gx.t.forEach(v => { g.beginPath(); g.moveTo(X(v), T); g.lineTo(X(v), T + h); g.stroke(); g.fillText(lab(v), X(v), T + h + 6); });
  g.strokeStyle = '#8a92a3'; g.strokeRect(L, T, w, h);
  g.fillStyle = '#1d2330'; g.fillText(xlabel, L + w / 2, H - 18);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(ylabel, 6, 16);
  if (droite) {
    g.save(); g.beginPath(); g.rect(L, T, w, h); g.clip();
    g.strokeStyle = '#b3261e'; g.setLineDash([6, 4]); g.lineWidth = 1.5; g.beginPath();
    g.moveTo(X(gx.min), Y(droite.a * gx.min + droite.b)); g.lineTo(X(gx.max), Y(droite.a * gx.max + droite.b)); g.stroke(); g.restore();
  }
  let lx = L + 8;
  series.forEach(s => {
    const pts = s.pts.filter(p => isFinite(p[0]) && isFinite(p[1]));
    g.strokeStyle = g.fillStyle = s.couleur; g.lineWidth = 2; g.setLineDash([]);
    if (s.ligne && pts.length > 1) { g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))); g.stroke(); }
    if (pts.length < 150) pts.forEach(p => { g.beginPath(); g.arc(X(p[0]), Y(p[1]), 3.5, 0, 7); g.fill(); });
    if (series.length > 1 && s.nom) {
      g.fillRect(lx, T + 8, 12, 12); g.fillStyle = '#1d2330'; g.textBaseline = 'top'; g.fillText(s.nom, lx + 16, T + 7);
      lx += g.measureText(s.nom).width + 34;
    }
  });
}

/* Enregistrement automatique à intervalle régulier */
function automate(idBouton, idSelect, tick) {
  let timer = null;
  const b = $(idBouton);
  const arreter = () => { clearInterval(timer); timer = null; b.textContent = '▶ Démarrer'; b.classList.add('primaire'); };
  b.onclick = () => {
    if (timer) { arreter(); return; }
    if (!port) { alert("Connectez d'abord l'Arduino."); return; }
    tick();
    timer = setInterval(() => { if (!port) arreter(); else tick(); }, num($(idSelect).value) * 1000);
    b.textContent = '■ Arrêter'; b.classList.remove('primaire');
  };
  return { arreter, actif: () => !!timer };
}
const tempsDepuis = (liste) => { const now = Date.now(); if (!liste.length) liste.t0 = now; return (now - liste.t0) / 1000; };
function confirmerRaz(liste) { return liste.length && confirm('Effacer tous les points enregistrés ?'); }
const recent = (hist, ms) => hist.filter(h => Date.now() - h.date <= ms);

/* =================== TEMPÉRATURE =================== */
const temp = (() => {
  const COUL = ['#1f4e8c', '#c0392b', '#1b7a33'];
  const noms = store.get('temp.noms', ['Sonde T1', 'Sonde T2', 'Sonde T3']);
  let live = [null, null, null], recu = false;
  const pts = []; // {t, v:[...]}
  $('temp-cartes').innerHTML = [0, 1, 2].map(k => `
    <div class="afficheur absent" id="temp-c${k}" style="--c:${COUL[k]}">
      <div class="nom"><input id="temp-n${k}" value="${noms[k].replace(/"/g, '&quot;')}" aria-label="Nom de la sonde T${k + 1}"></div>
      <div class="valeur"><span id="temp-v${k}">—</span> <small>°C</small></div>
      <div class="detail" id="temp-d${k}">T${k + 1} : non branchée</div>
    </div>`).join('');
  [0, 1, 2].forEach(k => $('temp-n' + k).oninput = e => { noms[k] = e.target.value || 'T' + (k + 1); store.set('temp.noms', noms); dessiner(); });

  function ligne(p) {
    if (p.length === 3) live = [num(p[1]), null, null];            // ancien sketch à une sonde CTN
    else live = p.slice(1, 4).map(v => (v === 'NA' || isNaN(num(v))) ? null : num(v));
    recu = true;
    live.forEach((v, k) => {
      $('temp-v' + k).textContent = fmt(v, 2);
      $('temp-c' + k).classList.toggle('absent', v == null);
      $('temp-d' + k).textContent = v == null ? `T${k + 1} : non branchée` : `T${k + 1} : connecteur D${k + 2}`;
    });
  }
  function point() {
    if (!recu) { alert("Aucune mesure reçue : connectez le boîtier température."); return; }
    if (live.every(v => v == null)) { alert('Aucune sonde branchée.'); return; }
    const t = tempsDepuis(pts);
    pts.push({ t, v: live.slice() });
    dessiner();
  }
  const auto = automate('temp-auto', 'temp-dt', point);
  $('temp-man').onclick = point;
  $('temp-raz').onclick = () => { if (confirmerRaz(pts)) { auto.arreter(); pts.length = 0; dessiner(); } };
  const actives = () => [0, 1, 2].filter(k => pts.some(p => p.v[k] != null));
  $('temp-csv').onclick = () => {
    const a = actives();
    exporterCSV('temperature', ['t (s)', ...a.map(k => noms[k] + ' (°C)')], pts.map(p => [p.t, ...a.map(k => p.v[k] ?? '')]));
  };
  function dessiner() {
    const a = actives();
    remplirTableau('temp-thead', 'temp-tbody', ['t (s)', ...a.map(k => noms[k] + ' (°C)')],
      pts.map(p => [fmt(p.t, 1), ...a.map(k => fmt(p.v[k], 2))]), i => { pts.splice(i, 1); dessiner(); });
    tracer($('temp-graphe'), {
      xlabel: 't (s)', ylabel: 'θ (°C)',
      series: a.map(k => ({ nom: noms[k], couleur: COUL[k], ligne: true, pts: pts.filter(p => p.v[k] != null).map(p => [p.t, p.v[k]]) }))
    });
  }
  return { ligne, redessiner: dessiner };
})();

/* =================== PRESSION =================== */
const pres = (() => {
  let brut = null, offset = store.get('pres.offset', 0), unite = store.get('pres.unite', 'hPa');
  const hist = [], bm = [], tps = [];            // bm : {v, vm, p} en mL et kPa ; tps : {t, p}
  const K = { hPa: [10, 0], kPa: [1, 1], bar: [0.01, 3] };
  const enU = kpa => kpa * K[unite][0];
  const fu = kpa => fmt(enU(kpa), K[unite][1]);
  $('pres-unite').value = unite;
  $('pres-vm').value = store.get('pres.vm', 0);
  $('pres-unite').onchange = e => { unite = e.target.value; store.set('pres.unite', unite); $('pres-unite-aff').textContent = unite; afficher(); dessiner(); };
  $('pres-unite-aff').textContent = unite;
  $('pres-vm').onchange = e => { store.set('pres.vm', num(e.target.value) || 0); };
  const P = () => { const r = recent(hist, 1500); return r.length ? moyenne(r.map(h => h.p)) + offset : null; };

  function ligne(p) {
    const v = num(p[1]); if (!isFinite(v)) return;
    brut = v; hist.push({ date: Date.now(), p: v }); if (hist.length > 30) hist.shift();
    afficher();
  }
  function afficher() {
    $('pres-val').textContent = brut == null ? '—' : fu(brut + offset);
    $('pres-detail').textContent = brut == null ? '' : (offset ? `étalonné (correction ${fmt(offset * 10, 1)} hPa)` : 'non étalonné');
    $('pres-etal-info').textContent = offset ? `Correction appliquée : ${fmt(offset * 10, 1)} hPa (gardée sur cet appareil).` : 'Aucune correction appliquée.';
  }
  afficher();
  $('pres-etal').onclick = () => {
    const patm = num($('pres-patm').value), r = recent(hist, 1500);
    if (!r.length) { alert("Aucune mesure reçue : connectez le boîtier pression."); return; }
    if (!(patm > 800 && patm < 1100)) { alert('Saisissez une pression atmosphérique en hPa (entre 800 et 1100).'); return; }
    offset = patm / 10 - moyenne(r.map(h => h.p)); store.set('pres.offset', offset); afficher(); dessiner();
  };
  $('pres-etal-raz').onclick = () => { offset = 0; store.set('pres.offset', 0); afficher(); dessiner(); };

  const mode = () => $('pres-mode').value;
  $('pres-mode').onchange = () => { $('pres-zbm').hidden = mode() !== 'bm'; $('pres-ztps').hidden = mode() !== 'tps'; dessiner(); };

  $('pres-pt').onclick = () => {
    const p = P(), v = num($('pres-v').value), vm = num($('pres-vm').value) || 0;
    if (p == null) { alert("Aucune mesure reçue : connectez le boîtier pression."); return; }
    if (!(v > 0)) { alert('Saisissez le volume V de la seringue (mL).'); $('pres-v').focus(); return; }
    bm.push({ v, vm, p }); $('pres-v').value = ''; $('pres-v').focus(); dessiner();
  };
  function pointTps() {
    const p = P(); if (p == null) { alert("Aucune mesure reçue : connectez le boîtier pression."); return; }
    tps.push({ t: tempsDepuis(tps), p }); dessiner();
  }
  const auto = automate('pres-auto', 'pres-dt', pointTps);
  $('pres-man').onclick = pointTps;
  $('pres-raz-bm').onclick = () => { if (confirmerRaz(bm)) { bm.length = 0; dessiner(); } };
  $('pres-raz-tps').onclick = () => { if (confirmerRaz(tps)) { auto.arreter(); tps.length = 0; dessiner(); } };
  $('pres-csv-bm').onclick = () => exporterCSV('boyle_mariotte', ['V seringue (mL)', 'V total (mL)', `P (${unite})`, '1/V (mL^-1)', `P×V (${unite}·mL)`],
    bm.map(q => { const vt = q.v + q.vm; return [q.v, vt, enU(q.p), 1 / vt, enU(q.p) * vt]; }));
  $('pres-csv-tps').onclick = () => exporterCSV('pression', ['t (s)', `P (${unite})`], tps.map(q => [q.t, enU(q.p)]));

  function dessiner() {
    const res = $('pres-res');
    if (mode() === 'bm') {
      remplirTableau('pres-thead', 'pres-tbody', ['V (mL)', 'V total (mL)', `P (${unite})`, '1/V (mL⁻¹)', `P×V (${unite}·mL)`],
        bm.map(q => { const vt = q.v + q.vm; return [fmt(q.v, 1), fmt(vt, 1), fu(q.p), fmt(1 / vt, 4), fmt(enU(q.p) * vt, 0)]; }),
        i => { bm.splice(i, 1); dessiner(); });
      const x = bm.map(q => 1 / (q.v + q.vm)), y = bm.map(q => enU(q.p)), r = regression(x, y);
      tracer($('pres-graphe'), { xlabel: '1/V (mL⁻¹)', ylabel: `P (${unite})`, x0: true, y0: true, droite: r,
        series: [{ couleur: '#1f4e8c', pts: x.map((v, i) => [v, y[i]]) }] });
      if (r && bm.length >= 3) {
        const pv = bm.map(q => enU(q.p) * (q.v + q.vm)), m = moyenne(pv), e = (Math.max(...pv) - Math.min(...pv)) / 2 / m * 100;
        res.innerHTML = `Droite de régression : P = ${fmt(r.a, 1)} × (1/V) ${r.b < 0 ? '−' : '+'} ${fmt(Math.abs(r.b), 1)} &nbsp; (R² = ${r.r2.toFixed(4).replace('.', ',')})<br>` +
          `P×V moyen = ${fmt(m, 0)} ${unite}·mL, écart maximal ± ${fmt(e, 1)} %. Si P×V est constant, la loi de Boyle-Mariotte est vérifiée.`;
        res.hidden = false;
      } else res.hidden = true;
    } else {
      remplirTableau('pres-thead', 'pres-tbody', ['t (s)', `P (${unite})`], tps.map(q => [fmt(q.t, 1), fu(q.p)]), i => { tps.splice(i, 1); dessiner(); });
      tracer($('pres-graphe'), { xlabel: 't (s)', ylabel: `P (${unite})`, series: [{ couleur: '#1f4e8c', ligne: true, pts: tps.map(q => [q.t, enU(q.p)]) }] });
      res.hidden = true;
    }
  }
  return { ligne, redessiner: dessiner };
})();

/* =================== INTENSITÉ SONORE =================== */
const son = (() => {
  let K = store.get('son.K', null), live = null;
  const hist = [], pd = [], tps = [];           // pd : {d, L} ; tps : {t, L}
  const niveau = rms => rms > 0 ? 20 * Math.log10(rms) + (K ?? 0) : null;
  const Lmoy = () => { const r = recent(hist, 1000).map(h => h.rms).filter(v => v > 0); return r.length ? niveau(Math.sqrt(moyenne(r.map(v => v * v)))) : null; };

  function ligne(p) {
    const rms = num(p[1]), pp = num(p[2]); if (!isFinite(rms)) return;
    live = { rms, pp }; hist.push({ date: Date.now(), rms }); if (hist.length > 40) hist.shift();
    const L = Lmoy();
    $('son-val').textContent = fmt(L, 1);
    $('son-detail').innerHTML = `${K == null ? '<span class="alerte">non étalonné (niveau relatif)</span> — ' : ''}valeur efficace ${fmt(rms, 1)} — crête à crête ${fmt(pp, 0)} (unités du CAN)` +
      (pp >= 1000 ? ' — <span class="alerte">saturation : baisser le gain (potentiomètre) ou s\'éloigner</span>' : '');
  }
  function infoEtal() { $('son-etal-info').textContent = K == null ? "Non étalonné : les dB affichés sont relatifs (seules les différences de niveau ont un sens)." : `Constante d'étalonnage : ${fmt(K, 1)} dB (gardée sur cet appareil). Ne plus toucher au potentiomètre du capteur.`; }
  infoEtal();
  $('son-etal').onclick = () => {
    const ref = num($('son-ref').value), r = recent(hist, 1000).map(h => h.rms).filter(v => v > 0);
    if (!r.length) { alert("Aucune mesure reçue : connectez le boîtier intensité sonore."); return; }
    if (!(ref > 20 && ref < 140)) { alert('Saisissez la valeur lue sur le sonomètre (en dB).'); return; }
    K = ref - 20 * Math.log10(Math.sqrt(moyenne(r.map(v => v * v)))); store.set('son.K', K); infoEtal();
  };
  $('son-etal-raz').onclick = () => { K = null; store.set('son.K', null); infoEtal(); };

  const mode = () => $('son-mode').value;
  $('son-mode').onchange = () => { $('son-zd').hidden = mode() !== 'd'; $('son-ztps').hidden = mode() !== 'tps'; dessiner(); };
  $('son-pt').onclick = () => {
    const L = Lmoy(), d = num($('son-d').value);
    if (L == null) { alert("Aucune mesure reçue : connectez le boîtier intensité sonore."); return; }
    if (!(d > 0)) { alert('Saisissez la distance (cm).'); $('son-d').focus(); return; }
    pd.push({ d, L }); $('son-d').value = ''; $('son-d').focus(); dessiner();
  };
  function pointTps() {
    const L = Lmoy(); if (L == null) { alert("Aucune mesure reçue : connectez le boîtier intensité sonore."); return; }
    tps.push({ t: tempsDepuis(tps), L }); dessiner();
  }
  const auto = automate('son-auto', 'son-dt', pointTps);
  $('son-man').onclick = pointTps;
  $('son-raz-d').onclick = () => { if (confirmerRaz(pd)) { pd.length = 0; dessiner(); } };
  $('son-raz-tps').onclick = () => { if (confirmerRaz(tps)) { auto.arreter(); tps.length = 0; dessiner(); } };
  $('son-csv-d').onclick = () => exporterCSV('niveau_sonore_distance', ['d (cm)', 'log10(d)', 'L (dB)'], pd.map(q => [q.d, Math.log10(q.d), q.L]));
  $('son-csv-tps').onclick = () => exporterCSV('niveau_sonore', ['t (s)', 'L (dB)'], tps.map(q => [q.t, q.L]));

  function dessiner() {
    const res = $('son-res');
    if (mode() === 'd') {
      remplirTableau('son-thead', 'son-tbody', ['d (cm)', 'log₁₀(d)', 'L (dB)'], pd.map(q => [fmt(q.d, 1), fmt(Math.log10(q.d), 3), fmt(q.L, 1)]), i => { pd.splice(i, 1); dessiner(); });
      const x = pd.map(q => Math.log10(q.d)), y = pd.map(q => q.L), r = regression(x, y);
      tracer($('son-graphe'), { xlabel: 'log₁₀(d)  (d en cm)', ylabel: 'L (dB)', droite: r, series: [{ couleur: '#8c3b1f', pts: x.map((v, i) => [v, y[i]]) }] });
      if (r && pd.length >= 3) {
        res.innerHTML = `Pente : ${fmt(r.a, 1)} dB par décade (théorie : −20 dB par décade, source ponctuelle en champ libre)<br>` +
          `Soit ${fmt(r.a * Math.log10(2), 1)} dB quand la distance double (théorie : −6 dB). R² = ${r.r2.toFixed(3).replace('.', ',')}`;
        res.hidden = false;
      } else res.hidden = true;
    } else {
      remplirTableau('son-thead', 'son-tbody', ['t (s)', 'L (dB)'], tps.map(q => [fmt(q.t, 1), fmt(q.L, 1)]), i => { tps.splice(i, 1); dessiner(); });
      tracer($('son-graphe'), { xlabel: 't (s)', ylabel: 'L (dB)', series: [{ couleur: '#8c3b1f', ligne: true, pts: tps.map(q => [q.t, q.L]) }] });
      res.hidden = true;
    }
  }
  return { ligne, redessiner: dessiner };
})();

/* =================== VOLTMÈTRE-AMPÈREMÈTRE =================== */
const va = (() => {
  let cur = null, cal = null;
  const hist = [], car = [], tps = [];          // car : {u, i} ; tps : {t, u, i}
  const mode = () => document.querySelector('input[name=va-mode]:checked').value;
  const typ = () => $('va-type').value;

  function ligne(p) {
    if (p[0] === 'CAL') {
      cal = { zU: num(p[1]), zI: num(p[2]), gU: num(p[3]), gI: num(p[4]) };
      $('va-cal').textContent = `Valeurs enregistrées dans la carte : zéro U ${fmt(cal.zU, 1)}, zéro I ${fmt(cal.zI, 1)} (pas du CAN), gain U ${fmt(cal.gU, 4)}, gain I ${fmt(cal.gI, 4)}`;
      return;
    }
    const v = p.slice(1, 7).map(num); if (v.some(isNaN)) return;
    cur = { um: v[0], ue: v[1], im: v[2], ie: v[3], f: v[4], sat: v[5], date: Date.now() };
    hist.push(cur); if (hist.length > 8) hist.shift();
    afficher();
  }
  function afficher() {
    if (!cur) return;
    const m = mode(), fr = cur.f > 0 ? ` — f = ${fmt(cur.f, 1)} Hz` : '';
    $('va-u').textContent = fmt(m === 'moy' ? cur.um : cur.ue, 2);
    $('va-i').textContent = fmt(m === 'moy' ? cur.im : cur.ie, 3);
    $('va-ud').innerHTML = `moyenne ${fmt(cur.um, 2)} V — efficace ${fmt(cur.ue, 2)} V${fr}` + (cur.sat & 1 ? ' <span class="alerte">— DÉPASSEMENT DE CALIBRE</span>' : '');
    $('va-id').innerHTML = `moyenne ${fmt(cur.im, 3)} A — efficace ${fmt(cur.ie, 3)} A${fr}` + ((cur.sat & 2) || cur.ie > 5 ? ' <span class="alerte">— DÉPASSEMENT DE CALIBRE (5 A max)</span>' : '');
  }
  document.querySelectorAll('input[name=va-mode]').forEach(r => r.onchange = () => { afficher(); dessiner(); });
  function lecture() {                            // moyenne des 2 dernières secondes
    const r = recent(hist, 2000); if (!r.length) return null;
    const m = mode();
    return { u: moyenne(r.map(h => m === 'moy' ? h.um : h.ue)), i: moyenne(r.map(h => m === 'moy' ? h.im : h.ie)) };
  }
  $('va-type').onchange = () => { $('va-zcar').hidden = typ() !== 'car'; $('va-ztps').hidden = typ() !== 'tps'; dessiner(); };
  $('va-pt').onclick = () => {
    const l = lecture(); if (!l) { alert("Aucune mesure reçue : connectez le boîtier voltmètre-ampèremètre."); return; }
    car.push(l); dessiner();
  };
  function pointTps() {
    const l = lecture(); if (!l) { alert("Aucune mesure reçue : connectez le boîtier voltmètre-ampèremètre."); return; }
    tps.push({ t: tempsDepuis(tps), ...l }); dessiner();
  }
  const auto = automate('va-auto', 'va-dt', pointTps);
  $('va-man').onclick = pointTps;
  $('va-courbe').onchange = () => dessiner();
  $('va-raz-car').onclick = () => { if (confirmerRaz(car)) { car.length = 0; dessiner(); } };
  $('va-raz-tps').onclick = () => { if (confirmerRaz(tps)) { auto.arreter(); tps.length = 0; dessiner(); } };
  const suffixe = () => mode() === 'moy' ? 'continu' : 'alternatif (eff.)';
  $('va-csv-car').onclick = () => exporterCSV('caracteristique_U_I', ['I (A)', 'U (V)', 'P (W)', 'mode'], car.map(q => [q.i, q.u, q.u * q.i, suffixe()]));
  $('va-csv-tps').onclick = () => exporterCSV('suivi_U_I', ['t (s)', 'U (V)', 'I (A)', 'P (W)'], tps.map(q => [q.t, q.u, q.i, q.u * q.i]));

  function dessiner() {
    const res = $('va-res');
    if (typ() === 'car') {
      remplirTableau('va-thead', 'va-tbody', ['I (A)', 'U (V)', 'P = U·I (W)'], car.map(q => [fmt(q.i, 3), fmt(q.u, 2), fmt(q.u * q.i, 3)]), i => { car.splice(i, 1); dessiner(); });
      const r = regression(car.map(q => q.i), car.map(q => q.u));
      tracer($('va-graphe'), { xlabel: 'I (A)', ylabel: 'U (V)', x0: true, y0: true, droite: r, series: [{ couleur: '#1f4e8c', pts: car.map(q => [q.i, q.u]) }] });
      if (r && car.length >= 3) {
        res.innerHTML = `Droite de régression : U = ${fmt(r.a, 3)} × I ${r.b < 0 ? '−' : '+'} ${fmt(Math.abs(r.b), 3)} &nbsp; (R² = ${r.r2.toFixed(4).replace('.', ',')})<br>` +
          (r.a >= 0
            ? `Dipôle récepteur : la pente donne la résistance R ≈ ${fmt(r.a, 2)} Ω (loi d'Ohm U = R·I si la droite passe par l'origine).`
            : `Générateur (U = E − r·I) : force électromotrice E ≈ ${fmt(r.b, 2)} V, résistance interne r ≈ ${fmt(-r.a, 2)} Ω.`);
        res.hidden = false;
      } else res.hidden = true;
    } else {
      remplirTableau('va-thead', 'va-tbody', ['t (s)', 'U (V)', 'I (A)', 'P (W)'], tps.map(q => [fmt(q.t, 1), fmt(q.u, 2), fmt(q.i, 3), fmt(q.u * q.i, 3)]), i => { tps.splice(i, 1); dessiner(); });
      const c = $('va-courbe').value, lab = { u: 'U (V)', i: 'I (A)', p: 'P (W)' }[c], col = { u: '#1f4e8c', i: '#b8860b', p: '#6a1b9a' }[c];
      tracer($('va-graphe'), { xlabel: 't (s)', ylabel: lab, series: [{ couleur: col, ligne: true, pts: tps.map(q => [q.t, c === 'u' ? q.u : c === 'i' ? q.i : q.u * q.i]) }] });
      res.hidden = true;
    }
  }

  // ---- étalonnage (professeur) ----
  $('va-zu').onclick = () => envoyer('ZU');
  $('va-zi').onclick = () => envoyer('ZI');
  $('va-rcal').onclick = () => { if (confirm("Revenir aux valeurs d'étalonnage par défaut dans la carte ?")) envoyer('RAZ'); };
  function etalonner(voie) {
    if (!cal || !cur) { alert("Connectez d'abord le boîtier voltmètre-ampèremètre (les valeurs d'étalonnage de la carte doivent s'afficher)."); return; }
    const ref = num($(voie === 'U' ? 'va-refu' : 'va-refi').value), l = lecture(), lu = voie === 'U' ? l.u : l.i;
    if (isNaN(ref) || Math.abs(lu) < (voie === 'U' ? 1 : 0.1)) {
      alert(voie === 'U' ? "Saisissez la tension de référence (au moins 1 V)." : "Saisissez l'intensité de référence (au moins 0,1 A)."); return;
    }
    const g = (voie === 'U' ? cal.gU : cal.gI) * ref / lu;
    if (g < 0.5 || g > 2) { alert('Correction trop importante (' + g.toFixed(3) + ') : vérifiez le branchement et le zéro.'); return; }
    envoyer('G' + voie + g.toFixed(5));
  }
  $('va-cu').onclick = () => etalonner('U');
  $('va-ci').onclick = () => etalonner('I');
  return { ligne, redessiner: dessiner };
})();

/* =================== VITESSE DU SON =================== */
const vit = (() => {
  let live = null;
  const hist = [], pts = [];                     // pts : {d (cm), t (µs)}
  $('vit-theta').value = store.get('vit.theta', 20);
  $('vit-theta').onchange = e => { store.set('vit.theta', num(e.target.value)); dessiner(); };
  const tMoy = () => { const r = recent(hist, 1200).filter(h => h.t > 0); return r.length ? moyenne(r.map(h => h.t)) : null; };

  function ligne(p) {
    const v = p.slice(1, 5).map(num); if (v.some(isNaN)) return;
    live = { t: v[0], min: v[1], max: v[2], n: v[3] };
    hist.push({ date: Date.now(), t: live.n > 0 ? live.t : 0 }); if (hist.length > 30) hist.shift();
    const ok = live.n > 0 && live.t > 0;
    $('vit-t').textContent = ok ? Math.round(live.t) : '—';
    $('vit-detail').innerHTML = ok ? `min ${live.min} – max ${live.max} µs, ${live.n} mesures valides`
      : '<span class="alerte">pas d\'écho : vérifier l\'écran réflecteur (face au boîtier, perpendiculaire, à plus de 3 cm)</span>';
  }
  $('vit-pt').onclick = () => {
    const t = tMoy(), d = num($('vit-d').value);
    if (!live) { alert("Aucune mesure reçue : connectez le boîtier vitesse du son."); return; }
    if (t == null) { alert("Pas d'écho : vérifiez la position de l'écran réflecteur."); return; }
    if (!(d > 0)) { alert('Saisissez la distance boîtier - écran (cm).'); $('vit-d').focus(); return; }
    pts.push({ d, t }); $('vit-d').value = ''; $('vit-d').focus(); dessiner();
  };
  $('vit-raz').onclick = () => { if (confirmerRaz(pts)) { pts.length = 0; dessiner(); } };
  $('vit-csv').onclick = () => exporterCSV('vitesse_son', ['d (cm)', 't aller-retour (µs)', 'v = 2d/t (m/s)'], pts.map(q => [q.d, q.t, 2 * q.d * 1e4 / q.t]));

  function dessiner() {
    remplirTableau('vit-thead', 'vit-tbody', ['d (cm)', 't aller-retour (µs)', 'v = 2d/t (m/s)'],
      pts.map(q => [fmt(q.d, 1), fmt(q.t, 0), fmt(2 * q.d * 1e4 / q.t, 1)]), i => { pts.splice(i, 1); dessiner(); });
    const r = regression(pts.map(q => q.t), pts.map(q => q.d));
    tracer($('vit-graphe'), { xlabel: 't aller-retour (µs)', ylabel: 'd (cm)', x0: true, y0: true, droite: r,
      series: [{ couleur: '#00695c', pts: pts.map(q => [q.t, q.d]) }] });
    const res = $('vit-res'), th = num($('vit-theta').value);
    const vth = isFinite(th) ? 331.3 * Math.sqrt(1 + th / 273.15) : null;
    if (r && pts.length >= 3 && r.a > 0) {
      const v = 2 * r.a * 1e4, t0 = -r.b / r.a;   // d = (v/2)(t - t0) ; a en cm/µs -> ×1e4 pour des m/s
      res.innerHTML = `Droite de régression : d = ${fmt(r.a, 5)} × t ${r.b < 0 ? '−' : '+'} ${fmt(Math.abs(r.b), 2)} &nbsp; (R² = ${r.r2.toFixed(4).replace('.', ',')})<br>` +
        `L'onde parcourt 2d pendant t, donc v = 2 × pente : <b>v = ${fmt(v, 1)} m/s</b>. Retard propre au module : t₀ ≈ ${fmt(t0, 0)} µs (éliminé par la régression).` +
        (vth ? `<br>Valeur théorique à ${fmt(th, 1)} °C : v = 331,3 × √(1 + θ/273,15) = ${fmt(vth, 1)} m/s — écart ${fmt((v - vth) / vth * 100, 1)} %` : '');
      res.hidden = false;
    } else res.hidden = true;
  }
  return { ligne, redessiner: dessiner };
})();

const modules = { temp, pres, son, va, vit };
const depart = location.hash.slice(1);
if (modules[depart]) montrer(depart);
window.addEventListener('resize', () => { if (modules[vue]) modules[vue].redessiner(); });

/* =================== PWA : installation et fonctionnement hors ligne =================== */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
let invite = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); invite = e; $('installer').hidden = false; });
$('installer').onclick = async () => { if (!invite) return; invite.prompt(); await invite.userChoice; invite = null; $('installer').hidden = true; };
window.addEventListener('appinstalled', () => { $('installer').hidden = true; });
if (!navigator.serial && !navigator.usb) etat("Non connecté — ce navigateur n'a pas accès à l'USB : utilisez Chrome ou Edge (PC) ou Chrome (Android).");
