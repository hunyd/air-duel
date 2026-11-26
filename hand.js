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

// 칼을 쥔 주먹 (1인칭): 손등(어두운 면 + 관절 줄) → 칼자루를 가로질러 감싼 손가락 네 마디 → 엄지.
// 손가락은 칼 방향(d)을 따라 검지(코등이 쪽)부터 새끼(손잡이 끝 쪽)까지 나란히 놓여,
// 칼자루는 주먹 위아래로만 보이고 손의 방향이 분명하게 읽힌다.
export function drawGripHand(ctx, pts, sword, scale = 1) {
  const c = sword.hilt;
  const p = pts.map((q) => ({ x: c.x + (q.x - c.x) * scale, y: c.y + (q.y - c.y) * scale }));
  const d0 = { x: sword.tip.x - sword.base.x, y: sword.tip.y - sword.base.y };
  const dl = Math.hypot(d0.x, d0.y) || 1;
  const d = { x: d0.x / dl, y: d0.y / dl };
  const n = { x: -d.y, y: d.x };
  const palmW = Math.max(18, Math.hypot(p[5].x - p[17].x, p[5].y - p[17].y));
  // 손등(관절 줄)이 칼자루의 어느 쪽에 있는지: n 방향 부호
  const kn = [5, 9, 13, 17].reduce((a, i) => ({ x: a.x + p[i].x / 4, y: a.y + p[i].y / 4 }), { x: 0, y: 0 });
  const side = Math.sign((kn.x - c.x) * n.x + (kn.y - c.y) * n.y) || 1;
  const at = (along, across) => ({ x: c.x + d.x * along * palmW + n.x * across * palmW * side, y: c.y + d.y * along * palmW + n.y * across * palmW * side });
  const outline = `rgb(${PAL.ink})`, skin = 'rgb(238,229,213)', back = 'rgb(205,193,172)';
  const capsule = (a, b, w, fill) => {
    for (const [col, lw] of [[outline, w + 3], [fill, w]]) {
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 1) 손등: 관절 줄(칼자루 옆)에서 손목 쪽으로 — 조금 어두운 면
  const wrist = p[0];
  const dorsum = [at(0.42, 0.34), at(-0.46, 0.34), { x: wrist.x - d.x * palmW * 0.3, y: wrist.y - d.y * palmW * 0.3 }, { x: wrist.x + d.x * palmW * 0.25, y: wrist.y + d.y * palmW * 0.25 }];
  ctx.beginPath();
  dorsum.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  ctx.closePath();
  ctx.fillStyle = back;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 3;
  ctx.fill();
  ctx.stroke();
  // 2) 손가락 네 마디: 새끼 → 검지 순으로 (검지가 위에 겹치게), 칼자루를 가로지름
  const fw = palmW * 0.24;
  for (let i = 3; i >= 0; i--) {
    const along = 0.33 - i * 0.22;
    capsule(at(along, 0.3), at(along - 0.03, -0.2), fw, skin);
  }
  // 관절 표시: 손가락이 손등에서 접히는 자리
  ctx.strokeStyle = `rgba(${PAL.ink},0.55)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) { const q = at(0.33 - i * 0.22, 0.3); ctx.moveTo(q.x - n.x * 2, q.y - n.y * 2); ctx.arc(q.x, q.y, 2, 0, Math.PI * 2); }
  ctx.stroke();
  // 3) 엄지: 손등 쪽 뿌리에서 칼자루 위로 검지 옆까지
  capsule(at(0.25, 0.42), at(0.5, -0.05), fw * 0.95, skin);
  ctx.restore();
}
