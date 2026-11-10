/* 共聴図面ツール: 図記号・損失テーブル・レベル計算エンジン
 * 出典: 国交省 公共建築設備工事標準図(電気設備工事編)令和4年版 図記号、
 *       JEITA 受信システム計算事例集 第2.2a版(2025)
 */
'use strict';

const KZ = {};

/* ---------- 周波数と目標レベル ---------- */
KZ.FREQS = [470, 710, 1000, 1489, 2150, 2681, 3224];
KZ.isTerr = (i) => i < 2;            // 0,1 = 地デジ / 2..6 = BS・110°CS IF
KZ.RANGE = { terr: [50, 81], sat: [54, 81] };
KZ.rangeOf = (i) => (KZ.isTerr(i) ? KZ.RANGE.terr : KZ.RANGE.sat);

/* ---------- 同軸ケーブル (JEITA 7-7 / 3-2) ---------- */
const CABLE_BASE_F = [470, 770, 1000, 1489, 2150, 2681, 3224];
KZ.CABLES = {
  '5C': { name: 'S-5C-FB', base: [145, 192, 224, 284, 355, 408, 459] },
  '7C': { name: 'S-7C-FB', base: [105, 140, 164, 210, 265, 306, 346] },
};
function sqrtInterp(fA, fB, a, b, f) {
  return a + (b - a) * (Math.sqrt(f) - Math.sqrt(fA)) / (Math.sqrt(fB) - Math.sqrt(fA));
}
KZ.cablePerKm = function (type) {
  const c = KZ.CABLES[type] || KZ.CABLES['5C'];
  return KZ.FREQS.map((f) => {
    const i = CABLE_BASE_F.indexOf(f);
    if (i >= 0) return c.base[i];
    let j = CABLE_BASE_F.findIndex((x) => x > f);
    if (j <= 0) j = 1;
    return sqrtInterp(CABLE_BASE_F[j - 1], CABLE_BASE_F[j], c.base[j - 1], c.base[j], f);
  });
};

/* ---------- 機器損失テーブル [470,710,1000,1489,2150,2681,3224] ----------
 * src: 'JEITA' = 計算事例集の値 / '目安' = 一般的な製品値からの仮置き(メーカー値で上書き推奨)
 */
KZ.T = {
  splitter: {
    2: { v: [4.0, 4.0, 4.5, 4.5, 5.5, 6.5, 7.5], src: 'JEITA' },
    4: { v: [8.0, 8.0, 9.0, 9.0, 10.5, 11.5, 13.0], src: 'JEITA' },
    6: { v: [11.0, 11.0, 12.0, 12.0, 14.0, 16.0, 18.0], src: 'JEITA' },
    8: { v: [12.0, 12.0, 13.5, 13.5, 15.5, 17.5, 19.5], src: '目安' },
  },
  tapIns: {
    1: { v: [1.5, 1.5, 2.0, 2.0, 3.0, 4.0, 4.5], src: 'JEITA' },
    2: { v: [2.5, 2.5, 3.0, 3.5, 4.5, 5.0, 6.0], src: '目安' },
    4: { v: [4.5, 4.5, 5.5, 5.5, 6.0, 6.5, 7.5], src: 'JEITA' },
  },
  // 結合損失 = 公称値(UHF帯) + 周波数オフセット (JEITA 1分岐器 12/12/13/13/14/14.5/15.5 より)
  coupOffset: [0, 0, 1.0, 1.0, 2.0, 2.5, 3.5],
  mixer: { v: [1.0, 1.0, 1.5, 1.5, 1.5, 2.0, 2.0], src: '目安' },
  outlet: {
    1: { v: [1.0, 1.0, 1.5, 1.5, 2.0, 2.5, 3.0], src: '目安' },
    2: { v: [4.5, 4.5, 5.0, 5.0, 6.0, 7.0, 8.0], src: 'JEITA' },
  },
  seriesIns: { v: [1.5, 1.5, 2.0, 2.0, 2.5, 3.0, 3.5], src: '目安' },
  seriesEnd: { v: [1.0, 1.0, 1.5, 1.5, 2.0, 2.5, 3.0], src: '目安' },
};

