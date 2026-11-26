// 게임 로직: DUEL(패링 후 베기) / SLICE(날아오는 오브젝트 베기)
import { sweepHitsCircle, segSegDist, angleDiff180, lerpPt, dist, norm } from './sword.js';
import { PAL } from './palette.js';

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
// 피오라식 급소: 상하좌우 4방향 중 하나. 그 방향에서 '안쪽으로' 휘둘러야 적중
// dir = 필요한 휘두르기 방향(화면 좌표), arc = 표시할 쪽 (캔버스 각도, 0 = 오른쪽)
const VITALS = {
  UP: { dir: { x: 0, y: 1 }, arc: -Math.PI / 2, label: 'SLASH DOWN' },
  DOWN: { dir: { x: 0, y: -1 }, arc: Math.PI / 2, label: 'SLASH UP' },
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
// 색 인자를 생략하면 흰색 (versus/ 화면은 기존 모습 그대로)
const WHITE = '255,255,255';
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
  // 막기: 방패 모양 섬광
  shield(x, y, r, color = WHITE, life = 0.42) {
    this.shields.push({ x, y, r, color, life, max: life });
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

  renderSlash(ctx, o) {
    const k = 1 - o.life / o.max;
    const grow = easeOut(Math.min(1, k / 0.35));
    const fade = 1 - Math.max(0, (k - 0.35) / 0.65);
    const L = o.length * (0.4 + 0.6 * grow);
    const bulge = o.length * 0.16 * o.bend;
    const w = o.length * 0.07 * fade;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.angle);
    // 바깥 호와 안쪽 호 사이를 채운 초승달 (양 끝이 뾰족)
    const crescent = (thick) => {
      ctx.beginPath();
      ctx.moveTo(-L / 2, 0);
      ctx.quadraticCurveTo(0, bulge * 2 + thick * o.bend, L / 2, 0);
      ctx.quadraticCurveTo(0, bulge * 2 - thick * o.bend, -L / 2, 0);
      ctx.closePath();
    };
    ctx.shadowColor = `rgba(${o.color},0.95)`;
    ctx.shadowBlur = 18;
    ctx.fillStyle = `rgba(${o.color},${0.75 * fade})`;
    crescent(w);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(255,255,255,${0.95 * fade})`;
    crescent(w * 0.35);
    ctx.fill();
    ctx.restore();
  }

  renderBeam(ctx, o) {
    const k = 1 - o.life / o.max;
    const reach = easeOut(Math.min(1, k / 0.4));
    const fade = 1 - k;
    const L = o.length * reach;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.angle);
    ctx.lineCap = 'round';
    // 창날처럼 칼끝에서 넓게 시작해 뾰족하게 뻗는 빛
    const w = o.length * 0.13 * (0.45 + 0.55 * fade);
    const lance = ctx.createLinearGradient(0, 0, L, 0);
    lance.addColorStop(0, `rgba(255,255,255,${0.9 * fade})`);
    lance.addColorStop(0.25, `rgba(${o.color},${0.85 * fade})`);
    lance.addColorStop(1, `rgba(${o.color},0)`);
    ctx.shadowColor = `rgba(${o.color},1)`;
    ctx.shadowBlur = 24;
    ctx.fillStyle = lance;
    ctx.beginPath();
    ctx.moveTo(-w * 0.6, 0);
    ctx.quadraticCurveTo(0, -w, L * 0.25, -w * 0.55);
    ctx.lineTo(L, 0);
    ctx.lineTo(L * 0.25, w * 0.55);
    ctx.quadraticCurveTo(0, w, -w * 0.6, 0);
    ctx.fill();
    ctx.shadowBlur = 0;
    // 하얀 심 + 양옆 속도선
    ctx.strokeStyle = `rgba(255,255,255,${fade})`;
    ctx.lineWidth = 3 * fade + 1;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L * 0.85, 0); ctx.stroke();
    ctx.strokeStyle = `rgba(${o.color},${0.8 * fade})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const side of [-1, 1]) {
      ctx.moveTo(L * 0.1, side * w * 1.25); ctx.lineTo(L * 0.7 * reach, side * w * 1.1);
    }
    ctx.stroke();
    // 칼끝의 십자 반짝임
    const r = o.length * 0.14 * (1 - k * 0.5);
    ctx.fillStyle = `rgba(255,255,255,${fade})`;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a + Math.PI / 4) * r * 0.18, Math.sin(a + Math.PI / 4) * r * 0.18);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  renderShield(ctx, o) {
    const k = 1 - o.life / o.max;
    const sc = 0.55 + 0.6 * easeOut(Math.min(1, k / 0.3));
    const fade = k < 0.3 ? 1 : 1 - (k - 0.3) / 0.7;
    const r = o.r * sc;
    // 위가 넓고 아래가 뾰족한 방패
    const path = (q) => {
      ctx.beginPath();
      ctx.moveTo(0, -q * 1.0);
      ctx.quadraticCurveTo(q * 0.45, -q * 0.78, q * 0.86, -q * 0.82);
      ctx.quadraticCurveTo(q * 0.92, q * 0.2, 0, q * 1.08);
      ctx.quadraticCurveTo(-q * 0.92, q * 0.2, -q * 0.86, -q * 0.82);
      ctx.quadraticCurveTo(-q * 0.45, -q * 0.78, 0, -q * 1.0);
      ctx.closePath();
    };
    ctx.save();
    ctx.translate(o.x, o.y);
    const g = ctx.createRadialGradient(0, -r * 0.2, 0, 0, 0, r * 1.1);
    g.addColorStop(0, `rgba(255,255,255,${0.55 * fade})`);
    g.addColorStop(0.5, `rgba(${o.color},${0.28 * fade})`);
    g.addColorStop(1, `rgba(${o.color},${0.06 * fade})`);
    ctx.fillStyle = g;
    path(r);
    ctx.fill();
    ctx.shadowColor = `rgba(${o.color},1)`;
    ctx.shadowBlur = 20;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(${o.color},${fade})`;
    ctx.lineWidth = 5;
    path(r);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * fade})`;
    ctx.lineWidth = 2;
    path(r * 0.72);
    ctx.stroke();
    // 방패 문장: 가운데 세로·가로 띠
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(255,255,255,${0.5 * fade})`;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.7); ctx.lineTo(0, r * 0.78);
    ctx.moveTo(-r * 0.6, -r * 0.2); ctx.lineTo(r * 0.6, -r * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  render(ctx, view) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const o of this.shields) this.renderShield(ctx, o);
    for (const o of this.slashes) this.renderSlash(ctx, o);
    for (const o of this.beams) this.renderBeam(ctx, o);
    ctx.shadowBlur = 8;
    for (const p of this.parts) {
      const k = p.life / p.max;
      ctx.shadowColor = `rgba(${p.color},0.9)`;
      ctx.strokeStyle = `rgba(${p.color},${k})`;
      ctx.lineWidth = p.w;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
      ctx.stroke();
    }
    for (const r of this.rings) {
      const k = 1 - r.life / r.max;
      ctx.shadowColor = `rgba(${r.color},0.9)`;
      ctx.strokeStyle = `rgba(${r.color},${1 - k})`;
      ctx.lineWidth = r.width * (1 - k) + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const c of this.cracks) {
      const k = c.life / c.max;
      ctx.shadowColor = `rgba(${c.color},0.9)`;
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
      ctx.fillStyle = `rgba(${this.flashColor},${this.flash * 0.35})`;
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
  ctx.shadowColor = 'rgba(255,255,255,0.7)';
  ctx.shadowBlur = 14;
  shapePath(ctx, o.bomb ? 'circle' : o.shape, o.r);
  ctx.fillStyle = o.bomb ? 'rgba(15,16,20,0.62)' : 'rgba(255,255,255,0.2)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.shadowBlur = 0;
  if (o.bomb) {
    const k = o.r * 0.38;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-k, -k); ctx.lineTo(k, k);
    ctx.moveTo(k, -k); ctx.lineTo(-k, k);
    ctx.stroke();
  } else {
    // 유리 하이라이트
    ctx.rotate(-o.rot);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.ellipse(-o.r * 0.32, -o.r * 0.38, o.r * 0.32, o.r * 0.14, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------- 사무라이 ----------
// 2D 일러스트풍: 먹선 외곽 + 셀 음영(빛은 왼쪽 위). 각 색은 [밝은 면, 기본, 그림자]
const INK = '#0c0b10';
const SAM = {
  lacquer: ['#e0544c', '#a0222a', '#5e0f18'], // 옻칠 갑옷
  cloth: ['#56658f', '#2e3858', '#1a2039'],   // 하카마·소매
  straw: ['#f2da9f', '#c9a463', '#85663a'],   // 삿갓
  iron: ['#767b8b', '#3d404b', '#1f2129'],    // 토시·가면·코등이
  sash: ['#ff7262', '#c52d35', '#7a1420'],    // 허리끈 자락
  lace: '#eab24c',                             // 갑옷 끈
  collar: '#ece4d2',
  face: '#2c1d1d',
};

// '#rrggbb'를 흰색 쪽으로 k(0~1)만큼 섞기 — 피격 섬광용
function tint(hex, k) {
  if (!k) return hex;
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(v + (255 - v) * k);
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

// 상대 검객: geo = { s, ex, ey }, blade = { a: 칼자루, b: 칼끝 } (화면 좌표)
// opts: alpha, tilt(발 기준 회전), flash(피격 0~1)
export function drawFigure(ctx, geo, blade, { alpha = 1, tilt = 0, flash = 0 } = {}) {
  const { s, ex, ey } = geo;
  const P = (x, y) => ({ x: ex + x * s, y: ey + y * s });
  const t = performance.now() / 1000;
  const fk = Math.min(1, flash) * 0.75;
  const tone = (c) => (Array.isArray(c) ? c.map((h) => tint(h, fk)) : tint(c, fk));
  const lacq = tone(SAM.lacquer), cloth = tone(SAM.cloth), straw = tone(SAM.straw);
  const iron = tone(SAM.iron), sash = tone(SAM.sash), lace = tone(SAM.lace);

  // 셀 음영: 왼쪽 → 오른쪽으로 밝은 면 / 기본 / 그림자가 딱 끊기는 그라데이션
  const cel = (x0, x1, [hl, base, sh], a = 0.3, b = 0.68) => {
    const p0 = P(x0, 0), p1 = P(x1, 0);
    const g = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
    g.addColorStop(0, hl); g.addColorStop(a, hl);
    g.addColorStop(a + 0.001, base); g.addColorStop(b, base);
    g.addColorStop(b + 0.001, sh); g.addColorStop(1, sh);
    return g;
  };
  const path = (pts) => {
    ctx.beginPath();
    pts.forEach((q, i) => {
      const p = q.x !== undefined ? q : P(q[0], q[1]);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
  };
  const shape = (pts, fill) => { path(pts); ctx.fillStyle = fill; ctx.fill(); ctx.stroke(); };
  const lines = (segs, color, w) => {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = w;
    ctx.beginPath();
    for (const [a, b] of segs) { const p = P(...a), q = P(...b); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    ctx.stroke();
    ctx.restore();
  };
  // 먹선 외곽이 있는 굵은 팔다리
  const limb = (pts, w, color) => {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const [c, lw] of [[INK, w + ink * 2], [color, w]]) {
      ctx.strokeStyle = c; ctx.lineWidth = lw;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.restore();
  };

  ctx.save();
  ctx.globalAlpha = alpha;
  if (tilt) {
    const foot = P(0, 0.45);
    ctx.translate(foot.x, foot.y);
    ctx.rotate(tilt);
    ctx.translate(-foot.x, -foot.y);
  }
  const ink = Math.max(1.5, s * 0.0065);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink;

  // 등 뒤의 붉은 기운 — 어두운 배경에서 실루엣을 떼어냄
  const c0 = P(0, -0.08);
  const aura = ctx.createRadialGradient(c0.x, c0.y, s * 0.05, c0.x, c0.y, s * 0.62);
  aura.addColorStop(0, `rgba(${PAL.enemy},${0.2 + flash * 0.25})`);
  aura.addColorStop(1, `rgba(${PAL.enemy},0)`);
  ctx.fillStyle = aura;
  ctx.beginPath(); ctx.arc(c0.x, c0.y, s * 0.62, 0, Math.PI * 2); ctx.fill();

  // 바닥 그림자
  const gs = P(0, 0.45);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath(); ctx.ellipse(gs.x, gs.y, s * 0.27, s * 0.035, 0, 0, Math.PI * 2); ctx.fill();

  // 허리끈 자락: 등 뒤에서 바람에 날림
  for (const [ph, len, dy] of [[0, 0.26, 0], [1.7, 0.2, 0.035]]) {
    const top = [], bot = [];
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const x = 0.08 + u * len;
      const y = 0.03 + dy + u * 0.1 + Math.sin(t * 4.2 - u * 5 + ph) * 0.03 * u;
      const w = 0.02 * (1 - u * 0.55);
      top.push([x, y - w]); bot.unshift([x, y + w]);
    }
    shape([...top, ...bot], cel(0.08, 0.08 + len, sash, 0.2, 0.6));
  }

  // 발 (하카마 아래로 살짝)
  ctx.fillStyle = iron[2];
  for (const x of [-0.13, 0.13]) {
    const f = P(x, 0.44);
    ctx.beginPath(); ctx.ellipse(f.x, f.y, s * 0.04, s * 0.018, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  // 하카마: 넓게 퍼진 바지, 밑단이 살랑거림
  const hem = (x) => 0.42 + Math.sin(t * 3 + x * 18) * 0.006;
  shape([
    [-0.11, 0.02], [0.11, 0.02], [0.235, hem(0.235)], [0.035, hem(0.035)], [0, 0.27],
    [-0.035, hem(-0.035)], [-0.235, hem(-0.235)],
  ], cel(-0.235, 0.235, cloth, 0.3, 0.62));
  // 주름
  lines([
    [[-0.07, 0.04], [-0.165, 0.41]], [[-0.03, 0.04], [-0.09, 0.41]],
    [[0.03, 0.04], [0.09, 0.41]], [[0.07, 0.04], [0.165, 0.41]],
  ], cloth[2], ink * 0.8);

  // 쿠사즈리: 허리에서 늘어진 미늘 판 3장
  for (const j of [-1, 0, 1]) {
    const cx = j * 0.083, top = 0.02, bot = j ? 0.165 : 0.175;
    const wt = 0.041, wb = 0.047;
    const col = j < 0 ? lacq[0] : j === 0 ? lacq[1] : lacq[2];
    shape([[cx - wt, top], [cx + wt, top], [cx + wb + j * 0.008, bot], [cx - wb + j * 0.008, bot]], col);
    const bands = [];
    for (const f of [0.33, 0.62]) { const y = top + (bot - top) * f; bands.push([[cx - wt - 0.003, y], [cx + wb, y]]); }
    lines(bands, INK, ink * 0.7);
    lines([[[cx - 0.015, top], [cx - 0.015 + j * 0.003, bot]], [[cx + 0.015, top], [cx + 0.015 + j * 0.003, bot]]], lace, ink * 0.6);
  }

  // 깃: 갑옷 위로 보이는 흰 속옷 깃
  shape([[-0.055, -0.318], [0.055, -0.318], [0.028, -0.25], [-0.028, -0.25]], tone(SAM.collar));
  shape([[-0.022, -0.318], [0.022, -0.318], [0, -0.262]], cloth[1]);

  // 도: 가슴 갑옷 (가운데 V홈, 허리로 좁아짐) + 미늘 띠와 금색 끈
  ctx.beginPath();
  const dTL = P(-0.13, -0.285), dTR = P(0.13, -0.285), dBR = P(0.1, 0.005), dBL = P(-0.1, 0.005);
  ctx.moveTo(dTL.x, dTL.y);
  for (const q of [[-0.036, -0.285], [0, -0.252], [0.036, -0.285]]) { const p = P(...q); ctx.lineTo(p.x, p.y); }
  ctx.lineTo(dTR.x, dTR.y);
  const cR = P(0.138, -0.14), cL = P(-0.138, -0.14);
  ctx.quadraticCurveTo(cR.x, cR.y, dBR.x, dBR.y);
  ctx.lineTo(dBL.x, dBL.y);
  ctx.quadraticCurveTo(cL.x, cL.y, dTL.x, dTL.y);
  ctx.closePath();
  ctx.fillStyle = cel(-0.13, 0.13, lacq, 0.3, 0.66);
  ctx.fill(); ctx.stroke();
  // 윗판(무나이타)
  shape([[-0.13, -0.285], [-0.036, -0.285], [0, -0.252], [0.036, -0.285], [0.13, -0.285], [0.132, -0.25], [-0.132, -0.25]],
    cel(-0.13, 0.13, iron, 0.3, 0.66));
  const bandY = [-0.2, -0.145, -0.09, -0.04];
  lines(bandY.map((y) => { const w = 0.132 - (y + 0.25) * 0.11; return [[-w, y], [w, y]]; }), INK, ink * 0.7);
  const laces = [];
  for (const x of [-0.085, -0.045, 0, 0.045, 0.085]) laces.push([[x, -0.25], [x * 0.82, 0]]);
  lines(laces, lace, ink * 0.55);
  // 옻칠 광택
  ctx.save();
  ctx.globalAlpha *= 0.35;
  shape([[-0.105, -0.235], [-0.08, -0.235], [-0.07, -0.03], [-0.085, -0.03]], '#ffffff');
  ctx.restore();

  // 오비
  shape([[-0.104, -0.005], [0.104, -0.005], [0.108, 0.03], [-0.108, 0.03]], cel(-0.108, 0.108, cloth, 0.3, 0.66));
  lines([[[-0.104, 0.012], [0.106, 0.012]]], sash[1], ink * 1.1);

  // 얼굴: 삿갓 그늘 속 어두운 얼굴 + 철가면 + 붉게 빛나는 눈
  shape([[-0.042, -0.41], [0.042, -0.41], [0.046, -0.36], [0.03, -0.322], [-0.03, -0.322], [-0.046, -0.36]], tone(SAM.face));
  shape([[-0.045, -0.365], [0.045, -0.365], [0.03, -0.322], [-0.03, -0.322]], cel(-0.045, 0.045, iron, 0.3, 0.65));
  lines([[[-0.018, -0.345], [0.018, -0.345]], [[-0.012, -0.333], [0.012, -0.333]]], INK, ink * 0.6);
  ctx.save();
  ctx.shadowColor = `rgba(${PAL.enemy},1)`;
  ctx.shadowBlur = s * 0.03;
  ctx.fillStyle = `rgb(${PAL.enemyCore})`;
  for (const x of [-0.019, 0.019]) {
    const e = P(x, -0.385);
    ctx.beginPath(); ctx.ellipse(e.x, e.y, s * 0.011, s * 0.004, x < 0 ? 0.25 : -0.25, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  // 삿갓: 왼쪽 면은 밝게, 오른쪽 면은 그늘 + 짚 결
  const apex = [0, -0.545], bL = [-0.185, -0.4], bR = [0.185, -0.4], bC = [0, -0.388];
  shape([apex, bR, [0.09, -0.392], bC, [-0.09, -0.392], bL], straw[1]);
  shape([apex, bL, [-0.09, -0.392], bC], straw[0]);
  shape([apex, bR, [0.09, -0.392], bC], straw[2]);
  const weave = [];
  for (const u of [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75]) weave.push([[0, -0.535], [0.185 * u, -0.397 + Math.abs(u) * -0.003]]);
  lines(weave, straw[2], ink * 0.5);
  lines([[[-0.16, -0.408], [0.16, -0.408]]], straw[2], ink * 0.5);
  // 꼭지
  const ap = P(...apex);
  ctx.fillStyle = straw[2];
  ctx.beginPath(); ctx.arc(ap.x, ap.y, s * 0.009, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // 팔 → 칼자루: 넓은 소매(위팔) + 철 토시(아래팔)
  const shL = P(-0.125, -0.255), shR = P(0.125, -0.255);
  for (const sh of [shR, shL]) {
    const el = lerpPt(sh, blade.a, 0.5);
    el.y += s * 0.04;
    limb([el, blade.a], s * 0.042, iron[1]);
    limb([sh, el], s * 0.07, cloth[sh === shL ? 0 : 1]);
  }

  // 소데: 어깨 판
  for (const side of [-1, 1]) {
    const o = (x) => x * side;
    const pts = [[o(0.085), -0.295], [o(0.18), -0.275], [o(0.198), -0.155], [o(0.112), -0.168]];
    shape(pts, side < 0 ? lacq[0] : lacq[2]);
    lines([0.33, 0.62].map((f) => [[o(0.085 + 0.027 * f), -0.295 + 0.127 * f], [o(0.18 + 0.018 * f), -0.275 + 0.12 * f]]), INK, ink * 0.7);
    lines([[[o(0.12), -0.287], [o(0.14), -0.163]], [[o(0.155), -0.281], [o(0.172), -0.158]]], lace, ink * 0.55);
  }

  // 칼: 붉은 날 + 코등이 + 손잡이
  const d = norm({ x: blade.b.x - blade.a.x, y: blade.b.y - blade.a.y });
  const nv = { x: -d.y, y: d.x };
  const at = (k, w = 0) => ({ x: blade.a.x + d.x * k * s + nv.x * w * s, y: blade.a.y + d.y * k * s + nv.y * w * s });
  shape([at(-0.075, 0.012), at(0.03, 0.012), at(0.03, -0.012), at(-0.075, -0.012)], sash[2]);
  ctx.save();
  ctx.strokeStyle = lace; ctx.lineWidth = ink * 0.6;
  ctx.beginPath();
  for (let k = -0.07; k < 0.025; k += 0.024) {
    const p = at(k, 0.011), q = at(k + 0.024, -0.011), r = at(k, -0.011), u = at(k + 0.024, 0.011);
    ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.moveTo(r.x, r.y); ctx.lineTo(u.x, u.y);
  }
  ctx.stroke();
  ctx.restore();
  const tip = blade.b;
  const bl = Math.hypot(tip.x - blade.a.x, tip.y - blade.a.y) / s;
  const bladeGrad = ctx.createLinearGradient(blade.a.x, blade.a.y, tip.x, tip.y);
  bladeGrad.addColorStop(0, `rgb(${PAL.enemyCore})`);
  bladeGrad.addColorStop(1, `rgb(${PAL.enemy})`);
  ctx.save();
  ctx.shadowColor = `rgba(${PAL.enemy},0.95)`;
  ctx.shadowBlur = s * 0.035 + flash * 20;
  path([at(0.04, 0.013), at(bl - 0.06, 0.011), tip, at(bl - 0.025, -0.011), at(0.04, -0.013)]);
  ctx.fillStyle = bladeGrad;
  ctx.fill();
  ctx.restore();
  path([at(0.04, 0.013), at(bl - 0.06, 0.011), tip, at(bl - 0.025, -0.011), at(0.04, -0.013)]);
  ctx.stroke();
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(1, ink * 0.5);
  ctx.beginPath(); { const p = at(0.045, -0.004), q = at(bl - 0.03, -0.004); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
  ctx.stroke();
  ctx.restore();
  // 코등이
  const tb = at(0.035);
  ctx.save();
  ctx.translate(tb.x, tb.y);
  ctx.rotate(Math.atan2(d.y, d.x));
  ctx.fillStyle = iron[1];
  ctx.strokeStyle = lace;
  ctx.lineWidth = ink * 0.9;
  ctx.beginPath(); ctx.ellipse(0, 0, s * 0.011, s * 0.038, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();

  // 손 (칼자루를 쥔 주먹)
  for (const k of [-0.045, 0.005]) {
    const h = at(k);
    ctx.fillStyle = iron[0];
    ctx.beginPath(); ctx.arc(h.x, h.y, s * 0.024, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
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
      ctx.shadowBlur = 16;
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
      ctx.fillStyle = '#fff';
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
      ctx.shadowBlur = 6;
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
      ctx.shadowBlur = 16 + pulse * 14;
      ctx.strokeStyle = `rgb(${PAL.vital})`;
      ctx.lineWidth = 6 + pulse * 2;
      const span = (Math.PI / 2) * 0.85;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, V.arc - span / 2, V.arc + span / 2); ctx.stroke();
      // 남은 시간: 호 바깥쪽 얇은 선
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx * 1.1, ry * 1.1, 0, V.arc - (span / 2) * left, V.arc + (span / 2) * left); ctx.stroke();
      // 휘두를 방향 화살표 (바깥 → 안쪽)
      const p = this.vitalPos(geo);
      const d = V.dir;
      const n = { x: -d.y, y: d.x };
      const L = s * 0.16, back = s * 0.12 + pulse * s * 0.02;
      const tail = { x: p.x - d.x * (back + L), y: p.y - d.y * (back + L) };
      const head = { x: p.x - d.x * back * 0.35, y: p.y - d.y * back * 0.35 };
      ctx.lineWidth = 4;
      ctx.shadowBlur = 12;
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
      ctx.shadowBlur = 10 + near * 18;
      ctx.setLineDash([12, 10]);
      ctx.lineDashOffset = -this.clock / 20;
      ctx.strokeStyle = `rgba(${PAL.enemy},${0.35 + 0.35 * p + urgent * 0.25})`;
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
