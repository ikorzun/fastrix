;/* ===== FASTRIX ONLINE (tools/mp_patch.js, injected by tools/build_mp.py) =====
 * Live players in one arena, free-for-all.
 * Modes:
 *   auto      Playgama build (window.__fxBridge, no ?mp): every fresh start («Play») looks for players
 *             in a Playgama Bridge room for this map while the 3-2-1 countdown runs. Somebody there:
 *             the match goes online. Nobody: the room is left and the match runs as usual.
 *             An online match left alone for 6 s turns back into a usual one.
 *   bridge    ?mp=bridge or the /mp/ test page: online from load, Bridge rooms.
 *   local     ?mp=local: online from load, BroadcastChannel (two tabs, no servers).
 *   autolocal ?mp=autolocal: auto mode over BroadcastChannel, for tests.
 * Model: each client owns its own player (position, health, death). Shots are checked
 * by the shooter and sent to the victim as 'hit'; the victim applies them with hurtPlayer.
 * Computer opponents are off while online; remote players appear as the same characters
 * (puppets), driven by the network with 120 ms interpolation.
 */
(function () {
  const Q = new URLSearchParams(location.search);
  const MODE = Q.get('mp') || (/\/mp\/(index\.html)?$/.test(location.pathname) ? 'bridge' : (window.__fxBridge ? 'auto' : ''));
  if (!MODE) return;
  const AUTO = MODE === 'auto' || MODE === 'autolocal', LOCAL = MODE === 'local' || MODE === 'autolocal';
  try { setup(); } catch (e) { console.error('[fastrix mp] setup failed', e); }
  function setup() {
  const SEND_MS = 66, INTERP_MS = 120, PEER_TIMEOUT = 4000, SEARCH_MS = 3000, ALONE_MS = 6000;
  const NET = window.__net = { mode: MODE, on: false, state: 'подключение…', peers: new Map(), rtt: null, sent: 0, recv: 0, room: null, searching: false };
  let myName = nickOne(), ON = false, T = null, aloneMs = 0;

  // ----- status chip (auto mode: only while a match is online) -----
  const chip = document.createElement('div');
  chip.id = 'netChip'; chip.setAttribute('translate', 'no'); chip.className = 'notranslate';
  chip.style.cssText = 'position:fixed;right:12px;top:calc(env(safe-area-inset-top,0px) + 64px);z-index:99999;pointer-events:none;' +
    'font:700 12px/1.2 Nunito,system-ui,sans-serif;color:#fff;background:rgba(22,19,31,.72);padding:4px 10px;border-radius:999px;white-space:nowrap';
  document.body.appendChild(chip);
  const EN = { 'подключение…': 'connecting…', 'в комнате (локально)': 'in a room (local)', 'онлайн недоступен на этой платформе': 'online is not available on this platform',
    'ищу комнату…': 'looking for a room…', 'в комнате': 'in a room', 'в комнате (хост)': 'in a room (host)', 'вне комнаты': 'out of the room' };
  function drawChip() {
    chip.hidden = AUTO && !ON;
    const n = NET.peers.size + 1, en = /^en/.test(document.documentElement.lang || '');
    let txt;
    if (AUTO) txt = en ? 'Online · players ' + n + (NET.rtt != null ? ' · ping ' + NET.rtt + ' ms' : '') : 'Онлайн · игроков ' + n + (NET.rtt != null ? ' · пинг ' + NET.rtt + ' мс' : '');
    else {
      const st = en ? (EN[NET.state] || NET.state.replace('связь: ', 'link: ').replace('ошибка: ', 'error: ')) : NET.state;
      txt = en ? 'Online: ' + st + ' · players ' + n + (NET.rtt != null ? ' · ping ' + NET.rtt + ' ms' : '')
               : 'Онлайн: ' + st + ' · игроков ' + n + (NET.rtt != null ? ' · пинг ' + NET.rtt + ' мс' : '');
    }
    if (chip.textContent !== txt) chip.textContent = txt;
  }
  setInterval(drawChip, 500);

  // the board code expects at least one opponent; with nobody joined yet it must not throw
  { const _drawBoard = drawBoard; drawBoard = function () { try { return _drawBoard.apply(this, arguments); } catch (e) {} }; }

  // ----- online on / off -----
  let pool = [], savedMode = null;
  function rebuildBoard() {
    if (typeof initBoard !== 'function' || !meF) return;
    const keep = new Map(fighters.map(f => [f.me ? '__me' : f, [f.sk, f.sd]]));
    initBoard();
    for (const f of fighters) { const s = keep.get(f.me ? '__me' : f); if (s) { f.sk = s[0]; f.sd = s[1]; } }
    drawBoard();
  }
  function enable() {
    if (ON) return; ON = true; NET.on = true; aloneMs = 0;
    try { AA_ONLINE = true; } catch (e) {}        // capped aim help (core v47 AA_ONLINE_CFG)
    try { SLOWMO_ON = false; } catch (e) {}       // nobody slows the world for real people
    try { mdInit(); savedMode = MD.mode; MD.mode = 'dm'; MD.cur = 'dm'; MD.win = null; MD.sc.A = 0; MD.sc.B = 0; } catch (e) {}
    pool = bots.splice(0);                        // computer opponents leave; they become puppets for players
    for (const b of pool) { b.dead = 1e9; b.g.visible = false; b.net = null; b.team = null; b.rv = null; b.foe = null; if (b.aimLine) b.aimLine.visible = false; }
    try { MD.boardMode = 'dm'; } catch (e) {}
    try { initBoard(); } catch (e) {}
    sendState(); drawChip();
  }
  function disable() {                            // back to a usual match: opponents return and spawn
    if (!ON) return;
    for (const q of [...NET.peers.values()]) removePeer(q);
    ON = false; NET.on = false;
    try { AA_ONLINE = false; } catch (e) {}
    try { SLOWMO_ON = true; } catch (e) {}
    for (const b of pool) { b.net = null; if (bots.indexOf(b) < 0) bots.push(b); }
    pool = [];
    try { if (savedMode) MD.mode = savedMode; MD.boardMode = null; _mdApply(); } catch (e) {}
    try { nickAll(); } catch (e) {}
    for (const b of bots) { b.dead = 0; try { spawnBot(b); } catch (e) {} }
    try { initBoard(); } catch (e) {}
    leaveRoom(); drawChip();
  }
  // core v48 match modes: online is deathmatch only, and the bots list belongs to the network
  const _mdApply = typeof mdApply === 'function' ? mdApply : function () {};
  if (typeof mdApply === 'function') {
    mdApply = function () {
      if (!ON) return _mdApply.apply(this, arguments);
      try { mdInit(); MD.mode = 'dm'; MD.cur = 'dm'; MD.win = null; MD.sc.A = 0; MD.sc.B = 0;
        for (const b of bots) { b.team = null; b.rv = null; b.foe = null; }
        if (MD.boardMode !== 'dm') { MD.boardMode = 'dm'; rebuildBoard(); } } catch (e) {}
    };
  }
  if (typeof mdSetMode === 'function') { const _ms = mdSetMode; mdSetMode = function (m) { if (!ON || m === 'dm') return _ms.apply(this, arguments); }; }
  if (typeof nickAll === 'function') { const _na = nickAll; nickAll = function () { if (!ON) return _na.apply(this, arguments); }; }   // puppet names come from their owners

  function takePuppet(p) {
    const b = pool.find(x => !x.net); if (!b) return null;
    b.net = p.id; b.name = p.name; b.dead = 0; b.hp = b.maxHp = 100; b.dmgByMe = 0; b.spawned = true;
    try { restoreDebris(b); } catch (e) {}
    b.g.visible = true; b.mats.forEach(m => m.emissive && m.emissive.setHex(0));
    b.mode = 'net'; b.foe = null; b.hunting = false; b.charged = false; b.chargeT = 0;
    bots.push(b); rebuildBoard(); return b;
  }
  function dropPuppet(p) {
    const b = p.b; if (!b) return; p.b = null;
    b.net = null; b.dead = 1e9; b.g.visible = false;
    const i = bots.indexOf(b); if (i >= 0) bots.splice(i, 1);
    rebuildBoard();
  }

  // ----- transports: send(type, data, to?), leave(); incoming messages go to onMsg({type, data, from}) -----
  function localTransport() {
    const id = Math.random().toString(36).slice(2, 10);
    const bc = new BroadcastChannel('fastrix-mp-' + MAP);
    const t = { id, ready: Promise.resolve(), send(type, data, to) { try { bc.postMessage({ type, data, from: id, to: to || null }); } catch (e) {} },
      leave() { t.send('bye', {}); try { bc.close(); } catch (e) {} } };
    bc.onmessage = e => { const m = e.data; if (!m || (m.to && m.to !== id) || T !== t) return; onMsg(m); };
    NET.state = 'в комнате (локально)'; NET.room = 'local-' + MAP;
    return t;
  }
  const B = window.bridge, M = B && B.multiplayer;
  let bridgeHooked = false;
  function bridgeTransport() {
    if (!M || !M.isSupported) { NET.state = 'онлайн недоступен на этой платформе'; return null; }
    const E = B.EVENT_NAME;
    if (!bridgeHooked) {
      bridgeHooked = true;
      M.on(E.MULTIPLAYER_STATE_CHANGED, s => { if (!M.roomId) NET.state = 'связь: ' + s; });
      M.on(E.MULTIPLAYER_MESSAGE_RECEIVED, m => { if (T && T.bridge) onMsg({ type: m.type, data: m.data, from: m.from }); });
      M.on(E.MULTIPLAYER_PLAYER_LEFT, p => { const q = NET.peers.get(p.id); if (q) removePeer(q); });
      M.on(E.MULTIPLAYER_ROOM_LEFT, () => { NET.state = 'вне комнаты'; NET.room = null; for (const q of [...NET.peers.values()]) removePeer(q); });
    }
    const t = { bridge: true, id: null, gone: false,
      send(type, data, to) { if (!M.roomId || t.gone) return; try { M.send(type, data, to ? { to } : undefined); } catch (e) {} },
      leave() { t.gone = true; try { if (M.roomId) M.leaveRoom(); } catch (e) {} } };
    NET.state = 'ищу комнату…';
    t.ready = M.joinOrCreateRoom({ maxPlayers: 8, filter: { mode: 'fx-ffa', map: MAP, v: 1 } }).then(id => {
      if (t.gone) { try { M.leaveRoom(); } catch (e) {} return; }   // gave up before the room answered
      t.id = M.playerId; NET.room = id; NET.state = 'в комнате' + (M.isHost ? ' (хост)' : '');
    }).catch(e => { NET.state = 'ошибка: ' + ((e && (e.code || e.message)) || e); });
    return t;
  }
  function openRoom() { if (!T) T = LOCAL ? localTransport() : bridgeTransport(); return T; }
  function leaveRoom() { if (T) { try { T.leave(); } catch (e) {} T = null; } NET.room = null; }
  addEventListener('pagehide', () => leaveRoom());

  // ----- peers -----
  function peerFor(id, name) {
    let p = NET.peers.get(id);
    if (!p) {
      p = { id, name: name || 'Игрок', buf: [], last: 0, b: null };
      if (p.name === myName) myName = nickOne();          // two equal nicknames would mix up the kill feed
      for (const q of NET.peers.values()) if (q.name === p.name) p.name += ' ' + (1 + Math.random() * 9 | 0);
      NET.peers.set(id, p); p.b = takePuppet(p);
    }
    return p;
  }
  function removePeer(p) { dropPuppet(p); NET.peers.delete(p.id); }

  // ----- auto mode: look for players while the 3-2-1 countdown runs -----
  let searchT = 0, searchHi = 0;
  function search() {
    if (NET.searching) return;
    if (!openRoom()) return;                      // no multiplayer on this platform: a usual match
    NET.searching = true;
    const hi = () => { if (T) T.send('hi', { n: myName }); };
    Promise.resolve(T.ready).then(hi);
    searchHi = setInterval(hi, 500);
    searchT = setTimeout(() => endSearch(false), SEARCH_MS);
  }
  function endSearch(found) {
    if (!NET.searching) return;
    NET.searching = false; clearTimeout(searchT); clearInterval(searchHi);
    if (found) enable(); else if (!ON) leaveRoom();
  }
  if (AUTO && typeof goPlay === 'function') {
    const _gp = goPlay;
    goPlay = function (fresh) {
      const r = _gp.apply(this, arguments);       // first, so full screen and the mouse keep the player's tap
      try {
        if (fresh) {
          if (ON && !NET.peers.size) disable();   // everybody left between matches
          if (!ON) search();
        }
      } catch (e) { console.warn('[fastrix mp] search', e); }
      return r;
    };
  }

  const W_SET = { rifle: 1, pistol: 1, shotgun: 1, sniper: 1 };
  function onMsg(m) {
    NET.recv++;
    if (!ON) {                                    // not online yet: a sign of life from another player ends the search
      if (NET.searching && (m.type === 'hi' || m.type === 'st')) { endSearch(true); } else return;
      if (m.type === 'hi') return;
    }
    if (m.type === 'hi') { sendState(); return; } // answer at once: the newcomer is still counting 3-2-1
    if (m.type === 'st') {
      const d = m.data, p = peerFor(m.from, d.n);
      p.last = performance.now();
      p.buf.push({ t: p.last, x: d.p[0], y: d.p[1], z: d.p[2], yw: d.y, w: d.w, dd: d.d, hp: d.hp, g: d.g });
      if (p.buf.length > 30) p.buf.shift();
      if (d.s && d.s.length && p.b) for (const s of d.s) remoteShot(p, s);
    } else if (m.type === 'hit') {
      const p = NET.peers.get(m.from); if (!p) return;
      const d = m.data, alive = deadT <= 0; hurtPlayer(d.d, p.name, d.w, p.b ? p.b.pos : null);
      if (d.h && deadT <= 0) sfx('head', 0.45, 0.8);
      if (alive && deadT > 0 && T) T.send('kd', { w: d.w }, m.from);   // this hit killed me: the shooter gets the kill
    } else if (m.type === 'kd') {                 // the victim says our hit killed it (our own copy may lag behind)
      const p = NET.peers.get(m.from), b = p && p.b;
      if (b && b.dead <= 0) { b.localKillMs = b.awaitDD = performance.now(); try { _damageBot(b, (b.hp || 100) + 999, false, b.pos.clone(), { kind: m.data.w }); } catch (e) {} }
    } else if (m.type === 'ping') T && T.send('pong', { id: m.data.id }, m.from);
    else if (m.type === 'pong' && pings[m.data.id]) { NET.rtt = Math.round(performance.now() - pings[m.data.id]); delete pings[m.data.id]; }
    else if (m.type === 'bye') { const p = NET.peers.get(m.from); if (p) removePeer(p); }
  }
  const pings = {};
  setInterval(() => { if (!ON || !T || !NET.peers.size) return; const id = Math.random().toString(36).slice(2, 8); pings[id] = performance.now(); const p = NET.peers.values().next().value; T.send('ping', { id }, p.id); }, 2000);

  // ----- what we send: our state 15 times a second, with the shots fired since the last packet -----
  let shots = [], sendT = 0;
  const _castShot = castShot;
  castShot = function (spread, out) {
    const r = _castShot(spread, out);
    if (ON) try { const o = ray.ray.origin, d = ray.ray.direction; if (shots.length < 12) shots.push([+o.x.toFixed(2), +o.y.toFixed(2), +o.z.toFixed(2), +d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3), W.id]); } catch (e) {}
    return r;
  };
  function sendState() {
    if (!T) return;
    const P = player.pos;
    T.send('st', { n: myName, p: [+P.x.toFixed(2), +P.y.toFixed(2), +P.z.toFixed(2)], y: +yaw.toFixed(3), w: W.id, d: deadT > 0 ? 1 : 0, hp: Math.max(0, Math.round(hp)), g: player.onGround ? 1 : 0, s: shots });
    shots = []; NET.sent++;
  }

  // ----- hits: the shooter decides, the victim applies -----
  const _damageBot = damageBot;
  damageBot = function (bot, dmg, head, point, opt = {}) {
    if (!bot || !bot.net) return _damageBot(bot, dmg, head, point, opt);
    if (bot.dead > 0) return false;
    const h0 = bot.hp, r = _damageBot(bot, dmg, head, point, opt), dealt = Math.max(0, h0 - bot.hp);
    if (dealt > 0 && T) { T.send('hit', { d: Math.round(dealt), h: head ? 1 : 0, w: opt.kind || W.id }, bot.net); bot.myHitMs = performance.now(); }
    if (r) bot.localKillMs = bot.awaitDD = performance.now();
    return r;
  };
  if (typeof hzHurtBot === 'function') { const _hz = hzHurtBot; hzHurtBot = function (b) { if (b && b.net) return; return _hz.apply(this, arguments); }; }
  if (typeof botHurtBot === 'function') { const _bh = botHurtBot; botHurtBot = function (b, o) { if ((b && b.net) || (o && o.net)) return; return _bh.apply(this, arguments); }; }

  // ----- remote shots: tracer from the puppet's gun along the shooter's aim, stopped by walls -----
  const shotRay = new THREE.Raycaster(), sO = new THREE.Vector3(), sD = new THREE.Vector3(), sM = new THREE.Vector3(), sE = new THREE.Vector3();
  function remoteShot(p, s) {
    const b = p.b; if (!b || b.dead > 0) return;
    sO.set(s[0], s[1], s[2]); sD.set(s[3], s[4], s[5]).normalize();
    shotRay.set(sO, sD); shotRay.far = 90;
    const h = shotRay.intersectObjects(solidMeshes, false);
    sE.copy(h.length ? h[0].point : sD.clone().multiplyScalar(90).add(sO));
    if (b.gunG) b.gunG.localToWorld(sM.set(0, b.muzY != null ? b.muzY : 0.02, b.muzZ || -0.62)); else sM.set(b.pos.x, b.pos.y + 1.3, b.pos.z);
    const w = s[6];
    tracer(sM, sE, w === 'sniper' ? 0xff2a48 : w === 'shotgun' ? 0xff9a3a : 0xff5a4a, 0.06, w === 'sniper' ? 'enemySniper' : w === 'shotgun' ? 'enemyShotgun' : 'enemy');
    if (h.length && typeof sparksAt === 'function') sparksAt(h[0].point);
    b.recoilT = w === 'sniper' || w === 'shotgun' ? 0.2 : 0.1;
    const vol = Math.max(0.15, 1 - Math.hypot(b.pos.x - player.pos.x, b.pos.z - player.pos.z) / 45), sp = { pos: b.pos };
    if (w === 'sniper') sfx('w_sniper', 0.55 * vol, 0.92, sp); else if (w === 'shotgun') sfx('w_shotgun', 0.5 * vol, 0.95, sp);
    else if (w === 'pistol') sfx('w_pistol', 0.4 * vol, 0.97, sp); else sfx('enemy', 0.6 * vol, 1, sp);
  }

  // ----- puppets: interpolated 120 ms behind, animated like the characters they are -----
  function sample(buf, t) {
    if (!buf.length) return null;
    if (t <= buf[0].t) return buf[0];
    for (let i = buf.length - 1; i > 0; i--) {
      const a = buf[i - 1], c = buf[i];
      if (t >= a.t) {
        if (t >= c.t) return c;
        const k = (t - a.t) / Math.max(1, c.t - a.t);
        let dy = c.yw - a.yw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        return { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: a.z + (c.z - a.z) * k, yw: a.yw + dy * k, w: c.w, dd: c.dd, hp: c.hp, g: c.g };
      }
    }
    return buf[buf.length - 1];
  }
  let lastTick = 0;
  function netTick(dt) {
    const now = lastTick = performance.now();
    // auto mode, left alone (in a match or between matches): the usual opponents come back
    if (AUTO) { if (NET.peers.size) aloneMs = 0; else if (!aloneMs) aloneMs = now; else if (now - aloneMs > ALONE_MS) { aloneMs = 0; disable(); return; } }
    if ((sendT -= dt * 1000) <= 0) { sendT = SEND_MS; sendState(); }
    for (const p of [...NET.peers.values()]) {
      if (now - p.last > PEER_TIMEOUT) { removePeer(p); continue; }
      const b = p.b; if (!b) continue;
      const st = sample(p.buf, now - INTERP_MS); if (!st) continue;
      if (st.dd) {                                      // dead on its own screen (hazard, someone else): break apart here too
        if (b.dead <= 0) { b.dead = 999; try { burstBot(b, 'rifle', b.pos); } catch (e) {}
          if (now - (b.localKillMs || 0) > 900) { b.sd = (b.sd || 0) + 1; try { drawBoard(); } catch (e) {} } }   // own grenade, hazard: a death, no kill to anyone
        else b.awaitDD = 0;                            // its own death packet after our kill: from now on a live packet is a respawn
        continue;
      }
      if (b.dead > 0) {                                 // alive again over there
        if (now - (b.localKillMs || 0) < 900 || (b.awaitDD && now - b.awaitDD < 5000)) continue;   // older packets from before the kill
        b.dead = 0; b.hp = st.hp; try { restoreDebris(b); } catch (e) {} b.g.visible = true; b.mats.forEach(m => m.emissive && m.emissive.setHex(0));
        b.pos.set(st.x, st.y, st.z); try { pfx('respawn-beam', b.pos, 3.4); } catch (e) {}
      }
      if (now - (b.myHitMs || 0) > 400) b.hp = st.hp;
      if (W_SET[st.w] && b.wpn !== st.w) { b.wpn = st.w; try { gobSetWeapon(b); } catch (e) {} }
      b.flashT -= dt; if (b.flashT <= 0) b.mats.forEach(m => m.emissive && m.emissive.setHex(0));
      const ox = b.pos.x, oz = b.pos.z;
      b.pos.set(st.x, st.y, st.z); b.onGround = !!st.g;
      b.g.position.copy(b.pos); b.g.rotation.y = st.yw;
      const moved = Math.hypot(b.pos.x - ox, b.pos.z - oz) / Math.max(dt, 1e-4);
      try { if (b.gob) gobAnimate(b, dt, moved, Math.hypot(b.pos.x - player.pos.x, b.pos.z - player.pos.z)); else animateBlocky(b, dt, moved > 0.5, Math.max(0.6, moved / 4)); } catch (e) {}
      b.losT = (b.losT || 0) - dt; if (b.losT <= 0) { b.losT = 0.2; b.losCache = canSee(b); }
      b.spotT = b.losCache ? 6 : (b.spotT || 0) - dt;
    }
  }
  // the AI loop runs without the puppets; the network moves them instead
  const _updateBots = updateBots;
  updateBots = function (dt) {
    if (!ON) return _updateBots(dt);
    const keep = bots.splice(0);
    try { _updateBots(dt); } finally { bots.push(...keep); }
    netTick(dt);
  };
  // the menu stays open until the player presses «Play»; keep sending state anyway
  // and while the world stands still (menu, 3-2-1 countdown, pause) nobody runs the AI loop
  setInterval(() => { if (ON && performance.now() - lastTick > 150) netTick(0.1); }, 100);
  if (!AUTO) { openRoom(); if (T) enable(); }
  drawChip();
  }
})();
/* ===== FASTRIX ONLINE (end) ===== */