KZ.parseVec = function (s) {
  if (s == null || String(s).trim() === '') return null;
  const a = String(s).split(/[,\s、]+/).filter((x) => x !== '').map(Number);
  if (a.length !== 7 || a.some((x) => !Number.isFinite(x))) return null;
  return a;
};

/* ---------- 機器タイプ定義 ---------- */
KZ.TYPES = {
  uhf_ant:  { name: 'UHFアンテナ', group: 'アンテナ', defaults: { label: 'UHFアンテナ 20素子', E: 60, g470: 8.1, g710: 13.4, cn: 32.2 } },
  bs_ant:   { name: 'BS・110°CSアンテナ', group: 'アンテナ', defaults: { label: '75型BS・110°CS', level: 77.9, cn: 19.0 } },
  mixer:    { name: '混合(分波)器', group: '増幅・混合', defaults: { label: '混合器', lossOverride: '' } },
  booster:  { name: '増幅器(ブースタ)', group: '増幅・混合', defaults: {
    label: 'ブースタ CS・BS・UHF', dualIn: false,
    uhfAtt: 0, uhfGain: 40, uhfAdj: 0,
    satAtt: 0, satInTilt: 0, satGainLow: 35, satGainHigh: 45, satAdjLow: 0, satAdjHigh: 0,
    ratedUhf: 108, ratedSat: 110, nfUhf: 3, nfSat: 10 } },
  tap:      { name: '分岐器', group: '分岐器', defaults: { label: '', n: 1, coupling: 15, lossOverride: '', coupOverride: '' } },
  splitter: { name: '分配器', group: '分配器', defaults: { label: '', n: 2, lossOverride: '' } },
  outlet:   { name: 'テレビ端子', group: '端子', defaults: { label: '', terminals: 1, S: false, lossOverride: '' } },
  series:   { name: '直列ユニット', group: '端子', defaults: { label: '', end: false, coupling: 12, lossOverride: '', coupOverride: '' } },
  term:     { name: '終端抵抗器', group: 'その他', defaults: { label: '' } },
  box:      { name: '機器収容箱', group: 'その他', defaults: { label: 'TV-1', w: 260, h: 160 } },
  text:     { name: 'テキスト', group: 'その他', defaults: { text: 'テキスト', size: 13 } },
};

KZ.displayName = function (n) {
  const p = n.p;
  switch (n.type) {
    case 'tap': return `${p.n}分岐器`;
    case 'splitter': return `${p.n}分配器`;
    case 'outlet': return `${p.terminals}端子形テレビ端子`;
    case 'series': return p.end ? '直列ユニット(終端形)' : '直列ユニット';
    default: return KZ.TYPES[n.type].name;
  }
};
// 図面上の傍記
KZ.annotation = function (n) {
  const p = n.p;
  if (p.label) return p.label;
  switch (n.type) {
    case 'tap': return `${p.n}分岐器 ${p.coupling}dB`;
    case 'splitter': return `${p.n}分配器`;
    case 'outlet': return p.S ? 'S' : '';
    case 'series': return (p.end ? 'R ' : '') + `${p.coupling}dB`;
    default: return '';
  }
};

/* ---------- 端子(ポート)ジオメトリ ---------- */
const R = 14;
KZ.R = R;
function ticksY(k) {
  return { 1: [0], 2: [-3, 3], 3: [-6, 0, 6], 4: [-9, -3, 3, 9] }[k] || [0];
}
const TICK = 9;

