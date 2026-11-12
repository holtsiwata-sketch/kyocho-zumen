/* 共聴系統図エディタ: UI */
(() => {
  'use strict';
  const KZ = window.KZ;
  const $ = (s) => document.querySelector(s);
  const svg = $('#canvas'), viewport = $('#viewport'), world = $('#world'), overlay = $('#overlay');
  const STORE = 'kyocho_zumen_v1';
  const GRID = 5;
  const NEG = -Infinity;

  const today = () => new Date().toISOString().slice(0, 10);
  const blank = () => ({
    version: 1, title: '新規 共聴系統図', author: '', date: today(),
    floors: ['RF', '3F', '2F', '1F'], laneH: 180, nodes: [], edges: [], seq: 1,
    cn: Object.assign({}, KZ.CN_DEFAULT),
  });

  let model = loadLocal() || normalize(KZ.sample());
  let res = null, num = { nodes: {}, edges: {} };
  let sel = null;                 // {k:'n'|'e', id}
  let view = { x: 0, y: 0, k: 1 };
  let tool = null;                // パレットで選択中 {type, p}
  let drag = null;
  let lastCable = { cable: '5C', len: 10 };
  const undoStack = [], redoStack = [];
  const show = { num: true, cable: true, lvl: true, cn: false };
  let activeTab = 'calc';

  // スマホ・タッチ対応
  const mq = window.matchMedia('(max-width: 760px), (max-height: 520px)');
  const isMobile = () => mq.matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (coarse) document.body.classList.add('coarse');
  const pointers = new Map();   // 押されている指 (ピンチ判定)
  let pinch = null;
  let pendingWire = null;        // タップ配線: 出力端子を選んだ状態
  let sheetKey = null;           // 開いている下部シート
  // タッチでは端子を画面上で約12pxの大きさに保つ(ズームに追従して描き直す)
  // (極端に縮小したときに記号を覆い隠さないよう上限あり)
  const portR = () => (coarse ? Math.max(4, Math.min(12 / view.k, 14)) : 4);
  let portTimer = null;
  const refreshPorts = () => {
    if (!coarse) return;
    clearTimeout(portTimer);
    portTimer = setTimeout(() => { if (!drag && !pinch) renderCanvasOnly(); }, 150);
  };

  /* ---------- 永続化 ---------- */
  function loadLocal() {
    try { const s = localStorage.getItem(STORE); return s ? normalize(JSON.parse(s)) : null; } catch (e) { return null; }
  }
  function saveLocal() {
    try { localStorage.setItem(STORE, JSON.stringify(model)); } catch (e) { /* 保存不可でも動作継続 */ }
  }
  function normalize(m) {
    const b = blank();
    m = Object.assign(b, m);
    m.cn = Object.assign({}, KZ.CN_DEFAULT, m.cn);
    m.nodes.forEach((n) => { n.p = Object.assign({}, KZ.TYPES[n.type].defaults, n.p); });
    m.edges.forEach((e) => { e.p = Object.assign({ cable: '5C', len: 10 }, e.p); });
    if (!m.seq) m.seq = m.nodes.length + m.edges.length + 1;
    return m;
  }
  const newId = (pfx) => pfx + model.seq++;

  function snapshot() {
    undoStack.push(JSON.stringify(model));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(model));
    model = JSON.parse(undoStack.pop());
    validateSel(); render();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(model));
    model = JSON.parse(redoStack.pop());
    validateSel(); render();
  }
  function validateSel() {
    if (!sel) return;
    const ok = sel.k === 'n' ? model.nodes.some((n) => n.id === sel.id) : model.edges.some((e) => e.id === sel.id);
    if (!ok) sel = null;
  }

  const nodeById = (id) => model.nodes.find((n) => n.id === id);
  const edgeById = (id) => model.edges.find((e) => e.id === id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1 = (x) => (x == null || x === NEG || !Number.isFinite(x) ? '—' : x.toFixed(1));
  const snap = (v) => Math.round(v / GRID) * GRID;
  const floorOf = (y) => model.floors[Math.floor(y / model.laneH)] || '-';

  /* ---------- 配線ルート ---------- */
  function portAbs(n, pid) {
    const q = KZ.port(n, pid);
    return q ? { x: n.x + q.x, y: n.y + q.y, dir: q.dir, kind: q.kind } : null;
  }
  function route(a, b) {
    const [dx, dy] = KZ.DIRV[a.dir];
    const P = [[a.x, a.y]];
    if (dy !== 0) {
      if (b.y - 8 >= a.y + 6) {
        if (Math.abs(a.x - b.x) > 0.5) { const my = snap((a.y + b.y) / 2); P.push([a.x, my], [b.x, my]); }
      } else {
        const mx = Math.max(a.x, b.x) + 40;
        P.push([a.x, a.y + 10], [mx, a.y + 10], [mx, b.y - 10], [b.x, b.y - 10]);
      }
    } else if ((b.x - a.x) * dx >= 6 && b.y - 8 >= a.y - 0.5) {
      P.push([b.x, a.y]);
    } else {
      const sx = a.x + dx * 12;
      P.push([sx, a.y], [sx, b.y - 10], [b.x, b.y - 10]);
    }
    P.push([b.x, b.y]);
    return P.filter((p, i) => i === 0 || p[0] !== P[i - 1][0] || p[1] !== P[i - 1][1]);
  }

  /* ---------- 図面描画 (live=true で編集用要素を含む) ---------- */
  function bounds() {
    let minX = 0, maxX = 1000;
    model.nodes.forEach((n) => {
      const w = n.type === 'box' ? +n.p.w : 0;
      minX = Math.min(minX, n.x - 160);
      maxX = Math.max(maxX, n.x + w + 260);
    });
    return { x: minX, y: 0, w: maxX - minX, h: model.floors.length * model.laneH };
  }

  const LABEL_POS = {
    uhf_ant: [0, -26, 'middle'], bs_ant: [0, -26, 'middle'], mixer: [18, -14, 'start'], booster: [18, -2, 'start'],
    tap: [20, -20, 'start'], splitter: [20, -20, 'start'], outlet: [15, -4, 'start'], series: [15, -4, 'start'], term: [10, 4, 'start'],
  };

  function drawing(live) {
    const b = bounds();
    const out = [];
    // 階レーン
    model.floors.forEach((f, i) => {
      const y = i * model.laneH;
      out.push(`<rect x="${b.x}" y="${y}" width="${b.w}" height="${model.laneH}" fill="${i % 2 ? '#ffffff' : '#fafbfc'}" stroke="#c9ced6" stroke-width="0.8" stroke-dasharray="6 4"/>`);
      out.push(`<text x="${b.x + 12}" y="${y + 24}" font-size="16" font-weight="700" fill="#4b5563">${esc(f)}</text>`);
    });
    // 機器収容箱
    model.nodes.filter((n) => n.type === 'box').forEach((n) => {
      const cls = ['node', 'box', sel && sel.k === 'n' && sel.id === n.id ? 'sel' : ''].join(' ');
      out.push(`<g class="${cls}" data-node="${n.id}" transform="translate(${n.x},${n.y})">` +
        `<rect class="boxrect" width="${n.p.w}" height="${n.p.h}" fill="none" stroke="#374151" stroke-width="1.2"/>` +
        (live ? `<rect class="boxhit" width="${n.p.w}" height="${n.p.h}"/>` : '') +
        `<text x="6" y="16" font-size="12" fill="#374151">${esc(n.p.label)}</text>` +
        (live && sel && sel.id === n.id ? `<rect class="handle" data-handle="${n.id}" x="${n.p.w - 6}" y="${n.p.h - 6}" width="12" height="12"/>` : '') +
        `</g>`);
    });
    // ケーブル
    model.edges.forEach((e) => {
      const a = nodeById(e.from.n), c = nodeById(e.to.n);
      if (!a || !c) return;
      const pa = portAbs(a, e.from.p), pc = portAbs(c, e.to.p);
      if (!pa || !pc) return;
      const pts = route(pa, pc);
      const ps = pts.map((p) => p.join(',')).join(' ');
      const isSel = sel && sel.k === 'e' && sel.id === e.id;
      let label = '';
      if (e.p.cable !== 'direct' && (show.cable || show.num)) {
        // 縦の区間(30px以上)の右側を優先し、なければ最長の横区間の上に置く
        let best = 0, seg = null;
        for (let i = 1; i < pts.length; i++) {
          const vert = pts[i][0] === pts[i - 1][0];
          const L = Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
          const score = vert && L >= 30 ? L + 10000 : L;
          if (score > best) { best = score; seg = [pts[i - 1], pts[i]]; }
        }
        const txt = [show.num && num.edges[e.id] ? KZ.circled(num.edges[e.id]) : '', show.cable ? KZ.cableText(e) : ''].filter(Boolean).join(' ');
        if (seg && txt) {
          const vert = seg[0][0] === seg[1][0];
          const mx = (seg[0][0] + seg[1][0]) / 2, my = (seg[0][1] + seg[1][1]) / 2;
          const shortV = vert && Math.abs(seg[1][1] - seg[0][1]) < 30; // 機器の傍記(右側)と重ならないよう左へ
          label = shortV
            ? `<text x="${mx - 5}" y="${my + 4}" font-size="10.5" fill="#1f2937" text-anchor="end">${esc(txt)}</text>`
            : vert
            ? `<text x="${mx + 4}" y="${my + 4}" font-size="10.5" fill="#1f2937">${esc(txt)}</text>`
            : `<text x="${mx}" y="${my - 4}" font-size="10.5" fill="#1f2937" text-anchor="middle">${esc(txt)}</text>`;
        }
      }
      out.push(`<g class="edge${isSel ? ' sel' : ''}" data-edge="${e.id}">` +
        `<polyline class="wire" points="${ps}" fill="none" stroke="#111827" stroke-width="1.3"/>` +
        (live ? `<polyline class="hit" points="${ps}"/>` : '') + label + `</g>`);
    });
    // 警告ノード
    const bad = new Map();
    (res ? res.warnings : []).forEach((w) => { if (w.node) bad.set(w.node, w.level === 'err' || bad.get(w.node) === 'err' ? 'err' : 'warn'); });
    // 機器
    model.nodes.filter((n) => n.type !== 'box').forEach((n) => {
      const isSel = sel && sel.k === 'n' && sel.id === n.id;
      const cls = ['node', 't-' + n.type, isSel ? 'sel' : '', live && bad.get(n.id) === 'err' ? 'bad' : live && bad.get(n.id) ? 'warn' : ''].join(' ');
      let g = `<g class="${cls}" data-node="${n.id}" transform="translate(${n.x},${n.y})">`;
      if (n.type === 'text') {
        const lines = String(n.p.text).split('\n');
        const fs = +n.p.size || 13;
        if (live) g += `<rect class="hit" x="-4" y="${-fs}" width="${Math.max(40, Math.max(...lines.map((l) => l.length)) * fs + 8)}" height="${lines.length * fs * 1.35 + 6}"/>`;
        g += `<text font-size="${fs}" fill="#111827">${lines.map((l, i) => `<tspan x="0" dy="${i ? fs * 1.35 : 0}">${esc(l)}</tspan>`).join('')}</text>`;
        out.push(g + '</g>');
        return;
      }
      if (live) g += `<rect class="hit" x="-24" y="-26" width="48" height="52" rx="6"/>`;
      g += `<g class="sym" fill="none" stroke="#111827" stroke-width="1.4">${KZ.symbol(n)}</g>`;
      // 傍記・番号
      const [lx, ly, anchor] = LABEL_POS[n.type] || [18, -10, 'start'];
      const no = show.num && num.nodes[n.id] ? KZ.circled(num.nodes[n.id]) + ' ' : '';
      const ann = KZ.annotation(n);
      if (n.type === 'uhf_ant') {
        g += `<text x="${lx}" y="${ly - 12}" font-size="11.5" text-anchor="${anchor}" fill="#111827">${esc(ann)}</text>`;
        g += `<text x="${lx}" y="${ly}" font-size="10.5" text-anchor="${anchor}" fill="#4b5563">${esc(`E=${n.p.E}dBμV/m`)}</text>`;
      } else if (no || ann) {
        g += `<text x="${lx}" y="${ly}" font-size="11.5" text-anchor="${anchor}" fill="#111827">${esc(no + ann)}</text>`;
      }
      // 端子レベル
      if (show.lvl && res && res.term[n.id]) {
        const v = res.term[n.id];
        const t = KZ.minBand(v, true), s = KZ.minBand(v, false);
        const j = KZ.judge(v);
        const col = j === 'ok' ? '#15803d' : j === 'ng' ? '#dc2626' : '#9ca3af';
        const txt = [t != null ? `地${t.toFixed(1)}` : '', s != null ? `衛${s.toFixed(1)}` : ''].filter(Boolean).join(' ') || '信号なし';
        g += `<text x="${lx}" y="${ly + 13}" font-size="10.5" fill="${col}" font-weight="600">${esc(txt)}</text>`;
      }
      // C/N(判定に使う値: 受像機を含む総合 or 端子)
      if (show.cn && res && res.cn[n.id]) {
        const c = res.cn[n.id];
        const t = KZ.minOf(c.judged, true), s = KZ.minOf(c.judged, false);
        const txt = [t != null ? `地${t.toFixed(1)}` : '', s != null ? `衛${s.toFixed(1)}` : ''].filter(Boolean).join(' ');
        if (txt) {
          const dy = show.lvl ? 25 : 13;
          g += `<text x="${lx}" y="${ly + dy}" font-size="10" fill="${c.ng ? '#dc2626' : '#2563eb'}" font-weight="600">C/N ${esc(txt)}</text>`;
        }
      }
      // ポート
      if (live) {
        KZ.ports(n).forEach((q) => {
          g += `<circle class="port ${q.kind}" data-port="${n.id}:${q.id}" cx="${q.x}" cy="${q.y}" r="${portR().toFixed(1)}"/>`;
        });
      }
      out.push(g + '</g>');
    });
    return out.join('');
  }

  /* ---------- 全体描画 ---------- */
  function render() {
    res = KZ.compute(model);
    num = KZ.numbering(model, res);
    world.innerHTML = drawing(true);
    applyView();
    renderProps();
    renderWarnings();
    renderBottom();
    $('#docTitle').value = model.title || '';
    updateMobileState();
    saveLocal();
  }
  function renderCanvasOnly() {
    res = KZ.compute(model);
    num = KZ.numbering(model, res);
    world.innerHTML = drawing(true);
  }
  function applyView() {
    viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    refreshPorts();
  }

  /* ---------- スマホ: 下部シート・メニュー ---------- */
  const SHEETS = { palette: 'palette', props: 'side', calc: 'bottom', check: 'side' };
  function openSheet(key) {
    sheetKey = key && key !== sheetKey ? key : null;
    document.body.classList.remove('sheet-palette', 'sheet-side', 'sheet-bottom');
    if (sheetKey) document.body.classList.add('sheet-' + SHEETS[sheetKey]);
    if (sheetKey === 'props') $('#side').scrollTop = 0;
    if (sheetKey === 'check') $('#side').scrollTop = $('#warnings').offsetTop - 8;
    if (sheetKey === 'calc') renderBottom();
    updateMobileState();
  }
  function updateMobileState() {
    document.querySelectorAll('#mnav [data-sheet]').forEach((b) => {
      b.classList.toggle('on', b.dataset.sheet === sheetKey);
      if (b.dataset.sheet === 'props') b.classList.toggle('has-sel', !!sel);
    });
    if (res) $('#mBadge').textContent = res.warnings.length ? String(res.warnings.length) : '';
    // 選択中の操作バー(スマホ): 削除・複製・詳細・選択解除
    const bar = $('#selbar');
    const item = sel && (sel.k === 'n' ? nodeById(sel.id) : edgeById(sel.id));
    bar.hidden = !item;
    if (item) {
      const no = sel.k === 'n' ? num.nodes[sel.id] : num.edges[sel.id];
      const name = sel.k === 'n' ? (item.type === 'text' ? `テキスト「${item.p.text}」` : KZ.displayName(item)) : `ケーブル ${KZ.cableText(item)}`;
      $('#selName').textContent = (no ? KZ.circled(no) + ' ' : '') + name;
      bar.querySelector('[data-sel=dup]').hidden = sel.k !== 'n';
    }
    if (isMobile()) setHint();
  }
  $('#selbar').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sel]');
    if (!b || !sel) return;
    const a = b.dataset.sel;
    if (a === 'del') removeSel();
    else if (a === 'dup') duplicate();
    else if (a === 'props') { if (sheetKey !== 'props') openSheet('props'); }
    else if (a === 'clear') { sel = null; render(); }
  });
  $('#selbar').addEventListener('pointerdown', (ev) => ev.stopPropagation());
  document.querySelectorAll('#mnav [data-sheet]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.sheet)));
  $('#menuBtn').addEventListener('click', () => {
    const open = $('#toolbar').classList.toggle('menu-open');
    $('#menuBtn').setAttribute('aria-expanded', String(open));
    if (open) openSheet(null);
  });
  const closeMenu = () => { $('#toolbar').classList.remove('menu-open'); $('#menuBtn').setAttribute('aria-expanded', 'false'); };
  mq.addEventListener('change', () => { openSheet(null); closeMenu(); setHint(); requestAnimationFrame(fit); });
  function fit() {
    const b = bounds();
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const k = Math.min((r.width - 40) / b.w, (r.height - 40) / b.h, 1.6);
    view.k = Math.max(0.2, k);
    view.x = (r.width - b.w * view.k) / 2 - b.x * view.k;
    view.y = (r.height - b.h * view.k) / 2 - b.y * view.k;
    applyView();
  }
  function toWorld(ev) {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
  }
  function zoomAt(cx, cy, factor) {
    const k = Math.min(4, Math.max(0.15, view.k * factor));
    view.x = cx - (cx - view.x) * (k / view.k);
    view.y = cy - (cy - view.y) * (k / view.k);
    view.k = k;
    applyView();
  }

  /* ---------- パレット ---------- */
  const PALETTE = [
    ['アンテナ', [['uhf_ant', {}, 'UHFアンテナ'], ['bs_ant', {}, 'BS・CSアンテナ']]],
    ['増幅・混合', [['booster', {}, 'ブースタ'], ['booster', { dualIn: true }, 'ブースタ(UHF/BS別入力)'], ['mixer', {}, '混合(分波)器']]],
    ['分岐器', [['tap', { n: 1 }, '1分岐器'], ['tap', { n: 2 }, '2分岐器'], ['tap', { n: 4 }, '4分岐器']]],
    ['分配器', [['splitter', { n: 2 }, '2分配器'], ['splitter', { n: 4 }, '4分配器'], ['splitter', { n: 6 }, '6分配器'], ['splitter', { n: 8 }, '8分配器']]],
    ['端子', [['outlet', { terminals: 1 }, '1端子形テレビ端子'], ['outlet', { terminals: 2 }, '2端子形テレビ端子'], ['series', { end: false }, '直列ユニット'], ['series', { end: true }, '直列ユニット(終端R)']]],
    ['その他', [['term', {}, '終端抵抗器'], ['box', {}, '機器収容箱'], ['text', {}, 'テキスト']]],
  ];
  function iconSvg(type, p, size = 34) {
    const n = { type, p: Object.assign({}, KZ.TYPES[type].defaults, p) };
    let inner;
    if (type === 'box') inner = `<rect x="-14" y="-9" width="28" height="18" fill="none" stroke="#111827" stroke-width="1.4"/>`;
    else if (type === 'text') inner = `<text x="0" y="6" font-size="17" text-anchor="middle" fill="#111827">A</text>`;
    else inner = `<g fill="none" stroke="#111827" stroke-width="1.4">${KZ.symbol(n)}</g>`;
    return `<svg width="${size}" height="${size}" viewBox="-28 -28 56 56">${inner}</svg>`;
  }
  function buildPalette() {
    const el = $('#palette');
    el.innerHTML = PALETTE.map(([g, items], gi) => `<div class="pal-group"><h4>${g}</h4>` +
      items.map(([t, p, name], ii) => `<button class="pal-item" draggable="true" data-pal="${gi}:${ii}" title="クリックして図面上をクリック、またはドラッグで配置">${iconSvg(t, p)}<span>${name}</span></button>`).join('') +
      `</div>`).join('');
    el.querySelectorAll('.pal-item').forEach((b) => {
      const [gi, ii] = b.dataset.pal.split(':').map(Number);
      const [t, p] = PALETTE[gi][1][ii];
      b.addEventListener('click', () => {
        tool = tool && tool.key === b.dataset.pal ? null : { type: t, p, key: b.dataset.pal };
        updateArmed();
        if (tool && isMobile()) openSheet(null);   // 図面を見せて配置位置をタップしてもらう
      });
      b.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', b.dataset.pal); });
    });
  }
  function updateArmed() {
    document.querySelectorAll('.pal-item').forEach((b) => b.classList.toggle('armed', !!tool && tool.key === b.dataset.pal));
    svg.classList.toggle('armed', !!tool);
    setHint();
  }
  function setHint(msg) {
    if (!msg && isMobile()) {
      const n = sel && sel.k === 'n' ? nodeById(sel.id) : null;
      msg = tool ? '置きたい場所をタップ(もう一度部品を選ぶと取消)'
        : pendingWire ? '接続先の緑の端子(または部品)をタップ。背景タップで取消'
        : n && !['box', 'text'].includes(n.type) ? '橙の端子をタップ→接続先をタップで配線 / 削除・設定は上のバーから'
        : 'タップで選択・ドラッグで移動 / 2本指で拡大縮小・移動';
    }
    $('#hint').textContent = msg || (tool
      ? '図面をクリックして配置(Shift+クリックで連続配置、Escで解除)'
      : 'ドラッグ: 移動 / 出力端子(橙)から入力端子(緑)へドラッグ、または端子をクリック→接続先をクリック: 配線 / 背景ドラッグ: スクロール / ホイール: 拡大縮小');
  }
  function addNode(type, p, x, y) {
    snapshot();
    const n = { id: newId('n'), type, x: snap(x), y: snap(y), p: Object.assign({}, KZ.TYPES[type].defaults, p) };
    if (type === 'box') { n.x = snap(x - 40); n.y = snap(y - 20); }
    model.nodes.push(n);
    sel = { k: 'n', id: n.id };
    render();
    return n;
  }

  /* ---------- ポインタ操作 ---------- */
  // 2本指ピンチ: 指の中点の下にある図面位置を固定したまま拡大縮小・移動
  function startPinch() {
    if (drag && drag.moved) render();
    drag = null;
    overlay.innerHTML = '';
    svg.classList.remove('panning');
    const [a, b] = [...pointers.values()];
    const r = svg.getBoundingClientRect();
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, k0: view.k, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, vx: view.x, vy: view.y };
  }
  function endPointer(ev) {
    pointers.delete(ev.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return true;
    }
    return false;
  }
  svg.addEventListener('pointercancel', (ev) => {
    endPointer(ev);
    if (drag && drag.moved) render();
    drag = null;
    overlay.innerHTML = '';
    svg.classList.remove('panning');
    if (!pendingWire) svg.classList.remove('wiring');
  });

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'touch') {           // ピンチ判定はタッチのみ(マウスは対象外)
      if (ev.isPrimary) { pointers.clear(); pinch = null; }
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) { startPinch(); return; }
      if (pointers.size > 2) return;
    }
    if (pendingWire && ev.button === 0) {      // タップ配線の2回目: 接続先
      const d = pendingWire;
      pendingWire = null;
      svg.classList.remove('wiring');
      finishWire(d, ev.clientX, ev.clientY);
      setHint();
      return;
    }
    if (ev.button === 1 || (ev.button === 0 && ev.altKey)) { startPan(ev); return; }
    if (ev.button !== 0) return;
    const t = ev.target;
    const w = toWorld(ev);
    const portEl = t.closest('[data-port]');
    const handleEl = t.closest('[data-handle]');
    const nodeEl = t.closest('[data-node]');
    const edgeEl = t.closest('[data-edge]');
    if (tool && !portEl && !handleEl) {
      addNode(tool.type, tool.p, w.x, w.y);
      if (!ev.shiftKey) { tool = null; updateArmed(); }
      return;
    }
    if (portEl) {
      const [nid, pid] = portEl.dataset.port.split(':');
      const pa = portAbs(nodeById(nid), pid);
      drag = { mode: 'wire', nid, pid, kind: pa.kind, start: pa, sx: ev.clientX, sy: ev.clientY };
      svg.classList.add('wiring');
      svg.setPointerCapture(ev.pointerId);
      return;
    }
    if (handleEl) {
      const n = nodeById(handleEl.dataset.handle);
      drag = { mode: 'resize', n, w0: +n.p.w, h0: +n.p.h, s: w, snap: false };
      svg.setPointerCapture(ev.pointerId);
      return;
    }
    if (nodeEl) {
      const n = nodeById(nodeEl.dataset.node);
      sel = { k: 'n', id: n.id };
      drag = { mode: 'move', n, ox: w.x - n.x, oy: w.y - n.y, moved: false };
      svg.setPointerCapture(ev.pointerId);
      renderCanvasOnly(); renderProps(); renderBottom(); updateMobileState();
      return;
    }
    if (edgeEl) {
      sel = { k: 'e', id: edgeEl.dataset.edge };
      renderCanvasOnly(); renderProps(); renderBottom(); updateMobileState();
      return;
    }
    sel = null;
    renderCanvasOnly(); renderProps(); renderBottom(); updateMobileState();
    startPan(ev);
  });
  function startPan(ev) {
    drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
    svg.classList.add('panning');
    svg.setPointerCapture(ev.pointerId);
  }
  svg.addEventListener('pointermove', (ev) => {
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const r = svg.getBoundingClientRect();
      const k = Math.min(4, Math.max(0.15, pinch.k0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const wx = (pinch.mx - pinch.vx) / pinch.k0, wy = (pinch.my - pinch.vy) / pinch.k0;
      view = { k, x: mx - wx * k, y: my - wy * k };
      applyView();
      return;
    }
    if (!drag) return;
    const w = toWorld(ev);
    if (drag.mode === 'pan') {
      view.x = drag.vx + ev.clientX - drag.sx;
      view.y = drag.vy + ev.clientY - drag.sy;
      applyView();
    } else if (drag.mode === 'move') {
      const nx = snap(w.x - drag.ox), ny = snap(w.y - drag.oy);
      if (nx !== drag.n.x || ny !== drag.n.y) {
        if (!drag.moved) { snapshot(); drag.moved = true; }
        drag.n.x = nx; drag.n.y = ny;
        renderCanvasOnly();
      }
    } else if (drag.mode === 'resize') {
      if (!drag.snap) { snapshot(); drag.snap = true; }
      drag.n.p.w = Math.max(40, snap(drag.w0 + w.x - drag.s.x));
      drag.n.p.h = Math.max(30, snap(drag.h0 + w.y - drag.s.y));
      renderCanvasOnly();
    } else if (drag.mode === 'wire') {
      overlay.innerHTML = `<line x1="${drag.start.x}" y1="${drag.start.y}" x2="${w.x}" y2="${w.y}" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    }
  });
  svg.addEventListener('pointerup', (ev) => {
    if (endPointer(ev)) return;
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove('panning', 'wiring');
    overlay.innerHTML = '';
    if (d.mode === 'move' || d.mode === 'resize') { render(); return; }
    if (d.mode !== 'wire') return;
    // 端子をタップしただけ(ほぼ動かさず離した)なら、次のタップで接続先を選ぶモードへ
    if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 8) {
      pendingWire = d;
      svg.classList.add('wiring');
      overlay.innerHTML = `<circle cx="${d.start.x}" cy="${d.start.y}" r="${(portR() * 1.6).toFixed(1)}" fill="none" stroke="#2563eb" stroke-width="${(2 / view.k).toFixed(2)}"/>`;
      setHint(isMobile() ? null : '接続先の入力端子(緑)または部品をクリック。背景クリックで取消');
      return;
    }
    finishWire(d, ev.clientX, ev.clientY);
  });
  function finishWire(d, cx, cy) {
    overlay.innerHTML = '';
    const el = document.elementFromPoint(cx, cy);
    if (!el) return;
    let tn = null, tp = null;
    const portEl = el.closest('[data-port]');
    if (portEl) [tn, tp] = portEl.dataset.port.split(':');
    else {
      const nodeEl = el.closest('[data-node]');
      if (nodeEl) {
        tn = nodeEl.dataset.node;
        const n = nodeById(tn);
        const want = d.kind === 'out' ? 'in' : 'out';
        const ps = KZ.ports(n).filter((q) => q.kind === want);
        const free = ps.filter((q) => !model.edges.some((e) => (want === 'in' ? e.to : e.from).n === tn && (want === 'in' ? e.to : e.from).p === q.id));
        tp = (free[0] || ps[0] || {}).id;
      }
    }
    if (!tn || !tp || tn === d.nid) return;
    const tq = KZ.port(nodeById(tn), tp);
    if (!tq || tq.kind === d.kind) return;
    const from = d.kind === 'out' ? { n: d.nid, p: d.pid } : { n: tn, p: tp };
    const to = d.kind === 'out' ? { n: tn, p: tp } : { n: d.nid, p: d.pid };
    connect(from, to);
  }
  function connect(from, to) {
    snapshot();
    model.edges = model.edges.filter((e) => !(e.to.n === to.n && e.to.p === to.p) && !(e.from.n === from.n && e.from.p === from.p));
    const target = nodeById(to.n);
    const p = target.type === 'term' ? { cable: 'direct', len: 0 } : Object.assign({}, lastCable);
    const e = { id: newId('e'), from, to, p };
    model.edges.push(e);
    sel = { k: 'e', id: e.id };
    render();
  }
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(ev.clientX - r.left, ev.clientY - r.top, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
  svg.addEventListener('dragover', (ev) => ev.preventDefault());
  svg.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const key = ev.dataTransfer.getData('text/plain');
    if (!key) return;
    const [gi, ii] = key.split(':').map(Number);
    const item = PALETTE[gi] && PALETTE[gi][1][ii];
    if (!item) return;
    const w = toWorld(ev);
    addNode(item[0], item[1], w.x, w.y);
  });

  /* ---------- キーボード ---------- */
  document.addEventListener('keydown', (ev) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !typing) { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y' && !typing) { ev.preventDefault(); redo(); return; }
    if (typing) return;
    if (ev.key === 'Escape') { tool = null; pendingWire = null; overlay.innerHTML = ''; svg.classList.remove('wiring'); updateArmed(); sel = null; render(); }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel) { ev.preventDefault(); removeSel(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd' && sel && sel.k === 'n') { ev.preventDefault(); duplicate(); }
    if (sel && sel.k === 'n' && ev.key.startsWith('Arrow')) {
      ev.preventDefault();
      const n = nodeById(sel.id), s = ev.shiftKey ? 20 : GRID;
      snapshot();
      if (ev.key === 'ArrowLeft') n.x -= s; if (ev.key === 'ArrowRight') n.x += s;
      if (ev.key === 'ArrowUp') n.y -= s; if (ev.key === 'ArrowDown') n.y += s;
      render();
    }
  });
  function removeSel() {
    if (!sel) return;
    snapshot();
    if (sel.k === 'n') {
      model.nodes = model.nodes.filter((n) => n.id !== sel.id);
      model.edges = model.edges.filter((e) => e.from.n !== sel.id && e.to.n !== sel.id);
    } else {
      model.edges = model.edges.filter((e) => e.id !== sel.id);
    }
    sel = null;
    render();
    if (isMobile()) setHint('削除しました(上の ↶ で元に戻せます)');
  }
  function duplicate() {
    const n = nodeById(sel.id);
    snapshot();
    const c = JSON.parse(JSON.stringify(n));
    c.id = newId('n'); c.x += 40; c.y += 20;
    model.nodes.push(c);
    sel = { k: 'n', id: c.id };
    render();
  }
  function pruneEdges(n) {
    const ids = new Set(KZ.ports(n).map((q) => q.id));
    model.edges = model.edges.filter((e) => !((e.from.n === n.id && !ids.has(e.from.p)) || (e.to.n === n.id && !ids.has(e.to.p))));
  }

  /* ---------- プロパティパネル ---------- */
  const F = (key, label, type = 'num', opt) => ({ key, label, type, opt });
  const H = (label) => ({ head: label });
  const LBL = F('label', '傍記(空欄で自動)', 'text');
  const SCHEMA = {
    uhf_ant: [F('label', '傍記', 'text'), F('E', '電界強度 dBμV/m'), F('g470', 'アンテナ利得 470MHz dB'), F('g710', 'アンテナ利得 710MHz dB'), F('cn', 'アンテナ出力 C/N dB')],
    bs_ant: [F('label', '傍記', 'text'), F('level', 'コンバータ出力 dBμV'), F('cn', 'アンテナ出力 C/N dB')],
    mixer: [LBL, F('lossOverride', '挿入損失 上書き(7値)', 'vec')],
    booster: [F('label', '傍記', 'text'), F('dualIn', 'UHF/BS 別入力', 'bool'),
      H('UHF帯(地デジ)'), F('uhfAtt', '入力ATT dB'), F('uhfGain', '利得 dB'), F('uhfAdj', '利得調整(減衰) dB'),
      H('BS・110°CS帯'), F('satAtt', '入力ATT dB'), F('satInTilt', '入力チルト dB(1000MHz側)'),
      F('satGainLow', '利得 1000MHz dB'), F('satGainHigh', '利得 3224MHz dB'),
      F('satAdjLow', '利得調整 1000MHz dB'), F('satAdjHigh', '利得調整 3224MHz dB'),
      H('定格出力'), F('ratedUhf', 'UHF 定格出力 dBμV'), F('ratedSat', 'BS・CS 定格出力 dBμV'),
      H('雑音指数(C/N計算用)'), F('nfUhf', 'NF UHF dB'), F('nfSat', 'NF BS・CS dB')],
    tap: [LBL, F('n', '分岐数', 'sel', [1, 2, 4]), F('coupling', '結合損失(公称) dB', 'sel', [8, 10, 12, 15, 20, 25, 30]),
      F('lossOverride', '挿入損失 上書き(7値)', 'vec'), F('coupOverride', '結合損失 上書き(7値)', 'vec')],
    splitter: [LBL, F('n', '分配数', 'sel', [2, 4, 6, 8]), F('lossOverride', '分配損失 上書き(7値)', 'vec')],
    outlet: [LBL, F('terminals', '端子数', 'sel', [1, 2]), F('S', 'S: 上り信号カット', 'bool'), F('lossOverride', '端子損失 上書き(7値)', 'vec')],
    series: [LBL, F('end', '終端形(R)', 'bool'), F('coupling', '端子結合損失(公称) dB', 'sel', [8, 10, 12, 15, 20, 25]),
      F('lossOverride', '挿入損失 上書き(7値)', 'vec'), F('coupOverride', '端子結合損失 上書き(7値)', 'vec')],
    term: [F('label', '傍記', 'text')],
    box: [F('label', '名称', 'text'), F('w', '幅'), F('h', '高さ')],
    text: [F('text', 'テキスト', 'textarea'), F('size', '文字サイズ')],
  };
  const STRUCT_KEYS = new Set(['n', 'dualIn', 'end', 'terminals']);

  function fieldHtml(f, val) {
    const id = 'f_' + f.key;
    if (f.head) return `<h5>${f.head}</h5>`;
    switch (f.type) {
      case 'bool': return `<div class="field"><label for="${id}">${f.label}</label><input type="checkbox" id="${id}" data-key="${f.key}" ${val ? 'checked' : ''}></div>`;
      case 'sel': return `<div class="field"><label for="${id}">${f.label}</label><select id="${id}" data-key="${f.key}">${f.opt.map((o) => `<option value="${o}" ${String(o) === String(val) ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
      case 'text': return `<div class="field wide"><label for="${id}">${f.label}</label><input type="text" id="${id}" data-key="${f.key}" value="${esc(val)}"></div>`;
      case 'textarea': return `<div class="field wide"><label for="${id}">${f.label}</label><textarea id="${id}" data-key="${f.key}" rows="3">${esc(val)}</textarea></div>`;
      case 'vec': return `<div class="field wide"><label for="${id}">${f.label}</label><input type="text" id="${id}" data-key="${f.key}" value="${esc(val)}" placeholder="例: 4.5,4.5,5,5,6,7,8"></div>`;
      default: return `<div class="field"><label for="${id}">${f.label}</label><input type="number" step="0.1" id="${id}" data-key="${f.key}" value="${esc(val)}"></div>`;
    }
  }
  function levelTable(rows) {
    const head = `<tr><th></th>${KZ.FREQS.map((f) => `<th>${f}</th>`).join('')}</tr>`;
    return `<table class="grid levels">${head}${rows.map(([name, v, cls]) => `<tr${cls ? ` class="${cls}"` : ''}><td class="l">${name}</td>${v.map((x) => `<td>${f1(x)}</td>`).join('')}</tr>`).join('')}</table>`;
  }

  function renderProps() {
    const el = $('#props');
    if (!sel) { el.innerHTML = docSettingsHtml(); bindDocSettings(); return; }
    if (sel.k === 'e') {
      const e = edgeById(sel.id);
      if (!e) { sel = null; return renderProps(); }
      const a = nodeById(e.from.n), b = nodeById(e.to.n);
      const no = num.edges[e.id] ? KZ.circled(num.edges[e.id]) + ' ' : '';
      el.innerHTML = `<h3>${no}ケーブル</h3>
        <div class="note">${esc(KZ.displayName(a))} → ${esc(KZ.displayName(b))}</div>
        <div class="field"><label>種類</label><select data-ekey="cable">
          ${[['5C', 'S-5C-FB'], ['7C', 'S-7C-FB'], ['direct', '直結(損失なし)'], ['custom', '任意(損失入力)']].map(([v, t]) => `<option value="${v}" ${e.p.cable === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="field"><label>長さ m</label><input type="number" step="0.5" min="0" data-ekey="len" value="${e.p.len}"></div>
        ${e.p.cable === 'custom' ? `<div class="field wide"><label>名称</label><input type="text" data-ekey="name" value="${esc(e.p.name || '')}"></div>
        <div class="field wide"><label>損失 dB(7値)</label><input type="text" data-ekey="lossOverride" value="${esc(e.p.lossOverride || '')}" placeholder="470,710,1000,1489,2150,2681,3224MHz"></div>` : ''}
        ${levelTable([['損失 dB', KZ.edgeLoss(e)], ['到達 dBμV', res.edgeIn[e.id] || KZ.FREQS.map(() => NEG)]])}
        <div class="btnrow"><button class="danger" data-act="del">削除</button></div>
        <div class="note">新しく配線したケーブルには、最後に設定した種類と長さが入ります。</div>`;
      el.querySelectorAll('[data-ekey]').forEach((inp) => inp.addEventListener('change', () => {
        snapshot();
        const k = inp.dataset.ekey;
        e.p[k] = inp.type === 'number' ? Number(inp.value) : inp.value;
        if (e.p.cable !== 'direct' && e.p.cable !== 'custom') lastCable = { cable: e.p.cable, len: e.p.len };
        render();
      }));
      el.querySelector('[data-act=del]').onclick = removeSel;
      return;
    }
    const n = nodeById(sel.id);
    if (!n) { sel = null; return renderProps(); }
    const no = num.nodes[n.id] ? KZ.circled(num.nodes[n.id]) + ' ' : '';
    let html = `<h3>${no}${esc(KZ.displayName(n))}</h3>`;
    html += (SCHEMA[n.type] || []).map((f) => fieldHtml(f, f.head ? null : n.p[f.key])).join('');
    // 計算値
    if (res && !['box', 'text'].includes(n.type)) {
      const rows = [];
      if (!['uhf_ant', 'bs_ant'].includes(n.type)) rows.push(['入力 dBμV', res.inLv[n.id] || KZ.FREQS.map(() => NEG)]);
      if (n.type === 'booster' && res.bdet[n.id]) {
        const d = res.bdet[n.id];
        rows.push(['ATT+チルト', d.map((x) => -(x.att + x.tilt)), 'sub'], ['利得', d.map((x) => x.gain), 'sub'], ['利得調整', d.map((x) => -x.adj), 'sub']);
        rows.push(['単体 C/N dB', res.unitCn[n.id].map((x) => (x == null ? NEG : x)), 'sub']);
      }
      const o = res.out[n.id] || {};
      const keys = Object.keys(o);
      const uniq = [];
      keys.forEach((k) => { if (!uniq.some((u) => JSON.stringify(o[u]) === JSON.stringify(o[k]))) uniq.push(k); });
      uniq.forEach((k) => rows.push([k === 'out' ? '出力 dBμV' : n.type === 'tap' ? '分岐出力 dBμV' : '分配出力 dBμV', o[k]]));
      if (res.term[n.id]) {
        const c = res.cn[n.id], nz = (v) => v.map((x) => (x == null ? NEG : x));
        rows.push(['端子出力 dBμV', res.term[n.id]], ['端子 C/N dB', nz(c.term)]);
        if (res.cfg.rx) rows.push(['総合 C/N dB', nz(c.total)]);
      }
      if (rows.length) html += `<h5>計算値</h5>` + levelTable(rows);
    }
    html += `<div class="btnrow"><button data-act="dup">複製 (Ctrl+D)</button><button class="danger" data-act="del">削除</button></div>`;
    if (['tap', 'splitter', 'outlet', 'series', 'mixer'].includes(n.type)) {
      html += `<div class="note">損失の初期値はJEITA計算事例集などから入れた目安値です。製品カタログの値がある場合は「上書き」に7つの値(470/710/1000/1489/2150/2681/3224MHz)をカンマ区切りで入力してください。</div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('[data-key]').forEach((inp) => inp.addEventListener('change', () => {
      snapshot();
      const k = inp.dataset.key;
      let v = inp.type === 'checkbox' ? inp.checked : inp.value;
      if (inp.type === 'number' || (inp.tagName === 'SELECT' && !isNaN(Number(v)))) v = Number(v);
      n.p[k] = v;
      if (STRUCT_KEYS.has(k)) pruneEdges(n);
      render();
    }));
    el.querySelector('[data-act=del]').onclick = removeSel;
    el.querySelector('[data-act=dup]').onclick = duplicate;
  }

  function docSettingsHtml() {
    return `<h3>図面設定</h3>
      <div class="field wide"><label>図面名</label><input type="text" data-doc="title" value="${esc(model.title)}"></div>
      <div class="field wide"><label>作成者</label><input type="text" data-doc="author" value="${esc(model.author)}"></div>
      <div class="field"><label>日付</label><input type="date" data-doc="date" value="${esc(model.date)}"></div>
      <div class="field wide"><label>階(上から1行ずつ)</label><textarea data-doc="floors" rows="5">${esc(model.floors.join('\n'))}</textarea></div>
      <div class="field"><label>階の高さ(px)</label><input type="number" step="10" data-doc="laneH" value="${model.laneH}"></div>
      <h5>C/N 計算</h5>
      <div class="field"><label>衛星放送の種別</label><select data-cn="sat4k">
        <option value="0" ${model.cn.sat4k ? '' : 'selected'}>2K(熱雑音9.4dB・所要17dB)</option>
        <option value="1" ${model.cn.sat4k ? 'selected' : ''}>4K8K(熱雑音10.1dB・所要18dB)</option></select></div>
      <div class="field"><label>受像機を含めて判定</label><input type="checkbox" data-cn="rx" ${model.cn.rx ? 'checked' : ''}></div>
      <div class="field"><label>受像機 NF 地デジ dB</label><input type="number" step="0.5" data-cn="rxNfTerr" value="${model.cn.rxNfTerr}"></div>
      <div class="field"><label>受像機 NF BS・CS dB</label><input type="number" step="0.5" data-cn="rxNfSat" value="${model.cn.rxNfSat}"></div>
      <div class="field"><label>端子→受像機 5C ケーブル m</label><input type="number" step="0.5" data-cn="rxCableLen" value="${model.cn.rxCableLen}"></div>
      <div class="field wide"><label>分波器損失 上書き(7値)</label><input type="text" data-cn="demux" value="${esc(model.cn.demux)}" placeholder="${KZ.DEMUX.v.join(',')}"></div>
      <div class="note">機器単体の C/N = 入力レベル − 熱雑音 − NF。アンテナ・各ブースタ・受像機の C/N を電力加算して総合 C/N を求めます(JEITA 3-8)。アンテナ出力の C/N は、各アンテナの設定に現地の測定値を入れてください(初期値は JEITA 計算例の値)。</div>
      <h5>使い方</h5>
      <div class="note">
        1. 左のパレットから部品を選んで図面上をクリック(ドラッグでも可)<br>
        2. 部品にマウスを乗せると端子が表示されます。<b style="color:#ea580c">橙=出力</b>から<b style="color:#16a34a">緑=入力</b>へドラッグして配線<br>
        3. 部品やケーブルをクリックすると、右側で仕様(分岐数、結合損失、ケーブル長など)を変更できます<br>
        4. テレビ端子を選ぶと、下の「レベル計算表」にアンテナからの計算過程が表示されます<br>
        <span class="kbd">Del</span> 削除 <span class="kbd">Ctrl+Z</span> 元に戻す <span class="kbd">Ctrl+D</span> 複製 <span class="kbd">矢印</span> 微移動
      </div>
      <div class="note">判定基準(JEITA): 地デジ 50〜81 dBμV / BS・110°CS 54〜81 dBμV</div>`;
  }
  function bindDocSettings() {
    $('#props').querySelectorAll('[data-doc]').forEach((inp) => inp.addEventListener('change', () => {
      snapshot();
      const k = inp.dataset.doc;
      if (k === 'floors') model.floors = inp.value.split('\n').map((s) => s.trim()).filter(Boolean);
      else if (k === 'laneH') model.laneH = Math.max(80, Number(inp.value) || 180);
      else model[k] = inp.value;
      render();
    }));
    $('#props').querySelectorAll('[data-cn]').forEach((inp) => inp.addEventListener('change', () => {
      snapshot();
      const k = inp.dataset.cn;
      model.cn[k] = k === 'sat4k' ? inp.value === '1' : inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
      render();
    }));
  }

  function renderWarnings() {
    const el = $('#warnings');
    const ws = res.warnings;
    el.innerHTML = `<h3>チェック結果 <span class="mutedtxt" style="font-weight:400">(${ws.length}件)</span></h3>` +
      (ws.length ? ws.map((w, i) => `<div class="warn-item ${w.level}" data-wi="${i}">${esc(w.msg)}</div>`).join('') : `<div class="note ok">問題は見つかりませんでした。</div>`);
    el.querySelectorAll('[data-wi]').forEach((d) => d.addEventListener('click', () => {
      const w = ws[+d.dataset.wi];
      if (w.node) { sel = { k: 'n', id: w.node }; if (isMobile()) openSheet(null); centerOn(nodeById(w.node)); render(); }
    }));
  }
  function centerOn(n) {
    if (!n) return;
    const r = svg.getBoundingClientRect();
    view.x = r.width / 2 - n.x * view.k;
    view.y = r.height / 2 - n.y * view.k;
    applyView();
  }

  /* ---------- 下部パネル ---------- */
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tabpane').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + activeTab));
    renderBottom();
  }));
  function renderBottom() {
    const m = isMobile();
    if (activeTab === 'calc') {
      const h = calcTableHtml();
      $('#tab-calc').innerHTML = m ? stackTable(h, 3, stackedBandHead()) : h;
    }
    if (activeTab === 'list') {
      const h = outletListHtml(true);
      const head = `<tr><th>地デジ<br>dBμV</th><th>BS・CS<br>dBμV</th><th>C/N<br>地デジ</th><th>C/N<br>BS・CS</th><th>判定</th></tr>`;
      $('#tab-list').innerHTML = m ? stackTable(h, 4, head).replace(/colspan="7"/g, 'colspan="5"') : h;
      bindList();
    }
    if (activeTab === 'legend') $('#tab-legend').innerHTML = legendHtml();
  }
  /* スマホ用: 先頭 labelCols 列(ラベル)を1行にまとめ、その下に数値の行を並べた縦積みの表に組み替える
   * (rowspan / colspan を列の占有で追跡して変換) */
  function stackTable(html, labelCols, headHtml) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const table = tpl.content.querySelector('table');
    if (!table) return html;
    let carry = [];       // {col, span, left}
    let out = '';
    [...table.rows].forEach((tr) => {
      if (tr.querySelector('th')) return;      // 見出しは headHtml で置き換え
      const labels = [], values = [];
      let col = 0;
      const occupied = (c) => carry.some((k) => k.left > 0 && c >= k.col && c < k.col + k.span);
      [...tr.cells].forEach((td) => {
        while (occupied(col)) col++;
        const span = td.colSpan || 1;
        if (col < labelCols) {
          const t = td.textContent.trim();
          if (t) labels.push(t);
        } else {
          values.push(td.outerHTML.replace(/<td/, `<td colspan="${span}"`).replace(/colspan="\d+"([^>]*)colspan="\d+"/, `colspan="${span}"$1`));
        }
        if (td.rowSpan > 1) carry.push({ col, span, left: td.rowSpan });
        col += span;
      });
      carry.forEach((k) => { k.left--; });
      carry = carry.filter((k) => k.left > 0);
      const attrs = [...tr.attributes].map((a) => `${a.name}="${esc(a.value)}"`).join(' ');
      const cls = tr.className;
      if (labels.length) out += `<tr ${attrs.replace(/class="[^"]*"/, '')} class="mlbl ${cls}"><td colspan="${KZ.FREQS.length}">${esc(labels.join('  '))}</td></tr>`;
      out += `<tr ${attrs}>${values.join('')}</tr>`;
    });
    const before = html.slice(0, html.indexOf('<table'));
    return `${before}<table class="grid stacked">${headHtml}${out}</table>`;
  }
  const stackedBandHead = () => `<tr><th colspan="2">地デジ</th><th colspan="5">BS・110°CS (MHz)</th></tr>
    <tr>${KZ.FREQS.map((f) => `<th>${f}</th>`).join('')}</tr>`;

  function bandHead() {
    return `<tr><th colspan="3" rowspan="2">機器</th><th colspan="2">地上デジタル</th><th colspan="5">BS・110°CS</th></tr>
      <tr>${KZ.FREQS.map((f) => `<th>${f}MHz</th>`).join('')}</tr>`;
  }
  function calcTableHtml() {
    const target = sel && sel.k === 'n' && res.term[sel.id] ? sel.id : null;
    if (!target) return `<div class="note">図面上のテレビ端子(または直列ユニット)をクリックすると、アンテナからその端子までのレベル計算表を表示します。</div>`;
    const n = nodeById(target);
    const rows = KZ.pathRows(model, res, target, num);
    const cell = (x) => `<td>${f1(x)}</td>`;
    const lossCell = (l, lv) => `<td>${l == null || !Number.isFinite(l) ? '—' : (l >= 0 ? '−' : '+') + Math.abs(l).toFixed(1)}<span class="lv">${f1(lv)}</span></td>`;
    let body = '';
    rows.forEach((r) => {
      const no = r.no ? KZ.circled(r.no) : '';
      if (r.kind === 'src') {
        body += `<tr><td class="c" rowspan="2">${no}</td><td class="l" rowspan="2">${esc(r.name)}</td><td class="l">${esc(r.spec)}</td>${r.level.map(cell).join('')}</tr>`;
        body += `<tr class="sub"><td class="l">C/N dB</td>${r.cn.map(cell).join('')}</tr>`;
      } else if (r.kind === 'booster') {
        body += `<tr><td class="c" rowspan="6">${no}</td><td class="l" rowspan="6">${esc(r.name)}</td><td class="l">入力 dBμV</td>${r.input.map(cell).join('')}</tr>`;
        body += `<tr class="sub"><td class="l">入力ATT・チルト dB</td>${r.detail.map((d, i) => (r.input[i] === NEG ? '<td>—</td>' : `<td>−${(d.att + d.tilt).toFixed(1)}</td>`)).join('')}</tr>`;
        body += `<tr class="sub"><td class="l">利得 dB</td>${r.detail.map((d, i) => (r.input[i] === NEG ? '<td>—</td>' : `<td>${d.gain.toFixed(1)}</td>`)).join('')}</tr>`;
        body += `<tr class="sub"><td class="l">利得調整 dB</td>${r.detail.map((d, i) => (r.input[i] === NEG ? '<td>—</td>' : `<td>${d.adj ? '−' : ''}${d.adj.toFixed(1)}</td>`)).join('')}</tr>`;
        body += `<tr><td class="l">出力 dBμV</td>${r.level.map(cell).join('')}</tr>`;
        body += `<tr class="sub"><td class="l">単体 C/N dB(入力−熱雑音−NF)</td>${r.cn.map(cell).join('')}</tr>`;
      } else {
        body += `<tr${r.final ? ' class="total"' : ''}><td class="c">${no}</td><td class="l">${esc(r.name)}</td><td class="l">${esc(r.spec)}</td>${r.loss.map((l, i) => lossCell(l, r.level[i])).join('')}</tr>`;
      }
    });
    const v = res.term[target];
    body += `<tr class="total"><td colspan="3" class="l">テレビ端子出力 dBμV</td>${v.map((x, i) => {
      if (x === NEG) return '<td>—</td>';
      const [lo, hi] = KZ.rangeOf(i);
      return `<td class="${x < lo || x > hi ? 'ng' : 'ok'}">${x.toFixed(1)}</td>`;
    }).join('')}</tr>`;
    body += `<tr class="sub"><td colspan="3" class="l">望ましい値 dBμV</td><td colspan="2" class="c">${KZ.RANGE.terr.join('〜')}</td><td colspan="5" class="c">${KZ.RANGE.sat.join('〜')}</td></tr>`;
    // C/N
    const c = res.cn[target], cfg = res.cfg;
    const cnCell = (x, i, judge) => (x == null ? '<td>—</td>' : `<td class="${judge ? (x < cfg.req[i] ? 'ng' : 'ok') : ''}">${x.toFixed(1)}</td>`);
    body += `<tr><td colspan="3" class="l">端子 C/N dB(アンテナ+ブースタ)</td>${c.term.map((x, i) => cnCell(x, i, !cfg.rx)).join('')}</tr>`;
    if (cfg.rx) {
      body += `<tr class="sub"><td colspan="3" class="l">端子→受像機の損失 dB(5C ${cfg.rxCableLen}m+分波器)</td>${cfg.rxLoss.map((x, i) => (c.term[i] == null ? '<td>—</td>' : `<td>−${x.toFixed(1)}</td>`)).join('')}</tr>`;
      body += `<tr class="sub"><td colspan="3" class="l">受像機入力レベル dBμV</td>${c.rxLevel.map(cell).join('')}</tr>`;
      body += `<tr class="sub"><td colspan="3" class="l">受像機単体 C/N dB(NF 地${cfg.rxNfTerr}/衛${cfg.rxNfSat})</td>${c.rxUnit.map((x) => cell(x == null ? NEG : x)).join('')}</tr>`;
      body += `<tr class="total"><td colspan="3" class="l">総合 C/N dB</td>${c.total.map((x, i) => cnCell(x, i, true)).join('')}</tr>`;
    }
    body += `<tr class="sub"><td colspan="3" class="l">所要 C/N dB</td><td colspan="2" class="c">24 以上</td><td colspan="5" class="c">${cfg.req[6]} 以上(${cfg.sat4k ? '4K8K' : '2K'})</td></tr>`;
    const no = num.nodes[target] ? KZ.circled(num.nodes[target]) : '';
    return `<div class="note">${no} ${esc(KZ.displayName(n))}(${esc(floorOf(n.y))})までの計算。損失欄の小さい数字は、その機器を通過した後のレベル(dBμV)です。</div>
      <table class="grid">${bandHead()}${body}</table>`;
  }
  function outletIds() {
    return Object.keys(res.term).sort((a, b) => (num.nodes[a] || 999) - (num.nodes[b] || 999));
  }
  function outletListHtml(interactive) {
    const ids = outletIds();
    if (!ids.length) return `<div class="note">テレビ端子がまだありません。</div>`;
    const rows = ids.map((id) => {
      const n = nodeById(id), v = res.term[id];
      const t = v.slice(0, 2).filter((x) => x !== NEG), s = v.slice(2).filter((x) => x !== NEG);
      const j = KZ.judgeAll(res, id);
      const rng = (a) => (a.length ? `${Math.min(...a).toFixed(1)} 〜 ${Math.max(...a).toFixed(1)}` : '—');
      const c = res.cn[id];
      const cmin = (terr) => {
        const x = KZ.minOf(c.judged, terr);
        if (x == null) return '—';
        const req = terr ? 24 : res.cfg.req[6];
        return `<span class="${x < req ? 'ng' : ''}">${x.toFixed(1)}</span>`;
      };
      return `<tr class="${interactive ? 'clickable' : ''}${sel && sel.id === id ? ' selrow' : ''}" data-oid="${id}">
        <td class="c">${num.nodes[id] ? KZ.circled(num.nodes[id]) : ''}</td><td class="c">${esc(floorOf(n.y))}</td>
        <td class="l">${esc(KZ.displayName(n))}</td><td class="l">${esc(n.p.label || '')}</td>
        <td>${rng(t)}</td><td>${rng(s)}</td><td>${cmin(true)}</td><td>${cmin(false)}</td>
        <td class="c ${j === 'ok' ? 'ok' : j === 'ng' ? 'ng' : 'mutedtxt'}">${j === 'ok' ? '適合' : j === 'ng' ? '範囲外' : '信号なし'}</td></tr>`;
    }).join('');
    const okc = ids.filter((id) => KZ.judgeAll(res, id) === 'ok').length;
    const cnLabel = res.cfg.rx ? '総合C/N' : '端子C/N';
    return `<div class="note">端子数 ${ids.length} / 適合 ${okc} / 範囲外・信号なし ${ids.length - okc}(レベルと C/N の両方で判定)</div>
      <table class="grid"><tr><th>No.</th><th>階</th><th>種別</th><th>傍記</th><th>地デジ dBμV<br>(50〜81)</th><th>BS・CS dBμV<br>(54〜81)</th>
      <th>${cnLabel} 地デジ<br>(24以上)</th><th>${cnLabel} BS・CS<br>(${res.cfg.req[6]}以上)</th><th>判定</th></tr>${rows}</table>`;
  }
  function bindList() {
    $('#tab-list').querySelectorAll('[data-oid]').forEach((tr) => tr.addEventListener('click', () => {
      sel = { k: 'n', id: tr.dataset.oid };
      if (isMobile()) { activeTab = 'calc'; document.querySelector('.tabs [data-tab=calc]').click(); }
      centerOn(nodeById(sel.id));
      render();
    }));
  }
  function legendHtml() {
    const items = KZ.LEGEND.map((l) => `<div class="legend-item">${iconSvg(l.type, l.p, 44)}<div>${l.name}<small>${l.note}</small></div></div>`).join('');
    const vrow = (name, o) => `<tr><td class="l">${name}</td>${o.v.map((x) => `<td>${x.toFixed(1)}</td>`).join('')}<td class="c ${o.src === 'JEITA' ? '' : 'mutedtxt'}">${o.src}</td></tr>`;
    const T = KZ.T;
    const cab = (k) => `<tr><td class="l">${KZ.CABLES[k].name} (dB/100m)</td>${KZ.cablePerKm(k).map((x) => `<td>${(x / 10).toFixed(1)}</td>`).join('')}<td class="c">JEITA</td></tr>`;
    return `<div class="note">図記号は 国土交通省「公共建築設備工事標準図(電気設備工事編)」(JIS C 0303 準拠)に従っています。</div>
      <div class="legend-grid">${items}</div>
      <table class="grid"><tr><th>損失の初期値 dB</th>${KZ.FREQS.map((f) => `<th>${f}</th>`).join('')}<th>出典</th></tr>
      ${cab('5C')}${cab('7C')}
      ${[2, 4, 6, 8].map((k) => vrow(`${k}分配器 分配損失`, T.splitter[k])).join('')}
      ${[1, 2, 4].map((k) => vrow(`${k}分岐器 挿入損失`, T.tapIns[k])).join('')}
      ${vrow('分岐器 結合損失(公称12dBの例)', { v: T.coupOffset.map((x) => x + 12), src: 'JEITA' })}
      ${vrow('混合(分波)器', T.mixer)}
      ${vrow('1端子形テレビ端子', T.outlet[1])}${vrow('2端子形テレビ端子', T.outlet[2])}
      ${vrow('直列ユニット 挿入損失', T.seriesIns)}${vrow('直列ユニット(終端形) 端子損失', T.seriesEnd)}
      </table>
      <div class="note">「目安」の値は一般的な製品の仮の値です。実際の設計では、使用する製品のカタログ値で上書きしてください。</div>`;
  }

  /* ---------- 出力 ---------- */
  function exportSvgString() {
    const b = bounds();
    const pad = 20, tbH = 70;
    const W = b.w + pad * 2, Hh = b.h + pad * 2 + tbH;
    const saveSel = sel; sel = null;
    const body = drawing(false);
    sel = saveSel;
    const tbW = 420, tx = b.x + b.w - tbW, ty = b.h + 12;
    const tb = `<g font-size="12" fill="#111827">
      <rect x="${tx}" y="${ty}" width="${tbW}" height="${tbH - 16}" fill="#fff" stroke="#111827" stroke-width="1"/>
      <line x1="${tx}" y1="${ty + 27}" x2="${tx + tbW}" y2="${ty + 27}" stroke="#111827" stroke-width="0.8"/>
      <line x1="${tx + 280}" y1="${ty}" x2="${tx + 280}" y2="${ty + tbH - 16}" stroke="#111827" stroke-width="0.8"/>
      <text x="${tx + 8}" y="${ty + 18}" font-weight="700">${esc(model.title)}</text>
      <text x="${tx + 8}" y="${ty + 45}">テレビ共同受信設備 系統図</text>
      <text x="${tx + 288}" y="${ty + 18}">${esc(model.date)}</text>
      <text x="${tx + 288}" y="${ty + 45}">${esc(model.author)}</text></g>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh}" viewBox="${b.x - pad} ${-pad} ${W} ${Hh}" font-family="Yu Gothic UI, Meiryo, sans-serif">` +
      `<rect x="${b.x - pad}" y="${-pad}" width="${W}" height="${Hh}" fill="#fff"/>${body}${tb}</svg>`;
  }
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const fname = (ext) => `${(model.title || '共聴系統図').replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
  function exportPng() {
    const s = exportSvgString();
    const img = new Image();
    const m = s.match(/width="([\d.]+)" height="([\d.]+)"/);
    const W = +m[1], Hh = +m[2], scale = 2;
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = W * scale; c.height = Hh * scale;
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      c.toBlob((bl) => download(fname('png'), bl), 'image/png');
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }
  function doPrint() {
    $('#print').innerHTML = exportSvgString() + `<h2>端子一覧</h2>` + outletListHtml(false);
    window.print();
  }

  function loadSample(fn, name) {
    if (!confirm(`サンプル「${name}」を読み込みますか?(現在の図面は置き換わります。元に戻すで戻せます)`)) return;
    snapshot(); model = normalize(fn()); sel = { k: 'n', id: model.checkNode }; render(); fit();
  }

  /* ---------- ツールバー ---------- */
  const ACTIONS = {
    new: () => { if (!confirm('現在の図面を破棄して新規作成しますか?(保存していない変更は失われます)')) return; snapshot(); model = blank(); sel = null; render(); fit(); },
    open: () => $('#fileInput').click(),
    save: () => download(fname('json'), new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' })),
    sample: () => loadSample(KZ.sample, 'ビル共同受信(JEITA 3-7)'),
    sample2: () => loadSample(KZ.homeSample, 'ホーム共同受信 C/N計算例(JEITA 3-8)'),
    undo, redo,
    fit,
    zoomin: () => { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.2); },
    zoomout: () => { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.2); },
    svg: () => download(fname('svg'), new Blob([exportSvgString()], { type: 'image/svg+xml' })),
    png: exportPng,
    print: doPrint,
  };
  document.querySelectorAll('#toolbar [data-act]').forEach((b) => b.addEventListener('click', () => {
    if (b.closest('.collapsible')) closeMenu();
    ACTIONS[b.dataset.act]();
  }));
  $('#fileInput').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    f.text().then((t) => {
      try { snapshot(); model = normalize(JSON.parse(t)); sel = null; render(); fit(); }
      catch (e) { alert('ファイルを読み込めませんでした: ' + e.message); }
    });
    ev.target.value = '';
  });
  $('#docTitle').addEventListener('change', (ev) => { snapshot(); model.title = ev.target.value; render(); });
  [['showNum', 'num'], ['showCable', 'cable'], ['showLvl', 'lvl'], ['showCN', 'cn']].forEach(([id, k]) => {
    $('#' + id).addEventListener('change', (ev) => { show[k] = ev.target.checked; renderCanvasOnly(); });
  });
  window.addEventListener('resize', () => applyView());

  buildPalette();
  setHint();
  render();
  requestAnimationFrame(fit);

  // デバッグ・検証用
  window.KZApp = { get model() { return model; }, get res() { return res; }, select: (id) => { sel = { k: 'n', id }; render(); },
    exportSvg: () => exportSvgString(),
    look: (x, y, k) => { const r = svg.getBoundingClientRect(); view = { k, x: r.width / 2 - x * k, y: r.height / 2 - y * k }; applyView(); } };
})();
