// BongoWaifu <-> llama-server 브릿지 (Electron main)
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let win = null;
let loopTimer = null;
let running = false;
let busy = false;            // LLM/ask 중복 호출 방지
let mcp = null;
let lastHotLevel = 0;
let seenAchv = new Set();
let lastSpoke = 0;
let sessionStart = 0;

// ─────────── 설정/메모리 영속화 ───────────
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const MEMORY_PATH   = () => path.join(app.getPath('userData'), 'memory.json');

const DEFAULTS = {
  // 연결
  bongoPort: 7337,
  llamaUrl: 'http://127.0.0.1:8001/v1/chat/completions',
  llamaModel: 'local',
  temperature: 0.9,
  maxTokens: 120,
  // 페르소나
  personaName: '유키',
  personaAge: '19',
  userCall: '오빠',
  personality: '츤데레지만 속은 다정한 여동생 같은 성격. 장난기 많음.',
  speechStyle: '반말, 이모지 거의 없음, 40자 이내 한 줄',
  // 트리거
  pollSec: 2,
  idleSec: 90,
  trigGreet: true,
  trigHot: true,
  trigAchv: true,
  trigIdle: true,
  trigAsk: true,
  askChance: 0.25,   // idle 잡담이 '질문'이 될 확률
  // 메모리
  memRecent: 40,
  memSummary: true,
};

let settings = { ...DEFAULTS };
let memory = { recent: [], summary: '' };

function loadJson(p, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch { return { ...fallback }; }
}
function saveJson(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch {}
}
const saveSettings = () => saveJson(SETTINGS_PATH(), settings);
const saveMemory   = () => saveJson(MEMORY_PATH(), memory);

function log(type, text) {
  if (win && !win.isDestroyed()) win.webContents.send('log', { type, text, ts: Date.now() });
}

// ─────────── MCP 클라이언트 (streamable HTTP) ───────────
function parseBody(text, ctype) {
  if ((ctype || '').includes('text/event-stream')) {
    let last = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        const p = t.slice(5).trim();
        if (p && p !== '[DONE]') { try { last = JSON.parse(p); } catch {} }
      }
    }
    return last;
  }
  return text.trim() ? JSON.parse(text) : null;
}

class MCP {
  constructor(url) { this.url = url; this.sid = null; this.id = 0; }

  async rpc(method, params, notify = false) {
    const body = { jsonrpc: '2.0', method };
    if (!notify) body.id = ++this.id;
    if (params) body.params = params;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sid) headers['Mcp-Session-Id'] = this.sid;
    const r = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.sid = sid;
    if (!r.ok) throw new Error(`MCP HTTP ${r.status}`);
    if (notify) return null;
    return parseBody(await r.text(), r.headers.get('content-type'));
  }

  async init() {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'bongowaifu-bridge', version: '1.0' },
    });
    await this.rpc('notifications/initialized', null, true);
  }

  async tools() {
    const o = await this.rpc('tools/list', {});
    return (o?.result?.tools || []).map(t => t.name);
  }

  async call(name, args) {
    const o = await this.rpc('tools/call', { name, arguments: args });
    if (o?.error) throw new Error(o.error.message || 'MCP tool error');
    return o?.result || {};
  }

  say(text) { return this.call('say', { text: String(text).slice(0, 120) }); }

  // 주의: ask_and_wait 인자명은 문서 미기재 — 오류 시 {question, choices} 등으로 바꿔볼 것
  ask(text, options) { return this.call('ask_and_wait', { text, options }); }

  async state(sections) {
    const r = await this.call('get_game_state', { sections });
    const c = r.content;
    if (Array.isArray(c) && c[0]?.type === 'text') {
      try { return JSON.parse(c[0].text); } catch { return {}; }
    }
    return r.structuredContent || r;
  }
}

