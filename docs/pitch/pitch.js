// 理念展示页 v2：画面只由时间 t 决定，拖动、切幕、暂停都能得到同一帧
// #gl 画镜头星河与镜头卡，#fx 画波形、连线与泳道，DOM 负责文字排版
const D = window.PITCH_DATA;
const TOTAL = 61;
// 前情提要占用 t ∈ [-20, 0)，原 60 秒主体时间轴保持不变
const T0 = -24;
// 整体播放倍速：节奏整体加快
const SPEED = 2.2;
const SCENES = [[-24, '封面'], [-20, '前情 · 漫剧'], [-15, '前情 · 宣发'], [-10, '前情 · 情绪'], [-5, '前情 · 产品'],
  [0, '千镜'], [7.3, '每一刀都是决定'], [17, '像不像 ≠ 放不放'], [28, '多级剪枝'], [42, '为什么是 Jev'], [54, '一线']];
const NOTES = [
  'MAD Lab：从成千上万个镜头，实时、智能地剪辑出情绪 MAD。',
  '先讲一点前情：我们有一部在红果上热播的漫剧，视频全部是自己生成的，素材可能有成千上万个镜头。',
  '要宣发，就得剪很多条宣发视频——就是大家在抖音上刷到的、几十万赞的热门音乐配快剪。今天这些都靠人大量地、反复地去筛。',
  '有了 Jev，我们可以把剪辑决策和情绪本身挂钩。召回下一个、Rerank，本身不带任何上下文；Jev 的决策可以带上前一刀、故事走到哪。本质上是用对大量内容的决策，代替召回和 Rerank。',
  '所以产品目的，就是把大量素材交给 Jev，让它按情绪和故事线实时剪出来。为什么要实时？因为找情绪是很高频的事：先快速找到对的，再具体调整。和以往的自动剪辑、信息流工具比，我们从内容本身出发，是为了讲情绪、讲故事。',
  '这是一个用 Jev 做决策核心的动漫剪辑工具：输入一句想法，从 4,575 个镜头里，剪出跟着音乐情绪走的时间轴。',
  '剪辑本质上是海量并行的小决策：每个拍点、每个镜头、每种处理方式，都要回答一次“要不要”。全塞进大模型上下文，既装不下，也等不起。',
  'RAG 只告诉我哪些镜头“像”——召回下一个、再 Rerank，都不带上下文，它会把三个哭脸排在最前面。剪辑要的是带上下文的决定：放不放、留原声还是只要人声、怎么转场、加什么特效和滤镜。Jev 在同一个插入点上把这些一起定下来。',
  '多级剪枝是每一刀一轮：Gemini 先听配乐定乐句情绪和检索方向；每一刀都回到全库 4,425 个镜头重新召回 96 到 384 个候选，这份名单只给这一刀用；合格的三四十到七十个候选全部交给 Jev 评分，不按相似度截断；最后拿 6 到 12 个真实裁剪窗口，结合前后镜和重音，定下镜头与时长。落一刀、更新状态，下一刀再查全库。',
  '这一层只有 Jev 扛得住：单次决策八十多毫秒，不生成文字、直接读选项概率，八路并行复用同一段上下文，本机跑几乎零成本。大模型是导演，一首歌开一次会；Jev 是剪辑师的手感，每个拍点问上千遍。',
  '有了 Jev 级的决策，剪辑从一次性生成，变成持续发生的决策——改一句想法，只重决受影响的那一段乐句。下面看实机演示。',
];

// ---------- 工具 ----------
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ramp = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = k => (k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const hash = (i, s = 0) => { const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); };
const gauss = (i, s) => Math.sqrt(-2 * Math.log(hash(i, s) + 1e-6)) * Math.cos(6.2832 * hash(i, s + 1));
const fmt = n => Math.round(n).toLocaleString('en-US');
const pad2 = n => String(Math.floor(n)).padStart(2, '0');
const $ = id => document.getElementById(id);

const stage = $('stage');
const sg = $('gl').getContext('2d');
const fx = $('fx').getContext('2d');

// ---------- 素材 ----------
const atlas = new Image();
atlas.src = D.atlas.file;
const feats = D.featured.map(f => { const im = new Image(); im.src = f.file; return im; });
const ready = im => im.complete && im.naturalWidth > 0;
const [CELL_W, CELL_H] = D.atlas.cell;
const [CARD_W, CARD_H] = D.atlas.card;

// ---------- 音乐：切点吸附真实重音，不够的在最长段中间补 ----------
const dur = D.music.duration;
const ACC = D.music.accents;
const ENV = D.music.env;
const cuts = [0, ...ACC.filter(a => a > .3 && a < dur - .3), dur];
while (cuts.length < D.featured.length + 1) {
  let k = 0;
  for (let i = 1; i < cuts.length - 1; i++) if (cuts[i + 1] - cuts[i] > cuts[k + 1] - cuts[k]) k = i;
  cuts.splice(k + 1, 0, (cuts[k] + cuts[k + 1]) / 2);
}
while (cuts.length > D.featured.length + 1) cuts.splice(cuts.length - 2, 1);
const PH = [0, 8, 14.8, 22.4, 29.8, 44.6, dur];
const PH_NAME = ['钩子', '为何无法放手', '承诺', '失去', '重试', '不放弃'];

// ---------- 镜头星河：按时间顺序从左流到右，每集之间留一点缝 ----------
const N = D.total;
const COL = [];
for (let i = 0; i < N; i++) COL.push('#' + D.colors.substr(i * 6, 6));
const RX = new Float32Array(N), RY = new Float32Array(N), RZ = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const u = i / (N - 1), ep = D.episodes[i];
  RX[i] = (u - .5) * 24 + (ep - 6) * .24 + gauss(i, 1) * .1;
  RY[i] = Math.sin(u * 10.5) * 1.05 + gauss(i, 3) * .4;
  RZ[i] = Math.cos(u * 7.3 + .6) * 2.3 + gauss(i, 5) * 1.05;
}
const EPC = {};
for (let i = 0; i < N; i++) {
  const e = EPC[D.episodes[i]] || (EPC[D.episodes[i]] = [0, 0, 0, 0]);
  e[0] += RX[i]; e[1] += RY[i]; e[2] += RZ[i]; e[3]++;
}