KZ.ports = function (n) {
  const p = n.p;
  const P = (id, x, y, dir, kind) => ({ id, x, y, dir, kind });
  switch (n.type) {
    case 'uhf_ant': return [P('out', 0, 20, 'down', 'out')];
    case 'bs_ant': return [P('out', 0, 20, 'down', 'out')];
    case 'mixer': return [P('in1', -6, -24, 'up', 'in'), P('in2', 6, -24, 'up', 'in'), P('out', 0, 24, 'down', 'out')];
    case 'booster':
      return p.dualIn
        ? [P('inU', -6, -20, 'up', 'in'), P('inS', 6, -20, 'up', 'in'), P('out', 0, 20, 'down', 'out')]
        : [P('in', 0, -20, 'up', 'in'), P('out', 0, 20, 'down', 'out')];
    case 'splitter': {
      const k = p.n / 2, ys = ticksY(k), a = [P('in', 0, -R - 8, 'up', 'in')];
      ys.forEach((y, i) => a.push(P('o' + (i + 1), R + TICK, y, 'right', 'out')));
      ys.forEach((y, i) => a.push(P('o' + (k + i + 1), -R - TICK, y, 'left', 'out')));
      return a;
    }
    case 'tap': {
      const a = [P('in', 0, -R - 8, 'up', 'in'), P('out', 0, R + 8, 'down', 'out')];
      const right = p.n === 4 ? [-3, 3] : [0];
      const left = p.n === 1 ? [] : p.n === 2 ? [0] : [-3, 3];
      let c = 1;
      right.forEach((y) => a.push(P('b' + c++, R + TICK, y, 'right', 'out')));
      left.forEach((y) => a.push(P('b' + c++, -R - TICK, y, 'left', 'out')));
      return a;
    }
    case 'outlet': return [P('in', 0, -21, 'up', 'in')];
    case 'series':
      return p.end ? [P('in', 0, -21, 'up', 'in')] : [P('in', 0, -21, 'up', 'in'), P('out', 0, 21, 'down', 'out')];
    case 'term': return [P('in', 0, -16, 'up', 'in')];
    default: return [];
  }
};
KZ.port = (n, id) => KZ.ports(n).find((q) => q.id === id);
KZ.DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/* ---------- 図記号描画 (SVG 文字列, ローカル座標) ---------- */
KZ.symbol = function (n) {
  const p = n.p;
  const L = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const C = (cx, cy, r, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" ${extra}/>`;
  let s = '';
  switch (n.type) {
    case 'uhf_ant':
      s = `<line x1="-16" y1="-16" x2="16" y2="-16" stroke-width="2.6"/>` + L(0, -16, 0, 20);
      break;
    case 'bs_ant':
      s = `<path d="M-19,-13 A15,15 0 0 1 -19,13" fill="none"/>` +
          `<rect x="-10" y="-7" width="20" height="14" fill="#fff"/>` + L(-10, -7, 10, 7) + L(0, 7, 0, 20);
      break;
    case 'mixer':
      s = C(0, 0, 13, 'fill="#fff"') + L(-6, -11.5, 0, 12) + L(6, -11.5, 0, 12) +
          L(-6, -11.5, -6, -24) + L(6, -11.5, 6, -24) + L(0, 13, 0, 24);
      break;
    case 'booster':
      s = (p.dualIn ? L(-6, -9, -6, -20) + L(6, -9, 6, -20) : L(0, -9, 0, -20)) +
          `<path d="M-12,-9 L12,-9 L0,11 Z" fill="#fff"/>` + L(0, 11, 0, 20);
      break;
    case 'splitter': {
      const k = p.n / 2;
      s = C(0, 0, R, 'fill="#fff"') + L(0, -R, 0, -R - 8);
      ticksY(k).forEach((y) => {
        const x0 = Math.sqrt(R * R - y * y);
        s += L(x0, y, R + TICK, y) + L(-x0, y, -R - TICK, y);
      });
      break;
    }
    case 'tap': {
      s = C(0, 0, R, 'fill="#fff"') + L(0, -R - 8, 0, R + 8);
      const right = p.n === 4 ? [-3, 3] : [0];
      const left = p.n === 1 ? [] : p.n === 2 ? [0] : [-3, 3];
      right.forEach((y) => { s += L(Math.sqrt(R * R - y * y), y, R + TICK, y); });
      left.forEach((y) => { s += L(-Math.sqrt(R * R - y * y), y, -R - TICK, y); });
      break;
    }
    case 'outlet':
    case 'series': {
      s = C(0, 0, 11, 'fill="#fff"') + L(0, -11, 0, -21);
      const two = n.type === 'outlet' && p.terminals === 2;
      s += two ? C(0, -3.6, 3.2) + C(0, 3.6, 3.2) : C(0, 0, 4);
      if (n.type === 'series' && !p.end) s += L(0, 11, 0, 21);
      break;
    }
    case 'term':
      s = L(0, -16, 0, -6) + C(0, 0, 6, 'fill="#fff"') + L(-4.2, -4.2, 4.2, 4.2) + L(-4.2, 4.2, 4.2, -4.2);
      break;
    default:
      s = '';
  }
  return s;
};

/* ---------- 損失ベクトル ---------- */
// 計算表を手計算(JEITA形式)と一致させるため、各段の値を 0.1dB 単位に丸める
const r1 = (x) => Math.round(x * 10 + 1e-9) / 10;  // 1.05 などの浮動小数誤差で切り下がらないよう補正
KZ.r1 = r1;
KZ.lossVec = function (n) {
  const p = n.p;
  const ov = KZ.parseVec(p.lossOverride);
  switch (n.type) {
    case 'splitter': return ov || KZ.T.splitter[p.n].v;
    case 'tap': return ov || KZ.T.tapIns[p.n].v;
    case 'mixer': return ov || KZ.T.mixer.v;
    case 'outlet': return ov || KZ.T.outlet[p.terminals].v;
    case 'series': return ov || (p.end ? KZ.T.seriesEnd.v : KZ.T.seriesIns.v);
    default: return [0, 0, 0, 0, 0, 0, 0];
  }
};
KZ.coupVec = function (n) {
  const ov = KZ.parseVec(n.p.coupOverride);
  return ov || KZ.T.coupOffset.map((o) => o + Number(n.p.coupling));
};
KZ.edgeLoss = function (e) {
  if (e.p.cable === 'direct') return [0, 0, 0, 0, 0, 0, 0];
  if (e.p.cable === 'custom') return KZ.parseVec(e.p.lossOverride) || [0, 0, 0, 0, 0, 0, 0];
  return KZ.cablePerKm(e.p.cable).map((v) => r1((v * Number(e.p.len || 0)) / 1000));
};
KZ.cableText = function (e) {
  if (e.p.cable === 'direct') return '直結';
  if (e.p.cable === 'custom') return `${e.p.name || 'ケーブル'} ${e.p.len}m`;
  return `${KZ.CABLES[e.p.cable].name}(${e.p.len}m)`;
};

/* ブースタ: 周波数ごとの利得明細 (JEITA表と同じく 0.1dB 単位) */
KZ.boosterDetail = function (p) {
  const lin = (lo, hi, f) => r1(lo + (hi - lo) * (f - 1000) / (3224 - 1000));
  return KZ.FREQS.map((f, i) => {
    if (KZ.isTerr(i)) return { att: +p.uhfAtt, tilt: 0, gain: +p.uhfGain, adj: +p.uhfAdj };
    return {
      att: +p.satAtt,
      tilt: lin(+p.satInTilt, 0, f),
      gain: lin(+p.satGainLow, +p.satGainHigh, f),
      adj: lin(+p.satAdjLow, +p.satAdjHigh, f),
    };
  });
};

const NEG = -Infinity;
const none = () => KZ.FREQS.map(() => NEG);
const nullNc = () => KZ.FREQS.map(() => null);

/* ---------- C/N 設定 (JEITA 3-8, 5) ----------
 * 熱雑音(75Ω, dBμV): 地デジ 2.3 / BS・110°CS(2K) 9.4 / 4K8K 10.1
 * 機器単体 C/N = 入力レベル − 熱雑音 − NF、総合は 1/CN の電力加算
 */
KZ.CN_DEFAULT = { sat4k: false, rx: true, rxNfTerr: 7, rxNfSat: 8, rxCableLen: 5, demux: '' };
KZ.DEMUX = { v: [1.5, 1.5, 2.0, 2.5, 3.0, 3.5, 3.5], src: '目安(710/3224MHzはJEITA)' };
KZ.cnConfig = function (model) {
  const c = Object.assign({}, KZ.CN_DEFAULT, model.cn || {});
  const nSat = c.sat4k ? 10.1 : 9.4;
  const cable = KZ.cablePerKm('5C').map((v) => r1((v * (+c.rxCableLen || 0)) / 1000));
  const demux = KZ.parseVec(c.demux) || KZ.DEMUX.v;
  return Object.assign(c, {
    noise: KZ.FREQS.map((_, i) => (KZ.isTerr(i) ? 2.3 : nSat)),
    rxNf: KZ.FREQS.map((_, i) => (KZ.isTerr(i) ? +c.rxNfTerr : +c.rxNfSat)),
    rxLoss: cable.map((x, i) => r1(x + demux[i])),
    req: KZ.FREQS.map((_, i) => (KZ.isTerr(i) ? 24 : c.sat4k ? 18 : 17)),
  });
};
const toNc = (cn) => Math.pow(10, -cn / 10);
const toCn = (nc) => (nc == null || nc <= 0 ? null : -10 * Math.log10(nc));
KZ.toCn = toCn;
KZ.psum = function (vecs) {
  if (vecs.length === 0) return none();
  if (vecs.length === 1) return vecs[0].slice();
  return KZ.FREQS.map((_, i) => {
    const s = vecs.reduce((a, v) => a + (v[i] === NEG ? 0 : Math.pow(10, v[i] / 10)), 0);
    return s === 0 ? NEG : 10 * Math.log10(s);
  });
};
const sub = (v, l) => v.map((x, i) => (x === NEG ? NEG : x - l[i]));

/* ---------- レベル計算 ----------
 * 返り値: { inLv[nodeId], out[nodeId][portId], term[nodeId](端子出力), order, warnings, edgeIn[edgeId] }
 */
KZ.compute = function (model) {
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const inEdges = new Map(), outEdges = new Map();
  model.nodes.forEach((n) => { inEdges.set(n.id, []); outEdges.set(n.id, []); });
  model.edges.forEach((e) => {
    if (!nodes.has(e.from.n) || !nodes.has(e.to.n)) return;
    outEdges.get(e.from.n).push(e);
    inEdges.get(e.to.n).push(e);
  });
  // トポロジカル順 (上→下, 左→右 を優先)
  const indeg = new Map(model.nodes.map((n) => [n.id, inEdges.get(n.id).length]));
  const cmp = (a, b) => (nodes.get(a).y - nodes.get(b).y) || (nodes.get(a).x - nodes.get(b).x);
  let ready = model.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort(cmp);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    outEdges.get(id).forEach((e) => {
      indeg.set(e.to.n, indeg.get(e.to.n) - 1);
      if (indeg.get(e.to.n) === 0) { ready.push(e.to.n); ready.sort(cmp); }
    });
  }
  const warnings = [];
  if (order.length < model.nodes.length) warnings.push({ level: 'err', msg: '配線がループしています(計算できない機器があります)' });

  const cfg = KZ.cnConfig(model);
  const out = {}, inLv = {}, term = {}, edgeIn = {}, bdet = {};
  const ncOut = {}, termNc = {}, unitCn = {};   // 雑音対搬送波比(真数)の伝搬
  // 周波数ごとに、最もレベルの高い入力の N/C を採用(混合は帯域が異なる信号の合成)
  const pickNc = (levels, ncs) => KZ.FREQS.map((_, i) => {
    let best = -1, bl = NEG;
    levels.forEach((v, k) => { if (v[i] > bl) { bl = v[i]; best = k; } });
    return best < 0 ? null : ncs[best][i];
  });
  for (const id of order) {
    const n = nodes.get(id), p = n.p;
    const ins = {}, insNc = {};
    inEdges.get(id).forEach((e) => {
      const src = out[e.from.n] && out[e.from.n][e.from.p];
      const v = src ? sub(src, KZ.edgeLoss(e)) : none();
      edgeIn[e.id] = v;
      (ins[e.to.p] = ins[e.to.p] || []).push(v);
      (insNc[e.to.p] = insNc[e.to.p] || []).push((ncOut[e.from.n] && ncOut[e.from.n][e.from.p]) || nullNc());
    });
    const allIn = KZ.psum(Object.values(ins).flat());
    let inNc = pickNc(Object.values(ins).flat(), Object.values(insNc).flat());
    inLv[id] = allIn;
    const o = {};
    switch (n.type) {
      case 'uhf_ant':
        o.out = KZ.FREQS.map((f, i) => {
          if (!KZ.isTerr(i)) return NEG;
          const He = 20 * Math.log10(300 / f / Math.PI);
          return r1(+p.E + (i === 0 ? +p.g470 : +p.g710) + r1(He) - 6);
        });
        inNc = KZ.FREQS.map((_, i) => (KZ.isTerr(i) ? toNc(+p.cn) : null));
        break;
      case 'bs_ant':
        o.out = KZ.FREQS.map((_, i) => (KZ.isTerr(i) ? NEG : +p.level));
        inNc = KZ.FREQS.map((_, i) => (KZ.isTerr(i) ? null : toNc(+p.cn)));
        break;
      case 'mixer':
        o.out = sub(allIn, KZ.lossVec(n));
        break;
      case 'booster': {
        const d = KZ.boosterDetail(p);
        bdet[id] = d;
        let inp = allIn;
        if (p.dualIn) { // UHF入力は地デジ帯のみ、BS入力は衛星帯のみ通す
          const u = KZ.psum(ins.inU || []), s = KZ.psum(ins.inS || []);
          inp = KZ.FREQS.map((_, i) => (KZ.isTerr(i) ? u[i] : s[i]));
          inLv[id] = inp;
          const nu = pickNc(ins.inU || [], insNc.inU || []), ns = pickNc(ins.inS || [], insNc.inS || []);
          inNc = KZ.FREQS.map((_, i) => (KZ.isTerr(i) ? nu[i] : ns[i]));
        }
        o.out = inp.map((x, i) => (x === NEG ? NEG : x - d[i].att - d[i].tilt + d[i].gain - d[i].adj));
        // ブースタ単体 C/N = 入力レベル − 熱雑音 − NF (JEITA 3-8)
        unitCn[id] = inp.map((x, i) => (x === NEG ? null : r1(x - cfg.noise[i] - (KZ.isTerr(i) ? +p.nfUhf : +p.nfSat))));
        inNc = inNc.map((x, i) => (unitCn[id][i] == null ? x : (x || 0) + toNc(unitCn[id][i])));
        const over = o.out.map((x, i) => x > (KZ.isTerr(i) ? +p.ratedUhf : +p.ratedSat));
        if (over.some(Boolean)) {
          const fs = KZ.FREQS.filter((_, i) => over[i]).join('/');
          warnings.push({ level: 'err', node: id, msg: `ブースタ出力が定格を超えています(${fs}MHz)` });
        }
        break;
      }
      case 'splitter': {
        const v = sub(allIn, KZ.lossVec(n));
        KZ.ports(n).filter((q) => q.kind === 'out').forEach((q) => { o[q.id] = v; });
        break;
      }
      case 'tap': {
        o.out = sub(allIn, KZ.lossVec(n));
        const b = sub(allIn, KZ.coupVec(n));
        KZ.ports(n).filter((q) => q.id[0] === 'b').forEach((q) => { o[q.id] = b; });
        break;
      }
      case 'outlet':
        term[id] = sub(allIn, KZ.lossVec(n));
        break;
      case 'series':
        if (p.end) term[id] = sub(allIn, KZ.lossVec(n));
        else { o.out = sub(allIn, KZ.lossVec(n)); term[id] = sub(allIn, KZ.coupVec(n)); }
        break;
    }
    out[id] = o;
    ncOut[id] = {};
    Object.keys(o).forEach((k) => { ncOut[id][k] = inNc; });  // 受動機器は C/N を変えない
    if (term[id]) termNc[id] = inNc;
    if (Object.keys(ins).some((k) => ins[k].length > 1) && n.type !== 'mixer') {
      warnings.push({ level: 'warn', node: id, msg: '1つの入力端子に複数のケーブルが接続されています' });
    }
  }

  // 接続チェック
  model.nodes.forEach((n) => {
    if (n.type === 'box' || n.type === 'text') return;
    KZ.ports(n).forEach((q) => {
      const conn = q.kind === 'in'
        ? inEdges.get(n.id).some((e) => e.to.p === q.id)
        : outEdges.get(n.id).some((e) => e.from.p === q.id);
      if (conn) return;
      if (q.kind === 'in') {
        if (n.type === 'mixer' || (n.type === 'booster' && n.p.dualIn)) return; // 片側未使用は許容
        warnings.push({ level: 'warn', node: n.id, msg: `${KZ.displayName(n)}: 入力が未接続です` });
      } else {
        warnings.push({ level: 'warn', node: n.id, msg: `${KZ.displayName(n)}: 出力端子(${q.id})が未接続です。終端抵抗器を接続してください` });
      }
    });
  });

  // 端子レベル判定
  Object.entries(term).forEach(([id, v]) => {
    const bad = [];
    let any = false;
    v.forEach((x, i) => {
      if (x === NEG) return;
      any = true;
      const [lo, hi] = KZ.rangeOf(i);
      if (x < lo) bad.push(`${KZ.FREQS[i]}MHz 不足(${x.toFixed(1)})`);
      else if (x > hi) bad.push(`${KZ.FREQS[i]}MHz 過大(${x.toFixed(1)})`);
    });
    const n = nodes.get(id);
    if (!any) warnings.push({ level: 'warn', node: id, msg: `${KZ.displayName(n)}: 信号が届いていません` });
    else if (bad.length) warnings.push({ level: 'err', node: id, msg: `${KZ.displayName(n)}: 端子レベル範囲外 ${bad.join(', ')}` });
  });

  // C/N: 端子(システム) と 受像機を含む総合
  const cn = {};
  Object.keys(term).forEach((id) => {
    const v = term[id], nc = termNc[id] || nullNc();
    const t = nc.map((x, i) => (v[i] === NEG ? null : toCn(x)));
    const rxLevel = v.map((x, i) => (x === NEG ? NEG : r1(x - cfg.rxLoss[i])));
    const rxUnit = rxLevel.map((x, i) => (x === NEG ? null : r1(x - cfg.noise[i] - cfg.rxNf[i])));
    const total = nc.map((x, i) => (rxUnit[i] == null || x == null ? null : toCn(x + toNc(rxUnit[i]))));
    const judged = cfg.rx ? total : t;
    const bad = [];
    judged.forEach((x, i) => { if (x != null && x < cfg.req[i]) bad.push(`${KZ.FREQS[i]}MHz ${x.toFixed(1)}dB`); });
    cn[id] = { term: t, rxLevel, rxUnit, total, judged, ng: bad.length > 0 };
    if (bad.length) {
      warnings.push({ level: 'err', node: id, msg: `${KZ.displayName(nodes.get(id))}: C/N不足(所要 地デジ24 / 衛星${cfg.req[6]}dB) ${bad.join(', ')}` });
    }
  });

  return { out, inLv, term, order, warnings, edgeIn, bdet, inEdges, outEdges, nodes, cn, cfg, unitCn };
};

