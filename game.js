// 게임 로직: DUEL(패링 후 베기) / SLICE(날아오는 오브젝트 베기)
import { sweepHitsCircle, segSegDist, angleDiff180, lerpPt, dist, norm } from './sword.js';
import { PAL, glow } from './palette.js';

export const GAME_CONFIG = {
  slice: {
    duration: 60,
    spawn: { EASY: [0.9, 1.3], NORMAL: [0.65, 1.0], HARD: [0.45, 0.75] },
    bombChance: { EASY: 0.08, NORMAL: 0.12, HARD: 0.18 },
    gravity: 1.25,   // 화면 높이/초²
    radius: 0.055,   // 화면 짧은 변 비율
    points: 10,
    bombPenalty: 30,
  },
  duel: {
    telegraph: { EASY: 1400, NORMAL: 1100, HARD: 800 }, // 공격 예고 시간(ms)
    roundSpeedup: 0.88,  // 라운드마다 예고 시간 배수
    chainSpeedup: 0.85,  // 연속 공격의 두 번째부터
    idle: [0.7, 1.4],    // 공격 사이 대기(초)
    chainMax: [3, 4, 5], // 라운드별 최대 연속 공격 수 (모멘텀이 높을수록 길어짐)
    chainGap: 220,
    staggerMs: 1700,
    vitalAngle: 55,
    thrustChance: 0.25,  // 급소가 '찌르기 급소'로 뜰 확률
    thrustRadius: 0.75,  // 찌르기 급소 판정 반경 (급소 원 반지름 비율)      // 급소 방향 허용 오차(°): 휘두르는 방향이 이 안에 들어야 적중
    weakDamage: 14,
    weakExtendMs: 250,   // 급소 적중 시 비틀거림 연장
    // 모멘텀(0~1): 높을수록 적 공격이 빠르고 길게 이어짐
    momentum: { start: 0.6, min: 0.15, max: 1, hit: 0.1, comboBonus: 0.03, parry: 0.03, hurt: 0.2, regen: 0.02 },
    parryAngle: 45,      // 칼 각도 허용 오차(°) — 대략 같은 방향이면 OK
    parryDist: 0.14,     // 칼과 예고선 거리 허용(화면 대각선 비율)
    parryBefore: 500,    // 충돌 시점 전후 판정 창(ms) — 일찍 갖다 대도 인정
    parryAfter: 150,
    parryStillOk: true,  // 휘두르는 중(SLASH)이어도 선을 지나가면 막기 인정
    playerDamage: { EASY: 12, NORMAL: 18, HARD: 25 },
    hitCooldown: 160,
    winsNeeded: 2,
  },
  hitstop: { slice: 55, parry: 95, hit: 75, bomb: 140, hurt: 120, block: 40 },
};

export const LEVELS = ['EASY', 'NORMAL', 'HARD'];
const rand = (a, b) => a + Math.random() * (b - a);
const SHAPES = ['circle', 'square', 'triangle', 'hexagon', 'diamond'];
// 피오라식 급소: 위·좌·우 3방향 중 하나 (아래에서 올려베기는 손목만 꺾게 되어 부자연스러워 제외). 그 방향에서 '안쪽으로' 휘둘러야 적중
// dir = 필요한 휘두르기 방향(화면 좌표), arc = 표시할 쪽 (캔버스 각도, 0 = 오른쪽)
const VITALS = {
  UP: { dir: { x: 0, y: 1 }, arc: -Math.PI / 2, label: 'SLASH DOWN' },
  LEFT: { dir: { x: 1, y: 0 }, arc: Math.PI, label: 'SLASH RIGHT' },
  RIGHT: { dir: { x: -1, y: 0 }, arc: 0, label: 'SLASH LEFT' },
  THRUST: { thrust: true, label: 'THRUST' }, // 찌르기 급소: 원 중앙을 찔러야 적중
};

function loadBest() {
  try { return JSON.parse(localStorage.getItem('airduel.best')) || {}; } catch { return {}; }
}
function saveBest(best) {
  try { localStorage.setItem('airduel.best', JSON.stringify(best)); } catch {}
}

// ---------- 이펙트 ----------
// 색 인자를 생략하면 먹색 (한지 바탕 위)
const WHITE = PAL.ink;
const easeOut = (k) => 1 - Math.pow(1 - k, 3);

