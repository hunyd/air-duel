// 색 팔레트 — 일본풍 수묵화: 한지 바탕 위에 먹, 주홍(상대), 쪽빛(나), 금박(기회)
// rgba()에 바로 넣을 수 있도록 'r,g,b' 문자열
export const PAL = {
  paper: '243,238,227',      // 한지 바탕
  ink: '24,21,23',           // 먹
  inkSoft: '74,68,70',       // 옅은 먹 (보조선)
  player: '34,62,132',       // 쪽빛: 내 칼·궤적·가드
  playerCore: '196,224,255', // 쪽빛 칼날 안쪽의 번뜩임
  enemy: '200,52,38',        // 주홍: 상대 칼날·공격 예고
  enemyCore: '120,22,18',    // 짙은 주홍: 예고선 진행 표시
  vital: '184,138,44',       // 금박: 급소·패링·OPENING
  hurt: '196,30,28',         // 피격
  spark: '24,21,23',         // 칼이 부딪힐 때 튀는 먹
};

export const rgba = (rgb, a) => `rgba(${rgb},${a})`;

// 발광(shadowBlur) 강도 배율: 0 = 끔. 수묵화풍은 빛 번짐 대신 또렷한 면과 선으로 표현하고,
// canvas 2D의 shadowBlur는 비싸서 꺼 둔다. (발광을 다시 쓰고 싶으면 값만 올리면 됨)
export const GLOW = 0;
export const glow = (px) => px * GLOW;
