// IceServer 設定（必要に応じて TURN を追加）
const RTC_CONFIG = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
    // 本番での確実な接続性には TURN が推奨。以下は例（自前のTURNを設定してください）
    // { urls: "turn:turn.example.com:3478", username: "user", credential: "pass" },
  ],
};

// Supabase クライアント
// - 認証/ユーザー用: userAuthClient（既存の user-auth-utils.js のクライアントを最優先で再利用）
// - インカム用: intercomClient（Realtime/シグナリング）
const userAuthClient = (window.userAuthUtils && window.userAuthUtils.supabaseClient)
  || (typeof createAuthSupabaseClient === 'function' ? createAuthSupabaseClient() : (typeof createSupabaseClient === 'function' ? createSupabaseClient() : null));
const intercomClient = (typeof createIntercomSupabaseClient === 'function' ? createIntercomSupabaseClient() : null);
if (!userAuthClient || !intercomClient) {
  console.error('Supabaseクライアントが初期化できませんでした。設定（step-config）を確認してください。');
}

// UI 要素
const elStepName = document.getElementById('step-name');
const elStepRooms = document.getElementById('step-rooms');
const elStepInRoom = document.getElementById('step-in-room');
const elNameInput = document.getElementById('input-name');
const elSaveName = document.getElementById('btn-save-name');
const elParticipants = document.getElementById('participants');
const elCurrentRoom = document.getElementById('current-room');
const elMeName = document.getElementById('me-name');
const elLog = document.getElementById('log');
const elAudios = document.getElementById('audios');
const btnLeave = document.getElementById('btn-leave');
const btnMute = document.getElementById('btn-mute');
// Login UI
const elUsername = document.getElementById('input-username');
const elPassword = document.getElementById('input-password');
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
// Config UI
const elCfgAuthUrl = document.getElementById('cfg-auth-url');
const elCfgAuthKey = document.getElementById('cfg-auth-key');
const elCfgCommsUrl = document.getElementById('cfg-comms-url');
const elCfgCommsKey = document.getElementById('cfg-comms-key');
const btnSaveConfig = document.getElementById('btn-save-config');

const joinButtons = Array.from(document.querySelectorAll('.btn-join'));

// 状態
const clientId = crypto.randomUUID();
let userName = '';
let currentRoom = '';
let roomChannel = null;
let localStream = null;
let isMuted = false;
// peerId -> RTCPeerConnection
const peerConnections = new Map();
// peerId -> HTMLAudioElement
const peerAudioEls = new Map();
// peerId -> pending ICE candidates (when remoteDescription not set yet)
const pendingRemoteCandidates = new Map();

// --- 発話検出（AudioContext + AnalyserNode） ---
let sharedAudioContext = null;
const speakingState = new Map(); // peerId -> boolean
const audioLevelMonitors = new Map(); // peerId -> { source, analyser, rafId }

function getAudioContext() {
  try {
    if (!sharedAudioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      sharedAudioContext = new Ctx();
    }
    if (sharedAudioContext.state === 'suspended') sharedAudioContext.resume().catch(() => {});
    return sharedAudioContext;
  } catch {
    return null;
  }
}

function setSpeakingUI(peerId, isSpeaking) {
  speakingState.set(peerId, !!isSpeaking);
  const el = document.querySelector(`.avatar-circle[data-peer-id="${peerId}"]`);
  if (el) el.classList.toggle('speaking', !!isSpeaking);
}

