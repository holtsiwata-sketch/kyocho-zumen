// JEITA 計算事例集 3-7 との照合テスト:  node test/verify.js
const KZ = require('../js/lib.js');
const sample = require('../js/sample.js');

const m = sample();
const res = KZ.compute(m);
const expected = [69.5, 68.8, 66.5, 68.7, 65.9, 63.3, 59.8];
const got = res.term[m.checkNode].map((x) => Math.round(x * 10) / 10);

// 中間値: ブースタ(2段目)到達レベル (JEITA 3-7①)
const b2 = m.nodes.find((n) => n.p.label === 'ブースタ(2段目)');
const reach = res.inLv[b2.id];
const reachRaw = res.edgeIn[m.edges.find((e) => e.to.n === b2.id).id].map((x) => Math.round(x * 10) / 10);
const expReach = [67.4, 67.9, 75.3, 75.2, 73.0, 70.7, 68.2];

let ok = true;
const cmp = (label, a, b) => {
  const bad = a.some((x, i) => Math.abs(x - b[i]) > 0.15);
  if (bad) ok = false;
  console.log(`${bad ? 'NG' : 'OK'}  ${label}\n    計算: ${a.join(' / ')}\n    JEITA: ${b.join(' / ')}`);
};
cmp('ブースタ(2段目)到達レベル', reachRaw, expReach);
cmp('テレビ端子出力 (JEITA ⑭)', got, expected);
console.log('\n警告:', res.warnings.length ? res.warnings.map((w) => w.msg) : 'なし');
void reach;
process.exit(ok ? 0 : 1);
