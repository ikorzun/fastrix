;/* ===== FASTRIX ONLINE PROTOTYPE (tools/mp_patch.js, injected by tools/build_mp.py) =====
 * Live players in one arena, free-for-all. Turned on by ?mp=bridge (Playgama Bridge rooms)
 * or ?mp=local (BroadcastChannel: two tabs of one browser, for testing without servers).
 * Model: each client owns its own player (position, health, death). Shots are checked
 * by the shooter and sent to the victim as 'hit'; the victim applies them with hurtPlayer.
 * Computer opponents are switched off in this mode for now; remote players appear as
 * the same characters (puppets), driven by the network with 120 ms interpolation.
 */
(function () {
  const Q = new URLSearchParams(location.search);
  const MODE = Q.get('mp') || (/\/mp\/(index\.html)?$/.test(location.pathname) ? 'bridge' : '');
  if (!MODE) return;
  try { setup(); } catch (e) { console.error('[fastrix mp] setup failed', e); }
  function setup() {
  const SEND_MS = 66, INTERP_MS = 120, PEER_TIMEOUT = 4000;
  const NET = window.__net = { mode: MODE, state: 'подключение…', peers: new Map(), rtt: null, sent: 0, recv: 0, room: null };
  let myName = nickOne();

  // ----- status chip -----
  const chip = document.createElement('div');
  chip.id = 'netChip';
  chip.style.cssText = 'position:fixed;right:12px;top:calc(env(safe-area-inset-top,0px) + 64px);z-index:99999;pointer-events:none;' +
    'font:700 12px/1.2 Nunito,system-ui,sans-serif;color:#fff;background:rgba(22,19,31,.72);padding:4px 10px;border-radius:999px;white-space:nowrap';
  document.body.appendChild(chip);
  function drawChip() {
    const n = NET.peers.size + 1;
    chip.textContent = 'Онлайн: ' + NET.state + ' · игроков ' + n + (NET.rtt != null ? ' · пинг ' + NET.rtt + ' мс' : '');
  }
  setInterval(drawChip, 500);

  // ----- computer opponents off: they become a pool of puppets for remote players -----
  // the board code expects at least one opponent; with nobody joined yet it must not throw
  { const _drawBoard = drawBoard; drawBoard = function () { try { return _drawBoard.apply(this, arguments); } catch (e) {} }; }
  const pool = bots.splice(0);
  for (const b of pool) { b.dead = 1e9; b.g.visible = false; b.net = null; if (b.aimLine) b.aimLine.visible = false; }
  function rebuildBoard() {
    if (typeof initBoard !== 'function' || !meF) return;
    const keep = new Map(fighters.map(f => [f.me ? '__me' : f, [f.sk, f.sd]]));
    initBoard();
    for (const f of fighters) { const s = keep.get(f.me ? '__me' : f); if (s) { f.sk = s[0]; f.sd = s[1]; } }
    drawBoard();
  }
  rebuildBoard();

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

  // ----- transports: both give send(type, data, to?) and call onMsg({type, data, from}) -----
  let T = null;
  function localTransport() {
    const id = Math.random().toString(36).slice(2, 10);
    const bc = new BroadcastChannel('fastrix-mp-' + MAP);
    const t = { id, send(type, data, to) { bc.postMessage({ type, data, from: id, to: to || null }); }, onMsg: null, leave() { t.send('bye', {}); } };
    bc.onmessage = e => { const m = e.data; if (!m || (m.to && m.to !== id)) return; t.onMsg && t.onMsg(m); };
    NET.state = 'в комнате (локально)'; NET.room = 'local-' + MAP;
    return t;
  }
  function bridgeTransport() {
    const B = window.bridge, M = B && B.multiplayer;
    if (!M || !M.isSupported) { NET.state = 'онлайн недоступен на этой платформе'; return null; }
    const E = B.EVENT_NAME;
    const t = { id: null, send(type, data, to) { if (!M.roomId) return; try { M.send(type, data, to ? { to } : undefined); } catch (e) {} }, onMsg: null, leave() { try { M.leaveRoom(); } catch (e) {} } };
    M.on(E.MULTIPLAYER_STATE_CHANGED, s => { if (!M.roomId) NET.state = 'связь: ' + s; });
    M.on(E.MULTIPLAYER_MESSAGE_RECEIVED, m => t.onMsg && t.onMsg({ type: m.type, data: m.data, from: m.from }));
    M.on(E.MULTIPLAYER_PLAYER_LEFT, p => { const q = NET.peers.get(p.id); if (q) removePeer(q); });
    M.on(E.MULTIPLAYER_ROOM_LEFT, () => { NET.state = 'вне комнаты'; NET.room = null; for (const q of [...NET.peers.values()]) removePeer(q); });
    NET.state = 'ищу комнату…';
    M.joinOrCreateRoom({ maxPlayers: 8, filter: { mode: 'fx-ffa', map: MAP, v: 1 } }).then(id => {
      t.id = M.playerId; NET.room = id; NET.state = 'в комнате' + (M.isHost ? ' (хост)' : '');
    }).catch(e => { NET.state = 'ошибка: ' + ((e && (e.code || e.message)) || e); });
    return t;
  }
  T = MODE === 'local' ? localTransport() : bridgeTransport();
  if (!T) { drawChip(); return; }
  addEventListener('pagehide', () => T.leave());

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

  const W_SET = { rifle: 1, pistol: 1, shotgun: 1, sniper: 1 };
  T.onMsg = m => {
    NET.recv++;
    if (m.type === 'st') {
      const d = m.data, p = peerFor(m.from, d.n);
      p.last = performance.now();
      p.buf.push({ t: p.last, x: d.p[0], y: d.p[1], z: d.p[2], yw: d.y, w: d.w, dd: d.d, hp: d.hp, g: d.g });
      if (p.buf.length > 30) p.buf.shift();
      if (d.s && d.s.length && p.b) for (const s of d.s) remoteShot(p, s);
    } else if (m.type === 'hit') {
      const p = NET.peers.get(m.from); if (!p) return;
      const d = m.data; hurtPlayer(d.d, p.name, d.w, p.b ? p.b.pos : null);
      if (d.h && deadT <= 0) sfx('head', 0.45, 0.8);
    } else if (m.type === 'ping') T.send('pong', { id: m.data.id }, m.from);
    else if (m.type === 'pong' && pings[m.data.id]) { NET.rtt = Math.round(performance.now() - pings[m.data.id]); delete pings[m.data.id]; }
    else if (m.type === 'bye') { const p = NET.peers.get(m.from); if (p) removePeer(p); }
  };
  const pings = {};
  setInterval(() => { if (!NET.peers.size) return; const id = Math.random().toString(36).slice(2, 8); pings[id] = performance.now(); const p = NET.peers.values().next().value; T.send('ping', { id }, p.id); }, 2000);

  // ----- what we send: our state 15 times a second, with the shots fired since the last packet -----
  let shots = [], sendT = 0;
  const _castShot = castShot;
  castShot = function (spread, out) {
    const r = _castShot(spread, out);
    try { const o = ray.ray.origin, d = ray.ray.direction; if (shots.length < 12) shots.push([+o.x.toFixed(2), +o.y.toFixed(2), +o.z.toFixed(2), +d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3), W.id]); } catch (e) {}
    return r;
  };
  function sendState() {
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
    if (dealt > 0) { T.send('hit', { d: Math.round(dealt), h: head ? 1 : 0, w: opt.kind || W.id }, bot.net); bot.myHitMs = performance.now(); }
    if (r) bot.localKillMs = performance.now();
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
  function netTick(dt) {
    const now = performance.now();
    if ((sendT -= dt * 1000) <= 0) { sendT = SEND_MS; sendState(); }
    for (const p of [...NET.peers.values()]) {
      if (now - p.last > PEER_TIMEOUT) { removePeer(p); continue; }
      const b = p.b; if (!b) continue;
      const st = sample(p.buf, now - INTERP_MS); if (!st) continue;
      if (st.dd) {                                      // dead on its own screen (hazard, someone else): break apart here too
        if (b.dead <= 0) { b.dead = 999; try { burstBot(b, 'rifle', b.pos); } catch (e) {} }
        continue;
      }
      if (b.dead > 0) {                                 // alive again over there
        if (now - (b.localKillMs || 0) < 900) continue;
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
    const keep = bots.splice(0);
    try { _updateBots(dt); } finally { bots.push(...keep); }
    netTick(dt);
  };
  // the menu stays open in this mode until the player presses «Играть»; keep sending state anyway
  setInterval(() => { if (!playing) netTick(0.1); }, 100);
  drawChip();
  }
})();
/* ===== FASTRIX ONLINE PROTOTYPE (end) ===== */
