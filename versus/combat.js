// 1:1 대전 규칙 (For Honor식 3방향 가드). DOM·네트워크와 분리된 순수 로직.
// 각 클라이언트는 '자기 방어'에 대해 권한을 가진다: 상대 공격이 내 화면에서 착지하는 순간
// 내 가드/패링 상태로 결과를 판정하고, 결과와 내 HP를 상대에게 보낸다.
//
// 공격은 휘두르기가 끝났을 때 판정한다: 그 휘두르기의 최고 속도가 유효 범위(듄의 실드처럼
// 너무 느리지도 빠르지도 않은 구간)에 있어야 공격이 나가고, 방향은 칼끝의 전체 이동으로 정한다.

export const VS_CONFIG = {
  slashWindup: 700,    // 베기 예고 시간(ms): 상대 화면에 방향 표시 후 착지까지 (사람 반응 + 칼 기울이기 + 인식 지연)
  thrustWindup: 950,   // 찌르기(가드 브레이크) 예고 시간
  parryWindow: 300,    // 착지 직전 이 시간 안에 같은 방향으로 맞받아 베면 패링
  clashWindow: 300,    // 같은 방향 공격끼리 착지 시각이 이 안이면 서로 튕김
  attackCooldown: 650, // 공격 후 다음 공격까지

  // 휘두르기 속도 (칼끝 속도, 화면 대각선/초). sword.js의 slashIn(1.15)을 넘으면 '휘두르기'로 본다.
  speedMin: 1.6,       // 이보다 느리면 TOO SLOW
  speedMax: 4.2,       // 이보다 빠르면 TOO FAST
  speedGaugeMax: 6,    // 게이지 오른쪽 끝
  maxSwingMs: 450,     // 휘두르기가 이보다 길면 그 시점에 판정

  slashDamage: 12,
  thrustDamage: 6,
  crushRatio: 0.6,     // 스태미나가 바닥났을 때 막아도 들어오는 데미지 비율
  openBonus: 1.5,      // 스턴 중 맞으면 데미지 배수

  // 스턴 = 칼이 굳는 구간(freeze) + 실제 손 위치로 돌아가는 구간(recover). 합쳐서 0.6~0.7초 목표
  stun: {
    blocked: { freeze: 420, recover: 220 }, // 내 공격이 막힘
    parried: { freeze: 520, recover: 220 }, // 내 공격이 패링당함
    broken: { freeze: 480, recover: 220 },  // 내 가드가 찌르기에 깨짐
  },

  stamina: {
    max: 100,
    slash: 20, thrust: 28, block: 10, fizzle: 10, parry: 5,
    regen: 22,          // 초당 회복
    regenDelay: 500,    // 마지막 소모 후 회복 시작까지
    recoverAt: 35,      // 바닥난 뒤 이만큼 차야 다시 공격 가능
  },

  guardTop: 50,        // 칼날 중심이 과녁 중심에서 위쪽 ±이 각도 안에 있으면 위 가드, 그 밖은 좌/우
  guardHyst: 8,
  hp: 100,
  winsNeeded: 2,
};

const C = VS_CONFIG;

// 상대와 마주 보고 있으므로 내 왼쪽 공격은 상대 화면에서 오른쪽에서 들어온다
export const flipSide = (s) => (s === 'LEFT' ? 'RIGHT' : s === 'RIGHT' ? 'LEFT' : s);

// 가드 방향 = 칼날이 '어디에 놓였나': 칼날 중간점이 과녁 중심(center)에서 어느 쪽에 있는지.
// 손 위치와 칼 기울기가 함께 반영된다 (왼쪽으로 칼을 들어 올리면 LEFT, 머리 위로 가로 들면 TOP).
export function guardFromBlade(base, tip, center, prev) {
  const m = { x: (base.x + tip.x) / 2, y: (base.y + tip.y) / 2 };
  const theta = (Math.atan2(m.x - center.x, center.y - m.y) * 180) / Math.PI; // 0 = 바로 위, 음수 = 왼쪽, ±180 = 아래
  let g = theta < -C.guardTop ? 'LEFT' : theta > C.guardTop ? 'RIGHT' : 'TOP';
  if (prev && g !== prev && Math.abs(Math.abs(theta) - C.guardTop) < C.guardHyst) g = prev;
  return g;
}

// 휘두른 방향(칼끝 이동) → 공격 방향 (왼→오른쪽 = 왼쪽 공격, 위→아래 = 위 공격)
export function slashSide(v) {
  const ax = Math.abs(v.x), ay = Math.abs(v.y);
  if (v.y > 0 && ay > ax * 0.9) return 'TOP';
  if (ax > ay * 0.5) return v.x > 0 ? 'LEFT' : 'RIGHT';
  return null; // 위로 올려베기는 공격으로 치지 않음
}