/* レベルと C/N を合わせた判定 */
KZ.judgeAll = function (res, id) {
  const j = KZ.judge(res.term[id]);
  if (j !== 'ok') return j;
  return res.cn[id] && res.cn[id].ng ? 'ng' : 'ok';
};
KZ.minOf = function (v, terr) {
  const xs = v.filter((x, i) => KZ.isTerr(i) === terr && x != null && Number.isFinite(x));
  return xs.length ? Math.min(...xs) : null;
};

/* 端子判定 */
KZ.judge = function (v) {
  if (!v) return 'none';
  let any = false, bad = false;
  v.forEach((x, i) => {
    if (x === NEG) return;
    any = true;
    const [lo, hi] = KZ.rangeOf(i);
    if (x < lo || x > hi) bad = true;
  });
  return !any ? 'none' : bad ? 'ng' : 'ok';
};
KZ.minBand = function (v, terr) {
  const xs = v.filter((x, i) => KZ.isTerr(i) === terr && x !== NEG);
  return xs.length ? Math.min(...xs) : null;
};

/* ---------- 番号付け(①②…): 機器とケーブルを上流から順に ---------- */
KZ.circled = function (k) {
  if (k >= 1 && k <= 20) return String.fromCharCode(0x2460 + k - 1);
  if (k >= 21 && k <= 35) return String.fromCharCode(0x3251 + k - 21);
  if (k >= 36 && k <= 50) return String.fromCharCode(0x32b1 + k - 36);
  return `(${k})`;
};
// 入力ケーブルを接続元の位置(左→右)順に並べる
function sortIn(res, id) {
  return res.inEdges.get(id).slice().sort((a, b) => res.nodes.get(a.from.n).x - res.nodes.get(b.from.n).x);
}
KZ.numbering = function (model, res) {
  const num = { nodes: {}, edges: {} };
  let c = 1;
  res.order.forEach((id) => {
    const n = res.nodes.get(id);
    if (['uhf_ant', 'bs_ant', 'box', 'text', 'term'].includes(n.type)) return;
    const ins = sortIn(res, id);
    ins.forEach((e) => { if (!num.edges[e.id] && e.p.cable !== 'direct') num.edges[e.id] = c++; });
    num.nodes[id] = c++;
  });
  return num;
};