// ---------- 镜头卡 ----------
const NC = D.cards.length;
const CW = 1.0;
const heroCard = D.featured[0].card;
const featOfCard = new Map(D.featured.map((f, m) => [f.card, m]));
const REC = new Int16Array(N).fill(-1);
D.recall.forEach((s, r) => { REC[s] = r; });
const JUDGED_SHOT = new Uint8Array(N);
D.judged.forEach(n => { JUDGED_SHOT[D.cards[n].shot] = 1; });

// ---------- 剪枝各层的屏幕坐标：横轴统一是音乐时间 ----------
const X0 = 620, X1 = 1780, XW = X1 - X0;
const tx = time => X0 + time / dur * XW;
const L1X = new Float32Array(N), L1Y = new Float32Array(N), L2X = new Float32Array(N), L2Y = new Float32Array(N);
for (let i = 0; i < N; i++) {
  L1X[i] = X0 + hash(i, 11) * XW;
  L1Y[i] = 374 + clamp(gauss(i, 12), -2.3, 2.3) * 15;
  if (REC[i] >= 0) {
    const tm = hash(i, 16) * dur;
    let p = 0;
    while (p < 5 && tm >= PH[p + 1]) p++;
    L2X[i] = tx(PH[p] + (.07 + .86 * hash(i, 17)) * (PH[p + 1] - PH[p]));
    L2Y[i] = 512 + clamp(gauss(i, 18), -2, 2) * 10;
  }
}
const L3 = D.judged.map((n, j) => {
  const row = j % 3, col = Math.floor(j / 3);
  return { n, j, feat: featOfCard.has(n) ? featOfCard.get(n) : -1, x: X0 + (col + .5) / 16 * XW - 30 + (row - 1) * 20, y: 616 + row * 38, w: 60, h: 34 };
});
const CLIP = D.featured.map((f, m) => ({ x: tx(cuts[m]) + 1, y: 816, w: tx(cuts[m + 1]) - tx(cuts[m]) - 2, h: 58 }));

// ---------- 相机：环绕目标点，开场从主镜头铺满全屏拉远到整条星河 ----------
const F = 540 / Math.tan(20 * Math.PI / 180);
const HERO_DIST = CW * F / 1920;
const hs = D.cards[heroCard].shot;
const OVER = { x: 0, y: -1.5, z: 0, dist: 30 };
let C = null, cY = 1, sY = 0, cP = 1, sP = 0;
function camAt(t) {
  const d = Math.exp(lerp(Math.log(HERO_DIST), Math.log(OVER.dist), ease(ramp(t, 3.6, 6.6))));
  const k = (d - HERO_DIST) / (OVER.dist - HERO_DIST);
  const drift = t > 6.6 ? Math.sin((t - 6.6) * .05) * .3 : 0;
  return {
    x: lerp(RX[hs], OVER.x, k), y: lerp(RY[hs], OVER.y, k), z: lerp(RZ[hs], OVER.z, k),
    yaw: lerp(0, -.16, k) + drift, pitch: lerp(0, .24, k), dist: d,
  };
}
function setCam(c) { C = c; cY = Math.cos(c.yaw); sY = Math.sin(c.yaw); cP = Math.cos(c.pitch); sP = Math.sin(c.pitch); }
const P = { x: 0, y: 0, d: 0 };
function proj(x, y, z) {
  const dx = x - C.x, dy = y - C.y, dz = z - C.z;
  const xr = dx * cY - dz * sY, zr = dx * sY + dz * cY;
  const yr = dy * cP + zr * sP, z2 = -dy * sP + zr * cP;
  P.d = C.dist + z2;
  P.x = 960 + xr * F / P.d;
  P.y = 540 - yr * F / P.d;
}

