// 1:1 대전 규칙 (For Honor식 3방향 가드). DOM·네트워크와 분리된 순수 로직.
// 각 클라이언트는 '자기 방어'에 대해 권한을 가진다: 상대 공격이 내 화면에서 착지하는 순간
// 내 가드/패링 상태로 결과를 판정하고, 결과와 내 HP를 상대에게 보낸다.

export const VS_CONFIG = {
  slashWindup: 550,    // 베기 예고 시간(ms): 상대 화면에 방향 표시 후 착지까지
  thrustWindup: 800,   // 찌르기(가드 브레이크) 예고 시간
  parryWindow: 280,    // 착지 직전 이 시간 안에 같은 방향으로 맞받아 베면 패링
  attackCooldown: 700, // 공격 후 다음 공격까지
  slashDamage: 12,
  thrustDamage: 6,
  stunMs: 1000,        // 패링당하거나 가드가 깨지면 경직
  openBonus: 1.5,      // 경직 중 맞으면 데미지 배수
  guardTilt: 25,       // 칼을 수직에서 이 각도 이상 기울이면 좌/우 가드, 아니면 위 가드
  guardHyst: 8,        // 가드 경계에서 떨림 방지
  hp: 100,
  winsNeeded: 2,
};

const C = VS_CONFIG;

// 상대와 마주 보고 있으므로 내 왼쪽 공격은 상대 화면에서 오른쪽에서 들어온다
export const flipSide = (s) => (s === 'LEFT' ? 'RIGHT' : s === 'RIGHT' ? 'LEFT' : s);

// 칼 각도(칼자루→칼끝, 화면 기준 deg) → 가드 방향
export function guardFromAngle(angleDeg, prev) {
  const r = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(r), dy = Math.sin(r);
  if (dy < -0.25) {
    // 칼끝이 위: 수직 기준 기울기 (음수 = 왼쪽으로 기움)
    const theta = (Math.atan2(dx, -dy) * 180) / Math.PI;
    let g = theta < -C.guardTilt ? 'LEFT' : theta > C.guardTilt ? 'RIGHT' : 'TOP';
    if (prev && g !== prev && Math.abs(Math.abs(theta) - C.guardTilt) < C.guardHyst) g = prev;
    return g;
  }
  // 칼끝이 옆/아래: 칼끝이 향한 쪽
  return dx < 0 ? 'LEFT' : 'RIGHT';
}

// 휘두른 방향 → 공격 방향 (왼→오른쪽 베기 = 왼쪽 공격, 위→아래 = 위 공격)
export function slashSide(vel) {
  const ax = Math.abs(vel.x), ay = Math.abs(vel.y);
  if (vel.y > 0 && ay > ax * 0.9) return 'TOP';
  if (ax > ay * 0.5) return vel.x > 0 ? 'LEFT' : 'RIGHT';
  return null; // 위로 올려베기는 공격으로 치지 않음
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
    this.stunnedUntil = 0;
    this.cooldownUntil = 0;
    this.incoming = [];       // 상대가 나에게 날린 공격
    this.outgoing = new Map(); // 내가 날린 공격 (결과 대기)
    this.lastSwing = -1;
    this.dead = false;
  }

  setFighting(f) {
    this.fighting = f;
    if (!f) { this.incoming = []; this.outgoing.clear(); }
  }

  stunned(ts) { return ts < this.stunnedUntil; }
  emit(e) { this.events.push(e); }
  canAttack(ts) { return this.fighting && !this.dead && !this.stunned(ts) && ts >= this.cooldownUntil; }

  // 추론 결과마다 호출
  onSword(sword, ts) {
    this.guard = sword.active && !this.stunned(ts) ? guardFromAngle(sword.angle, this.guard) : null;
    const thrusts = sword.thrusts.splice(0);
    if (!this.fighting || this.dead) return;
    if (sword.slashing && sword.swingId !== this.lastSwing) {
      this.lastSwing = sword.swingId;
      const side = slashSide(sword.vel);
      if (side) this.onSlash(side, ts);
    }
    if (thrusts.length) this.onThrust(ts);
  }

  onSlash(side, ts) {
    // 같은 방향에서 들어오는 공격이 착지 직전이면 맞받아 베기 = 패링
    const inc = this.incoming.find((a) => a.kind === 'slash' && !a.parried && a.side === side && a.impactAt - ts <= C.parryWindow);
    if (inc) {
      inc.parried = true;
      this.emit({ type: 'parryArm', side });
      return;
    }
    this.launch('slash', side, ts);
  }

  onThrust(ts) {
    // 상대 찌르기에 찌르기로 받아치면 상쇄
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
      if (m.outcome === 'parry') this.stunnedUntil = ts + C.stunMs;
      this.emit({ type: 'attackResult', outcome: m.outcome, dmg: m.dmg, side: atk?.side, kind: atk?.kind });
    } else if (m.t === 'pose') {
      this.opp = m;
      if (typeof m.hp === 'number') this.oppHp = m.hp;
    }
  }

  // 매 프레임: 착지한 공격 판정
  update(ts) {
    if (!this.fighting) return;
    const due = this.incoming.filter((a) => a.impactAt <= ts);
    if (!due.length) return;
    this.incoming = this.incoming.filter((a) => a.impactAt > ts);
    for (const a of due) {
      const open = this.stunned(ts);
      let outcome, dmg = 0;
      if (a.kind === 'slash') {
        if (a.parried) outcome = 'parry';
        else if (!open && this.guard === a.side) outcome = 'block';
        else { outcome = 'hit'; dmg = Math.round(C.slashDamage * (open ? C.openBonus : 1)); }
      } else if (a.countered) {
        outcome = 'counter';
      } else {
        outcome = 'break';
        dmg = C.thrustDamage;
        this.stunnedUntil = ts + C.stunMs;
      }
      if (this.dead) dmg = 0;
      this.hp = Math.max(0, this.hp - dmg);
      this.send({ t: 'res', id: a.id, outcome, dmg, hp: this.hp });
      this.emit({ type: 'defense', outcome, side: a.side, kind: a.kind, dmg });
      if (this.hp <= 0 && !this.dead) {
        this.dead = true;
        this.send({ t: 'dead' });
        this.emit({ type: 'dead' });
      }
    }
  }
}
