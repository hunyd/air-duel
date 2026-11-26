// 연습 모드 봇: 사람 대전과 같은 Combat 규칙을 쓰고, 네트워크 대신 같은 페이지 안에서 메시지를 주고받는다.
// 사람처럼 반응 지연 후 가드를 맞추고(가끔 틀림), 가끔 패링·찌르기 상쇄를 하며, 방향을 바꿔 가며 공격한다.
import { Combat } from './combat.js';

export const BOT_CONFIG = {
  latencyMs: 40,             // 메시지 전달 지연 (네트워크 흉내)
  reactMs: [260, 420],       // 공격 예고를 보고 가드를 바꾸기까지
  guardSkill: 0.72,          // 올바른 방향으로 가드할 확률
  parryChance: 0.15,         // 막을 수 있을 때 패링을 시도할 확률
  thrustCounterChance: 0.5,  // 찌르기를 찌르기로 받아칠 확률
  attackEvery: [1100, 2300], // 공격 간격
  thrustChance: 0.15,        // 공격 중 찌르기 비율
  minStaminaToAttack: 30,
  idleGuardEvery: [700, 1600], // 공격이 없을 때 가드 자세를 바꾸는 간격
  poseHz: 15,
};

const B = BOT_CONFIG;
const SIDES = ['LEFT', 'TOP', 'RIGHT'];
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr, not) => { const c = arr.filter((x) => x !== not); return c[Math.floor(Math.random() * c.length)]; };

export class Bot {
  // deliver(m): 봇이 보낸 메시지를 플레이어 쪽 onMessage로 전달
  constructor(deliver) {
    this.deliver = deliver;
    this.c = new Combat((m) => setTimeout(() => this.deliver(m), B.latencyMs));
    this.plans = new Map(); // 들어온 공격 id → 반응 계획
    this.nextAttack = 0;
    this.nextIdleGuard = 0;
    this.lastSide = null;
    this.lastPose = 0;
  }

  // 플레이어가 보낸 메시지
  receive(m) {
    setTimeout(() => this.handle(m), B.latencyMs);
  }

  handle(m) {
    const now = performance.now();
    if (m.t === 'round') {
      if (m.phase === 'countdown') { this.c.reset(); this.c.setFighting(false); this.plans.clear(); }
      else if (m.phase === 'fight') { this.c.setFighting(true); this.c.guard = 'TOP'; this.nextAttack = now + rand(...B.attackEvery); }
      else this.c.setFighting(false);
    } else if (m.t === 'ping') {
      this.deliver({ t: 'pong', ts: m.ts });
    } else {
      this.c.onMessage(m, now);
    }
  }

  update(t, dt) {
    const c = this.c;
    c.events.length = 0; // 봇 쪽 이벤트(화면 효과)는 쓰지 않음
    if (c.fighting && !c.dead) {
      this.defend(t);
      this.attack(t);
    }
    c.update(t, dt);
    if (c.stunned(t)) c.guard = null;
    if (t - this.lastPose > 1000 / B.poseHz) {
      this.lastPose = t;
      this.deliver({ t: 'pose', guard: c.guard, angle: -90, active: true, hp: c.hp, stunned: c.stunned(t), exhausted: c.exhausted });
    }
  }

  defend(t) {
    const c = this.c;
    if (c.stunned(t)) return;
    let busy = false;
    for (const a of c.incoming) {
      let p = this.plans.get(a.id);
      if (!p) {
        const right = Math.random() < B.guardSkill;
        p = {
          at: a.start + rand(...B.reactMs),
          side: a.kind === 'slash' ? (right ? a.side : pick(SIDES, a.side)) : null,
          parry: a.kind === 'slash' && right && Math.random() < B.parryChance,
          counter: a.kind === 'thrust' && Math.random() < B.thrustCounterChance,
          done: false,
        };
        this.plans.set(a.id, p);
      }
      busy = true;
      if (t < p.at) continue;
      if (p.side) c.guard = p.side;
      // 패링: 착지 직전에 같은 방향으로 맞받아 벰
      if (p.parry && !p.done && a.impactAt - t <= 220) {
        p.done = true;
        a.parried = true;
        c.spend(5, t);
      }
      if (p.counter && !p.done) {
        p.done = true;
        c.onThrust(t);
      }
    }
    // 공격이 없을 때는 가끔 가드 자세를 바꿔서 상대가 노릴 방향을 고르게 함
    if (!busy && t > this.nextIdleGuard) {
      c.guard = pick(SIDES, c.guard);
      this.nextIdleGuard = t + rand(...B.idleGuardEvery);
    }
    for (const id of this.plans.keys()) if (!c.incoming.some((a) => a.id === id)) this.plans.delete(id);
  }

  attack(t) {
    const c = this.c;
    if (t < this.nextAttack || !c.canAttack(t) || c.stamina < B.minStaminaToAttack || c.incoming.length) return;
    this.nextAttack = t + rand(...B.attackEvery);
    if (Math.random() < B.thrustChance) {
      c.launch('thrust', 'CENTER', t);
    } else {
      this.lastSide = pick(SIDES, this.lastSide);
      c.launch('slash', this.lastSide, t);
    }
  }
}