/* ---------- 経路(アンテナ→端子)の計算表行 ---------- */
KZ.pathRows = function (model, res, targetId, num) {
  const rows = [];
  const visit = (id, viaPort, seen) => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = res.nodes.get(id);
    const ins = sortIn(res, id);
    ins.forEach((e) => {
      visit(e.from.n, e.from.p, seen);
      if (e.p.cable !== 'direct') rows.push({ kind: 'cable', no: num.edges[e.id], name: 'ケーブル', spec: KZ.cableText(e),
        loss: KZ.edgeLoss(e), level: res.edgeIn[e.id] });
    });
    const no = num.nodes[id];
    const name = KZ.displayName(n);
    const spec = n.p.label || '';
    if (n.type === 'uhf_ant' || n.type === 'bs_ant') {
      const cnv = res.out[id].out.map((x) => (x === -Infinity ? null : +n.p.cn));
      rows.push({ kind: 'src', no: null, name, spec, level: res.out[id].out, cn: cnv });
    } else if (n.type === 'booster') {
      rows.push({ kind: 'booster', no, name, spec, input: res.inLv[id], detail: res.bdet[id], level: res.out[id].out, cn: res.unitCn[id] });
    } else if (viaPort === '__term') {
      const v = res.term[id];
      rows.push({ kind: 'dev', no, name, spec: spec || (n.type === 'series' && !n.p.end ? '端子結合損失' : ''),
        loss: res.inLv[id].map((x, i) => (x === -Infinity ? null : x - v[i])), level: v, final: true });
    } else {
      const v = res.out[id][viaPort];
      const portName = n.type === 'tap' ? (viaPort === 'out' ? '挿入損失' : '結合損失') : '';
      rows.push({ kind: 'dev', no, name, spec: [spec, portName].filter(Boolean).join(' / '),
        loss: res.inLv[id].map((x, i) => (x === -Infinity ? null : x - v[i])), level: v });
    }
  };
  visit(targetId, '__term', new Set());
  return rows;
};

