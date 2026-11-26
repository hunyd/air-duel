// 칼: 손 위치 → 칼자루/칼날, One Euro Filter smoothing, 궤적, 스윕 충돌 판정
import { PAL, glow } from './palette.js';

export const SWORD_CONFIG = {
  bladePalm: 4.6,     // 칼 길이 = 손바닥 길이(px) × 이 값
  minLen: 0.17,       // 화면 짧은 변 대비 최소/최대 길이
  maxLen: 0.56,
  guardOffset: 0.3,   // 주먹 중심에서 코등이(날 시작점)까지 (손바닥 길이 배수)
  pommel: 0.22,       // 주먹 중심에서 손잡이 끝(새끼손가락 쪽)까지 (손바닥 길이 배수)
  gripTilt: 0.1,      // 칼이 주먹 축에서 손가락 쪽으로 기우는 정도 (0 = 주먹 축과 평행)
  gripDepth: 0.8,     // 칼자루 위치: 0 = 손등 관절(MCP) 줄, 1 = 말아 쥔 손가락 중간 관절(PIP) 줄
  slashIn: 1.15,      // 칼끝 속도(화면 대각선/초) 이상이면 SLASH
  slashOut: 0.7,      // 이 아래로 떨어지면 SLASH 종료
  guardSpeed: 0.32,   // 이 아래로 guardMs 이상 유지하면 GUARD
  guardMs: 150,
  jumpDiag: 0.38,     // 한 프레임에 칼끝이 이만큼 튀면 추적 오류로 보고 스윕을 끊음
  maxGapMs: 160,      // 결과 간격이 이보다 길면 이전 위치와 연결하지 않음
  trailMs: 140,
  minForeshorten: 0.32, // 검지가 카메라를 정면으로 향해도 칼이 이 비율 이하로 짧아지지 않음
  depthSmooth: 0.45,    // 깊이·면 방향 smoothing (0~1, 클수록 빠르게 따라감)
  // 찌르기: 주먹이 카메라 쪽으로 빠르게 다가옴(화면 속 손이 빠르게 커짐) + 칼끝이 화면 안쪽을 향함
  thrustRate: 1.2,      // 손 크기 증가율(ln/초) 이 값 이상이면 찌르기
  thrustWindowMs: 140,  // 증가율을 재는 구간
  thrustDepth: -0.15,   // 칼 방향 z가 이 값 이하(카메라 쪽)여야 함 — 옆으로 든 칼로 앞으로 밀기는 제외
  thrustCooldown: 350,
  depthInvert: true,    // true: 칼끝을 카메라(모니터) 쪽으로 겨누면 화면 '안쪽'으로 들어가 보임 (플레이어 시점)
  depthGain: 1.35,      // 기울기 효과 증폭 (1 = 실제 각도 그대로)
  euro: { minCutoff: 1.4, beta: 0.012, dCutoff: 1.0 },
};

const C = SWORD_CONFIG;

// ---------- 기하 유틸 ----------
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const lerpPt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross3 = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm3 = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };

export function segDist(p, a, b) {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  let t = l2 ? ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function segIntersect(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

export function segSegDist(a, b, c, d) {
  if (segIntersect(a, b, c, d)) return 0;
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
}

function pointInTri(p, a, b, c) {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function triCircle(a, b, c, p, r) {
  return pointInTri(p, a, b, c) || segDist(p, a, b) <= r || segDist(p, b, c) <= r || segDist(p, c, a) <= r;
}

// 이전 칼 선분(h0-t0) → 현재 칼 선분(h1-t1)이 쓸고 지나간 영역과 원의 충돌
export function sweepHitsCircle(sw, p, r) {
  return triCircle(sw.h0, sw.t0, sw.t1, p, r) || triCircle(sw.h0, sw.t1, sw.h1, p, r);
}

// 칼날 방향 각도 차 (방향 무관, 0~90°)
export function angleDiff180(a, b) {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

// ---------- One Euro Filter ----------
class OneEuro {
  constructor({ minCutoff, beta, dCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() { this.x = null; }
  static alpha(dt, cutoff) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.dx = 0; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const ad = OneEuro.alpha(dt, this.dCutoff);
    this.dx = ad * ((x - this.x) / dt) + (1 - ad) * this.dx;
    const a = OneEuro.alpha(dt, this.minCutoff + this.beta * Math.abs(this.dx));
    this.x = a * x + (1 - a) * this.x;
    return this.x;
  }
}

// ---------- Sword ----------
export class Sword {
  constructor() {
    this.filters = [0, 1, 2, 3].map(() => new OneEuro(C.euro));
    this.active = false;
    this.dir = { x: 0, y: -1 };
    this.sweeps = [];      // game.js가 소비
    this.thrusts = [];     // 찌르기 이벤트 (game.js가 소비)
    this.sizeHist = [];    // [ts, palmPx] — 찌르기 감지용
    this.approach = 0;     // 손이 카메라로 다가오는 속도 (ln/초)
    this.thrustUntil = 0;
    this.lastThrust = -1e9;
    this.thrusting = false;
    this.debugSweeps = []; // 디버그 시각화용
    this.trail = [];
    this.segId = 0;
    this.swingId = 0;
    this.slashing = false;
    this.guarding = false;
    this.guardSince = 0;
    this.speed = 0;
    this.vel = { x: 0, y: 0 };
    this.angle = -90;
    this.len = 0;
    this.prev = null;
    this.prevRawTip = null;
    this.lastTs = 0;
  }

  detectThrust(ts, palmPx) {
    this.sizeHist.push([ts, palmPx]);
    while (this.sizeHist.length > 2 && ts - this.sizeHist[1][0] >= C.thrustWindowMs) this.sizeHist.shift();
    const [t0, p0] = this.sizeHist[0];
    const dt = (ts - t0) / 1000;
    this.approach = dt > 0.03 ? Math.log(palmPx / p0) / dt : 0;
    if (this.approach > C.thrustRate && this.depth < C.thrustDepth && ts - this.lastThrust > C.thrustCooldown) {
      this.lastThrust = ts;
      this.thrustUntil = ts + 220;
      this.thrusts.push({ ts, tip: this.tip, hilt: this.hilt, base: this.base });
      if (this.thrusts.length > 4) this.thrusts.shift();
    }
  }

  breakChain() {
    this.filters.forEach((f) => f.reset());
    this.sizeHist = [];
    this.approach = 0;
    this.prev = null;
    this.prevRawTip = null;
    this.segId++;
  }

  hide(ts) {
    if (this.active || this.prev) this.breakChain();
    this.active = false;
    this.slashing = false;
    this.guarding = false;
    this.guardSince = 0;
    this.speed = 0;
    this.lastTs = ts;
  }

  // pts: 화면 좌표(px)로 변환된 21개 랜드마크, 칼을 쥐지 않았으면 null
  // world: 3D world landmarks (손 기울기 → 칼의 깊이감)
  update(pts, ts, view, world = null) {
    if (!pts) { this.hide(ts); return; }

    // 주먹으로 칼 쥐기: 칼은 말아 쥔 손가락 '터널'을 관통한다.
    // → 칼 방향 = 새끼 뿌리(17) → 검지 뿌리(5) 축 (엄지·검지 쪽으로 칼이 나옴)
    //   + 손가락 쪽(손목→중지 뿌리)으로 살짝 기울임 (실제 쥐는 각도)
    // 칼자루 위치 = 손등 관절(MCP)이 아니라 말아 쥔 손가락 안쪽(PIP 관절 쪽) — 실제로 칼이 지나가는 곳
    const avg = (ids) => mul(ids.reduce((acc, i) => add(acc, pts[i]), { x: 0, y: 0 }), 1 / ids.length);
    const fistCenter = lerpPt(avg([5, 9, 13, 17]), avg([6, 10, 14, 18]), C.gripDepth);
    const palmPx = Math.max(dist(pts[0], pts[9]), dist(pts[5], pts[17]) * 1.3);
    const axis = sub(lerpPt(pts[5], pts[6], C.gripDepth), lerpPt(pts[17], pts[18], C.gripDepth));
    const fwd = norm(sub(pts[9], pts[0]));
    const grip = add(axis, mul(fwd, len(axis) * C.gripTilt));
    // 주먹 축이 카메라를 향해 짧게 보이면 이전 방향 유지
    if (len(axis) > palmPx * 0.18) this.dir = norm(grip);

    const minWH = Math.min(view.W, view.H);
    const fullLen = Math.max(C.minLen * minWH, Math.min(C.maxLen * minWH, palmPx * C.bladePalm));

    const gap = ts - this.lastTs;
    let broken = !this.active || gap > C.maxGapMs;

    // 3D 기울기: depth = 칼 방향의 z 성분(-1 카메라 쪽 ~ +1 화면 안쪽), face = 손바닥(=칼 면)이 카메라를 보는 정도
    let depth = 0, face = 1, faceSign = 1;
    if (world) {
      const mid3 = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
      const ax = norm3(sub3(mid3(world[5], world[6], C.gripDepth), mid3(world[17], world[18], C.gripDepth)));
      const fw = norm3(sub3(world[9], world[0]));
      const f = norm3({ x: ax.x + fw.x * C.gripTilt, y: ax.y + fw.y * C.gripTilt, z: ax.z + fw.z * C.gripTilt });
      depth = f.z;
      const n = norm3(cross3(sub3(world[5], world[0]), sub3(world[17], world[0])));
      face = Math.abs(n.z);
      faceSign = n.z >= 0 ? 1 : -1;
    }
    const k = broken || this.depth === undefined ? 1 : C.depthSmooth;
    this.depth = this.depth === undefined || broken ? depth : this.depth + (depth - this.depth) * k;
    this.face = this.face === undefined || broken ? face : this.face + (face - this.face) * k;
    this.faceSign = faceSign;
    // 원근 단축: 카메라 쪽/안쪽으로 기울수록 화면상 칼이 짧아짐
    const dz = Math.max(-1, Math.min(1, this.depth * C.depthGain));
    const planar = Math.sqrt(Math.max(0, 1 - dz * dz));
    const L = fullLen * Math.max(C.minForeshorten, planar);
    const shrink = Math.max(C.minForeshorten, planar);
    const palmCenter = fistCenter;
    const tipRaw = add(palmCenter, mul(this.dir, L));
    if (!broken && this.prevRawTip && dist(tipRaw, this.prevRawTip) / view.diag > C.jumpDiag) broken = true;
    if (broken) this.breakChain();
    this.prevRawTip = tipRaw;

    const t = ts / 1000;
    const hilt = { x: this.filters[0].filter(palmCenter.x, t), y: this.filters[1].filter(palmCenter.y, t) };
    let tip = { x: this.filters[2].filter(tipRaw.x, t), y: this.filters[3].filter(tipRaw.y, t) };
    const dir = norm(sub(tip, hilt));
    tip = add(hilt, mul(dir, L));
    const base = add(hilt, mul(dir, palmPx * C.guardOffset * shrink));

    if (this.prev && gap > 0) {
      this.vel = mul(sub(tip, this.prev.tip), 1000 / gap);
      this.speed = len(this.vel) / view.diag;
    } else {
      this.vel = { x: 0, y: 0 };
      this.speed = 0;
    }

    const wasSlashing = this.slashing;
    if (!this.slashing && this.speed > C.slashIn) this.slashing = true;
    else if (this.slashing && this.speed < C.slashOut) this.slashing = false;
    if (this.slashing && !wasSlashing) this.swingId++;

    if (this.speed < C.guardSpeed) {
      if (!this.guardSince) this.guardSince = ts;
      this.guarding = ts - this.guardSince >= C.guardMs;
    } else {
      this.guardSince = 0;
      this.guarding = false;
    }

    if (this.prev) {
      const sw = {
        h0: this.prev.base, t0: this.prev.tip, h1: base, t1: tip,
        slashing: this.slashing, speed: this.speed, vel: this.vel, swingId: this.swingId, ts,
      };
      this.sweeps.push(sw);
      if (this.sweeps.length > 8) this.sweeps.shift();
      this.debugSweeps.push(sw);
      if (this.debugSweeps.length > 6) this.debugSweeps.shift();
    }

    this.trail.push({ a: lerpPt(base, tip, 0.3), b: tip, ts, speed: this.speed, seg: this.segId });
    if (this.trail.length > 24) this.trail.shift();

    Object.assign(this, { hilt, base, tip, len: L, fullLen, palmPx, active: true, lastTs: ts });
    this.angle = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
    this.prev = { base, tip };
    this.detectThrust(ts, palmPx);
    this.thrusting = ts < this.thrustUntil;
  }

  render(ctx, view, now, debug) {
    ctx.clearRect(0, 0, view.W, view.H);

    // 베기 궤적: 칼끝이 지나간 길을 따라 휘어진 초승달 띠 (오래된 쪽일수록 가늘게)
    this.trail = this.trail.filter((p) => now - p.ts < C.trailMs);
    const tr = this.trail;
    for (let i = 1; i < tr.length; i++) {
      const p0 = tr[i - 1], p1 = tr[i];
      if (p0.seg !== p1.seg) continue;
      const age0 = (now - p0.ts) / C.trailMs, age1 = (now - p1.ts) / C.trailMs;
      const k = Math.min(1, p1.speed / C.slashIn);
      const alpha = (1 - age1) * k * 0.6;
      if (alpha <= 0.01) continue;
      const in0 = lerpPt(p0.b, p0.a, (1 - age0) * 0.55), in1 = lerpPt(p1.b, p1.a, (1 - age1) * 0.55);
      ctx.fillStyle = `rgba(${p1.tint || PAL.player},${alpha})`; // tint: 무효 공격 등에서 궤적 색 덮어쓰기
      ctx.beginPath();
      ctx.moveTo(in0.x, in0.y);
      ctx.lineTo(p0.b.x, p0.b.y);
      ctx.lineTo(p1.b.x, p1.b.y);
      ctx.lineTo(in1.x, in1.y);
      ctx.closePath();
      ctx.fill();
    }
    // 바깥 가장자리: 칼끝을 매끄럽게 잇는 밝은 곡선
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = `rgba(${PAL.player},1)`;
    ctx.shadowBlur = glow(12);
    for (let i = 2; i < tr.length; i++) {
      const a = tr[i - 2], b = tr[i - 1], c = tr[i];
      if (a.seg !== c.seg) continue;
      const k = Math.min(1, c.speed / C.slashIn);
      const fade = 1 - (now - c.ts) / C.trailMs;
      if (k * fade <= 0.02) continue;
      const m0 = lerpPt(a.b, b.b, 0.5), m1 = lerpPt(b.b, c.b, 0.5);
      ctx.strokeStyle = `rgba(${c.tint || PAL.playerCore},${k * fade})`;
      ctx.lineWidth = 1 + 3 * fade;
      ctx.beginPath();
      ctx.moveTo(m0.x, m0.y);
      ctx.quadraticCurveTo(b.b.x, b.b.y, m1.x, m1.y);
      ctx.stroke();
    }
    ctx.restore();

    if (this.active) {
      const { base, tip, hilt } = this;
      const d = norm(sub(tip, base));
      const n = { x: -d.y, y: d.x };
      const w = Math.max(4, (this.fullLen || this.len) * 0.032);

      ctx.save();
      ctx.shadowColor = `rgba(${PAL.player},0.95)`;
      ctx.shadowBlur = glow(this.slashing ? 28 : this.guarding ? 20 : 14);

      // 손잡이: 짧고 어둡게(남색) + 감은 끈 무늬 → 청백 칼날과 확실히 구분
      const pom = { x: hilt.x - d.x * this.palmPx * C.pommel, y: hilt.y - d.y * this.palmPx * C.pommel };
      const hw = w * 0.85;
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(20,30,58,0.92)';
      ctx.strokeStyle = `rgba(${PAL.playerCore},0.85)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pom.x + n.x * hw, pom.y + n.y * hw);
      ctx.lineTo(base.x + n.x * hw, base.y + n.y * hw);
      ctx.lineTo(base.x - n.x * hw, base.y - n.y * hw);
      ctx.lineTo(pom.x - n.x * hw, pom.y - n.y * hw);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 끈 무늬 (X자)
      const gl = dist(pom, base);
      const wraps = Math.max(2, Math.round(gl / (hw * 2.2)));
      ctx.strokeStyle = `rgba(${PAL.player},0.75)`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < wraps; i++) {
        const p0 = lerpPt(pom, base, i / wraps), p1 = lerpPt(pom, base, (i + 1) / wraps);
        ctx.moveTo(p0.x + n.x * hw, p0.y + n.y * hw); ctx.lineTo(p1.x - n.x * hw, p1.y - n.y * hw);
        ctx.moveTo(p0.x - n.x * hw, p0.y - n.y * hw); ctx.lineTo(p1.x + n.x * hw, p1.y + n.y * hw);
      }
      ctx.stroke();
      // 손잡이 끝 마개
      ctx.fillStyle = `rgb(${PAL.playerCore})`;
      ctx.beginPath(); ctx.arc(pom.x, pom.y, hw * 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // 날: 손바닥이 카메라를 볼수록 칼 면이 넓게, 옆으로 세우면 날 끝(edge)만 얇게
      // 원근(persp): +면 칼끝이 플레이어 쪽으로 튀어나옴(굵고 밝게), -면 화면 안쪽으로 들어감(가늘고 흐리게)
      const raw = this.depth || 0;
      // MediaPipe z는 카메라에 가까울수록 음수. 기본(-raw)은 '카메라 쪽 = 튀어나옴', 반전 시 '카메라 쪽 = 화면 안쪽'
      const persp = Math.max(-1, Math.min(1, (C.depthInvert ? raw : -raw) * C.depthGain));
      const faceW = 0.35 + 0.75 * (this.face ?? 1);
      const tipScale = Math.max(0.22, Math.min(2.4, 1 + persp * 1.4));
      const wb = w * 0.55 * faceW * Math.max(0.8, 1 - persp * 0.25); // 손 쪽은 반대로 약간
      const wt = w * 0.42 * faceW * tipScale;
      const nearTip = add(tip, mul(d, -Math.max(w * 2, wt * 4)));
      const baseA = Math.max(0.7, Math.min(1, 0.95 + persp * 0.1));
      const tipA = Math.max(0.18, Math.min(1, 0.92 + persp * 0.75)); // 안쪽으로 갈수록 칼끝이 안개처럼 흐려짐
      const lit = this.faceSign > 0;
      // 두 면을 다른 색으로(밝은 면 = 흰빛, 어두운 면 = 푸른빛) + 칼자루→칼끝 그라데이션으로 깊이감
      const half = (side, k) => {
        const lightSide = k === 1;
        const grd = ctx.createLinearGradient(base.x, base.y, tip.x, tip.y);
        grd.addColorStop(0, `rgba(${lightSide ? PAL.playerCore : PAL.player},${baseA})`);
        grd.addColorStop(1, `rgba(${lightSide ? '200,232,255' : PAL.player},${tipA * (lightSide ? 1 : 0.85)})`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(base.x + n.x * wb * side, base.y + n.y * wb * side);
        ctx.lineTo(nearTip.x + n.x * wt * side, nearTip.y + n.y * wt * side);
        ctx.lineTo(tip.x, tip.y);
        ctx.closePath();
        ctx.fill();
      };
      half(1, lit ? 1 : 0.62);
      half(-1, lit ? 0.62 : 1);
      // 칼등 능선
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(255,255,255,${tipA})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      // 칼끝이 플레이어 쪽으로 튀어나오면 반짝임
      if (persp > 0.25) {
        const g = Math.min(1, (persp - 0.25) / 0.5);
        const r = wt * 3 + 6;
        const grd = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, r);
        grd.addColorStop(0, `rgba(255,255,255,${0.95 * g})`);
        grd.addColorStop(0.4, `rgba(${PAL.player},${0.6 * g})`);
        grd.addColorStop(1, `rgba(${PAL.player},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(tip.x, tip.y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.shadowBlur = glow(this.slashing ? 28 : 14);

      // 코등이: 손잡이와 날 사이의 둥근 원판
      ctx.save();
      ctx.translate(base.x, base.y);
      ctx.rotate(Math.atan2(d.y, d.x));
      ctx.fillStyle = 'rgba(20,30,58,0.95)';
      ctx.strokeStyle = `rgb(${PAL.playerCore})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, w * 0.75, w * 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.restore();
    }

    if (debug) {
      ctx.save();
      ctx.lineWidth = 1;
      for (const sw of this.debugSweeps) {
        if (now - sw.ts > 300) continue;
        ctx.strokeStyle = sw.slashing ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)';
        ctx.beginPath();
        ctx.moveTo(sw.h0.x, sw.h0.y);
        ctx.lineTo(sw.t0.x, sw.t0.y);
        ctx.lineTo(sw.t1.x, sw.t1.y);
        ctx.lineTo(sw.h1.x, sw.h1.y);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}