// ---------- 画镜头卡：按目标宽高比从图集里居中裁切 ----------
function drawCard(n, x, y, w, h, a) {
  if (a < .01 || w < 1 || !ready(atlas)) return;
  sg.globalAlpha = a;
  if (n === heroCard && w > 240 && ready(feats[0])) {
    const im = feats[0], iw = im.naturalWidth, ih = im.naturalHeight;
    let sw = iw, sh = ih;
    if (w / h < iw / ih) sw = ih * w / h; else sh = iw * h / w;
    sg.drawImage(im, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
    return;
  }
  let sw = CARD_W, sh = CARD_H;
  if (w / h < CARD_W / CARD_H) sw = CARD_H * w / h; else sh = CARD_W * h / w;
  const col = n % D.atlas.cols, row = Math.floor(n / D.atlas.cols);
  const ox = (CELL_W - CARD_W) / 2, oy = (CELL_H - CARD_H) / 2;
  sg.drawImage(atlas, col * CELL_W + ox + (CARD_W - sw) / 2, row * CELL_H + oy + (CARD_H - sh) / 2, sw, sh, x, y, w, h);
}

// ---------- 星河整体状态 ----------
function starAlpha(t) {
  if (t < 3.6) return 0;
  if (t < 7.3) return .95 * ramp(t, 3.7, 4.8);
  if (t < 17) return .9;
  if (t < 28) return .7;
  return .85;
}
function aperture(t) {
  if (t < 7.3) return lerp(.35, 1, ramp(t, 5, 6.6));
  if (t < 17) return lerp(1, 10, ramp(t, 7.3, 8.4));
  if (t < 28) return lerp(10, 14, ramp(t, 17, 18));
  return 10;
}
function cardAlpha(t) {
  if (t < 7.3) return .95 * ramp(t, 3.8, 4.9);
  if (t < 17) return lerp(.95, .3, ramp(t, 7.3, 8.2));
  if (t < 28) return lerp(.3, .16, ramp(t, 17, 18));
  return .16 * (1 - ramp(t, 28, 28.6));
}

// 每帧星的屏幕位置，供 #fx 连线使用
const SX = new Float32Array(N), SY = new Float32Array(N), SA = new Float32Array(N);
const WR = .05;
const cardOrder = [...Array(NC).keys()];
const CX = new Float32Array(NC), CYs = new Float32Array(NC), CD = new Float32Array(NC);

// 剪枝层里一颗星的位置（写入 Q）
const Q = { x: 0, y: 0, r: 0, a: 0 };
function sheetStar(i, tt) {
  let x = L1X[i], y = L1Y[i], r = 1.3, a = .6;
  if (REC[i] >= 0) {
    const k = ease(ramp(tt, 30.9 + hash(i, 15) * .6, 31.7 + hash(i, 15) * .6));
    x = lerp(x, L2X[i], k); y = lerp(y, L2Y[i], k); r = lerp(r, 2.1, k); a = lerp(a, 1, k);
    a *= lerp(1, .35, ramp(tt, 36.1, 36.8));
    if (JUDGED_SHOT[i]) a *= 1 - ramp(tt, 33.3, 33.9);
  } else {
    a = lerp(a, .09, ramp(tt, 30.9, 31.6));
  }
  Q.x = x; Q.y = y; Q.r = r; Q.a = a;
}

function drawWorld(t) {
  setCam(camAt(t));
  const A = starAlpha(t), ap = aperture(t), focus = C.dist;
  const inSheet = t >= 28 && t < 43.4;
  const tt = Math.min(t, 41.99);

  // 星：先投影再按景深算弥散圈，越虚越暗，叠加发光
  sg.globalCompositeOperation = 'lighter';
  for (let i = 0; i < N; i++) {
    proj(RX[i], RY[i], RZ[i]);
    let x = P.x, y = P.y, r, a;
    if (P.d < .3) { r = 0; a = 0; } else {
      const size = WR * F / P.d;
      const coc = ap * Math.abs(P.d - focus) / P.d * 16;
      r = Math.min(34, Math.max(size, coc));
      a = A * Math.max(.07, Math.min(1, (size / r) * (size / r)));
      if (r > 8) { if (hash(i, 31) > .5) a = 0; else a *= 1.8; }
    }
    if (inSheet) {
      sheetStar(i, tt);
      const k = t < 42 ? ease(ramp(t, 28 + hash(i, 14) * .9, 28.9 + hash(i, 14) * .9)) : 1 - ease(ramp(t, 42, 43.4));
      x = lerp(x, Q.x, k); y = lerp(y, Q.y, k); r = lerp(r, Q.r, k); a = lerp(a, Q.a, k);
    }
    SX[i] = x; SY[i] = y; SA[i] = a;
    if (a < .004 || x < -40 || x > 1960 || y < -40 || y > 1120) continue;
    sg.globalAlpha = Math.min(1, a);
    sg.fillStyle = COL[i];
    if (r < 1.6) sg.fillRect(x - r, y - r, r * 2, r * 2);
    else { sg.beginPath(); sg.arc(x, y, r, 0, 6.2832); sg.fill(); }
  }
  // 第 5 幕：星河里不断有镜头被 Jev 问到，闪一下
  if (t > 43.2 && t < 54) {
    const b = Math.floor(t * 11.36);
    sg.fillStyle = '#ff5d8f';
    for (let i = 0; i < N; i++) if (hash(i, b) < .0025) {
      sg.globalAlpha = .5;
      sg.beginPath(); sg.arc(SX[i], SY[i], 5, 0, 6.2832); sg.fill();
    }
  }
  sg.globalCompositeOperation = 'source-over';

  // 星河里的镜头卡：远的先画
  const CA = cardAlpha(t);
  if (t < 28.6 && (CA > .01 || t < 3.9)) {
    for (let n = 0; n < NC; n++) {
      const s = D.cards[n].shot;
      proj(RX[s], RY[s], RZ[s]);
      CX[n] = P.x; CYs[n] = P.y; CD[n] = P.d;
    }
    cardOrder.sort((a, b) => CD[b] - CD[a]);
    for (const n of cardOrder) {
      const d = CD[n];
      if (d < .05) continue;
      const w = CW * F / d, h = w * 9 / 16;
      const coc = ap * Math.abs(d - focus) / d * 16;
      let a = (n === heroCard && t < 7.3 ? 1 : CA) / (1 + (coc / 4) * (coc / 4));
      if (t < 3.6 && n !== heroCard) a = 0;
      drawCard(n, CX[n] - w / 2, CYs[n] - h / 2, w, h, a);
    }
  }

  // 剪枝第 3、4 层：判别幸存的卡，最终 16 张落进时间轴
  if (t >= 33.3 && t < 42.8) {
    const out = 1 - ramp(t, 42, 42.8);
    for (const c of L3) {
      const s = D.cards[c.n].shot;
      const k = ease(ramp(t, 33.3 + c.j * .018, 34 + c.j * .018));
      let x = lerp(L2X[s] - 2, c.x, k), y = lerp(L2Y[s] - 1, c.y, k), w = lerp(4, c.w, k), h = lerp(2.25, c.h, k);
      let a = k * out;
      if (c.feat >= 0) {
        const q = CLIP[c.feat];
        const k2 = ease(ramp(t, 36.1 + c.feat * .05, 36.9 + c.feat * .05));
        x = lerp(x, q.x, k2); y = lerp(y, q.y, k2); w = lerp(w, q.w, k2); h = lerp(h, q.h, k2);
      } else {
        a *= lerp(1, .16, ramp(t, 36.1, 36.7));
      }
      drawCard(c.n, x, y, w, h, a);
    }
  }
  sg.globalAlpha = 1;
}

// ---------- #fx：各幕的线条层 ----------
function strokeLine(x1, y1, x2, y2) { fx.beginPath(); fx.moveTo(x1, y1); fx.lineTo(x2, y2); fx.stroke(); }
function envBars(x0, x1, yc, hmax, color, alpha, until = Infinity) {
  const step = (x1 - x0) / ENV.length;
  fx.fillStyle = color;
  for (let k = 0; k < ENV.length; k++) {
    const x = x0 + k * step;
    if (x > until) break;
    const h = 1.5 + ENV[k] * hmax;
    fx.globalAlpha = alpha;
    fx.fillRect(x, yc - h / 2, Math.max(1, step * .55), h);
  }
}

// 01：每一集的位置
function drawS1(t) {
  const a = ramp(t, 5.2, 6) * (1 - ramp(t, 6.9, 7.4));
  if (a <= 0) return;
  fx.font = '500 12px Inter, sans-serif';
  fx.letterSpacing = '3px';
  fx.textAlign = 'center';
  for (const ep in EPC) {
    const e = EPC[ep];
    proj(e[0] / e[3], e[1] / e[3] + 2.1, e[2] / e[3]);
    fx.globalAlpha = a * .7;
    fx.fillStyle = '#efe9e1';
    fx.fillText('EP ' + pad2(ep), P.x, P.y);
    fx.globalAlpha = a * .25;
    fx.fillRect(P.x - .5, P.y + 8, 1, 14);
  }
  fx.letterSpacing = '0px';
  fx.textAlign = 'left';
}

// 02：配乐走过每个重音，就向星河里上千个镜头发出一次询问
const WX0 = 140, WX1 = 1780, WY = 925;
const wx = time => WX0 + time / dur * (WX1 - WX0);
function drawS2(t) {
  const A = ramp(t, 7.9, 8.6) * (1 - ramp(t, 16.4, 17));
  if (A <= 0) return;
  const mt = ramp(t, 8.4, 16.4) * dur, px = wx(mt);
  envBars(WX0, WX1, WY, 46, '#efe9e1', .16 * A);
  envBars(WX0, WX1, WY, 46, '#efe9e1', .6 * A, px);
  fx.lineWidth = 1;
  for (let ai = 0; ai < ACC.length; ai++) {
    const x = wx(ACC[ai]), hit = mt >= ACC[ai];
    fx.globalAlpha = A * (hit ? .95 : .25);
    fx.strokeStyle = hit ? '#ff5d8f' : '#efe9e1';
    strokeLine(x + .5, 872, x + .5, 980);
    const age = t - (8.4 + ACC[ai] / dur * 8);
    if (age < 0 || age > .9) continue;
    const grow = ease(ramp(age, 0, .22)), fade = (1 - age / .9) * (1 - age / .9);
    fx.strokeStyle = '#ff5d8f';
    fx.fillStyle = '#ff5d8f';
    for (let j = 0; j < 40; j++) {
      const i = Math.floor(hash(ai * 97 + j, 41) * N);
      if (SX[i] < 0 || SX[i] > 1920 || SY[i] < 0 || SY[i] > 860) continue;
      const ex = lerp(x, SX[i], grow), ey = lerp(872, SY[i], grow);
      fx.globalAlpha = A * fade * .38;
      fx.beginPath(); fx.moveTo(x, 872); fx.quadraticCurveTo(x, lerp(872, ey, .6), ex, ey); fx.stroke();
      if (grow >= 1) {
        fx.globalAlpha = A * fade * .9;
        fx.beginPath(); fx.arc(SX[i], SY[i], 3, 0, 6.2832); fx.fill();
        fx.globalAlpha = A * fade * .18;
        fx.beginPath(); fx.arc(SX[i], SY[i], 11, 0, 6.2832); fx.fill();
      }
    }
  }
  fx.globalAlpha = A;
  fx.fillStyle = '#efe9e1';
  fx.fillRect(px - 1, 862, 2, 126);
  fx.globalAlpha = 1;
}

// 03：Jev 逐个把候选放进插入点问一遍
const RAG = [[8, .91], [1, .89], [13, .88], [10, .86], [5, .84]];
const POLL = [[19.6, 0, .12, '✗ 前一刀已是哭脸'], [20.2, 1, .08, '✗ 还是哭，情绪不推进'], [20.8, 2, .21, '✗ 太慢，压不住重音'], [21.4, 3, .94, '✓ 放入']];
function curPoll(t) { let c = null; for (const p of POLL) if (t >= p[0]) c = p; return c; }
function drawS3(t) {
  const p = curPoll(t);
  if (!p || t > 24.6 || t < 17) return;
  const [st, k, prob] = p;
  const ok = prob > .5;
  const age = t - st;
  const a = ok ? 1 - ramp(t, 23.6, 24.6) : 1 - ramp(age, .45, .6);
  if (a <= 0) return;
  const x0 = 772, y0 = 330 + k * 100, x1 = 900, y1 = 482;
  const pr = ease(ramp(age, 0, .22));
  fx.strokeStyle = ok ? '#ff5d8f' : '#efe9e1';
  fx.fillStyle = fx.strokeStyle;
  fx.lineWidth = ok ? 1.5 : 1;
  fx.globalAlpha = a * (ok ? .9 : .5);
  fx.beginPath();
  for (let s = 0; s <= 40; s++) {
    const u = s / 40 * pr, v = 1 - u;
    const bx = v * v * v * x0 + 3 * v * v * u * (x0 + 70) + 3 * v * u * u * (x1 - 70) + u * u * u * x1;
    const by = v * v * v * y0 + 3 * v * v * u * y0 + 3 * v * u * u * y1 + u * u * u * y1;
    s ? fx.lineTo(bx, by) : fx.moveTo(bx, by);
  }
  fx.stroke();
  fx.beginPath(); fx.arc(x0, y0, 3, 0, 6.2832); fx.fill();
  fx.globalAlpha = 1;
}

// 04：多级剪枝的线条层——大纲、参考线、时间轴、逐拍轮询
function drawS4(t) {
  const A = ramp(t, 28.6, 29.2) * (1 - ramp(t, 41.6, 42.3));
  if (A <= 0) return;
  const g0 = ramp(t, 29.4, 30.1) * A, rev = ease(ramp(t, 29.4, 30.6));
  // 乐句竖向参考线：每一层都对齐在同一条音乐时间上
  fx.fillStyle = '#efe9e1';
  for (const b of PH) { fx.globalAlpha = .07 * g0; fx.fillRect(tx(b), 214, 1, 670); }
  // L0 大模型写的情绪大纲
  envBars(X0, X1, 262, 22, '#c9a45c', .55 * g0, X0 + rev * XW);
  fx.font = '400 16px "PingFang SC", sans-serif';
  for (let p = 0; p < 6; p++) {
    const x = tx(PH[p]);
    if (x > X0 + rev * XW) break;
    fx.globalAlpha = g0 * .95;
    fx.fillStyle = '#c9a45c';
    fx.fillText(PH_NAME[p], x + 8, 232);
    fx.fillRect(x, 222, 2, 14);
  }
  // L4 时间轴：配乐包络、重音、空槽
  const g4 = ramp(t, 33.3, 33.9) * A;
  if (g4 > 0) {
    envBars(X0, X1, 790, 20, '#efe9e1', .2 * g4);
    fx.strokeStyle = '#efe9e1';
    fx.lineWidth = 1;
    for (const q of CLIP) { fx.globalAlpha = .12 * g4 * (1 - ramp(t, 36.8, 37.4)); fx.strokeRect(q.x + .5, q.y + .5, q.w - 1, q.h - 1); }
    fx.fillStyle = '#ff5d8f';
    for (const a of ACC) { fx.globalAlpha = .9 * g4; fx.fillRect(tx(a) - 1, 800, 2, 10); }
  }
  // 逐拍轮询：每个重音不停地问各张候选卡“放这里合适吗”
  const gb = ramp(t, 33.8, 34.2) * (1 - ramp(t, 35.6, 36.1)) * A;
  if (gb > 0) {
    const b = Math.floor(t * 16);
    fx.lineWidth = 1;
    for (let ai = 0; ai < ACC.length; ai++) for (let r = 0; r < 3; r++) {
      const c = L3[Math.floor(hash(ai * 13 + r * 7 + b, 51) * L3.length)];
      const hot = c.feat >= 0 && hash(ai + b, 53) < .5;
      fx.strokeStyle = hot ? '#ff5d8f' : '#efe9e1';
      fx.globalAlpha = gb * (hot ? .75 : .16);
      strokeLine(tx(ACC[ai]), 800, c.x + c.w / 2, c.y + c.h);
      if (hot) { fx.globalAlpha = gb; fx.strokeRect(c.x - 1.5, c.y - 1.5, c.w + 3, c.h + 3); }
    }
  }
  // 播放头扫过时间轴，每一刀依次落定
  const gp = ramp(t, 37.2, 37.5) * A;
  if (gp > 0) {
    const ph = ramp(t, 37.4, 41.4) * dur, x = tx(ph);
    fx.strokeStyle = '#ff5d8f';
    fx.lineWidth = 2;
    D.featured.forEach((f, m) => {
      const pass = 37.4 + cuts[m] / dur * 4;
      const age = t - pass;
      if (age < 0 || age > .6) return;
      const q = CLIP[m];
      fx.globalAlpha = gp * (1 - age / .6);
      fx.strokeRect(q.x - 1, q.y - 1, q.w + 2, q.h + 2);
    });
    fx.globalAlpha = gp * .9;
    fx.fillStyle = '#efe9e1';
    fx.fillRect(x - 1, 772, 2, 110);
  }
  fx.globalAlpha = 1;
}

// 05：大模型一条泳道，Jev 八条泳道，同样 10 秒各能问多少次
const LX0 = 140, PXS = 110, T5 = 43.2, LLM_Y = 256, JEV_Y = 470;
const CALLS = [[0, '听配乐 · 写大纲'], [1.8, '规划乐句 1–3'], [3.9, '重规划 · 乐句 4'], [5.6, '规划乐句 5'], [7.3, '重规划 · 乐句 6']];
const ESC = [3.9, 7.3];
let jevTotal = 0, llmTotal = 0;
function drawS5(t) {
  const A = ramp(t, 42.6, 43.2) * (1 - ramp(t, 53.6, 54.1));
  jevTotal = 0; llmTotal = 0;
  if (A <= 0) return;
  const now = clamp(t - T5, 0, 10);
  // 时间刻度
  fx.font = '400 12px "Source Code Pro", monospace';
  fx.fillStyle = '#efe9e1';
  for (let s = 0; s <= 10; s++) {
    const x = LX0 + s * PXS;
    fx.globalAlpha = .1 * A; fx.fillRect(x, 240, 1, 420);
    fx.globalAlpha = .35 * A; fx.fillText(s + 's', x + 4, 676);
  }
  // 大模型：逐字生成，一次一两秒
  fx.font = '400 13px "PingFang SC", sans-serif';
  for (const [s, label] of CALLS) {
    if (now < s) continue;
    llmTotal++;
    const x = LX0 + s * PXS, w = Math.min(now - s, 1.6) * PXS;
    fx.globalAlpha = A;
    fx.fillStyle = 'rgba(201,164,92,.12)';
    fx.strokeStyle = 'rgba(201,164,92,.7)';
    fx.lineWidth = 1;
    fx.beginPath(); fx.roundRect(x + .5, LLM_Y + .5, Math.max(w - 3, 2), 38, 19); fx.fill(); fx.stroke();
    fx.fillStyle = '#c9a45c';
    if (now - s < 1.6) {
      for (let d = 16; d < w - 12; d += 11) fx.fillRect(x + d, LLM_Y + 18, 3, 3);
    } else {
      fx.globalAlpha = A * ramp(now - s, 1.6, 1.9);
      fx.fillText(label, x + 16, LLM_Y + 24);
    }
  }
  // Jev：8 路并行，每 88 ms 一次，只读概率
  for (let l = 0; l < 8; l++) {
    const off = l * .011, y = JEV_Y + l * 22;
    fx.globalAlpha = .08 * A; fx.fillStyle = '#efe9e1'; fx.fillRect(LX0, y, 1100, 1);
    if (now < off) continue;
    const cnt = Math.floor((now - off) / .088) + 1;
    jevTotal += cnt;
    for (let k = 0; k < cnt; k++) {
      const rel = off + k * .088, x = LX0 + rel * PXS;
      const fresh = 1 + 1.5 * (1 - ramp(now - rel, 0, .3));
      if (hash(k * 8 + l, 21) < .12) {
        fx.fillStyle = '#ff5d8f'; fx.globalAlpha = Math.min(1, .8 * fresh) * A;
        fx.fillRect(x - .75, y - 7, 1.5, 14);
      } else {
        fx.fillStyle = '#efe9e1'; fx.globalAlpha = Math.min(1, .2 * fresh) * A;
        fx.fillRect(x - .5, y - 4, 1, 8);
      }
    }
  }
  // 拿不准：升级回大模型
  fx.font = '400 14px "PingFang SC", sans-serif';
  for (const e of ESC) {
    const age = now - e;
    if (age < 0) continue;
    const x = LX0 + e * PXS, k = ease(ramp(age, 0, .35));
    fx.strokeStyle = '#c9a45c'; fx.fillStyle = '#c9a45c';
    fx.globalAlpha = A * .9;
    fx.lineWidth = 1.5;
    fx.setLineDash([4, 4]);
    strokeLine(x, JEV_Y - 10, x, lerp(JEV_Y - 10, LLM_Y + 42, k));
    fx.setLineDash([]);
    fx.beginPath(); fx.arc(x, JEV_Y - 10, 3.5, 0, 6.2832); fx.fill();
    fx.globalAlpha = A * ramp(age, .2, .5) * .95;
    fx.fillText('拿不准 → 升级', x + 10, (JEV_Y + LLM_Y) / 2 + 10);
  }
  // 播放头
  const px = LX0 + now * PXS;
  fx.globalAlpha = A * .7; fx.fillStyle = '#efe9e1';
  fx.fillRect(px - .5, 240, 1, 400);
  fx.globalAlpha = 1;
}

// ---------- DOM ----------
const timed = [...document.querySelectorAll('[data-t]')].map(el => {
  const [a, b] = el.dataset.t.split(',').map(Number);
  return { el, a, b: Number.isFinite(b) ? b : Infinity, on: null };
});

const ragList = $('ragList');
const ragItems = RAG.map(([m, s], k) => {
  const f = D.featured[m];
  const li = document.createElement('li');
  li.innerHTML = `<span class="k">0${k + 1}</span><img src="${f.file}" alt=""><span class="t"></span><span class="s num">${s.toFixed(2)}</span>`;
  li.querySelector('.t').textContent = f.desc;
  ragList.appendChild(li);
  return li;
});
const slotFrame = $('slotFrame'), whiteout = $('whiteout'), pread = $('pread');
const preadB = pread.querySelector('b'), preadI = pread.querySelector('i');
const packRows = [...document.querySelectorAll('#pack .row')];

const montage = $('montage');
const mImg = document.createElement('img');
mImg.alt = '';
montage.appendChild(mImg);
const flash = $('flash'), bars = $('bars'), mtL = $('mtL'), mtR = $('mtR'), mtTrack = $('mtTrack');
const trackSegs = D.featured.map((f, m) => {
  const i = document.createElement('i');
  i.style.flex = `${cuts[m + 1] - cuts[m]} 0 0`;
  mtTrack.appendChild(i);
  return i;
});
const S1CUTS = [[.35, 1], [.95, 5], [1.45, 9], [1.85, 11], [2.2, 12], [2.5, 13], [2.75, 3], [2.98, 0]];
const S6CUTS = D.featured.map((f, m) => [54.2 + cuts[m] / dur * 3, m]);

const bigCount = $('bigCount'), llmCount = $('llmCount'), jevCount = $('jevCount');
const s1Scrim = document.querySelector('.s1 .scrim');
const sceneNo = $('sceneNo'), sceneName = $('sceneName'), tcEl = $('tc');
const notesEl = $('notes'), bar = $('bar');
SCENES.forEach(([s]) => { const i = document.createElement('i'); i.style.left = `${(s - T0) / (TOTAL - T0) * 100}%`; $('ticks').appendChild(i); });

const cache = {};
function setText(el, key, v) { if (cache[key] !== v) { cache[key] = v; el.textContent = v; } }
function setStyle(el, key, prop, v) { if (cache[key] !== v) { cache[key] = v; el.style[prop] = v; } }
function setClass(el, key, cls, v) { if (cache[key] !== v) { cache[key] = v; el.classList.toggle(cls, v); } }

function updateMontage(t) {
  let seq = null;
  if (t >= 0 && t < 3.9) seq = S1CUTS;
  else if (t >= 54) seq = S6CUTS;
  let idx = 0, ct = -9, n = 0;
  if (seq) for (const [a, m] of seq) if (t >= a) { idx = m; ct = a; n++; }
  // 结尾定格换成"焰持盾立于废墟"那一镜，替换原来的圆神拥抱镜头
  const END_IDX = 9;
  if (t >= 57.1) idx = END_IDX;
  const op = t < .32 ? 0 : t < 3.9 ? 1 - ramp(t, 3.6, 3.9) : t >= 54 ? 1 : 0;
  setStyle(montage, 'mop', 'opacity', op.toFixed(3));
  if (op > 0) {
    const f = D.featured[idx];
    if (cache.msrc !== f.file) { cache.msrc = f.file; mImg.src = f.file; }
    let sc = 1 + .05 * (1 - ease(ramp(t, ct, ct + .5)));
    let filter = 'none';
    if (t >= 57.1) { sc = 1 + .07 * ramp(t, 57.2, 61); filter = `blur(${(5 * ramp(t, 57.1, 58)).toFixed(2)}px)`; }
    mImg.style.transform = `scale(${sc.toFixed(4)})`;
    setStyle(mImg, 'mflt', 'filter', filter);
    const s6 = t >= 54;
    setText(mtL, 'mtL', `EP ${pad2(f.episode)}   ·   SHOT ${f.shot}   ·   ${f.desc}`);
    setText(mtR, 'mtR', s6 ? `♪ ${(ramp(t, 54.2, 57.2) * dur).toFixed(2)} / ${dur.toFixed(2)}` : `CUT ${pad2(n)} / 08`);
    setClass(mtTrack, 'trk', 'on', s6);
    if (s6) trackSegs.forEach((seg, m) => {
      setClass(seg, 'd' + m, 'done', m < idx || t >= 57.2);
      setClass(seg, 'c' + m, 'cur', m === idx && t < 57.2);
    });
  }
  setClass(bars, 'bars', 'on', (t >= .35 && t < 3.6) || (t >= 54 && t < 57.2));
  let fl = ct > 0 && t < 57.3 ? .5 * (1 - ramp(t, ct, ct + .16)) : 0;
  if (t >= 54) fl = Math.max(fl, 1 - ramp(t, 54, 54.45));
  setStyle(flash, 'fl', 'opacity', fl.toFixed(3));
}

function updateS3(t) {
  const p = curPoll(t);
  ragItems.forEach((li, k) => {
    setClass(li, 'ron' + k, 'on', t >= 17.6 + k * .12);
    setClass(li, 'rej' + k, 'rej', k < 3 && t >= POLL[k][0] + .45);
    setClass(li, 'ok' + k, 'ok', k === 3 && t >= 21.85);
  });
  if (p) {
    const [st, k, prob, why] = p;
    const f = D.featured[RAG[k][0]];
    setStyle(slotFrame, 'sbg', 'backgroundImage', `url("${f.file}")`);
    const age = t - st, done = age >= .35;
    setText(preadB, 'pb', (prob * ease(ramp(age, 0, .35))).toFixed(2));
    setText(preadI, 'pi', done ? why : '');
    setClass(pread, 'pno', 'no', done && prob < .5);
    setClass(pread, 'pyes', 'yes', done && prob >= .5);
  } else {
    setStyle(slotFrame, 'sbg', 'backgroundImage', 'none');
  }
  setClass(pread, 'pon', 'on', !!p);
  const g = ramp(t, 21.75, 22.2);
  setStyle(slotFrame, 'sflt', 'filter', g > 0 ? `saturate(${lerp(1, .72, g).toFixed(3)}) hue-rotate(${(-10 * g).toFixed(2)}deg) contrast(${lerp(1, 1.06, g).toFixed(3)})` : 'none');
  slotFrame.style.transform = `scale(${lerp(1, 1.06, ease(ramp(t, 21.75, 25))).toFixed(4)})`;
  setStyle(whiteout, 'wo', 'opacity', (ramp(t, 21.62, 21.75) * (1 - ramp(t, 21.75, 22.15))).toFixed(3));
  packRows.forEach((r, k) => setClass(r, 'pk' + k, 'on', t >= 21.9 + k * .13));
}

// ---------- 00 前情提要 ----------
const wall = $('wall'), pImg = $('pImg'), pFlash = $('pFlash'), pTag = $('pTag'), pLike = $('pLike');
// 手机里的快剪：前两段是人工反复筛，后两段是 Jev 按情绪挑出的一刀
const PH_SEQ = [0, 7, 3, 10, 1, 12, 5, 9, 2, 6, 14, 4];
const PH_WHY = ['✓ 情绪推进：对峙 → 爆发', '✓ 接上一刀的眼神', '✓ 压住重音', '✓ 故事线：守护'];
const phone = $('phone');
function updateS0(t) {
  const a = 1 - ramp(t, -.5, 0);
  // 封面时素材墙压暗一些，前情提要再提亮
  setStyle(wall, 'wop', 'opacity', (a * lerp(.3, .55, ramp(t, -20.4, -19.6))).toFixed(3));
  if (a > 0) wall.style.backgroundPosition = `${(-(t - T0) * 18).toFixed(1)}px ${(-(t - T0) * 6).toFixed(1)}px`;
  // 进入第一幕：手机放大成全屏，画面与快切的第一刀同一帧，衔接无缝
  const ex = ease(ramp(t, 0, .32));
  setClass(phone, 'pex', 'ex', t >= 0);
  setClass(phone, 'pgone', 'gone', t >= .34);
  if (t >= 0 && t < .34) {
    phone.style.left = `${lerp(1282, 0, ex).toFixed(1)}px`;
    phone.style.top = `${lerp(150, 0, ex).toFixed(1)}px`;
    phone.style.width = `${lerp(428, 1920, ex).toFixed(1)}px`;
    phone.style.height = `${lerp(760, 1080, ex).toFixed(1)}px`;
    phone.style.borderRadius = `${lerp(46, 0, ex).toFixed(1)}px`;
  } else if (phone.style.left) {
    phone.style.left = phone.style.top = phone.style.width = phone.style.height = phone.style.borderRadius = '';
  }
  if (t < -15 || t >= .34) return;
  const beat = (t + 15) / .5, k = Math.floor(beat);
  // 前情最后一拍起定格在第一幕开场镜头上，放大时接得上
  const f = D.featured[t >= -1.4 ? 0 : PH_SEQ[k % PH_SEQ.length]];
  if (cache.psrc !== f.file) { cache.psrc = f.file; pImg.src = f.file; }
  pImg.style.transform = `scale(${(t >= -1.4 ? 1 : 1.08 - .06 * ease(beat - k)).toFixed(4)})`;
  setStyle(pFlash, 'pfl', 'opacity', t >= -1.4 ? '0' : ((1 - ramp(beat - k, 0, .3)) * .35).toFixed(3));
  setText(pLike, 'plk', (Math.min(32.6, 1.2 + (t + 15) * 2.4)).toFixed(1) + 'w');
  setText(pTag, 'ptg', t >= -10 && t < -1.4 ? PH_WHY[Math.floor((t + 10) / 1.25) % PH_WHY.length] : '');
}

function updateDom(t) {
  for (const x of timed) {
    const on = t >= x.a && t < x.b;
    if (on !== x.on) { x.on = on; x.el.classList.toggle('on', on); }
  }
  updateMontage(t);
  updateS0(t);
  setStyle(s1Scrim, 's1s', 'opacity', ramp(t, 4, 5).toFixed(3));
  setText(bigCount, 'big', fmt(4575 * 120 * 6 * ease(ramp(t, 8.8, 11.5))));
  updateS3(t);
  setText(llmCount, 'llm', String(llmTotal));
  setText(jevCount, 'jev', fmt(jevTotal));

  let sc = 0;
  SCENES.forEach(([s], k) => { if (t >= s) sc = k; });
  setText(sceneNo, 'sno', pad2(sc + 1));
  setText(sceneName, 'snm', SCENES[sc][1]);
  setText(notesEl, 'note', NOTES[sc]);
  const fr = Math.floor((t - T0) * 24);
  setText(tcEl, 'tc', `00:${pad2(fr / 1440)}:${pad2(fr / 24 % 60)}:${pad2(fr % 24)}`);
  setStyle(bar, 'bar', 'width', `${((t - T0) / (TOTAL - T0) * 100).toFixed(2)}%`);
}

// ---------- 主循环 ----------
let t = T0, playing = false, last = 0, dpr = 1;

function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  dpr = Math.min(2, (window.devicePixelRatio || 1) * s);
  for (const c of [$('gl'), $('fx')]) { c.width = Math.round(1920 * dpr); c.height = Math.round(1080 * dpr); }
}

