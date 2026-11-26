// PeerJS(WebRTC P2P) 래퍼: 방 코드로 1:1 연결. Peer는 index.html의 script 태그(전역)에서 로드.
// 호스트는 'airduel-v1-<CODE>' ID로 열고, 게스트가 그 ID로 접속한다.

const PREFIX = 'airduel-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외

export function randomCode(n = 4) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export class Net {
  constructor({ onOpen, onMessage, onClose, onStatus }) {
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onStatus = onStatus;
    this.peer = null;
    this.conn = null;
    this.role = null;
    this.code = null;
  }

  get connected() { return !!this.conn?.open; }

  host(code = randomCode()) {
    this.destroy();
    this.role = 'host';
    this.code = code;
    this.onStatus('Creating room…', 'busy');
    const peer = (this.peer = new window.Peer(PREFIX + code));
    peer.on('open', () => this.onStatus(`Room ${code} · waiting for opponent`, 'busy'));
    peer.on('connection', (conn) => {
      if (this.conn?.open) { conn.on('open', () => conn.close()); return; } // 2명까지만
      this.attach(conn);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') { this.host(); return; } // 코드 충돌 → 새 코드
      this.onStatus(`Network error (${err.type})`, 'error');
    });
    peer.on('disconnected', () => { if (!this.conn?.open) peer.reconnect(); });
  }

  join(code) {
    this.destroy();
    this.role = 'guest';
    this.code = code.toUpperCase();
    this.onStatus(`Joining ${this.code}…`, 'busy');
    const peer = (this.peer = new window.Peer());
    peer.on('open', () => this.attach(peer.connect(PREFIX + this.code, { reliable: true })));
    peer.on('error', (err) => {
      this.onStatus(err.type === 'peer-unavailable' ? `Room ${this.code} not found` : `Network error (${err.type})`, 'error');
    });
  }

  attach(conn) {
    this.conn = conn;
    conn.on('open', () => {
      this.onStatus('Connected', 'ok');
      this.onOpen();
    });
    conn.on('data', (d) => this.onMessage(d));
    conn.on('close', () => {
      if (this.conn === conn) this.conn = null;
      this.onClose();
    });
    conn.on('error', () => this.onStatus('Connection error', 'error'));
  }

  send(m) {
    if (this.conn?.open) this.conn.send(m);
  }

  destroy() {
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.conn = null;
    this.peer = null;
  }
}
