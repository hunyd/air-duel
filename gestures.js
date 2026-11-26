// 제스처 판별: 3D world landmarks의 관절 각도 + 손바닥 크기로 정규화한 거리
// 상태: NONE / GRIP(주먹 = 칼 쥐기) / OPEN(손바닥 = 메뉴)
// SLASH / GUARD는 GRIP 상태에서 칼끝 속도로 sword.js가 판별한다.

export const GESTURE_CONFIG = {
  confirmMs: 250,     // 새 제스처 진입까지 유지 시간
  exitMs: 140,        // GRIP/OPEN → NONE 해제 시간 (명확한 해제만)
  graceMs: 110,       // 후보 제스처가 잠깐 깨져도 타이머 유지
  lostGraceMs: 220,   // 손이 잠깐 사라져도 상태 유지 (칼은 즉시 숨김)
  fistIn: 0.35,       // 네 손가락 펴짐(0~1)이 이 값 미만이면 접힘 — 진입 (엄지는 자유)
  fistHold: 0.55,     // 유지 조건 (완화: 휘두를 때 손가락이 살짝 풀려도 유지)
  openIn: 0.75,       // 펴짐 이 값 초과 — 손바닥 진입
  openHold: 0.6,
  thumbOpen: 0.5,     // 엄지 끝~검지 MCP 거리 / 손바닥 길이
  menuHoldMs: 650,    // 손바닥 유지 시 메뉴 열림
  angleWeight: 0.65,  // 펴짐 점수 = 각도 0.65 + 거리 0.35
};

const C = GESTURE_CONFIG;
const FINGERS = [
  [5, 6, 7, 8],     // index
  [9, 10, 11, 12],  // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];

const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const len3 = (v) => Math.hypot(v[0], v[1], v[2]);
const dist3 = (a, b) => len3(sub(a, b));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function angleDeg(u, v) {
  const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len3(u) * len3(v) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

export function handMetrics(world) {
  const w = world[0];
  const palm = dist3(w, world[9]) || 1e-6;
  const ext = FINGERS.map(([m, p, d, t]) => {
    // MCP/PIP/DIP 굽힘 각도 합: 곧게 펴면 ~20°, 주먹이면 ~250°
    const bend =
      angleDeg(sub(world[m], w), sub(world[p], world[m])) +
      angleDeg(sub(world[p], world[m]), sub(world[d], world[p])) +
      angleDeg(sub(world[d], world[p]), sub(world[t], world[d]));
    const angleExt = clamp01(1 - (bend - 30) / 170);
    const distExt = clamp01((dist3(world[t], w) / palm - 1.05) / 0.85);
    return C.angleWeight * angleExt + (1 - C.angleWeight) * distExt;
  });
  const thumb = dist3(world[4], world[5]) / palm;
  return { ext, thumb, palm, bends: ext };
}

export class GestureTracker {
  constructor() {
    this.state = 'NONE';
    this.stateSince = 0;
    this.cand = null;
    this.candSince = 0;
    this.candLast = 0;
    this.lastSeen = -1e9;
    this.lastTs = 0;
    this.frameDt = 33;
    this.raw = 'NONE';
    this.metrics = null;
    this.present = false;
  }

  classify(m) {
    const s = this.state;
    // 엄지 위치는 자유: 주먹 판정에 쓰지 않음
    const holding = s === 'GRIP';
    const curled = m.ext.filter((e) => e < (holding ? C.fistHold : C.fistIn)).length;
    const mean = m.ext.reduce((a, b) => a + b, 0) / 4;
    const isFist = holding ? curled >= 3 && mean < C.fistHold : curled === 4;
    const openT = s === 'OPEN' ? C.openHold : C.openIn;
    const isOpen = m.ext.every((e) => e > openT) && m.thumb > C.thumbOpen;
    return isOpen ? 'OPEN' : isFist ? 'GRIP' : 'NONE';
  }

  setState(s, since) {
    this.state = s;
    this.stateSince = since;
  }

  update(world, ts) {
    const dt = this.lastTs ? ts - this.lastTs : 33;
    this.lastTs = ts;
    this.frameDt = this.frameDt * 0.8 + dt * 0.2;

    if (!world) {
      this.present = false;
      this.metrics = null;
      if (this.state !== 'NONE' && ts - this.lastSeen > C.lostGraceMs) this.setState('NONE', ts);
      this.cand = null;
      return this.snapshot(ts);
    }

    this.present = true;
    this.lastSeen = ts;
    this.metrics = handMetrics(world);
    const raw = this.classify(this.metrics);
    this.raw = raw;

    // 느린 프레임에서도 타이머가 리셋되지 않도록 grace를 프레임 간격에 맞춰 늘림
    const grace = Math.max(C.graceMs, this.frameDt * 1.5);

    if (raw === this.state) {
      if (this.cand && ts - this.candLast > grace) this.cand = null;
    } else {
      if (this.cand === raw) {
        this.candLast = ts;
      } else if (!this.cand || ts - this.candLast > grace) {
        this.cand = raw;
        this.candSince = ts;
        this.candLast = ts;
      }
      if (this.cand === raw) {
        const need = raw === 'NONE' ? C.exitMs : C.confirmMs;
        if (ts - this.candSince >= need) {
          this.setState(raw, this.candSince);
          this.cand = null;
        }
      }
    }
    return this.snapshot(ts);
  }

  snapshot(ts) {
    const need = this.cand === 'NONE' ? C.exitMs : C.confirmMs;
    return {
      state: this.state,
      raw: this.raw,
      present: this.present,
      cand: this.cand,
      candProgress: this.cand ? Math.min(1, (ts - this.candSince) / need) : 0,
      // 손바닥을 처음 편 순간부터 누적
      openHeldMs: this.state === 'OPEN' ? ts - this.stateSince : this.cand === 'OPEN' ? ts - this.candSince : 0,
      metrics: this.metrics,
    };
  }
}