// 최고 속도 → 'slow' | 'valid' | 'fast'
export function speedBand(peak) {
  return peak < C.speedMin ? 'slow' : peak > C.speedMax ? 'fast' : 'valid';
}

export class Combat {
  constructor(send) {
    this.send = send;
    this.events = [];
    this.opp = {};
    this.nextId = 1;
    this.fighting = false;
    this.reset();
  }

  reset() {
    this.hp = C.hp;
    this.oppHp = C.hp;
    this.guard = null;
    this.stunFreezeUntil = 0;
    this.stunnedUntil = 0;
    this.stunKind = null;
    this.cooldownUntil = 0;
    this.incoming = [];
    this.outgoing = new Map();
    this.swing = null;        // 진행 중인 휘두르기 { id, startTip, lastTip, peak, startTs }
    this.lastSwingId = -1;
    this.lastPeak = 0;        // 게이지 표시용: 마지막 휘두르기 최고 속도
    this.stamina = C.stamina.max;
    this.lastSpend = -1e9;
    this.exhausted = false;
    this.dead = false;
  }

  setFighting(f) {
    this.fighting = f;
    if (!f) { this.incoming = []; this.outgoing.clear(); this.swing = null; }
  }

  stunned(ts) { return ts < this.stunnedUntil; }
  frozen(ts) { return ts < this.stunFreezeUntil; }
  emit(e) { this.events.push(e); }
  canAttack(ts) { return this.fighting && !this.dead && !this.stunned(ts) && !this.exhausted && ts >= this.cooldownUntil; }

  stun(kind, ts) {
    const s = C.stun[kind];
    this.stunKind = kind;
    this.stunFreezeUntil = ts + s.freeze;
    this.stunnedUntil = ts + s.freeze + s.recover;
    this.swing = null;
    this.emit({ type: 'stun', kind, freezeUntil: this.stunFreezeUntil, until: this.stunnedUntil });
  }

  spend(cost, ts) {
    this.stamina = Math.max(0, this.stamina - cost);
    this.lastSpend = ts;
    if (this.stamina === 0 && !this.exhausted) {
      this.exhausted = true;
      this.emit({ type: 'exhausted' });
    }
  }

  regen(dt, ts) {
    if (ts - this.lastSpend < C.stamina.regenDelay) return;
    this.stamina = Math.min(C.stamina.max, this.stamina + C.stamina.regen * dt);
    if (this.exhausted && this.stamina >= C.stamina.recoverAt) {
      this.exhausted = false;
      this.emit({ type: 'recovered' });
    }
  }

  // 추론 결과마다 호출
  // center: 화면의 가드 과녁 중심 (상대 상체)
  onSword(sword, ts, center) {
    const stunned = this.stunned(ts);
    this.guard = sword.active && !stunned ? guardFromBlade(sword.base, sword.tip, center, this.guard) : null;
    const thrusts = sword.thrusts.splice(0);

    // 스턴 중(칼이 손 위치로 돌아가는 구간 포함)의 움직임은 휘두르기로 치지 않는다
    if (!this.fighting || this.dead || stunned || !sword.active) {
      this.swing = null;
      this.lastSwingId = sword.swingId;
      return;
    }

    if (sword.slashing && sword.swingId !== this.lastSwingId) {
      this.lastSwingId = sword.swingId;
      this.swing = { id: sword.swingId, startTip: sword.tip, lastTip: sword.tip, peak: sword.speed, startTs: ts };
    }
    if (this.swing) {
      this.swing.peak = Math.max(this.swing.peak, sword.speed);
      this.swing.lastTip = sword.tip;
      if (!sword.slashing || ts - this.swing.startTs > C.maxSwingMs) this.finishSwing(ts);
    }

    if (thrusts.length) this.onThrust(ts);
  }

  finishSwing(ts) {
    const sw = this.swing;
    this.swing = null;
    const side = slashSide({ x: sw.lastTip.x - sw.startTip.x, y: sw.lastTip.y - sw.startTip.y });
    if (!side) return;
    this.lastPeak = sw.peak;
    const band = speedBand(sw.peak);
    if (band !== 'valid') {
      this.spend(C.stamina.fizzle, ts);
      this.emit({ type: 'fizzle', reason: band, peak: sw.peak, side });
      return;
    }
    // 같은 방향에서 들어오는 공격이 착지 직전이면 맞받아 베기 = 패링
    const inc = this.incoming.find((a) => a.kind === 'slash' && !a.parried && a.side === side && a.impactAt - ts <= C.parryWindow);
    if (inc) {
      inc.parried = true;
      this.spend(C.stamina.parry, ts);
      this.emit({ type: 'parryArm', side });
      return;
    }
    this.launch('slash', side, ts);
  }