function startAudioLevelMonitor(peerId, mediaStream) {
  const ctx = getAudioContext();
  if (!ctx || !mediaStream) return;
  stopAudioLevelMonitor(peerId);
  const source = ctx.createMediaStreamSource(mediaStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.85;
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  let rafId = 0;
  let lastSpeaking = false;
  let lastActiveTs = 0;
  const THRESHOLD = 0.03; // 0.02〜0.06 程度で調整
  const HANGOVER_MS = 250;

  const loop = () => {
    try {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      const now = performance.now();
      let speaking = rms > THRESHOLD;
      if (speaking) {
        lastActiveTs = now;
      } else if (now - lastActiveTs < HANGOVER_MS) {
        speaking = true;
      }
      if (speaking !== lastSpeaking) {
        lastSpeaking = speaking;
        setSpeakingUI(peerId, speaking);
      }
    } catch {}
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
  audioLevelMonitors.set(peerId, { source, analyser, rafId });
}

function stopAudioLevelMonitor(peerId) {
  const m = audioLevelMonitors.get(peerId);
  if (!m) return;
  try { if (m.rafId) cancelAnimationFrame(m.rafId); } catch {}
  try { if (m.source && m.analyser) m.source.disconnect(m.analyser); } catch {}
  audioLevelMonitors.delete(peerId);
  setSpeakingUI(peerId, false);
}

function log(msg, obj) {
  try {
    const time = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.textContent = `[${time}] ${msg}`;
    if (elLog && typeof elLog.prepend === 'function') {
      elLog.prepend(line);
      if (obj) {
        const pre = document.createElement('pre');
        pre.style.margin = '0 0 6px 0';
        pre.textContent = JSON.stringify(obj, null, 2);
        elLog.prepend(pre);
      }
    } else {
      // フォールバック: コンソールへ
      console.log(`[LOG] ${msg}`, obj || '');
    }
  } catch (e) {
    console.log('[log-failed]', msg, obj || '', e);
  }
}

function showStep(step) {
  const elStepLogin = document.getElementById('step-login');
  const elStepConfig = document.getElementById('step-config');
  if (elStepConfig) elStepConfig.classList.toggle('hidden', step !== 'config');
  if (elStepLogin) elStepLogin.classList.toggle('hidden', step !== 'login');
  elStepName.classList.toggle('hidden', step !== 'name');
  elStepRooms.classList.toggle('hidden', step !== 'rooms');
  elStepInRoom.classList.toggle('hidden', step !== 'inroom');
}

function updateCounts() {
  // 人数表示（presence が必要なので在室中のみ更新）
  const counts = { Room1: 0, Room2: 0, Room3: 0 };
  ['Room1','Room2','Room3'].forEach(room => {
    const ch = (roomChannel && currentRoom === room) ? roomChannel : null;
    if (ch && ch.presenceState) {
      const state = ch.presenceState();
      let total = 0;
      for (const key in state) total += state[key].length;
      counts[room] = total;
    } else {
      // 部屋に入っていない場合、人数不明（0表示）
    }
    const label = document.getElementById(`count-${room}`);
    if (label) label.textContent = `参加者: ${counts[room]}`;
  });
}

function updateParticipantsUI() {
  elParticipants.innerHTML = '';
  if (!roomChannel) return;
  const state = roomChannel.presenceState();
  const entries = [];
  for (const key in state) {
    for (const meta of state[key]) {
      entries.push(meta);
    }
  }
  entries.sort((a, b) => a.userName.localeCompare(b.userName));
  entries.forEach(meta => {
    const container = document.createElement('div');
    container.className = 'participant';

    const avatar = document.createElement('div');
    avatar.className = 'avatar-circle';
    avatar.dataset.peerId = meta.clientId;

    const initials = (meta.userName || '?')
      .split(/\s+/)
      .map(s => s[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

    const initialsEl = document.createElement('div');
    initialsEl.className = 'avatar-initials';
    initialsEl.textContent = initials || '??';
    avatar.appendChild(initialsEl);

    const label = document.createElement('div');
    label.className = 'label';
    const selfMark = meta.clientId === clientId ? ' (自分)' : '';
    label.textContent = `${meta.userName}${selfMark}`;

    container.appendChild(avatar);
    container.appendChild(label);
    elParticipants.appendChild(container);

    // 既知の発話状態を反映
    if (speakingState.get(meta.clientId)) {
      avatar.classList.add('speaking');
    }
  });
  updateCounts();
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (isMuted) {
      localStream.getAudioTracks().forEach(t => t.enabled = false);
    }
    return localStream;
  } catch (e) {
    log('マイク取得に失敗しました。ブラウザのマイク権限を確認してください。');
    throw e;
  }
}

function createAudioElForPeer(peerId, peerName) {
  const audio = document.createElement('audio');
  audio.setAttribute('playsinline', '');
  audio.setAttribute('autoplay', '');
  audio.dataset.peerId = peerId;
  audio.title = peerName;
  elAudios.appendChild(audio);
  peerAudioEls.set(peerId, audio);
  return audio;
}

function removeAudioElForPeer(peerId) {
  const el = peerAudioEls.get(peerId);
  if (el && el.parentNode) el.parentNode.removeChild(el);
  peerAudioEls.delete(peerId);
}

function closePeer(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    try { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; } catch {}
    try { pc.getSenders().forEach(s => { try { pc.removeTrack(s); } catch {} }); } catch {}
    try { pc.close(); } catch {}
  }
  peerConnections.delete(peerId);
  removeAudioElForPeer(peerId);
  pendingRemoteCandidates.delete(peerId);
  stopAudioLevelMonitor(peerId);
}

function ensurePeerConnection(peerId, peerName) {
  let pc = peerConnections.get(peerId);
  if (pc) return pc;
  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendSignal('webrtc:candidate', { targetId: peerId, candidate: ev.candidate });
    }
  };

  pc.ontrack = (ev) => {
    const [remoteStream] = ev.streams;
    let audio = peerAudioEls.get(peerId) || createAudioElForPeer(peerId, peerName || 'peer');
    audio.srcObject = remoteStream;
    // Safari/iOS 対策: 再生を試み、失敗しても無視
    audio.play().catch(() => {});
    startAudioLevelMonitor(peerId, remoteStream);
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    log(`peer ${peerId} state: ${st}`);
    if (st === 'failed' || st === 'disconnected' || st === 'closed') {
      closePeer(peerId);
    }
  };

  // 既存のローカルトラックを追加
  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }

  peerConnections.set(peerId, pc);
  return pc;
}