/* ---------- 凡例データ ---------- */
KZ.LEGEND = [
  { type: 'uhf_ant', p: {}, name: 'テレビアンテナ(UHF)', note: '種類は傍記(素子数など)' },
  { type: 'bs_ant', p: {}, name: 'パラボラアンテナ', note: '種類は傍記(BS・110°CS 等)' },
  { type: 'mixer', p: {}, name: '混合(分波)器', note: '' },
  { type: 'booster', p: { dualIn: false }, name: '増幅器(ブースタ)', note: '種類は傍記' },
  { type: 'tap', p: { n: 1 }, name: '1分岐器', note: '縦線が貫通 = 幹線が通過' },
  { type: 'tap', p: { n: 2 }, name: '2分岐器', note: '' },
  { type: 'tap', p: { n: 4 }, name: '4分岐器', note: '' },
  { type: 'splitter', p: { n: 2 }, name: '2分配器', note: '貫通なし = 等分配' },
  { type: 'splitter', p: { n: 4 }, name: '4分配器', note: '' },
  { type: 'splitter', p: { n: 6 }, name: '6分配器', note: '' },
  { type: 'splitter', p: { n: 8 }, name: '8分配器', note: '' },
  { type: 'outlet', p: { terminals: 1 }, name: '1端子形テレビ端子', note: '傍記S: 上り信号カット' },
  { type: 'outlet', p: { terminals: 2 }, name: '2端子形テレビ端子', note: '傍記S: 上り信号カット' },
  { type: 'series', p: { end: false }, name: '直列ユニット', note: '傍記R: 終端抵抗器付き' },
  { type: 'term', p: {}, name: '終端抵抗器(75Ω)', note: '未使用の出力端子に接続' },
];

if (typeof window !== 'undefined') window.KZ = KZ;
if (typeof module !== 'undefined') module.exports = KZ;