  onThrust(ts) {
    const inc = this.incoming.find((a) => a.kind === 'thrust' && !a.countered);
    if (inc) {
      inc.countered = true;
      this.emit({ type: 'counterArm' });
      return;
    }
    this.launch('thrust', 'CENTER', ts);
  }

  launch(kind, side, ts) {
    if (!this.canAttack(ts)) return;
    const windup = kind === 'slash' ? C.slashWindup : C.thrustWindup;
    const id = this.nextId++;
    this.outgoing.set(id, { id, kind, side, start: ts, impactAt: ts + windup });
    this.cooldownUntil = ts + C.attackCooldown;
    this.spend(kind === 'slash' ? C.stamina.slash : C.stamina.thrust, ts);
    this.send({ t: 'atk', id, kind, side, windup });
    this.emit({ type: 'launch', kind, side });
  }

  onMessage(m, ts) {
    if (m.t === 'atk') {
      if (!this.fighting) return;
      this.incoming.push({
        id: m.id, kind: m.kind, side: m.kind === 'slash' ? flipSide(m.side) : 'CENTER',
        start: ts, impactAt: ts + m.windup, windup: m.windup,
      });
      this.emit({ type: 'incoming', kind: m.kind });
    } else if (m.t === 'res') {
      const atk = this.outgoing.get(m.id);
      this.outgoing.delete(m.id);
      this.oppHp = m.hp;
      // 막히면 공격한 쪽이 스턴
      if (m.outcome === 'clash' && m.clashId != null) {
        const inc = this.incoming.find((a) => a.id === m.clashId);
        if (inc) inc.clashed = true;
      }
      if (m.outcome === 'block') this.stun('blocked', ts);
      else if (m.outcome === 'parry') this.stun('parried', ts);
      this.emit({ type: 'attackResult', outcome: m.outcome, dmg: m.dmg, side: atk?.side, kind: atk?.kind });
    } else if (m.t === 'pose') {
      this.opp = m;
      if (typeof m.hp === 'number') this.oppHp = m.hp;
    }
  }

  // 같은 방향(각자 기준)으로 동시에 휘두른 공격이 있으면 서로 튕김
  findClash(a) {
    if (a.kind !== 'slash') return null;
    for (const o of this.outgoing.values()) {
      if (o.kind === 'slash' && flipSide(o.side) === a.side && Math.abs(o.impactAt - a.impactAt) <= C.clashWindow) return o;
    }
    return null;
  }

  // 매 프레임: 스태미나 회복, 착지한 공격 판정
  update(ts, dt = 0) {
    if (!this.fighting) return;
    this.regen(dt, ts);
    const due = this.incoming.filter((a) => a.impactAt <= ts);
    if (!due.length) return;
    this.incoming = this.incoming.filter((a) => a.impactAt > ts);
    for (const a of due) {
      const open = this.stunned(ts);
      let outcome, dmg = 0, clashId;
      if (a.clashed) {
        outcome = 'clash'; // 상대가 먼저 튕김을 판정하고 알려 준 공격
      } else if (a.kind === 'slash') {
        const clash = this.findClash(a);
        if (clash) {
          outcome = 'clash';
          clashId = clash.id; // 상대도 내 이 공격을 튕김으로 처리하도록 알려 줌
          this.outgoing.delete(clash.id);
        } else if (a.parried) {
          outcome = 'parry';
        } else if (!open && this.guard === a.side) {
          if (this.exhausted) { outcome = 'crush'; dmg = Math.round(C.slashDamage * C.crushRatio); }
          else { outcome = 'block'; this.spend(C.stamina.block, ts); }
        } else {
          outcome = 'hit';
          dmg = Math.round(C.slashDamage * (open ? C.openBonus : 1));
        }
      } else if (a.countered) {
        outcome = 'counter';
      } else {
        outcome = 'break';
        dmg = C.thrustDamage;
        this.stun('broken', ts);
      }
      if (this.dead) dmg = 0;
      this.hp = Math.max(0, this.hp - dmg);
      this.send({ t: 'res', id: a.id, outcome, dmg, hp: this.hp, clashId });
      this.emit({ type: 'defense', outcome, side: a.side, kind: a.kind, dmg });
      if (this.hp <= 0 && !this.dead) {
        this.dead = true;
        this.send({ t: 'dead' });
        this.emit({ type: 'dead' });
      }
    }
  }
}