// ─────────── LLM ───────────
async function llama(messages) {
  const body = {
    model: settings.llamaModel,
    temperature: +settings.temperature,
    max_tokens: +settings.maxTokens,
    messages,
    stream: false,
  };
  const r = await fetch(settings.llamaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`llama HTTP ${r.status}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

// ─────────── 메모리 ───────────
function addMemory(who, text) {
  memory.recent.push({ who, text, ts: Date.now() });
  saveMemory();
  maybeSummarize().catch(() => {});
}

async function maybeSummarize() {
  if (!settings.memSummary) return;
  const lim = Math.max(10, +settings.memRecent);
  if (memory.recent.length <= lim * 1.5) return;
  const old = memory.recent.splice(0, memory.recent.length - lim);
  const text = old.map(m => `${m.who}: ${m.text}`).join('\n');
  try {
    memory.summary = await llama([
      { role: 'system', content: '다음 대화 기록을 기존 요약과 합쳐 한국어 5문장 이내로 요약하라. 사용자에 대한 사실(이름, 취향, 한 일, 약속)을 우선 보존. 요약문만 출력.' },
      { role: 'user', content: `기존 요약:\n${memory.summary || '(없음)'}\n\n새 기록:\n${text}` },
    ]);
    log('info', '장기 기억 요약 갱신됨');
  } catch {
    memory.recent.unshift(...old); // 실패 시 되돌림
  }
  saveMemory();
}

function histMsgs() {
  // 최근 기억을 chat 메시지로 변환 (event는 상황 메모로)
  return memory.recent.slice(-settings.memRecent).map(m => {
    if (m.who === 'user')  return { role: 'user', content: m.text };
    if (m.who === 'waifu') return { role: 'assistant', content: m.text };
    return { role: 'user', content: `(상황 메모: ${m.text})` };
  });
}

// ─────────── 프롬프트 ───────────
function sysPrompt(state) {
  const S = settings;
  const ch = state?.character || {};
  const now = new Date();
  const mins = sessionStart ? Math.round((Date.now() - sessionStart) / 60000) : 0;
  return `너는 데스크톱 컴패니언 '${S.personaName}'(${S.personaAge}살)이다. 성격: ${S.personality}
사용자를 '${S.userCall}'(이)라고 부른다. 말투: ${S.speechStyle}.
현재 시각: ${now.toLocaleString('ko-KR')} — 시간대 분위기 반영(새벽이면 건강 걱정, 아침엔 활기, 밤엔 차분). 사용자 연속 작업 ${mins}분째 — 2시간 넘으면 가끔 휴식 권유.
게임 캐릭터 외형: ${JSON.stringify({ type: ch.character_type, name: ch.character_name, skin: ch.current_skin, clothes: ch.current_clothes })} — 옷/스킨 분위기를 말투에 살짝 반영(gothic=시크, cute/pink=애교, maid=주인님 호칭, summer=산뜻).
장기 기억: ${memory.summary || '(없음)'}
대사만 출력. 따옴표·해설·이름표 금지.`;
}

async function genLine(state, event) {
  const msgs = [
    { role: 'system', content: sysPrompt(state) },
    ...histMsgs(),
    { role: 'user', content: `(상황: ${event}) 이 상황에 맞는 짧은 대사 한 줄.` },
  ];
  const t = await llama(msgs);
  return t.replace(/^["'「]|["'」]$/g, '').split('\n')[0].slice(0, 120);
}

async function genAsk(state, topic) {
  const msgs = [
    { role: 'system', content: sysPrompt(state) },
    ...histMsgs(),
    { role: 'user', content: `(상황: ${topic}) 사용자에게 물어볼 짧은 질문 1개와 선택지 2~4개를 만들어 JSON만 출력: {"text":"질문","options":["선택1","선택2"]}` },
  ];
  const t = await llama(msgs);
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('질문 JSON 파싱 실패');
  const j = JSON.parse(m[0]);
  return {
    text: String(j.text).slice(0, 120),
    options: (j.options || ['응', '아니']).slice(0, 4).map(o => String(o).slice(0, 30)),
  };
}

// ─────────── 발화 동작 ───────────
async function speak(state, event, tag) {
  const line = await genLine(state, event);
  await mcp.say(line);
  addMemory('event', event);
  addMemory('waifu', line);
  lastSpoke = Date.now();
  log('say', `[${tag}] ${line}`);
}

async function doAsk(state, topic) {
  const q = await genAsk(state, topic);
  log('ask', `${q.text}  [${q.options.join(' / ')}]`);
  addMemory('waifu', `(질문) ${q.text} 선택지: ${q.options.join('/')}`);
  let answer = '(무응답/닫음)';
  try {
    const res = await mcp.ask(q.text, q.options); // 플레이어 답변까지 블로킹
    const c = res.content;
    if (Array.isArray(c) && c[0]?.text) answer = c[0].text;
    else if (typeof res.answer === 'string') answer = res.answer;
  } catch (e) {
    log('error', `ask_and_wait 실패: ${e.message}`);
    return;
  }
  addMemory('user', `(버튼 선택) ${answer}`);
  log('answer', answer);
  // 답변에 대한 리액션
  await speak(state, `사용자가 방금 질문에 '${answer}'라고 답했다. 그에 맞게 반응한다.`, 'react');
}

// ─────────── 자동 루프 ───────────
async function tick() {
  if (!running || busy) return;
  busy = true;
  try {
    const state = await mcp.state(['character', 'gauges', 'achievements']);

    // 게이지 티어 상승
    const hot = state?.gauges?.hot_level ?? 0;
    if (settings.trigHot && hot > lastHotLevel) {
      await speak(state, `콤보 게이지가 레벨 ${hot}로 올랐다. 신나게 반응한다.`, `hot${hot}`);
    }
    lastHotLevel = hot;

    // 신규 업적
    if (settings.trigAchv) {
      for (const a of state?.achievements || []) {
        if (a.unlocked && !seenAchv.has(a.api_name)) {
          seenAchv.add(a.api_name);
          await speak(state, `새 업적 '${a.display_name || a.api_name}' 달성. 축하하거나 장난친다.`, 'achv');
        }
      }
    }

    // idle 잡담 / 질문
    if (settings.trigIdle && Date.now() - lastSpoke > settings.idleSec * 1000) {
      if (settings.trigAsk && Math.random() < +settings.askChance) {
        await doAsk(state, '한동안 조용했다. 사용자 근황이나 기분, 휴식 여부 등을 가볍게 묻는다.');
        lastSpoke = Date.now();
      } else {
        await speak(state, '한동안 조용했다. 가벼운 잡담 한 마디.', 'idle');
      }
    }
  } catch (e) {
    log('error', `루프 오류: ${e.message}`);
  } finally {
    busy = false;
  }
}

async function start() {
  if (running) return { ok: true };
  mcp = new MCP(`http://127.0.0.1:${settings.bongoPort}/mcp`);
  try {
    await mcp.init();
    const tools = await mcp.tools();
    log('info', `연결됨. 툴: ${tools.join(', ')}`);
    if (!tools.includes('say')) throw new Error('say 툴 없음 — 게임에서 AI Connection 토글 확인');
  } catch (e) {
    mcp = null;
    return { ok: false, error: e.message };
  }
  running = true;
  sessionStart = Date.now();
  lastSpoke = Date.now();
  lastHotLevel = 0;

  // 기존 업적 베이스라인
  try {
    const st = await mcp.state(['achievements']);
    for (const a of st?.achievements || []) if (a.unlocked) seenAchv.add(a.api_name);
  } catch {}

  // 시작 인사
  if (settings.trigGreet) {
    busy = true;
    try {
      const st = await mcp.state(['character']);
      await speak(st, '사용자가 막 자리에 앉아 브릿지를 켰다. 시간대에 맞는 인사를 건넨다.', 'greet');
    } catch (e) { log('error', `인사 실패: ${e.message}`); }
    busy = false;
  }

  loopTimer = setInterval(tick, Math.max(1, +settings.pollSec) * 1000);
  return { ok: true };
}

function stop() {
  running = false;
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  mcp = null;
  log('info', '중지됨');
}

// ─────────── IPC ───────────
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', (_, s) => {
  const wasRunning = running;
  settings = { ...DEFAULTS, ...s };
  saveSettings();
  if (wasRunning) { stop(); return start(); } // 재시작으로 반영
  return { ok: true };
});
ipcMain.handle('bridge:start', () => start());
ipcMain.handle('bridge:stop', () => { stop(); return { ok: true }; });
ipcMain.handle('bridge:status', () => ({ running }));