async function startOffer(peerId, peerName) {
  const pc = ensurePeerConnection(peerId, peerName);
  // 念のためローカルトラックを確実に追加
  if (localStream && pc.getSenders().length === 0) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal('webrtc:offer', { targetId: peerId, sdp: offer });
  log(`offer -> ${peerId}`);
}

async function handleOffer(fromId, payload) {
  const pc = ensurePeerConnection(fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  if (localStream && pc.getSenders().length === 0) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal('webrtc:answer', { targetId: fromId, sdp: answer });
  log(`answer -> ${fromId}`);
  // 保留されていた candidate を適用
  flushPendingCandidates(fromId);
}

async function handleAnswer(fromId, payload) {
  const pc = ensurePeerConnection(fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  log(`remoteDescription set by answer from ${fromId}`);
  flushPendingCandidates(fromId);
}

function flushPendingCandidates(peerId) {
  const pc = peerConnections.get(peerId);
  if (!pc || !pc.remoteDescription) return;
  const list = pendingRemoteCandidates.get(peerId) || [];
  while (list.length) {
    const c = list.shift();
    pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }
  if (list.length === 0) pendingRemoteCandidates.delete(peerId);
}

async function handleCandidate(fromId, payload) {
  const pc = peerConnections.get(fromId);
  if (!pc) {
    // まだPCが無い or remoteDescription 未設定の可能性。キューして後で適用
    const q = pendingRemoteCandidates.get(fromId) || [];
    q.push(payload.candidate);
    pendingRemoteCandidates.set(fromId, q);
    return;
  }
  if (!pc.remoteDescription) {
    const q = pendingRemoteCandidates.get(fromId) || [];
    q.push(payload.candidate);
    pendingRemoteCandidates.set(fromId, q);
    return;
  }
  try { await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch {}
}

function sendSignal(event, payload) {
  if (!roomChannel) return;
  roomChannel.send({ type: 'broadcast', event, payload: { fromId: clientId, fromName: userName, room: currentRoom, ...payload } });
}

async function joinRoom(room) {
  if (!userName) {
    alert('先に名前を入力してください');
    return;
  }
  if (roomChannel) await leaveRoom();

  currentRoom = room;
  elCurrentRoom.textContent = room;
  elMeName.textContent = userName;
  showStep('inroom');

  await ensureLocalStream();
  // 自分の発話もハイライト
  startAudioLevelMonitor(clientId, localStream);

  // チャンネル作成（presence + broadcast）
  roomChannel = intercomClient.channel(`room:${room}`, {
    config: {
      broadcast: { self: false },
      presence: { key: clientId },
    },
  });

  roomChannel
    .on('presence', { event: 'sync' }, () => {
      log('presence sync');
      const state = roomChannel.presenceState();
      updateParticipantsUI();
      // 既存メンバーに対して発呼ルール: 自分の clientId が小さい方が発呼
      const others = [];
      for (const key in state) {
        for (const meta of state[key]) {
          if (meta.clientId !== clientId) others.push(meta);
        }
      }
      others.sort((a, b) => a.clientId.localeCompare(b.clientId));
      for (const meta of others) {
        if (clientId < meta.clientId) {
          startOffer(meta.clientId, meta.userName).catch(err => log('offer error', err));
        }
      }
    })
    .on('presence', { event: 'join' }, ({ key, newPresences }) => {
      for (const p of newPresences) log(`join ${p.userName}`, p);
      updateParticipantsUI();
    })
    .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
      for (const p of leftPresences) {
        log(`leave ${p.userName}`);
        closePeer(p.clientId);
      }
      updateParticipantsUI();
    })
    .on('broadcast', { event: 'webrtc:offer' }, ({ payload }) => {
      if (payload.targetId !== clientId) return;
      log(`recv offer <- ${payload.fromId}`);
      handleOffer(payload.fromId, payload).catch(err => log('handleOffer error', err));
    })
    .on('broadcast', { event: 'webrtc:answer' }, ({ payload }) => {
      if (payload.targetId !== clientId) return;
      log(`recv answer <- ${payload.fromId}`);
      handleAnswer(payload.fromId, payload).catch(err => log('handleAnswer error', err));
    })
    .on('broadcast', { event: 'webrtc:candidate' }, ({ payload }) => {
      if (payload.targetId !== clientId) return;
      handleCandidate(payload.fromId, payload).catch(() => {});
    })
    .on('broadcast', { event: 'webrtc:leave' }, ({ payload }) => {
      closePeer(payload.fromId);
    });

  await roomChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      roomChannel.track({ userName, clientId, joinedAt: Date.now() });
      log(`subscribed room:${room}`);
    }
  });
}