export class FX {
  constructor() { this.clear(); }
  clear() {
    this.parts = []; this.rings = []; this.cracks = [];
    this.slashes = []; this.beams = []; this.shields = [];
    this.flash = 0; this.flashColor = WHITE; this.shake = 0; this.hitstop = 0;
  }
  sparks(x, y, n, speed, dirAngle = null, spread = Math.PI * 2, color = WHITE) {
    for (let i = 0; i < n; i++) {
      const a = dirAngle === null ? Math.random() * Math.PI * 2 : dirAngle + (Math.random() - 0.5) * spread;
      const v = speed * rand(0.35, 1);
      const life = rand(0.25, 0.55);
      this.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, w: rand(1.2, 2.8), color });
    }
  }
  ring(x, y, r0, r1, life = 0.35, width = 3, color = WHITE) { this.rings.push({ x, y, r0, r1, life, max: life, width, color }); }
  crack(x, y, size, color = WHITE) {
    const lines = [];
    const n = 7;
    for (let i = 0; i < n; i++) {
      let a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3);
      let p = { x, y };
      const pts = [p];
      const steps = 4;
      for (let s = 0; s < steps; s++) {
        a += rand(-0.45, 0.45);
        const l = (size / steps) * rand(0.6, 1.3);
        p = { x: p.x + Math.cos(a) * l, y: p.y + Math.sin(a) * l };
        pts.push(p);
      }
      lines.push(pts);
    }
    this.cracks.push({ lines, life: 0.8, max: 0.8, color });
  }
  // 베기: 휘두른 방향으로 휘어진 초승달 궤적
  slash(x, y, angle, length, color = WHITE, life = 0.32) {
    this.slashes.push({ x, y, angle, length, color, life, max: life, bend: Math.random() < 0.5 ? 1 : -1 });
  }
  // 찌르기: 칼끝에서 곧게 뻗는 빛줄기 + 겹쳐 퍼지는 링
  thrust(base, tip, length, color = WHITE) {
    const d = Math.atan2(tip.y - base.y, tip.x - base.x);
    this.beams.push({ x: tip.x, y: tip.y, angle: d, length, color, life: 0.28, max: 0.28 });
    this.ring(tip.x, tip.y, 4, length * 0.32, 0.3, 4, color);
    this.ring(tip.x, tip.y, 2, length * 0.18, 0.42, 3, color);
  }
  // 막기: 먹물이 튄 자국 (가시 모양은 만들 때 한 번만 정함)
  shield(x, y, r, color = WHITE, life = 0.42) {
    const n = 11, spikes = [];
    for (let i = 0; i < n; i++) spikes.push({ a: (i / n) * Math.PI * 2 + rand(-0.2, 0.2), l: rand(0.55, 1.35), w: rand(0.1, 0.22) });
    const drops = [];
    for (let i = 0; i < 6; i++) drops.push({ a: rand(0, Math.PI * 2), d: rand(1.25, 1.9), r: rand(0.05, 0.11) });
    this.shields.push({ x, y, r, color, life, max: life, spikes, drops });
  }
  stop(ms) { this.hitstop = Math.max(this.hitstop, ms); }
  kick(px) { this.shake = Math.max(this.shake, px); }

  update(simDt, realDt) {
    for (const p of this.parts) {
      p.x += p.vx * simDt; p.y += p.vy * simDt;
      const drag = Math.exp(-simDt * 4);
      p.vx *= drag; p.vy *= drag;
      p.life -= simDt;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const r of this.rings) r.life -= simDt;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const c of this.cracks) c.life -= realDt;
    this.cracks = this.cracks.filter((c) => c.life > 0);
    // 새 이펙트는 실제 시간으로: 히트스톱 중에도 펼쳐져 보이게
    for (const list of [this.slashes, this.beams, this.shields]) for (const o of list) o.life -= realDt;
    this.slashes = this.slashes.filter((o) => o.life > 0);
    this.beams = this.beams.filter((o) => o.life > 0);
    this.shields = this.shields.filter((o) => o.life > 0);
    this.flash = Math.max(0, this.flash - realDt * 2.8);
    if (this.flash === 0) this.flashColor = WHITE;
    this.shake *= Math.exp(-realDt * 11);
    if (this.shake < 0.3) this.shake = 0;
  }

  // 베기: 붓으로 휙 그은 획 — 한쪽은 굵게 눌렀다가 끝으로 갈수록 가늘게, 옆에 갈라진 붓털 자국
  renderSlash(ctx, o) {
    const k = 1 - o.life / o.max;
    const grow = easeOut(Math.min(1, k / 0.3));
    const fade = 1 - Math.max(0, (k - 0.3) / 0.7);
    const L = o.length * (0.35 + 0.65 * grow);
    const bulge = o.length * 0.14 * o.bend;
    const w = o.length * 0.075;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.angle);
    ctx.globalAlpha *= fade;
    ctx.fillStyle = `rgb(${o.color})`;
    // 시작(-L/2)은 굵고 끝(L/2)은 뾰족한 획
    ctx.beginPath();
    ctx.moveTo(-L / 2, -w * 0.2);
    ctx.quadraticCurveTo(-L * 0.15, bulge * 2 - w * o.bend, L / 2, 0);
    ctx.quadraticCurveTo(-L * 0.1, bulge * 2 + w * 0.15 * o.bend, -L / 2, w * 0.6);
    ctx.closePath();
    ctx.fill();
    // 갈라진 붓털 자국 두 줄
    ctx.strokeStyle = `rgb(${o.color})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const off of [1.35, 1.7]) {
      ctx.moveTo(-L * 0.42, w * 0.1 * off);
      ctx.quadraticCurveTo(-L * 0.05, bulge * 2 + w * off * 0.6 * o.bend, L * 0.3, w * 0.15);
    }
    ctx.stroke();
    ctx.restore();
  }

  // 찌르기: 곧은 먹선 + 엔소(붓으로 한 번에 그린 원) — 원은 한쪽이 열려 있고 굵기가 변함
  renderBeam(ctx, o) {
    const k = 1 - o.life / o.max;
    const reach = easeOut(Math.min(1, k / 0.35));
    const fade = 1 - Math.max(0, (k - 0.35) / 0.65);
    const L = o.length * reach;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.angle);
    ctx.globalAlpha *= fade;
    ctx.fillStyle = `rgb(${o.color})`;
    const w = o.length * 0.05;
    ctx.beginPath();
    ctx.moveTo(-w, -w * 0.5); ctx.lineTo(L, 0); ctx.lineTo(-w, w * 0.5);
    ctx.closePath();
    ctx.fill();
    // 엔소: 굵기가 다른 호 세 개를 이어 그려 붓 원 느낌 (열린 부분은 찌른 방향 반대쪽)
    const R = o.length * 0.22 * (0.7 + 0.3 * reach);
    const sweep = Math.PI * 1.75 * reach;
    ctx.strokeStyle = `rgb(${o.color})`;
    ctx.lineCap = 'round';
    const seg = sweep / 3;
    [0.09, 0.06, 0.03].forEach((lw, i) => {
      ctx.lineWidth = o.length * lw * 0.5;
      ctx.beginPath();
      ctx.arc(L * 0.15, 0, R, Math.PI * 0.6 + seg * i, Math.PI * 0.6 + seg * (i + 1));
      ctx.stroke();
    });
    ctx.restore();
  }

  // 막기·튕김: 먹물 튐 — 가운데 덩어리 + 가시 + 흩어진 방울
  renderShield(ctx, o) {
    const k = 1 - o.life / o.max;
    const sc = 0.6 + 0.5 * easeOut(Math.min(1, k / 0.25));
    const fade = k < 0.35 ? 1 : 1 - (k - 0.35) / 0.65;
    const r = o.r * sc;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.globalAlpha *= fade;
    ctx.fillStyle = `rgb(${o.color})`;
    ctx.beginPath();
    o.spikes.forEach((sp, i) => {
      const a0 = sp.a - sp.w, a1 = sp.a + sp.w;
      const p0 = { x: Math.cos(a0) * r * 0.45, y: Math.sin(a0) * r * 0.45 };
      const tip = { x: Math.cos(sp.a) * r * sp.l, y: Math.sin(sp.a) * r * sp.l };
      const p1 = { x: Math.cos(a1) * r * 0.45, y: Math.sin(a1) * r * 0.45 };
      i ? ctx.lineTo(p0.x, p0.y) : ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(p1.x, p1.y);
    });
    ctx.closePath();
    ctx.fill();
    for (const d of o.drops) {
      ctx.beginPath();
      ctx.arc(Math.cos(d.a) * r * d.d, Math.sin(d.a) * r * d.d, r * d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  render(ctx, view) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const o of this.shields) this.renderShield(ctx, o);
    for (const o of this.slashes) this.renderSlash(ctx, o);
    for (const o of this.beams) this.renderBeam(ctx, o);
    for (const p of this.parts) {
      const k = p.life / p.max;
      ctx.strokeStyle = `rgba(${p.color},${k})`;
      ctx.lineWidth = p.w * 1.4;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
      ctx.stroke();
    }
    for (const r of this.rings) {
      const k = 1 - r.life / r.max;
      ctx.strokeStyle = `rgba(${r.color},${1 - k})`;
      ctx.lineWidth = r.width * (1 - k) + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const c of this.cracks) {
      const k = c.life / c.max;
      ctx.strokeStyle = `rgba(${c.color},${0.9 * k})`;
      ctx.lineWidth = 2.2;
      for (const pts of c.lines) {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      }
    }
    ctx.restore();
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(${this.flashColor},${this.flash * 0.22})`;
      ctx.fillRect(-50, -50, view.W + 100, view.H + 100);
    }
  }
}

