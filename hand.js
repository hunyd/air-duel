// 메인 화면의 내 손: 점·선 뼈대 대신 외곽선이 있는 손 형태로 그린다 (좌표는 손 인식 그대로).
// 획 몇 개만 쓰므로 가볍고, 새 추론 결과가 올 때만 다시 그린다.
import { PAL } from './palette.js';

const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const PALM = [0, 1, 2, 5, 9, 13, 17];

// pts: 화면 좌표 21개, center: 축소 기준점, scale: 크기 배율
export function drawHand(ctx, pts, center, scale = 1) {
  const p = pts.map((q) => ({ x: center.x + (q.x - center.x) * scale, y: center.y + (q.y - center.y) * scale }));
  const palmW = Math.hypot(p[5].x - p[17].x, p[5].y - p[17].y);
  const fw = Math.max(5, palmW * 0.26); // 손가락 굵기
  const outline = `rgb(${PAL.ink})`, fill = 'rgb(232,224,210)';

  const strokeFingers = (color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const f of FINGERS) {
      const base = f[0] === 1 ? p[1] : p[f[0]];
      ctx.moveTo(base.x, base.y);
      for (const i of f.slice(1)) ctx.lineTo(p[i].x, p[i].y);
    }
    ctx.stroke();
  };
  const palmPath = () => {
    ctx.beginPath();
    PALM.forEach((i, k) => (k ? ctx.lineTo(p[i].x, p[i].y) : ctx.moveTo(p[i].x, p[i].y)));
    ctx.closePath();
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 1) 먹 외곽: 손가락은 굵게, 손바닥은 테두리째
  strokeFingers(outline, fw + 4);
  palmPath();
  ctx.lineWidth = 4;
  ctx.strokeStyle = outline;
  ctx.fillStyle = outline;
  ctx.fill();
  ctx.stroke();
  // 2) 안쪽 살색(한지 톤)으로 덮어 외곽선만 남김
  palmPath();
  ctx.fillStyle = fill;
  ctx.fill();
  strokeFingers(fill, fw);
  // 3) 손바닥과 손가락 경계에 옅은 먹선 (형태가 읽히게)
  ctx.strokeStyle = `rgba(${PAL.ink},0.35)`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const i of [5, 9, 13, 17]) { ctx.moveTo(p[i].x, p[i].y); ctx.lineTo(p[i + 1].x, p[i + 1].y); }
  ctx.stroke();
  ctx.restore();
}

