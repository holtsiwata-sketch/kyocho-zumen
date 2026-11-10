/* サンプル: JEITA 受信システム計算事例集 3-7「ビル共同受信システム5階新設計算例」を再現
 * 1F の 2端子形テレビ端子(JEITA ⑭)の期待値:
 *   69.5 / 68.8 / 66.5 / 68.7 / 65.9 / 63.3 / 59.8 dBμV
 */
'use strict';
(function (root) {
  const KZ = root.KZ || (typeof require !== 'undefined' ? require('./lib.js') : null);

  function sample() {
    let id = 0;
    const nodes = [], edges = [];
    const LH = 230;
    const Y = (fi, off) => fi * LH + off;
    const N = (type, x, y, p = {}) => {
      const n = { id: 'n' + ++id, type, x, y, p: Object.assign({}, KZ.TYPES[type].defaults, p) };
      nodes.push(n);
      return n;
    };
    const E = (a, ap, b, bp, cable, len = 0) => {
      edges.push({ id: 'e' + ++id, from: { n: a.id, p: ap }, to: { n: b.id, p: bp }, p: { cable, len } });
    };

    // RF
    const uhf = N('uhf_ant', 330, Y(0, 50), { label: '20素子UHFアンテナ', E: 60, g470: 8.0, g710: 13.4 });
    const bs = N('bs_ant', 470, Y(0, 50), { label: '75型BS・110°CS', level: 77.9 });
    const b1 = N('booster', 400, Y(0, 160), {
      label: 'ブースタ CS・BS・UHF型', dualIn: true,
      uhfAtt: 0, uhfGain: 40, uhfAdj: 0,
      satAtt: 9, satInTilt: 0, satGainLow: 35, satGainHigh: 45, satAdjLow: 3, satAdjHigh: 3,
    });
    E(uhf, 'out', b1, 'inU', '7C', 10);
    E(bs, 'out', b1, 'inS', '7C', 10);

    // 5F 4分岐器 → 5F / 4F 端子
    const tap = N('tap', 400, Y(1, 60), { n: 4, coupling: 20 });
    E(b1, 'out', tap, 'in', '7C', 0.5);
    const o5r = N('outlet', 560, Y(1, 130), { terminals: 1 });
    const o5l = N('outlet', 240, Y(1, 130), { terminals: 1 });
    const o4r = N('outlet', 620, Y(2, 90), { terminals: 1 });
    const o4l = N('outlet', 180, Y(2, 90), { terminals: 1 });
    E(tap, 'b1', o4r, 'in', '5C', 20);
    E(tap, 'b2', o5r, 'in', '5C', 15);
    E(tap, 'b3', o4l, 'in', '5C', 20);
    E(tap, 'b4', o5l, 'in', '5C', 15);

    // 3F 6分配器
    const sp6 = N('splitter', 400, Y(3, 50), { n: 6 });
    E(tap, 'out', sp6, 'in', '7C', 14);
    const o2r = N('outlet', 660, Y(4, 90), { terminals: 1 });
    const o3r = N('outlet', 580, Y(3, 120), { terminals: 1 });
    const o2l = N('outlet', 160, Y(4, 90), { terminals: 1 });
    const o3l = N('outlet', 220, Y(3, 120), { terminals: 1 });
    const t6 = N('term', 300, Y(3, 100));
    E(sp6, 'o1', o2r, 'in', '5C', 20);
    E(sp6, 'o2', o3r, 'in', '5C', 10);
    E(sp6, 'o4', o2l, 'in', '5C', 20);
    E(sp6, 'o5', o3l, 'in', '5C', 10);
    E(sp6, 'o6', t6, 'in', 'direct');

    // 1F ブースタ(2段目) → 4分配器 → 4分配器 → 2端子形テレビ端子
    const b2 = N('booster', 520, Y(5, 45), {
      label: 'ブースタ(2段目)',
      uhfAtt: 3, uhfGain: 40, uhfAdj: 10,
      satAtt: 5, satInTilt: 5, satGainLow: 35, satGainHigh: 45, satAdjLow: 3.9, satAdjHigh: 0,
    });
    E(sp6, 'o3', b2, 'in', '7C', 25);
    const spA = N('splitter', 520, Y(5, 110), { n: 4 });
    E(b2, 'out', spA, 'in', '7C', 0.5);
    const spB = N('splitter', 720, Y(5, 150), { n: 4 });
    E(spA, 'o1', spB, 'in', '7C', 25);
    const oT = N('outlet', 860, Y(5, 190), { terminals: 2, label: 'JEITA計算例の端子' });
    E(spB, 'o1', oT, 'in', '5C', 12);
    E(spA, 'o2', N('term', 640, Y(5, 170)), 'in', 'direct');
    E(spA, 'o3', N('term', 430, Y(5, 165)), 'in', 'direct');
    E(spA, 'o4', N('term', 465, Y(5, 165)), 'in', 'direct');
    E(spB, 'o2', N('term', 800, Y(5, 200)), 'in', 'direct');
    E(spB, 'o3', N('term', 660, Y(5, 205)), 'in', 'direct');
    E(spB, 'o4', N('term', 690, Y(5, 205)), 'in', 'direct');
    N('box', 400, Y(5, 10), { label: 'TV-2 機器収容箱', w: 560, h: 215 });

    return {
      version: 1,
      title: 'ビル共同受信システム 5階新設(JEITA計算例)',
      author: '',
      date: new Date().toISOString().slice(0, 10),
      floors: ['RF', '5F', '4F', '3F', '2F', '1F'],
      laneH: LH,
      nodes, edges,
      seq: id + 1,
      checkNode: oT.id,
    };
  }

  /* JEITA 3-8「システムのCN比計算」ホーム共同受信(5分配)の再現 (C/N 検証用)
   * 期待値 710MHz: 端子 53.3 dBμV / 総合C/N 31.1 dB, 3224MHz: 端子 56.0 dBμV / 総合C/N 18.8 dB
   * JEITA は 5C ケーブルを 1.8dB/10m(710MHz)・4.6dB/10m(3224MHz) として計算しているため 30m 区間は値を指定
   */
  function homeSample() {
    let id = 0;
    const nodes = [], edges = [];
    const N = (type, x, y, p = {}) => {
      const n = { id: 'n' + ++id, type, x, y, p: Object.assign({}, KZ.TYPES[type].defaults, p) };
      nodes.push(n);
      return n;
    };
    const E = (a, ap, b, bp, p) => edges.push({ id: 'e' + ++id, from: { n: a.id, p: ap }, to: { n: b.id, p: bp }, p });
    const uhf = N('uhf_ant', 300, 50, { label: '14素子UHFアンテナ', E: 60, g470: 6.8, g710: 10.5, cn: 32.2 });
    const bs = N('bs_ant', 440, 50, { label: '45型BS・110°CS', level: 74.5, cn: 19.0 });
    const b = N('booster', 370, 160, { label: 'ブースタ', dualIn: true, uhfGain: 30, satGainLow: 31, satGainHigh: 31, nfUhf: 3, nfSat: 10 });
    E(uhf, 'out', b, 'inU', { cable: '5C', len: 10 });
    E(bs, 'out', b, 'inS', { cable: '5C', len: 10 });
    const sp = N('splitter', 370, 260, { n: 4, label: '5分配器(損失指定)', lossOverride: '10.5,10.5,11.5,11.5,14,15.5,17.5' });
    E(b, 'out', sp, 'in', { cable: '5C', len: 10 });
    const o = N('outlet', 500, 380, { terminals: 2, lossOverride: '4.3,4.3,5,5,6,7,9.0' });
    E(sp, 'o1', o, 'in', { cable: 'custom', name: 'S-5C-FB', len: 30, lossOverride: '4.4,5.4,6.7,8.5,10.7,12.2,13.8' });
    ['o2', 'o3', 'o4'].forEach((pt, k) => E(sp, pt, N('term', 280 + k * 30, 330), 'in', { cable: 'direct', len: 0 }));
    return {
      version: 1, title: 'ホーム共同受信(JEITA C/N計算例)', author: '', date: new Date().toISOString().slice(0, 10),
      floors: ['屋根', '2F', '1F'], laneH: 150, nodes, edges, seq: id + 1, checkNode: o.id,
      cn: { sat4k: false, rx: true, rxNfTerr: 7, rxNfSat: 8, rxCableLen: 5, demux: '' },
    };
  }

  KZ.sample = sample;
  KZ.homeSample = homeSample;
  if (typeof module !== 'undefined') module.exports = sample;
})(typeof window !== 'undefined' ? window : globalThis);