function render() {
  for (const c of [sg, fx]) { c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, 1920, 1080); c.globalAlpha = 1; }
  if (t >= 3.5 && t < 54.5) drawWorld(t);
  setCam(camAt(t));
  drawS1(t);
  drawS2(t);
  drawS3(t);
  drawS4(t);
  drawS5(t);
  updateDom(t);
}

function frame(now) {
  if (playing) {
    t = Math.min(TOTAL, t + Math.min(.1, (now - last) / 1000) * SPEED);
    if (t >= TOTAL) setPlaying(false);
    // 幻灯片模式：播到本幕末尾就停住，等下一次按箭头
    if (stopAt !== null && t >= stopAt) { t = stopAt; stopAt = null; setPlaying(false); }
  }
  last = now;
  render();
  requestAnimationFrame(frame);
}

function setPlaying(v) { playing = v; stage.classList.toggle('playing', v); }
function seek(v) { t = clamp(v, T0, TOTAL); }
const starts = SCENES.map(s => s[0]);
let stopAt = null;
// 当前所在幕的序号，以及该幕结尾定格时刻
function sceneIndex(v) { let i = 0; starts.forEach((s, k) => { if (v >= s - .01) i = k; }); return i; }
function sceneEnd(i) { return (i + 1 < starts.length ? starts[i + 1] : TOTAL) - .05; }