// 채팅: 내 메시지 → LLM 응답 → (연결돼 있으면) 말풍선
ipcMain.handle('chat:send', async (_, text) => {
  addMemory('user', text);
  try {
    let state = {};
    if (mcp) { try { state = await mcp.state(['character']); } catch {} }
    const msgs = [{ role: 'system', content: sysPrompt(state) }, ...histMsgs()];
    const reply = (await llama(msgs)).split('\n')[0].slice(0, 200);
    addMemory('waifu', reply);
    lastSpoke = Date.now();
    if (mcp) { try { await mcp.say(reply); } catch {} }
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 수동 발화: 입력한 텍스트 그대로 말풍선
ipcMain.handle('say:manual', async (_, text) => {
  if (!mcp) return { ok: false, error: '연결 안 됨' };
  try {
    await mcp.say(text);
    addMemory('waifu', text);
    lastSpoke = Date.now();
    log('say', `[manual] ${text}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 수동 질문 트리거
ipcMain.handle('ask:manual', async () => {
  if (!mcp) return { ok: false, error: '연결 안 됨' };
  if (busy) return { ok: false, error: '다른 작업 중' };
  busy = true;
  try {
    const state = await mcp.state(['character']);
    await doAsk(state, '사용자가 직접 질문 버튼을 눌렀다. 지금 궁금한 것을 묻는다.');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { busy = false; }
});

ipcMain.handle('memory:get', () => memory);
ipcMain.handle('memory:clear', () => {
  memory = { recent: [], summary: '' };
  saveMemory();
  return { ok: true };
});

// ─────────── 앱 부트 ───────────
app.whenReady().then(() => {
  settings = loadJson(SETTINGS_PATH(), DEFAULTS);
  memory = loadJson(MEMORY_PATH(), { recent: [], summary: '' });
  win = new BrowserWindow({
    width: 900, height: 680,
    title: 'BongoWaifu Bridge',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => { stop(); app.quit(); });