async function leaveRoom() {
  // Peer切断
  for (const peerId of Array.from(peerConnections.keys())) closePeer(peerId);
  if (roomChannel) {
    try { roomChannel.untrack(); } catch {}
    try { await roomChannel.unsubscribe(); } catch {}
    roomChannel = null;
  }
  // ローカルトラック停止
  if (localStream) {
    // 自分の発話監視を停止
    stopAudioLevelMonitor(clientId);
    try { localStream.getTracks().forEach(t => t.stop()); } catch {}
    localStream = null;
  }
  isMuted = false;
  btnMute.textContent = 'ミュート';
  currentRoom = '';
  elCurrentRoom.textContent = '-';
  elParticipants.innerHTML = '';
  showStep('rooms');
  updateCounts();
  log('left room');
}

// UI events
if (btnLogin) {
  btnLogin.addEventListener('click', async () => {
    const username = (elUsername?.value || '').trim();
    const password = (elPassword?.value || '').trim();
    if (!username || !password) {
      alert('ユーザー名とパスワードを入力してください');
      return;
    }
    try {
      const result = await window.userAuthUtils.login(username, password);
      if (!result.success) {
        alert(result.error || 'ログインに失敗しました');
        return;
      }
      // セッション保存
      window.userAuthUtils.saveSession(result.user);
      // 表示名決定（氏名優先）
      userName = getUserDisplayName(result.user);
      showStep('rooms');
    } catch (e) {
      alert('ログインエラー: ' + (e?.message || e));
    }
  });
}

if (btnLogout) {
  btnLogout.addEventListener('click', () => {
    try { window.userAuthUtils.clearSession(); } catch {}
    // 退出と状態リセット
    leaveRoom();
    userName = '';
    if (elNameInput) elNameInput.value = '';
    if (elUsername) elUsername.value = '';
    if (elPassword) elPassword.value = '';
    showStep('login');
  });
}