// 칼을 쥔 주먹 (1인칭): 손 인식 점이 아니라 '칼자루'(위치·방향·palmPx)를 기준으로 그린 정형화된 주먹.
// 손 점은 손등이 칼자루의 어느 쪽에 있는지(한 비트)만 쓰고, 나머지 모양은 매번 같은 틀이라 흔들리지 않는다.
// 손등(뒤) → 칼자루를 가로질러 감싼 손가락 네 마디 → 엄지. 원통 음영·그림자로 종잇장 느낌을 줄인다.
export function drawGripHand(ctx, pts, sword) {
  const c = sword.hilt;
  const d0 = { x: sword.tip.x - sword.base.x, y: sword.tip.y - sword.base.y };
  const dl = Math.hypot(d0.x, d0.y) || 1;
  const d = { x: d0.x / dl, y: d0.y / dl };
  const n = { x: -d.y, y: d.x };
  const palmW = Math.max(18, (sword.palmPx || 60) * 0.72);
  // 손등 방향: 관절(5,9,13,17) 평균이 칼자루의 어느 쪽인지. 경계에서 깜빡이지 않게 히스테리시스
  const kn = [5, 9, 13, 17].reduce((a, i) => ({ x: a.x + pts[i].x / 4, y: a.y + pts[i].y / 4 }), { x: 0, y: 0 });
  const proj = ((kn.x - c.x) * n.x + (kn.y - c.y) * n.y) / palmW;
  if (!sword.gripSide || proj * sword.gripSide < -0.12) sword.gripSide = proj < 0 ? -1 : 1;
  const side = sword.gripSide;
  const at = (along, across) => ({ x: c.x + d.x * along * palmW + n.x * across * palmW * side, y: c.y + d.y * along * palmW + n.y * across * palmW * side });
  const outline = `rgb(${PAL.ink})`;
  const fw = palmW * 0.25;

  // 원통 음영: a→b 축에 수직인 방향으로 어두움-밝음-어두움 (빛은 화면 왼쪽 위)
  const cylinder = (a, b, w, tone) => {
    const ax = b.x - a.x, ay = b.y - a.y, l = Math.hypot(ax, ay) || 1;
    let px = -ay / l, py = ax / l;
    if (px + py > 0) { px = -px; py = -py; } // 밝은 쪽을 왼쪽 위로
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const g = ctx.createLinearGradient(m.x + px * w / 2, m.y + py * w / 2, m.x - px * w / 2, m.y - py * w / 2);
    g.addColorStop(0, tone[1]); g.addColorStop(0.3, tone[0]); g.addColorStop(1, tone[2]);
    return g;
  };
  const SKIN = ['rgb(246,236,220)', 'rgb(226,212,190)', 'rgb(168,148,124)'];
  const capsule = (a, b, w, tone) => {
    ctx.strokeStyle = outline; ctx.lineWidth = w + 3;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = cylinder(a, b, w, tone); ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // 칼자루 뒤로 말려 들어가는 끝은 어둡게
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, `rgba(${PAL.ink},0)`); g.addColorStop(0.55, `rgba(${PAL.ink},0)`); g.addColorStop(1, `rgba(${PAL.ink},0.32)`);
    ctx.strokeStyle = g;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  };
  const fingers = [0, 1, 2, 3].map((i) => {
    const along = 0.36 - i * 0.24;
    return [at(along, 0.3), at(along - 0.03, -0.22)];
  });
  const thumb = [at(0.26, 0.44), at(0.52, -0.04)];
  const dorsumPath = () => {
    const k0 = at(0.46, 0.3), k1 = at(-0.5, 0.3), w0 = at(-0.42, 1.25), w1 = at(0.3, 1.3);
    const s0 = at(-0.62, 0.75), s1 = at(0.5, 0.8);
    ctx.beginPath();
    ctx.moveTo(k0.x, k0.y);
    ctx.lineTo(k1.x, k1.y);
    ctx.quadraticCurveTo(s0.x, s0.y, w0.x, w0.y);
    ctx.lineTo(w1.x, w1.y);
    ctx.quadraticCurveTo(s1.x, s1.y, k0.x, k0.y);
    ctx.closePath();
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 0) 바닥 그림자: 주먹 전체 실루엣을 오른쪽 아래로 밀어 옅은 먹으로
  const sh = palmW * 0.09;
  ctx.save();
  ctx.translate(sh, sh * 1.4);
  ctx.fillStyle = ctx.strokeStyle = `rgba(${PAL.ink},0.16)`;
  dorsumPath(); ctx.fill();
  ctx.lineWidth = fw + 3;
  ctx.beginPath();
  for (const [a, b] of [...fingers, thumb]) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  ctx.stroke();
  ctx.restore();

  // 1) 손등: 관절 쪽은 빛을 받고 손목 쪽으로 갈수록 어두워지는 면
  const kA = at(0, 0.3), wA = at(0, 1.3);
  const gd = ctx.createLinearGradient(kA.x, kA.y, wA.x, wA.y);
  gd.addColorStop(0, 'rgb(228,214,192)'); gd.addColorStop(0.45, 'rgb(206,190,166)'); gd.addColorStop(1, 'rgb(150,132,110)');
  dorsumPath();
  ctx.fillStyle = gd; ctx.fill();
  ctx.strokeStyle = outline; ctx.lineWidth = 3; ctx.stroke();
  // 손등 힘줄: 관절에서 손목 쪽으로 모이는 옅은 선
  ctx.strokeStyle = 'rgba(255,248,236,0.45)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  fingers.forEach(([a], i) => { const w = at(0.1 - i * 0.12, 1.05); ctx.moveTo(a.x + (w.x - a.x) * 0.2, a.y + (w.y - a.y) * 0.2); ctx.lineTo(w.x, w.y); });
  ctx.stroke();

  // 2) 손가락 네 마디: 새끼 → 검지 (검지가 위에 겹치게), 칼자루를 가로지름
  for (let i = 3; i >= 0; i--) capsule(fingers[i][0], fingers[i][1], fw, SKIN);
  // 관절 하이라이트 + 칼자루 모서리에서 접히는 주름
  for (const [a, b] of fingers) {
    ctx.fillStyle = 'rgba(255,252,244,0.85)';
    ctx.beginPath(); ctx.arc(a.x - fw * 0.12, a.y - fw * 0.12, fw * 0.16, 0, Math.PI * 2); ctx.fill();
    const m = { x: a.x + (b.x - a.x) * 0.55, y: a.y + (b.y - a.y) * 0.55 };
    ctx.strokeStyle = `rgba(${PAL.ink},0.4)`; ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(m.x - d.x * fw * 0.38, m.y - d.y * fw * 0.38);
    ctx.lineTo(m.x + d.x * fw * 0.38, m.y + d.y * fw * 0.38);
    ctx.stroke();
  }

  // 3) 엄지: 손등 쪽 뿌리에서 칼자루 위로 검지 옆까지 + 손톱
  capsule(thumb[0], thumb[1], fw * 0.95, SKIN);
  const tn = { x: thumb[0].x + (thumb[1].x - thumb[0].x) * 0.82, y: thumb[0].y + (thumb[1].y - thumb[0].y) * 0.82 };
  ctx.fillStyle = 'rgba(255,240,232,0.9)';
  ctx.strokeStyle = `rgba(${PAL.ink},0.45)`; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(tn.x, tn.y, fw * 0.22, fw * 0.3, Math.atan2(thumb[1].y - thumb[0].y, thumb[1].x - thumb[0].x) + Math.PI / 2, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  ctx.restore();
}