// 跳到某一幕开头，只播这一幕，播完停在最后一帧
function playScene(start) {
  if (start >= TOTAL) return;
  const i = starts.indexOf(start);
  const end = i >= 0 && i + 1 < starts.length ? starts[i + 1] : TOTAL;
  seek(start);
  stopAt = end - .05;
  setPlaying(true);
}

addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); stopAt = null; if (t >= TOTAL) seek(T0); setPlaying(!playing); }
  else if (e.code === 'ArrowRight') {
    // →：本幕动画没播完就直接跳到本幕结尾定格；已在结尾则播下一幕
    e.preventDefault();
    const i = sceneIndex(t), end = sceneEnd(i);
    if (!playing && t <= starts[i] + .02) playScene(starts[i]);
    else if (t < end - .02) { stopAt = null; seek(end); setPlaying(false); }
    else playScene(starts[i + 1] ?? TOTAL);
  }
  else if (e.code === 'ArrowLeft') {
    // ←：直接回到上一幕的结尾定格，连续按可以一路往回翻
    e.preventDefault();
    const i = sceneIndex(t);
    stopAt = null; setPlaying(false);
    seek(i > 0 ? sceneEnd(i - 1) : starts[0]);
  }
  else if (e.code === 'KeyR') { stopAt = null; seek(T0); setPlaying(true); }
  else if (e.code === 'KeyN') stage.classList.toggle('show-notes');
  else if (e.code === 'KeyF') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});
$('progress').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  seek(T0 + (e.clientX - r.left) / r.width * (TOTAL - T0));
});

addEventListener('resize', fit);
fit();
const q = new URLSearchParams(location.search);
if (q.has('t')) seek(+q.get('t'));
if (q.has('auto')) setPlaying(true);
requestAnimationFrame(frame);