function shapePath(ctx, shape, r) {
  ctx.beginPath();
  if (shape === 'circle') { ctx.arc(0, 0, r, 0, Math.PI * 2); return; }
  const poly = (n, rot = 0, rr = r) => {
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
  };
  if (shape === 'square') poly(4, Math.PI / 4, r * 1.15);
  else if (shape === 'triangle') poly(3, -Math.PI / 2, r * 1.2);
  else if (shape === 'hexagon') poly(6, 0);
  else if (shape === 'diamond') poly(4, 0, r * 1.15);
}

function drawObject(ctx, o) {
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(o.rot);
  shapePath(ctx, o.bomb ? 'circle' : o.shape, o.r);
  ctx.fillStyle = o.bomb ? `rgb(${PAL.ink})` : `rgba(${PAL.ink},0.12)`;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgb(${PAL.ink})`;
  ctx.stroke();
  if (o.bomb) {
    const k = o.r * 0.38;
    ctx.lineWidth = 4;
    ctx.strokeStyle = `rgb(${PAL.enemy})`;
    ctx.beginPath();
    ctx.moveTo(-k, -k); ctx.lineTo(k, k);
    ctx.moveTo(k, -k); ctx.lineTo(-k, k);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- 사무라이 ----------
// 수묵화풍 실루엣: 먹색 면 두 톤(빛 받는 쪽 / 그늘) + 주홍 포인트. 그라데이션·발광 없이 평평한 면만 쓴다.
const SAM = {
  ink: [24, 21, 23],       // 그늘 면
  inkLit: [52, 46, 49],    // 빛 받는 면
  red: [200, 52, 38],      // 주홍 포인트 (끈, 띠, 칼끈)
};
// [r,g,b]를 to 쪽으로 k만큼 섞어 css 색으로 — 피격 섬광(주홍으로 물듦)
const mix = (c, to, k) => `rgb(${c.map((v, i) => Math.round(v + (to[i] - v) * k)).join(',')})`;

// 상대 검객: geo = { s, ex, ey }, blade = { a: 칼자루, b: 칼끝 } (화면 좌표)
// opts: alpha, tilt(발 기준 회전), flash(피격 0~1)
// 비율: 삿갓 꼭대기 -0.585 ~ 발 0.45 (키 대비 작은 머리, 넓은 삿갓, 길게 떨어지는 옷자락)
export function drawFigure(ctx, geo, blade, { alpha = 1, tilt = 0, flash = 0 } = {}) {
  const { s, ex, ey } = geo;
  const P = (x, y) => ({ x: ex + x * s, y: ey + y * s });
  const t = performance.now() / 1000;
  const fk = Math.min(1, flash) * 0.8;
  const ink = mix(SAM.ink, SAM.red, fk), lit = mix(SAM.inkLit, SAM.red, fk);
  const red = `rgb(${SAM.red.join(',')})`;
  const poly = (pts, fill) => {
    ctx.beginPath();
    pts.forEach((q, i) => { const p = q.x !== undefined ? q : P(q[0], q[1]); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  // 끝이 가늘어지는 띠 (바람에 날리는 천)
  const ribbon = (x0, y0, len, w, dir, ph, fill) => {
    const top = [], bot = [];
    for (let i = 0; i <= 8; i++) {
      const u = i / 8;
      const x = x0 + dir * u * len;
      const y = y0 + u * len * 0.18 + Math.sin(t * 4 - u * 4 + ph) * 0.025 * u;
      const ww = w * (1 - u * 0.85);
      top.push([x, y - ww]); bot.unshift([x, y + ww]);
    }
    poly([...top, ...bot], fill);
  };

  ctx.save();
  ctx.globalAlpha = alpha;

  // 땅선: 발밑에서 양옆으로 가늘어지는 붓 획 (기울어도 땅은 그대로)
  poly([[-0.62, 0.452], [-0.1, 0.44], [0.12, 0.438], [0.64, 0.455], [0.12, 0.462], [-0.1, 0.466]], `rgba(${SAM.ink.join(',')},0.85)`);

  if (tilt) {
    const foot = P(0, 0.45);
    ctx.translate(foot.x, foot.y);
    ctx.rotate(tilt);
    ctx.translate(-foot.x, -foot.y);
  }

  // 등 뒤로 날리는 주홍 끈 두 가닥 + 먹색 천
  ribbon(-0.03, -0.36, 0.34, 0.018, -1, 0, ink);
  ribbon(-0.02, -0.03, 0.26, 0.014, -1, 1.3, red);
  ribbon(0.02, -0.02, 0.2, 0.011, -1, 2.4, red);

  // 허리에 찬 칼집: 뒤로 비스듬히
  poly([[-0.03, -0.02], [-0.02, 0.0], [-0.44, 0.2], [-0.455, 0.185]], ink);
  poly([[-0.1, 0.017], [-0.09, 0.032], [-0.12, 0.046], [-0.13, 0.031]], red);

  // 발
  poly([[-0.1, 0.415], [-0.045, 0.415], [-0.04, 0.45], [-0.12, 0.45]], ink);
  poly([[0.05, 0.415], [0.105, 0.415], [0.125, 0.45], [0.045, 0.45]], ink);

  // 몸: 각진 어깨(카타기누) → 허리 → 넓게 퍼지는 하카마. 밑단은 바람에 살짝 날림
  const hem = (x) => 0.415 + Math.sin(t * 2.6 + x * 14) * 0.008;
  const body = [
    [-0.035, -0.375], [0.035, -0.375],
    [0.175, -0.345], [0.15, -0.3], [0.1, -0.29],
    [0.098, -0.02], [0.165, 0.33], [0.18, hem(0.18)], [0.05, hem(0.05)], [0.012, 0.24],
    [-0.012, 0.24], [-0.05, hem(-0.05)], [-0.18, hem(-0.18)], [-0.2, 0.36], [-0.098, -0.02],
    [-0.1, -0.29], [-0.15, -0.3], [-0.175, -0.345],
  ];
  poly(body, ink);
  // 빛 받는 면: 왼쪽 몸판과 왼쪽 하카마
  poly([[-0.035, -0.375], [-0.175, -0.345], [-0.15, -0.3], [-0.1, -0.29], [-0.098, -0.02], [-0.2, 0.36], [-0.18, hem(-0.18)], [-0.11, hem(-0.11)], [-0.04, -0.02], [-0.02, -0.3]], lit);
  // 허리띠 (주홍)
  poly([[-0.1, -0.035], [0.1, -0.035], [0.1, -0.008], [-0.1, -0.008]], red);
  // 깃: V자 (그늘 쪽 먹으로 그어 형태를 읽히게)
  poly([[-0.035, -0.375], [0.035, -0.375], [0.004, -0.29]], `rgb(${SAM.inkLit.map((v) => v + 30).join(',')})`);

  // 얼굴: 삿갓 그늘 속, 주홍 눈빛 한 줄
  poly([[-0.03, -0.44], [0.03, -0.44], [0.026, -0.385], [-0.026, -0.385]], ink);
  poly([[-0.022, -0.418], [0.022, -0.418], [0.02, -0.412], [-0.02, -0.412]], red);

  // 삿갓: 넓고 납작한 원뿔 — 왼쪽 면 밝게
  poly([[0, -0.585], [0.225, -0.458], [0.2, -0.45], [0, -0.462], [-0.2, -0.45], [-0.225, -0.458]], ink);
  poly([[0, -0.585], [-0.225, -0.458], [-0.2, -0.45], [0, -0.462]], lit);

  // 팔: 넓은 소매(먹) → 칼자루를 쥔 손
  const shL = P(-0.13, -0.32), shR = P(0.13, -0.32);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [sh, col] of [[shR, ink], [shL, lit]]) {
    const el = lerpPt(sh, blade.a, 0.45);
    el.y += s * 0.05;
    ctx.strokeStyle = col;
    ctx.lineWidth = s * 0.075;
    ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(el.x, el.y); ctx.stroke();
    ctx.lineWidth = s * 0.04;
    ctx.beginPath(); ctx.moveTo(el.x, el.y); ctx.lineTo(blade.a.x, blade.a.y); ctx.stroke();
  }

  // 칼: 먹색 칼등 + 주홍 날 선, 주홍 칼끈, 먹색 코등이
  const d = norm({ x: blade.b.x - blade.a.x, y: blade.b.y - blade.a.y });
  const nv = { x: -d.y, y: d.x };
  const at = (k, w = 0) => ({ x: blade.a.x + d.x * k * s + nv.x * w * s, y: blade.a.y + d.y * k * s + nv.y * w * s });
  const bl = Math.hypot(blade.b.x - blade.a.x, blade.b.y - blade.a.y) / s;
  poly([at(-0.075, 0.011), at(0.03, 0.011), at(0.03, -0.011), at(-0.075, -0.011)], red);
  poly([at(0.04, 0.011), at(bl * 0.55, 0.012), at(bl - 0.04, 0.006), blade.b, at(bl - 0.03, -0.009), at(0.04, -0.009)], ink);
  poly([at(0.05, 0.011), at(bl * 0.55, 0.012), at(bl - 0.04, 0.006), blade.b, at(bl - 0.04, 0.002), at(0.05, 0.005)], red);
  const tb = at(0.035);
  ctx.save();
  ctx.translate(tb.x, tb.y);
  ctx.rotate(Math.atan2(d.y, d.x));
  ctx.fillStyle = ink;
  ctx.beginPath(); ctx.ellipse(0, 0, s * 0.01, s * 0.034, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // 손
  ctx.fillStyle = lit;
  for (const k of [-0.045, 0.005]) { const h = at(k); ctx.beginPath(); ctx.arc(h.x, h.y, s * 0.022, 0, Math.PI * 2); ctx.fill(); }

  ctx.restore();
}

// ---------- Game ----------
export class Game {
  constructor() {
    this.mode = 'DUEL';
    this.level = 'NORMAL';
    this.paused = false;
    this.fx = new FX();
    this.best = loadBest();
    this.now = 0;
    this.lastBladeLen = 0;
    this.reset();
  }

  setMode(m) { this.mode = m; this.reset(); }
  setLevel(l) { this.level = l; this.reset(); }

  reset() {
    this.over = null;
    this.score = 0;
    this.combo = 0;
    this.parries = 0;
    this.clock = 0;
    this.started = false;
    this.banner = null;
    this.roundEnd = null;
    this.fx.clear();
    if (this.mode === 'SLICE') {
      this.objs = [];
      this.halves = [];
      this.timeLeft = GAME_CONFIG.slice.duration;
      this.spawnIn = 0.4;
      this.swing = { id: -1, count: 0 };
    } else {
      this.round = 1;
      this.wins = [0, 0];
      this.resetRound();
    }
  }

  resetRound() {
    this.playerHp = 100;
    this.enemyHp = 100;
    this.enemy = {
      state: this.started ? 'ready' : 'idle',
      until: this.clock + 1200,
      ghost: null, chainLeft: 0, chainIndex: 0,
      hitFlash: 0, lastHit: -1e9, lastBlock: -1e9,
      prevAngle: null, matching: false,
      lastPose: null, resolvedAt: -1e9,
      momentum: GAME_CONFIG.duel.momentum.start,
      weak: null, prevWeak: null, shakenShown: false,
    };
  }

  showBanner(text, ms = 1200, small = false) {
    this.banner = { text, until: this.now + ms, small };
  }

  finish(title) {
    const prev = this.best[this.mode] || 0;
    const isBest = this.score > prev;
    if (isBest) { this.best[this.mode] = this.score; saveBest(this.best); }
    this.over = { title, score: this.score, best: this.best[this.mode] || 0, isBest };
  }

  // dt: 초, now: performance.now() ms
  update(dt, now, sword, view) {
    this.now = now;
    this.view = view;
    if (sword.active) this.lastBladeLen = sword.fullLen || sword.len;
    if (this.paused || this.over) { sword.sweeps.length = 0; return; }

    if (!this.started && sword.active) {
      this.started = true;
      if (this.mode === 'DUEL') { this.enemy.state = 'ready'; this.enemy.until = this.clock + 900; this.showBanner('ROUND 1', 1100); }
      else this.showBanner('SLICE!', 900);
    }

    const sweeps = sword.sweeps.splice(0);
    const thrusts = sword.thrusts.splice(0);
    // 찌르기 손맛: 칼끝에서 곧게 뻗는 빛줄기와 링
    for (const th of thrusts) this.fx.thrust(th.base, th.tip, Math.min(view.W, view.H) * 0.32, PAL.player);
    let simDt = dt;
    if (this.fx.hitstop > 0) { this.fx.hitstop -= dt * 1000; simDt = 0; }
    this.clock += simDt * 1000;

    if (this.mode === 'SLICE') this.updateSlice(simDt, sweeps, sword, view, thrusts);
    else this.updateDuel(simDt, sweeps, sword, view, thrusts);
    this.fx.update(simDt, dt);
  }

  // ===== SLICE =====
  updateSlice(dt, sweeps, sword, v, thrusts = []) {
    const C = GAME_CONFIG.slice;
    const g = C.gravity * v.H;

    // 스윕은 히트스톱 중에도 처리 (연속 베기)
    for (const sw of sweeps) {
      if (!sw.slashing) continue;
      for (const o of this.objs) {
        if (!o.dead && sweepHitsCircle(sw, o, o.r * 1.05)) this.cut(o, sw);
      }
    }
    for (const th of thrusts) {
      for (const o of this.objs) {
        if (!o.dead && dist(th.tip, o) <= o.r * 1.6) this.cut(o, { vel: { x: 0, y: -1 }, swingId: -2 - th.ts });
      }
    }
    this.objs = this.objs.filter((o) => !o.dead);

    // 한 번 휘두르기로 여러 개 = 콤보
    if (this.swing.count > 0 && (!sword.slashing || sword.swingId !== this.swing.id)) {
      if (this.swing.count >= 2) {
        const bonus = (this.swing.count - 1) * 15;
        this.score += bonus;
        this.showBanner(`COMBO ×${this.swing.count}`, 800, true);
      }
      this.swing.count = 0;
    }

    if (!this.started) return;

    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; this.finish('TIME UP'); return; }

    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      const [a, b] = C.spawn[this.level];
      this.spawnIn = rand(a, b);
      const n = Math.random() < (this.level === 'HARD' ? 0.45 : 0.3) ? (Math.random() < 0.3 ? 3 : 2) : 1;
      for (let i = 0; i < n; i++) this.spawn(v, g);
    }

    for (const o of this.objs) {
      o.vy += g * dt; o.x += o.vx * dt; o.y += o.vy * dt; o.rot += o.vr * dt;
    }
    this.objs = this.objs.filter((o) => !(o.vy > 0 && o.y > v.H + o.r * 2));
    for (const h of this.halves) {
      h.vy += g * dt; h.x += h.vx * dt; h.y += h.vy * dt; h.rot += h.vr * dt; h.life -= dt;
    }
    this.halves = this.halves.filter((h) => h.life > 0 && h.y < v.H + h.r * 3);
  }

  spawn(v, g) {
    const C = GAME_CONFIG.slice;
    const r = C.radius * Math.min(v.W, v.H) * rand(0.85, 1.2);
    const x = rand(0.12, 0.88) * v.W;
    const apex = rand(0.42, 0.72) * v.H;
    const vy = -Math.sqrt(2 * g * apex);
    const T = (2 * -vy) / g;
    const vx = (rand(0.25, 0.75) * v.W - x) / T;
    this.objs.push({
      x, y: v.H + r, vx, vy, r,
      rot: Math.random() * Math.PI, vr: rand(-3, 3),
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
      bomb: Math.random() < C.bombChance[this.level],
    });
  }

  cut(o, sw) {
    const C = GAME_CONFIG.slice;
    const H = GAME_CONFIG.hitstop;
    o.dead = true;
    const a = Math.atan2(sw.vel.y, sw.vel.x);
    if (o.bomb) {
      this.score = Math.max(0, this.score - C.bombPenalty);
      this.combo = 0;
      this.swing.count = 0;
      this.fx.flash = 0.8; this.fx.flashColor = PAL.hurt; this.fx.kick(18); this.fx.stop(H.bomb);
      this.fx.sparks(o.x, o.y, 40, o.r * 14, null, Math.PI * 2, PAL.spark);
      this.fx.ring(o.x, o.y, o.r, o.r * 5, 0.5, 5, PAL.hurt);
      this.fx.crack(o.x, o.y, o.r * 3, PAL.hurt);
      this.showBanner(`BOMB −${C.bombPenalty}`, 900, true);
      return;
    }
    if (this.swing.id !== sw.swingId) this.swing = { id: sw.swingId, count: 0 };
    this.swing.count++;
    this.score += C.points;
    const n = { x: -Math.sin(a), y: Math.cos(a) };
    const pop = o.r * 4;
    for (const side of [1, -1]) {
      this.halves.push({
        x: o.x, y: o.y, r: o.r, shape: o.shape, rot: o.rot, cutA: a, side,
        vx: o.vx * 0.5 + n.x * pop * side + Math.cos(a) * pop * 0.6,
        vy: o.vy * 0.4 + n.y * pop * side + Math.sin(a) * pop * 0.6,
        vr: o.vr + side * 4, life: 1.6,
      });
    }
    this.fx.sparks(o.x, o.y, 16, o.r * 12, a, 1.0, PAL.playerCore);
    if (sw.swingId > -2) this.fx.slash(o.x, o.y, a, o.r * 4.5, PAL.player); // 찌르기로 자른 건 빛줄기만
    else this.fx.ring(o.x, o.y, o.r * 0.6, o.r * 2.6, 0.3, 3, PAL.player);
    this.fx.stop(H.slice); this.fx.kick(4);
  }

  // ===== DUEL =====
  enemyGeo(v) {
    const s = Math.min(v.W, v.H) * 0.62;
    const ex = v.W / 2, ey = v.H * 0.53;
    const pts = [];
    for (let i = 0; i <= 4; i++) pts.push({ x: ex, y: ey + (-0.40 + i * 0.13) * s });
    return { s, ex, ey, body: pts, r: 0.1 * s };
  }

  hitsBody(sw, geo) {
    return geo.body.some((p) => sweepHitsCircle(sw, p, geo.r));
  }

  updateDuel(dt, sweeps, sword, v, thrusts = []) {
    const C = GAME_CONFIG.duel;
    const H = GAME_CONFIG.hitstop;
    const e = this.enemy;
    const now = this.clock;
    e.hitFlash = Math.max(0, e.hitFlash - dt * 4);

    if (this.roundEnd) {
      if (this.now >= this.roundEnd.until) this.nextRound();
      sweeps.length = 0;
      return;
    }

    const geo = this.enemyGeo(v);
    const M = C.momentum;
    for (const sw of sweeps) {
      if (!sw.slashing) continue;
      if (!this.hitsBody(sw, geo)) continue;
      // 비틀거릴 때만 급소가 열림 — 급소 방향에서 안쪽으로 휘둘러야 데미지
      if (e.state === 'stagger' && e.weak && this.vitalMatch(sw)) {
        if (now - e.lastHit > C.hitCooldown) this.weakHit(sw, geo);
        if (this.roundEnd) return;
        continue;
      }
      if (now - e.lastBlock < 300) continue;
      // 다른 방향 공격은 막힘
      e.lastBlock = now;
      const p = lerpPt(sw.h1, sw.t1, 0.6);
      this.fx.shield(p.x, p.y, geo.s * 0.08, PAL.enemy, 0.3);
      this.fx.sparks(p.x, p.y, 10, geo.s * 0.9, null, Math.PI * 2, PAL.spark);
      this.fx.stop(H.block);
      this.showBanner(e.state !== 'stagger' ? 'BLOCKED' : e.weak === 'THRUST' ? 'THRUST IT!' : 'WRONG SIDE', 550, true);
    }

    // 찌르기: 찌르기 급소일 때 원 중앙 근처를 찌르면 적중
    for (const th of thrusts) {
      const vc = this.vitalCircle(geo);
      const near = Math.min(dist(th.tip, vc), dist(th.base, vc));
      if (near > vc.r * 1.1) continue; // 상대 근처가 아니면 무시
      if (e.state === 'stagger' && e.weak === 'THRUST' && near <= vc.r * C.thrustRadius) {
        if (now - e.lastHit > C.hitCooldown) this.weakHit({ vel: { x: 0, y: 0 } }, geo);
        if (this.roundEnd) return;
        continue;
      }
      if (now - e.lastBlock < 300) continue;
      e.lastBlock = now;
      this.fx.shield(th.tip.x, th.tip.y, geo.s * 0.08, PAL.enemy, 0.3);
      this.fx.sparks(th.tip.x, th.tip.y, 10, geo.s * 0.9, null, Math.PI * 2, PAL.spark);
      this.fx.stop(H.block);
      this.showBanner(e.state === 'stagger' ? 'WRONG MOVE' : 'BLOCKED', 550, true);
    }

    // 모멘텀은 천천히 기본값으로 회복
    if (e.momentum < M.start) e.momentum = Math.min(M.start, e.momentum + M.regen * dt);

    if (!this.started) return;

    switch (e.state) {
      case 'idle':
        break;
      case 'ready':
        if (now >= e.until) {
          // 연속 공격 수: 라운드가 오를수록, 모멘텀이 높을수록 길어짐
          const max = C.chainMax[Math.min(this.round, C.chainMax.length) - 1];
          const n = 1 + Math.floor(Math.random() * max * (0.35 + 0.65 * e.momentum));
          e.chainLeft = Math.min(max, n);
          e.chainIndex = 0;
          this.startTelegraph(v);
        }
        break;
      case 'gap':
        if (now >= e.until) this.startTelegraph(v);
        break;
      case 'telegraph': {
        const g = e.ghost;
        e.matching = this.matchGuard(sword, g, v);
        if (now >= g.impact - C.parryBefore && e.matching) this.parrySuccess(g);
        else if (now >= g.impact + C.parryAfter) this.parryFail(g);
        break;
      }
      case 'stagger':
      case 'recover':
        if (now >= e.until) {
          e.state = 'ready';
          e.weak = null;
          // 모멘텀이 낮으면 다음 공격까지 더 오래 머뭇거림
          e.until = now + rand(...C.idle) * 1000 * (1.6 - e.momentum);
        }
        break;
    }
  }

  // 급소 표시 위치 (몸을 감싸는 타원의 해당 방향 지점)
  vitalPos(geo, key = this.enemy.weak) {
    const c = this.vitalCircle(geo);
    if (VITALS[key].thrust) return { x: c.x, y: c.y };
    const a = VITALS[key].arc;
    return { x: c.x + Math.cos(a) * c.r, y: c.y + Math.sin(a) * c.r };
  }

  // 급소 원: 머리~엉덩이를 감싸는 정원
  vitalCircle(geo) {
    return { x: geo.ex, y: geo.ey - 0.14 * geo.s, r: geo.s * 0.32 };
  }

  vitalMatch(sw) {
    if (VITALS[this.enemy.weak].thrust) return false; // 찌르기 급소는 베기로 안 됨
    const v = VITALS[this.enemy.weak].dir;
    const sp = Math.hypot(sw.vel.x, sw.vel.y) || 1;
    const cos = (sw.vel.x * v.x + sw.vel.y * v.y) / sp;
    return cos >= Math.cos((GAME_CONFIG.duel.vitalAngle * Math.PI) / 180);
  }

  pickWeak() {
    const e = this.enemy;
    if (e.weak !== 'THRUST' && Math.random() < GAME_CONFIG.duel.thrustChance) { e.weak = 'THRUST'; return; }
    const keys = Object.keys(VITALS).filter((k) => k !== e.weak && !VITALS[k].thrust);
    e.weak = keys[Math.floor(Math.random() * keys.length)];
  }

  weakHit(sw, geo) {
    const wp = this.vitalPos(geo);
    const C = GAME_CONFIG.duel;
    const H = GAME_CONFIG.hitstop;
    const M = C.momentum;
    const e = this.enemy;
    e.lastHit = this.clock;
    const dmg = C.weakDamage * (1 + 0.2 * Math.min(this.combo, 5));
    this.enemyHp = Math.max(0, this.enemyHp - dmg);
    this.combo++;
    this.score += Math.round(dmg * 10);
    e.hitFlash = 1;
    // 연속 공격에 성공할수록 적 모멘텀이 꺾임
    e.momentum = Math.max(M.min, e.momentum - M.hit - M.comboBonus * Math.min(this.combo, 5));
    const a = Math.atan2(sw.vel.y, sw.vel.x);
    const thrust = !sw.vel.x && !sw.vel.y;
    if (thrust) {
      this.fx.sparks(wp.x, wp.y, 26, geo.s * 1.8, null, Math.PI * 2, PAL.vital);
      this.fx.ring(wp.x, wp.y, 8, geo.s * 0.26, 0.36, 5, PAL.player);
    } else {
      this.fx.slash(wp.x, wp.y, a, geo.s * 0.55, PAL.player);
      this.fx.sparks(wp.x, wp.y, 26, geo.s * 1.8, a, 1.1, PAL.vital);
    }
    this.fx.ring(wp.x, wp.y, 8, geo.s * 0.18, 0.32, 3, PAL.vital);
    this.fx.stop(H.hit); this.fx.kick(8);
    if (this.enemyHp <= 0) { this.endRound(true); return; }
    // 급소를 맞으면 방어 자세를 바꿔 급소가 다른 곳으로 이동
    this.pickWeak();
    e.until += C.weakExtendMs;
    if (e.momentum <= 0.3 && !e.shakenShown) { e.shakenShown = true; this.showBanner('RIVAL SHAKEN', 800, true); }
    else this.showBanner(e.weak === 'THRUST' ? 'NEXT: THRUST!' : this.combo >= 2 ? `CRITICAL ×${this.combo}` : 'CRITICAL', 600, true);
  }

  telegraphMs() {
    const C = GAME_CONFIG.duel;
    let t = C.telegraph[this.level] * Math.pow(C.roundSpeedup, this.round - 1);
    if (this.enemy.chainIndex > 0) t *= C.chainSpeedup;
    // 모멘텀 1 → 0.85배(빠름), 0.15 → 1.28배(느림)
    t *= 1.35 - 0.5 * this.enemy.momentum;
    return t;
  }

  startTelegraph(v) {
    const e = this.enemy;
    const angles = [0, 90, 45, 135];
    let a;
    do { a = angles[Math.floor(Math.random() * angles.length)]; } while (a === e.prevAngle && Math.random() < 0.75);
    e.prevAngle = a;
    const L = this.lastBladeLen || 0.3 * Math.min(v.W, v.H);
    const cx = v.W / 2 + rand(-0.14, 0.14) * v.W;
    const cy = v.H * 0.52 + rand(-0.12, 0.12) * v.H;
    const r = (a * Math.PI) / 180;
    const dx = (Math.cos(r) * L) / 2, dy = (Math.sin(r) * L) / 2;
    // 적 손에 가까운 끝을 칼자루로
    let p1 = { x: cx - dx, y: cy - dy }, p2 = { x: cx + dx, y: cy + dy };
    const geo = this.enemyGeo(v);
    const hand = { x: geo.ex + 0.06 * geo.s, y: geo.ey - 0.08 * geo.s };
    if (dist(p2, hand) < dist(p1, hand)) [p1, p2] = [p2, p1];
    e.ghost = { angle: a, cx, cy, a: p1, b: p2, len: L, start: this.clock, impact: this.clock + this.telegraphMs() };
    e.state = 'telegraph';
    e.matching = false;
  }

  // 칼이 예고선에 얼마나 가까운지 0~1 (1이면 막기 성공 범위)
  guardCloseness(sword, g, v) {
    const C = GAME_CONFIG.duel;
    if (!sword.active || (sword.slashing && !C.parryStillOk)) return 0;
    const a = angleDiff180(sword.angle, g.angle) / C.parryAngle;
    const d = segSegDist(sword.base, sword.tip, g.a, g.b) / (C.parryDist * v.diag);
    const worst = Math.max(a, d);
    return worst <= 1 ? 1 : Math.max(0, 1 - (worst - 1)); // 범위 밖 2배까지 점점 흐려짐
  }

  matchGuard(sword, g, v) {
    this.enemy.closeness = this.guardCloseness(sword, g, v);
    return this.enemy.closeness >= 1;
  }

  resolveGhost() {
    const e = this.enemy;
    e.lastPose = { a: e.ghost.a, b: e.ghost.b };
    e.resolvedAt = this.clock;
    e.ghost = null;
    e.matching = false;
  }

  parrySuccess(g) {
    const C = GAME_CONFIG.duel;
    const H = GAME_CONFIG.hitstop;
    const e = this.enemy;
    this.fx.shield(g.cx, g.cy, g.len * 0.38, PAL.player);
    this.fx.sparks(g.cx, g.cy, 30, g.len * 3, null, Math.PI * 2, PAL.spark);
    this.fx.ring(g.cx, g.cy, 10, g.len * 0.6, 0.4, 3, PAL.player);
    this.fx.flash = 0.3; this.fx.flashColor = PAL.player; this.fx.stop(H.parry); this.fx.kick(7);
    this.score += 50;
    this.parries++;
    this.resolveGhost();
    e.chainLeft--;
    e.chainIndex++;
    if (e.chainLeft > 0) {
      e.state = 'gap';
      e.until = this.clock + C.chainGap;
      this.showBanner('PARRY', 450, true);
    } else {
      e.state = 'stagger';
      e.until = this.clock + C.staggerMs;
      e.momentum = Math.max(C.momentum.min, e.momentum - C.momentum.parry);
      this.pickWeak();
      this.showBanner(`OPEN — ${VITALS[e.weak].label}!`, 900, true);
    }
  }

  parryFail(g) {
    const C = GAME_CONFIG.duel;
    const H = GAME_CONFIG.hitstop;
    const e = this.enemy;
    this.playerHp = Math.max(0, this.playerHp - C.playerDamage[this.level]);
    this.combo = 0;
    e.momentum = Math.min(C.momentum.max, e.momentum + C.momentum.hurt);
    e.shakenShown = false;
    this.fx.crack(g.cx, g.cy, g.len * 0.6, PAL.hurt);
    this.fx.flash = 0.7; this.fx.flashColor = PAL.hurt; this.fx.kick(16); this.fx.stop(H.hurt);
    this.resolveGhost();
    e.state = 'recover';
    e.until = this.clock + 700;
    if (this.playerHp <= 0) this.endRound(false);
  }

  endRound(won) {
    this.wins[won ? 0 : 1]++;
    if (won) this.score += 300;
    this.enemy.state = won ? 'down' : 'victory';
    this.enemy.ghost = null;
    this.roundEnd = { until: this.now + 1800 };
    this.showBanner(won ? 'ROUND WON' : 'ROUND LOST', 1600);
  }

  nextRound() {
    this.roundEnd = null;
    const W = GAME_CONFIG.duel.winsNeeded;
    if (this.wins[0] >= W) { this.finish('VICTORY'); return; }
    if (this.wins[1] >= W) { this.finish('DEFEAT'); return; }
    this.round++;
    this.resetRound();
    this.enemy.state = 'ready';
    this.enemy.until = this.clock + 1200;
    this.showBanner(`ROUND ${this.round}`, 1100);
  }

  // ===== 렌더 =====
  render(ctx, view) {
    ctx.clearRect(0, 0, view.W, view.H);
    ctx.save();
    if (this.fx.shake > 0) {
      ctx.translate((Math.random() - 0.5) * 2 * this.fx.shake, (Math.random() - 0.5) * 2 * this.fx.shake);
    }
    if (this.mode === 'SLICE') this.renderSlice(ctx, view);
    else this.renderDuel(ctx, view);
    this.fx.render(ctx, view);
    ctx.restore();
  }

  renderSlice(ctx) {
    for (const o of this.objs) drawObject(ctx, o);
    for (const h of this.halves) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, h.life / 0.5);
      ctx.translate(h.x, h.y);
      // 자른 방향의 반쪽만 보이도록 클리핑
      ctx.rotate(h.cutA);
      ctx.beginPath();
      ctx.rect(-h.r * 3, h.side > 0 ? 0 : -h.r * 3, h.r * 6, h.r * 3);
      ctx.clip();
      ctx.rotate(-h.cutA);
      drawObject(ctx, { ...h, x: 0, y: 0, bomb: false });
      ctx.restore();
    }
  }

  enemyBlade(geo) {
    const e = this.enemy;
    const { s, ex, ey } = geo;
    const idleHand = { x: ex + 0.06 * s, y: ey - 0.08 * s };
    let idle = { a: idleHand, b: { x: idleHand.x - 0.16 * s, y: idleHand.y - 0.34 * s } };
    if (e.state === 'stagger') {
      const h = { x: ex + 0.1 * s, y: ey + 0.02 * s };
      idle = { a: h, b: { x: h.x + 0.3 * s, y: h.y + 0.14 * s } };
    }
    if (e.state === 'telegraph' && e.ghost) {
      const g = e.ghost;
      const p = Math.min(1, Math.max(0, (this.clock - g.start) / (g.impact - g.start)));
      // 처음엔 뒤로 살짝 빼며 준비, 마지막에 빠르게 들어옴
      const wind = Math.sin(Math.min(1, p / 0.6) * Math.PI) * 0.12 * s;
      const k = Math.pow(p, 3);
      const back = { x: 0, y: -wind };
      return {
        a: lerpPt({ x: idle.a.x + back.x, y: idle.a.y + back.y }, g.a, k),
        b: lerpPt({ x: idle.b.x, y: idle.b.y - wind * 1.5 }, g.b, k),
      };
    }
    if (e.lastPose && this.clock - e.resolvedAt < 350) {
      const k = (this.clock - e.resolvedAt) / 350;
      const ease = 1 - Math.pow(1 - k, 2);
      return { a: lerpPt(e.lastPose.a, idle.a, ease), b: lerpPt(e.lastPose.b, idle.b, ease) };
    }
    return idle;
  }

  renderDuel(ctx, view) {
    const e = this.enemy;
    const geo = this.enemyGeo(view);
    const { s } = geo;

    drawFigure(ctx, geo, this.enemyBlade(geo), {
      alpha: e.state === 'down' ? 0.35 : 1,
      tilt: e.state === 'stagger' ? -0.04 + Math.sin(this.clock / 90) * 0.012 : 0,
      flash: e.hitFlash,
    });

    // 찌르기 급소: 원 중앙 과녁 + 안쪽으로 조여드는 링
    if (e.state === 'stagger' && e.weak === 'THRUST') {
      const vc = this.vitalCircle(geo);
      const r = vc.r * GAME_CONFIG.duel.thrustRadius;
      const t = (this.clock % 700) / 700;
      const left = Math.max(0, Math.min(1, (e.until - this.clock) / GAME_CONFIG.duel.staggerMs));
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(${PAL.vital},0.25)`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(vc.x, vc.y, vc.r, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowColor = `rgba(${PAL.vital},0.95)`;
      ctx.shadowBlur = glow(16);
      ctx.strokeStyle = `rgb(${PAL.vital})`;
      // 조여드는 링 2개
      for (const k of [t, (t + 0.5) % 1]) {
        ctx.globalAlpha = k;
        ctx.lineWidth = 2 + 3 * k;
        ctx.beginPath(); ctx.arc(vc.x, vc.y, r * (1.6 - k), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // 과녁
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(vc.x, vc.y, r * 0.55, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgb(${PAL.vital})`;
      ctx.beginPath(); ctx.arc(vc.x, vc.y, r * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgb(${PAL.vital})`;
      // 4방향 안쪽 화살촉
      ctx.lineWidth = 3.5;
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const o = r * 1.05, hw = r * 0.16;
        const p = { x: vc.x + Math.cos(a) * o, y: vc.y + Math.sin(a) * o };
        const dx = -Math.cos(a), dy = -Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(p.x - dx * hw - dy * hw, p.y - dy * hw + dx * hw);
        ctx.lineTo(p.x, p.y);
        ctx.lineTo(p.x - dx * hw + dy * hw, p.y - dy * hw - dx * hw);
        ctx.stroke();
      }
      // 남은 시간
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = glow(6);
      ctx.beginPath(); ctx.arc(vc.x, vc.y, vc.r * 1.1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left); ctx.stroke();
      ctx.restore();
    }

    // 급소 표시 (비틀거릴 때만): 몸을 감싼 원의 한쪽 1/4 호 + 안쪽을 가리키는 화살표
    if (e.state === 'stagger' && e.weak && !VITALS[e.weak].thrust) {
      const V = VITALS[e.weak];
      const vc = this.vitalCircle(geo);
      const cx = vc.x, cy = vc.y, rx = vc.r, ry = vc.r;
      const pulse = 0.5 + 0.5 * Math.sin(this.clock / 90);
      const left = Math.max(0, Math.min(1, (e.until - this.clock) / GAME_CONFIG.duel.staggerMs));
      ctx.save();
      ctx.lineCap = 'round';
      // 전체 원 (희미하게)
      ctx.strokeStyle = `rgba(${PAL.vital},0.25)`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      // 급소 호
      ctx.shadowColor = `rgba(${PAL.vital},0.95)`;
      ctx.shadowBlur = glow(16 + pulse * 14);
      ctx.strokeStyle = `rgb(${PAL.vital})`;
      ctx.lineWidth = 6 + pulse * 2;
      const span = (Math.PI / 2) * 0.85;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, V.arc - span / 2, V.arc + span / 2); ctx.stroke();
      // 남은 시간: 호 바깥쪽 얇은 선
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = glow(6);
      ctx.beginPath(); ctx.ellipse(cx, cy, rx * 1.1, ry * 1.1, 0, V.arc - (span / 2) * left, V.arc + (span / 2) * left); ctx.stroke();
      // 휘두를 방향 화살표 (바깥 → 안쪽)
      const p = this.vitalPos(geo);
      const d = V.dir;
      const n = { x: -d.y, y: d.x };
      const L = s * 0.16, back = s * 0.12 + pulse * s * 0.02;
      const tail = { x: p.x - d.x * (back + L), y: p.y - d.y * (back + L) };
      const head = { x: p.x - d.x * back * 0.35, y: p.y - d.y * back * 0.35 };
      ctx.lineWidth = 4;
      ctx.shadowBlur = glow(12);
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y); ctx.lineTo(head.x, head.y);
      const hw = s * 0.045;
      ctx.moveTo(head.x - d.x * hw + n.x * hw, head.y - d.y * hw + n.y * hw);
      ctx.lineTo(head.x, head.y);
      ctx.lineTo(head.x - d.x * hw - n.x * hw, head.y - d.y * hw - n.y * hw);
      ctx.stroke();
      ctx.restore();
    }

    // 공격 예고선(막아야 할 위치)
    if (e.state === 'telegraph' && e.ghost) {
      const g = e.ghost;
      const p = Math.min(1, Math.max(0, (this.clock - g.start) / (g.impact - g.start)));
      const urgent = p > 0.7 ? 0.5 + 0.5 * Math.sin(this.clock / 45) : 0;
      ctx.save();
      ctx.lineCap = 'round';
      const near = e.closeness || 0;
      // 상대 공격은 붉게, 내 칼이 제자리에 들어오면 청백색으로 빛남
      ctx.shadowColor = near >= 1 ? `rgba(${PAL.player},1)` : `rgba(${PAL.enemy},0.9)`;
      ctx.shadowBlur = glow(10 + near * 18);
      ctx.setLineDash([12, 10]);
      ctx.lineDashOffset = -this.clock / 20;
      ctx.strokeStyle = near >= 1 ? `rgba(${PAL.player},0.85)` : `rgba(${PAL.enemy},${0.35 + 0.35 * p + urgent * 0.25})`;
      ctx.lineWidth = 10 + near * 6;
      ctx.beginPath(); ctx.moveTo(g.a.x, g.a.y); ctx.lineTo(g.b.x, g.b.y); ctx.stroke();
      ctx.setLineDash([]);
      // 진행 막대
      const m = lerpPt(g.a, g.b, p);
      ctx.strokeStyle = `rgb(${PAL.enemyCore})`;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(g.a.x, g.a.y); ctx.lineTo(m.x, m.y); ctx.stroke();
      // 끝 표시
      ctx.fillStyle = `rgb(${PAL.enemyCore})`;
      for (const q of [g.a, g.b]) { ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.fill(); }
      // 남은 시간 링
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(${PAL.enemyCore},0.9)`;
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - p));
      ctx.stroke();
      ctx.restore();
    }
  }
}