if (btnSaveConfig) {
  btnSaveConfig.addEventListener('click', () => {
    const authUrl = (elCfgAuthUrl?.value || '').trim();
    const authKey = (elCfgAuthKey?.value || '').trim();
    const commsUrl = (elCfgCommsUrl?.value || '').trim();
    const commsKey = (elCfgCommsKey?.value || '').trim();
    if (!authUrl || !authKey || !commsUrl || !commsKey) {
      alert('すべての設定を入力してください');
      return;
    }
    // 保存
    localStorage.setItem('APP_AUTH_SUPABASE_URL', authUrl);
    localStorage.setItem('APP_AUTH_SUPABASE_ANON_KEY', authKey);
    localStorage.setItem('APP_COMMS_SUPABASE_URL', commsUrl);
    localStorage.setItem('APP_COMMS_SUPABASE_ANON_KEY', commsKey);
    // グローバルへ反映（次回リロードでも維持）
    window.APP_AUTH_SUPABASE_URL = authUrl;
    window.APP_AUTH_SUPABASE_ANON_KEY = authKey;
    window.APP_COMMS_SUPABASE_URL = commsUrl;
    window.APP_COMMS_SUPABASE_ANON_KEY = commsKey;
    alert('設定を保存しました。ログインに進んでください。');
    showStep('login');
  });
}

elSaveName.addEventListener('click', () => {
  const v = (elNameInput.value || '').trim();
  if (!v) {
    alert('名前を入力してください');
    return;
  }
  userName = v;
  showStep('rooms');
});

joinButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const room = btn.dataset.room;
    joinRoom(room).catch(err => {
      log('joinRoom error', err);
      alert('入室に失敗しました。設定を確認してください。');
    });
  });
});

btnLeave.addEventListener('click', () => {
  leaveRoom();
});

btnMute.addEventListener('click', () => {
  isMuted = !isMuted;
  btnMute.textContent = isMuted ? 'ミュート解除' : 'ミュート';
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
});

window.addEventListener('beforeunload', () => {
  try { if (roomChannel) roomChannel.untrack(); } catch {}
  for (const peerId of Array.from(peerConnections.keys())) closePeer(peerId);
  try { stopAudioLevelMonitor(clientId); } catch {}
  if (localStream) { try { localStream.getTracks().forEach(t => t.stop()); } catch {} }
});

// 初期表示
function getUserDisplayName(user) {
  if (!user) return '';
  return user.full_name || user.name || user.display_name || user.username || '';
}

(() => {
  // セッションがあればスキップ
  try {
    // 保存済み設定の読み出し（あれば自動適用）
    const authUrl = localStorage.getItem('APP_AUTH_SUPABASE_URL');
    const authKey = localStorage.getItem('APP_AUTH_SUPABASE_ANON_KEY');
    const commsUrl = localStorage.getItem('APP_COMMS_SUPABASE_URL');
    const commsKey = localStorage.getItem('APP_COMMS_SUPABASE_ANON_KEY');
    if (authUrl && authKey && commsUrl && commsKey) {
      window.APP_AUTH_SUPABASE_URL = authUrl;
      window.APP_AUTH_SUPABASE_ANON_KEY = authKey;
      window.APP_COMMS_SUPABASE_URL = commsUrl;
      window.APP_COMMS_SUPABASE_ANON_KEY = commsKey;
      if (elCfgAuthUrl) elCfgAuthUrl.value = authUrl;
      if (elCfgAuthKey) elCfgAuthKey.value = authKey;
      if (elCfgCommsUrl) elCfgCommsUrl.value = commsUrl;
      if (elCfgCommsKey) elCfgCommsKey.value = commsKey;
    }

    const sessionUser = window.userAuthUtils?.getSession?.();
    if (sessionUser) {
      userName = getUserDisplayName(sessionUser) || sessionUser.username || '';
      showStep('rooms');
      log('ログイン済みセッションを検出しました。');
      return;
    }
  } catch {}
  // 直接キーが書き換えられている前提で、そのままログイン画面へ
  showStep('login');
})();
log('準備完了。SupabaseのURL/キーを設定してご利用ください。');


