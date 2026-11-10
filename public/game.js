(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const socket = io({ reconnectionAttempts: Infinity });
  const screens = { home: $('homeScreen'), lobby: $('lobbyScreen'), game: $('gameScreen') };
  const canvas = $('gameCanvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const fogCanvas = document.createElement('canvas');
  const fogCtx = fogCanvas.getContext('2d');
  const playerColors = ['#5ad8de', '#ffb473'];
  let screen = 'home';
  let room = null;
  let game = null;
  let map = null;
  let tile = 40;
  let myId = null;
  let audio = null;
  let soundOn = false;
  let toastTimer = null;
  let gameToastTimer = null;
  let renderPlayers = new Map();
  let camera = { x: 100, y: 100 };
  let viewW = 1000;
  let viewH = 600;
  let scaleFactor = 1;
  let renderLastPhase = null;
  const keyboard = new Set();
  const touches = new Set();
  let touchRun = false;
  let touchUse = false;
  let clockMs = performance.now();

  $('nameInput').value = `Игрок ${Math.floor(Math.random() * 900) + 100}`;
  const invitationCode = new URLSearchParams(window.location.search).get('room');
  if (invitationCode) {
    $('codeInput').value = String(invitationCode).toUpperCase().slice(0, 5);
    window.setTimeout(() => $('nameInput').focus(), 200);
  }

  function showScreen(name) {
    screen = name;
    for (const [key, el] of Object.entries(screens)) el.classList.toggle('hidden', key !== name);
    if (name === 'game') setTimeout(resizeCanvas, 50);
    if (name !== 'game') keyboard.clear();
  }
  function errorText(message) { $('homeError').textContent = message || ''; }
  function toast(message, inGame = false) {
    const el = inGame ? $('gameToast') : $('globalToast');
    const showClass = inGame ? 'visible' : 'show';
    if (inGame) clearTimeout(gameToastTimer); else clearTimeout(toastTimer);
    el.textContent = message;
    el.classList.add(showClass);
    const timer = setTimeout(() => el.classList.remove(showClass), 3200);
    if (inGame) gameToastTimer = timer; else toastTimer = timer;
  }
  function getMyName() { return $('nameInput').value.trim().slice(0, 16) || 'Игрок'; }
  function setBusy(isBusy) {
    $('createBtn').disabled = isBusy;
    $('joinBtn').disabled = isBusy;
  }
  function request(event, payload, fn) {
    if (!socket.connected) { fn?.({ ok: false, error: 'Нет соединения с сервером. Проверь интернет.' }); return; }
    socket.timeout(7000).emit(event, payload, (err, answer) => {
      fn?.(err ? { ok: false, error: 'Сервер не ответил. Попробуй ещё раз.' } : answer);
    });
  }
  function showJoinError(result) {
    setBusy(false);
    if (!result?.ok) { errorText(result?.error || 'Не получилось подключиться.'); return; }
    errorText('');
  }
  $('createBtn').addEventListener('click', () => {
    errorText(''); setBusy(true);
    request('room:create', { name: getMyName() }, showJoinError);
  });
  $('joinBtn').addEventListener('click', joinRoom);
  $('codeInput').addEventListener('input', (e) => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5));
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') invitationCode ? joinRoom() : $('createBtn').click(); });
  function joinRoom() {
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length !== 5) return errorText('Введи 5 символов кода комнаты.');
    errorText(''); setBusy(true);
    request('room:join', { code, name: getMyName() }, showJoinError);
  }
  $('startBtn').addEventListener('click', () => request('room:start', null, (res) => {
    if (!res?.ok) toast(res?.error || 'Не удалось запустить игру.');
  }));
  $('restartBtn').addEventListener('click', () => request('room:restart', null, (res) => {
    if (!res?.ok) toast(res?.error || 'Не удалось начать заново.', true);
  }));
  function leaveRoom() {
    socket.emit('room:leave');
    room = null; game = null; map = null; myId = null;
    renderPlayers.clear();
    showScreen('home');
    setBusy(false);
    history.replaceState({}, '', window.location.pathname);
  }
  $('leaveLobbyBtn').addEventListener('click', leaveRoom);
  $('leaveGameBtn').addEventListener('click', leaveRoom);
  $('resultLeaveBtn').addEventListener('click', leaveRoom);

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea');
        field.value = text; field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.appendChild(field); field.select();
        if (!document.execCommand('copy')) throw new Error('no clipboard');
        field.remove();
      }
      toast('Скопировано! Отправь напарнику.');
    } catch { toast('Не удалось скопировать. Выдели и скопируй код вручную.'); }
  }
  $('copyCodeBtn').addEventListener('click', () => room && copyText(room.code));
  $('copyLinkBtn').addEventListener('click', () => {
    if (!room) return;
    const url = `${window.location.origin}${window.location.pathname}?room=${room.code}`;
    copyText(url);
  });

  function renderLobby() {
    if (!room) return;
    $('lobbyCode').textContent = room.code;
    for (let i = 0; i < 2; i++) {
      const row = $(`slot${i}`);
      const p = room.players.find(player => player.slot === i);
      row.classList.toggle('filled', Boolean(p));
      row.querySelector('.team-name').textContent = p ? p.name + (p.id === myId ? ' (ТЫ)' : '') : 'ОЖИДАНИЕ...';
      row.querySelector('.team-state').textContent = p ? (p.id === room.hostId ? 'СОЗДАТЕЛЬ' : 'В СЕТИ') : 'НЕ В СЕТИ';
    }
    const host = room.hostId === myId;
    const canStart = room.players.length === 2 && host;
    const btn = $('startBtn');
    btn.disabled = !canStart;
    btn.innerHTML = canStart ? 'НАЧАТЬ ПОБЕГ <span class="btn-end">↗</span>' :
      room.players.length < 2 ? 'ЖДЁМ ВТОРОГО ИГРОКА <span class="btn-end">⌛</span>' : 'ЖДЁМ ЗАПУСКА СОЗДАТЕЛЕМ';
  }

  function onRoomState(next) {
    const previousPhase = game?.phase;
    room = { code: next.code, phase: next.phase, hostId: next.hostId, players: next.players };
    myId = next.yourId || myId;
    if (next.map) {
      map = next.map;
      tile = next.tile || 40;
      fogCanvas.width = map[0].length * tile;
      fogCanvas.height = map.length * tile;
    }
    game = next;
    $('gameCode').textContent = next.code;
    if (next.phase === 'lobby') {
      renderLastPhase = null;
      showScreen('lobby');
      renderLobby();
      return;
    }
    if (previousPhase !== next.phase && next.phase === 'playing') {
      renderPlayers.clear();
      renderLastPhase = null;
      camera = { x: 100, y: 100 };
    }
    if (screen !== 'game') showScreen('game');
    refreshHud();
    updateEndScreen();
  }
  function updateEndScreen() {
    if (!game) return;
    const finished = game.phase === 'won' || game.phase === 'lost';
    $('gameResult').classList.toggle('hidden', !finished);
    if (!finished) return;
    const won = game.phase === 'won';
    $('resultBrow').textContent = won ? 'МИССИЯ ВЫПОЛНЕНА • ВЫ ВЫЖИЛИ' : 'МИССИЯ ПРОВАЛЕНА • ПОПРОБУЙ ЕЩЁ';
    $('resultTitle').textContent = won ? 'ПОБЕГ УДАЛСЯ!' : 'ВАС ПОЙМАЛИ!';
    $('resultTitle').style.color = won ? '#d7fc78' : '#ff9980';
    $('resultText').textContent = game.result || (won ? 'Вы смогли уйти от Кирпича вдвоём!' : 'Кирпич оказался быстрее.');
    const host = game.hostId === myId;
    $('restartBtn').disabled = !host;
    $('restartBtn').textContent = host ? 'ЕЩЁ ОДНА ПОПЫТКА ↗' : 'ЖДЁМ СОЗДАТЕЛЯ КОМНАТЫ';
    if (renderLastPhase !== game.phase) playSound(won ? 'win' : 'caught');
    renderLastPhase = game.phase;
  }
  function refreshHud() {
    if (!game || screen !== 'game') return;
    const collected = game.parts.filter(part => part.taken).length;
    $('partsCount').textContent = collected;
    for (const [i, el] of [...$('partsMarkers').children].entries()) el.classList.toggle('filled', i < collected);
    $('missionNext').textContent = collected === 4 ? '↗ ОБА БЕГИТЕ К ЗЕЛЁНЫМ ВОРОТАМ' : `⚙ ОСТАЛОСЬ НАЙТИ: ${4 - collected}`;
    const seconds = Math.ceil(game.seconds);
    $('timerText').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    $('timerText').classList.toggle('danger', seconds < 40);
    $('timerBar').firstElementChild.style.width = `${Math.max(0, (game.seconds / 220) * 100)}%`;
    game.players.forEach((player) => {
      $(`p${player.slot}Name`).textContent = player.name + (player.id === myId ? ' (ТЫ)' : '');
      $(`p${player.slot}State`).textContent = player.downed ? `НУЖНА ПОМОЩЬ • ${Math.ceil(player.downTime)}с` : 'В ИГРЕ';
      $(`p${player.slot}State`).style.color = player.downed ? '#ff9e7d' : '#98c79f';
      $(`p${player.slot}Parts`).textContent = `${player.parts} ⚙`;
    });
    const me = game.players.find(player => player.id === myId);
    if (!me) return;
    $('staminaBar').style.width = `${me.stamina}%`;
    $('staminaText').textContent = `${Math.round(me.stamina)}%`;
    const enemyDist = Math.hypot(me.x - game.enemy.x, me.y - game.enemy.y);
    $('liveThreat').classList.toggle('visible', enemyDist < 210 && game.phase === 'playing');
    const downedFriend = game.players.find(p => p.id !== myId && p.downed);
    let prompt = '';
    if (me.downed) prompt = `ТЫ ПОЙМАН! ПОМОЩЬ НУЖНА ЗА ${Math.ceil(me.downTime)} СЕК.`;
    else if (downedFriend && Math.hypot(me.x - downedFriend.x, me.y - downedFriend.y) < 76) {
      prompt = `УДЕРЖИВАЙ E, ЧТОБЫ СПАСТИ ДРУГА (${Math.floor((downedFriend.revive / 1.5) * 100)}%)`;
    } else if (collected === 4) prompt = 'ВСЕ ДЕТАЛИ СОБРАНЫ! ОБА ИДИТЕ К ЗЕЛЁНЫМ ВОРОТАМ.';
    $('gamePrompt').textContent = prompt;
    $('gamePrompt').classList.toggle('visible', Boolean(prompt) && game.phase === 'playing');
  }

  socket.on('connect', () => {
    $('onlineStatus').classList.remove('offline');
    $('onlineStatus').classList.add('ready');
    $('onlineStatus').querySelector('span').textContent = 'СЕРВЕР ОНЛАЙН';
    if (room) {
      toast('Соединение восстановлено. Создай комнату заново.');
      room = null; game = null; map = null; myId = null; showScreen('home');
    }
  });
  socket.on('disconnect', () => {
    $('onlineStatus').classList.remove('ready');
    $('onlineStatus').classList.add('offline');
    $('onlineStatus').querySelector('span').textContent = 'НЕТ СОЕДИНЕНИЯ';
    if (room) {
      room = null; game = null; map = null; myId = null;
      showScreen('home');
      toast('Соединение потеряно. Ждём сервер...');
    }
  });
  socket.on('room:sync', onRoomState);
  socket.on('game:state', next => {
    if (!room || next.code !== room.code) return;
    game = next;
    room.players = next.players;
    room.phase = next.phase;
    if (next.phase !== 'playing' && renderLastPhase !== next.phase) updateEndScreen();
    refreshHud();
  });
  socket.on('room:notice', message => {
    toast(message, screen === 'game');
    if (/нашёл деталь/.test(message)) playSound('part');
    if (/пойман|спас/.test(message)) playSound(/спас/.test(message) ? 'revive' : 'caught');
  });

  function resizeCanvas() {
    if (screen !== 'game') return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    scaleFactor = Math.min(2, devicePixelRatio || 1);
    viewW = rect.width; viewH = rect.height;
    canvas.width = Math.floor(viewW * scaleFactor);
    canvas.height = Math.floor(viewH * scaleFactor);
  }
  window.addEventListener('resize', resizeCanvas);
  if ('ResizeObserver' in window) new ResizeObserver(resizeCanvas).observe($('gameViewport'));

  window.addEventListener('keydown', event => {
    if (screen !== 'game' || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const k = event.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'e'].includes(k)) {
      event.preventDefault(); keyboard.add(k);
    }
  });
  window.addEventListener('keyup', event => keyboard.delete(event.key.toLowerCase()));
  window.addEventListener('blur', () => { keyboard.clear(); touches.clear(); touchRun = false; touchUse = false; });
  for (const btn of document.querySelectorAll('[data-dir]')) {
    const value = btn.dataset.dir;
    function release(e) { e.preventDefault(); touches.delete(value); btn.classList.remove('pressed'); }
    btn.addEventListener('pointerdown', e => { e.preventDefault(); btn.setPointerCapture(e.pointerId); touches.add(value); btn.classList.add('pressed'); });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
  }
  for (const [id, setter] of [['touchRun', value => touchRun = value], ['touchUse', value => touchUse = value]]) {
    const btn = $(id);
    const release = e => { e.preventDefault(); setter(false); btn.classList.remove('pressed'); };
    btn.addEventListener('pointerdown', e => { e.preventDefault(); btn.setPointerCapture(e.pointerId); setter(true); btn.classList.add('pressed'); });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
  }
  setInterval(() => {
    if (screen !== 'game' || !game || game.phase !== 'playing' || !socket.connected) return;
    const up = keyboard.has('w') || keyboard.has('arrowup') || touches.has('up');
    const down = keyboard.has('s') || keyboard.has('arrowdown') || touches.has('down');
    const left = keyboard.has('a') || keyboard.has('arrowleft') || touches.has('left');
    const right = keyboard.has('d') || keyboard.has('arrowright') || touches.has('right');
    let dx = Number(right) - Number(left), dy = Number(down) - Number(up);
    const length = Math.hypot(dx, dy) || 1;
    dx /= length; dy /= length;
    socket.emit('input', { dx, dy, sprint: keyboard.has('shift') || touchRun, use: keyboard.has('e') || touchUse });
  }, 50);

  // Audio is original, procedurally generated in the browser; no external sound assets.
  function setSound(on) {
    try {
      if (on) {
        if (!audio) {
          const a = new (window.AudioContext || window.webkitAudioContext)();
          const filter = a.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 190;
          const master = a.createGain(); master.gain.value = .018;
          filter.connect(master); master.connect(a.destination);
          for (const [frequency, type, volume] of [[55, 'sawtooth', .6], [82.4, 'sine', .8], [110.2, 'triangle', .35]]) {
            const oscillator = a.createOscillator(); oscillator.frequency.value = frequency; oscillator.type = type;
            const gain = a.createGain(); gain.gain.value = volume; oscillator.connect(gain); gain.connect(filter); oscillator.start();
          }
          audio = { context: a, master };
        }
        audio.context.resume(); audio.master.gain.setTargetAtTime(.018, audio.context.currentTime, .2);
      } else if (audio) audio.master.gain.setTargetAtTime(0, audio.context.currentTime, .13);
      soundOn = on;
      $('soundToggle').classList.toggle('active', on);
      $('soundLabel').textContent = on ? 'ON' : 'OFF';
      $('soundToggle').title = on ? 'Выключить звук' : 'Включить звук';
    } catch { toast('Звук не поддерживается этим браузером.'); }
  }
  $('soundToggle').addEventListener('click', () => setSound(!soundOn));
  function playSound(type) {
    if (!soundOn || !audio) return;
    try {
      const a = audio.context, now = a.currentTime;
      const osc = a.createOscillator(), gain = a.createGain();
      osc.type = type === 'caught' ? 'sawtooth' : 'sine';
      const freq = { part: 600, revive: 490, caught: 160, win: 740 }[type] || 400;
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(type === 'caught' ? 72 : freq * 1.45, now + .23);
      gain.gain.setValueAtTime(.0001, now);
      gain.gain.exponentialRampToValueAtTime(.13, now + .018);
      gain.gain.exponentialRampToValueAtTime(.0001, now + .31);
      osc.connect(gain); gain.connect(a.destination); osc.start(now); osc.stop(now + .34);
    } catch { /* Audio unsupported or suspended */ }
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  function getDrawEntity(key, entity) {
    if (!renderPlayers.has(key)) renderPlayers.set(key, { x: entity.x, y: entity.y });
    const cached = renderPlayers.get(key);
    const dist = Math.hypot(entity.x - cached.x, entity.y - cached.y);
    if (dist > 220) { cached.x = entity.x; cached.y = entity.y; }
    else { cached.x = lerp(cached.x, entity.x, .22); cached.y = lerp(cached.y, entity.y, .22); }
    return { ...entity, x: cached.x, y: cached.y };
  }
  function roundedRect(x, y, w, h, radius, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
  }
  function floorAndWalls(t) {
    const w = map[0].length, h = map.length;
    ctx.fillStyle = '#15252d'; ctx.fillRect(0, 0, w * tile, h * tile);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x * tile, py = y * tile;
      if (!map[y][x]) {
        ctx.fillStyle = (x * 7 + y * 13) % 9 === 0 ? '#1e3035' : '#192830';
        ctx.fillRect(px + 1, py + 1, tile - 2, tile - 2);
        if ((x * 17 + y * 19) % 23 === 0) {
          ctx.strokeStyle = '#34413c';ctx.lineWidth = 1;
          ctx.beginPath();ctx.moveTo(px+10,py+10);ctx.lineTo(px+15,py+18);ctx.lineTo(px+11,py+23);ctx.stroke();
        }
        if ((x + 3 * y) % 17 === 0) {
          ctx.fillStyle = '#31463d';ctx.fillRect(px+29,py+29,3,3);
        }
      } else {
        roundedRect(px, py, tile, tile, 2, '#0a121a');
        roundedRect(px + 2, py + 2, tile - 4, tile - 5, 3, '#46504e');
        ctx.fillStyle = '#53615a';ctx.fillRect(px+4,py+3,tile-8,3);
        ctx.fillStyle = '#303a3b'; ctx.fillRect(px+2,py+tile-8,tile-4,5);
        ctx.strokeStyle = '#303a3b';ctx.lineWidth = 1;
        ctx.beginPath();ctx.moveTo(px+20,py+6);ctx.lineTo(px+20,py+20);ctx.moveTo(px+5,py+21);ctx.lineTo(px+34,py+21);ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(210,255,145,.08)';
    for (const [x,y,text] of [[1.8, 5.9, 'ДВОР №4'],[20.6, 18.4, 'НЕ ШУМИ'],[14.2, 2.1, 'СКЛАД']]) {
      ctx.save();ctx.translate(x*tile,y*tile);ctx.rotate(-.1);ctx.font = '900 15px Arial';ctx.fillText(text,0,0);ctx.restore();
    }
    ctx.fillStyle = '#b9d39d';ctx.font = '900 12px Arial';ctx.textAlign = 'left';
    ctx.fillText('НАЧАЛО', 53, 58);
    ctx.fillText('ЗОНА ОХРАНЫ', 580, 365);
  }
  function drawExit(exit, ready, t) {
    const x = exit.x, y = exit.y, pulse = .5 + .5*Math.sin(t*.004);
    ctx.save();ctx.translate(x,y);
    ctx.strokeStyle = ready ? '#d7fc78' : '#697780';
    ctx.lineWidth = 3;
    ctx.fillStyle = ready ? `rgba(172,251,103,${.17 + pulse*.15})` : 'rgba(122,140,142,.12)';
    ctx.fillRect(-33,-35,66,69);ctx.strokeRect(-33,-35,66,69);
    for (let i=-30;i<30;i+=12){ctx.beginPath();ctx.moveTo(i,-35);ctx.lineTo(i+24,33);ctx.stroke();}
    ctx.shadowBlur = ready ? 25 : 0;ctx.shadowColor = '#d7fc78';
    roundedRect(-33,-45,66,15,3,ready?'#d7fc78':'#627277');
    ctx.shadowBlur = 0;ctx.textAlign='center';ctx.font='900 9px Arial';ctx.fillStyle='#111b1d';ctx.fillText('ВЫХОД',0,-34);
    ctx.restore();
  }
  function drawParts(parts, t) {
    for (const part of parts) {
      if (part.taken) continue;
      ctx.save();ctx.translate(part.x,part.y);
      const r = 17 + Math.sin(t*.006 + part.id)*3;
      const glow = ctx.createRadialGradient(0,0,3,0,0,36);
      glow.addColorStop(0,'rgba(214,252,120,.40)');glow.addColorStop(1,'rgba(214,252,120,0)');
      ctx.fillStyle=glow;ctx.beginPath();ctx.arc(0,0,36,0,Math.PI*2);ctx.fill();
      ctx.save();ctx.rotate(t*.0012 + part.id);
      ctx.strokeStyle='#d7fc78';ctx.lineWidth=3;ctx.strokeRect(-10,-10,20,20);
      ctx.fillStyle='#ecffd0';ctx.fillRect(-6,-6,12,12);ctx.restore();
      ctx.strokeStyle=`rgba(215,252,120,${.35 + .3*Math.sin(t*.008)})`;ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();
      ctx.fillStyle='#f3ffce';ctx.font='900 10px Arial';ctx.textAlign='center';ctx.fillText('ДЕТАЛЬ',0,-27);
      ctx.restore();
    }
  }
  function drawPlayer(player, t) {
    ctx.save();ctx.translate(player.x,player.y);
    const color = playerColors[player.slot];
    const floating = Math.sin(t*.009 + player.slot)*1.5;
    ctx.fillStyle='#0008';ctx.beginPath();ctx.ellipse(0,11,16,7,0,0,Math.PI*2);ctx.fill();
    if (player.downed) {
      ctx.save();ctx.rotate(.75);roundedRect(-17,-9,34,21,8,'#8d8e98');ctx.restore();
      ctx.strokeStyle='#fd987f';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-7,-19);ctx.lineTo(6,-6);ctx.moveTo(6,-19);ctx.lineTo(-7,-6);ctx.stroke();
      ctx.fillStyle='#ffaf91';ctx.font='900 10px Arial';ctx.textAlign='center';ctx.fillText(`${Math.ceil(player.downTime)}с`,0,-29);
      if (player.revive > 0) {
        ctx.strokeStyle='#d7fc78';ctx.lineWidth=4;ctx.beginPath();ctx.arc(0,0,22,-Math.PI/2,-Math.PI/2+Math.PI*2*(player.revive/1.5));ctx.stroke();
      }
    } else {
      if (player.invuln > 0) {
        ctx.strokeStyle=`rgba(215,252,120,${.4 + .4*Math.sin(t*.03)})`;ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,21,0,Math.PI*2);ctx.stroke();
      }
      const angle=Math.atan2(player.lookY,player.lookX);
      ctx.save();ctx.rotate(angle);
      ctx.fillStyle=color+'33';ctx.beginPath();ctx.moveTo(5,-5);ctx.lineTo(92,-37);ctx.lineTo(92,37);ctx.closePath();ctx.fill();ctx.restore();
      roundedRect(-14,-10+floating,28,28,9,color);
      ctx.fillStyle='#101e25';ctx.beginPath();ctx.arc(0,-4+floating,9,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#e6f6db';ctx.beginPath();ctx.arc(-3,-5+floating,2,0,Math.PI*2);ctx.arc(4,-5+floating,2,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,16+floating);ctx.lineTo(player.lookX*13,16+floating+player.lookY*13);ctx.stroke();
    }
    ctx.textAlign='center';ctx.font='900 12px Arial';ctx.lineWidth=3.4;ctx.strokeStyle='#06121b';
    ctx.strokeText(player.name,0,-34);ctx.fillStyle=color;ctx.fillText(player.name,0,-34);
    if (player.id === myId) {ctx.font='900 9px Arial';ctx.fillStyle='#ecffad';ctx.fillText('▼ ТЫ',0,-47);}
    ctx.restore();
  }
  function drawKirpich(k, t) {
    ctx.save();ctx.translate(k.x,k.y);
    const wobble=Math.sin(t*.008)*2.5;
    ctx.fillStyle='rgba(0,0,0,.65)';ctx.beginPath();ctx.ellipse(0,17,25,11,0,0,Math.PI*2);ctx.fill();
    ctx.shadowColor='#f45d45';ctx.shadowBlur=19;
    roundedRect(-22,-17+wobble,44,43,13,'#bc473e');ctx.shadowBlur=0;
    ctx.fillStyle='#3a2528';ctx.fillRect(-15,10+wobble,30,11);
    ctx.fillStyle='#e6a16f';ctx.beginPath();ctx.arc(0,-13+wobble,19,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#24282b';ctx.beginPath();ctx.ellipse(0,-27+wobble,23,8,-.05,0,Math.PI*2);ctx.fill();
    roundedRect(-23,-36+wobble,44,12,4,'#242c30');
    ctx.strokeStyle='#3f2526';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(-13,-18+wobble);ctx.lineTo(-2,-16+wobble);ctx.moveTo(5,-16+wobble);ctx.lineTo(15,-19+wobble);ctx.stroke();
    ctx.fillStyle='#fff6d9';ctx.beginPath();ctx.arc(-8,-10+wobble,2.5,0,7);ctx.arc(9,-10+wobble,2.5,0,7);ctx.fill();
    ctx.fillStyle='#6c2d29';ctx.fillRect(-6,1+wobble,14,3);
    ctx.textAlign='center';ctx.font='900 14px Arial';ctx.lineWidth=3.5;ctx.strokeStyle='#210f14';ctx.strokeText('КИРПИЧ',0,-52);ctx.fillStyle='#ff957c';ctx.fillText('КИРПИЧ',0,-52);
    ctx.restore();
  }
  function drawFog(players, t) {
    if (!fogCanvas.width) return;
    const fw = fogCanvas.width, fh = fogCanvas.height;
    fogCtx.clearRect(0,0,fw,fh);
    fogCtx.globalCompositeOperation='source-over';
    fogCtx.fillStyle='rgba(4,9,15,.77)';fogCtx.fillRect(0,0,fw,fh);
    fogCtx.globalCompositeOperation='destination-out';
    for (const player of players) {
      const radius=player.downed ? 90 : 202 + Math.sin(t*.002)*6;
      const grad=fogCtx.createRadialGradient(player.x,player.y,28,player.x,player.y,radius);
      grad.addColorStop(0,'rgba(0,0,0,1)');grad.addColorStop(.53,'rgba(0,0,0,.94)');grad.addColorStop(1,'rgba(0,0,0,0)');
      fogCtx.fillStyle=grad;fogCtx.beginPath();fogCtx.arc(player.x,player.y,radius,0,Math.PI*2);fogCtx.fill();
    }
    fogCtx.globalCompositeOperation='source-over';
    ctx.drawImage(fogCanvas,0,0);
  }
  function drawMiniMap(state) {
    if (!map) return;
    const mobile = viewW < 500;
    const width = mobile ? 105 : 158;
    const height = (width / map[0].length) * map.length;
    const x = viewW - width - (mobile ? 13 : 20);
    const y = mobile ? 67 : 55;
    ctx.fillStyle='rgba(7,14,21,.91)';ctx.fillRect(x-7,y-7,width+14,height+14);
    ctx.strokeStyle='#6c8464';ctx.lineWidth=1;ctx.strokeRect(x-7,y-7,width+14,height+14);
    const cell = width / map[0].length;
    for (let row=0;row<map.length;row++) for (let col=0;col<map[row].length;col++) {
      ctx.fillStyle=map[row][col]?'#465953':'#1c3037';ctx.fillRect(x+col*cell,y+row*cell,cell+.2,cell+.2);
    }
    for (const part of state.parts) if (!part.taken) {
      ctx.fillStyle='#d7fc78';ctx.fillRect(x+part.x/tile*cell-2,y+part.y/tile*cell-2,4,4);
    }
    ctx.fillStyle=state.parts.every(p=>p.taken)?'#d7fc78':'#697a7d';
    ctx.fillRect(x+state.exit.x/tile*cell-3,y+state.exit.y/tile*cell-3,6,6);
    for (const player of state.players) {
      ctx.fillStyle=playerColors[player.slot];ctx.beginPath();ctx.arc(x+player.x/tile*cell,y+player.y/tile*cell,mobile?3:4,0,Math.PI*2);ctx.fill();
    }
    ctx.fillStyle='#f1685b';ctx.beginPath();ctx.arc(x+state.enemy.x/tile*cell,y+state.enemy.y/tile*cell,mobile?3:4,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#9daf9c';ctx.font='900 9px Arial';ctx.textAlign='left';ctx.fillText('РАДАР',x,y-12);
  }
  function render(time) {
    requestAnimationFrame(render);
    if (screen !== 'game' || !game || !map || !canvas.width) return;
    clockMs = time;
    ctx.setTransform(scaleFactor,0,0,scaleFactor,0,0);
    ctx.clearRect(0,0,viewW,viewH);
    ctx.fillStyle='#0d1a23';ctx.fillRect(0,0,viewW,viewH);
    const me = game.players.find(p=>p.id===myId);
    if (!me) return;
    const drawnPlayers=game.players.map(p=>getDrawEntity(p.id,p));
    const drawnEnemy=getDrawEntity('kirpich',game.enemy);
    const local=drawnPlayers.find(p=>p.id===myId);
    const zoom=viewW<540? .88:Math.max(.70,Math.min(1.13,Math.min(viewW/990,viewH/630)));
    if (Math.hypot(camera.x-local.x,camera.y-local.y)>300) camera={x:local.x,y:local.y};
    camera.x=lerp(camera.x,local.x,.085);camera.y=lerp(camera.y,local.y,.085);
    const worldW=map[0].length*tile,worldH=map.length*tile;
    const camX=Math.max(viewW/(2*zoom),Math.min(worldW-viewW/(2*zoom),camera.x));
    const camY=Math.max(viewH/(2*zoom),Math.min(worldH-viewH/(2*zoom),camera.y));
    ctx.save();ctx.translate(viewW/2,viewH/2);ctx.scale(zoom,zoom);ctx.translate(-camX,-camY);
    floorAndWalls(time);
    drawExit(game.exit,game.parts.every(p=>p.taken),time);
    drawParts(game.parts,time);
    for (const p of drawnPlayers) drawPlayer(p,time);
    drawKirpich(drawnEnemy,time);
    drawFog(drawnPlayers,time);
    ctx.restore();
    drawMiniMap(game);
    // Player-specific proximity ring / position indicator in the bottom-left corner.
    const distance = Math.hypot(me.x-game.enemy.x,me.y-game.enemy.y);
    if (distance<250) {
      ctx.fillStyle='#ed775a';ctx.font='900 10px Arial';ctx.textAlign='left';
      ctx.fillText(distance<120?'⚠ КИРПИЧ ОЧЕНЬ БЛИЗКО!':'⚠ ВЫ СЛЫШИТЕ ШАГИ...',15,viewH-19);
    }
  }
  requestAnimationFrame(render);
})();
