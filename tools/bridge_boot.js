/* Fastrix: Playgama Bridge boot layer, injected by tools/build.py.
 * Runs right after the Bridge SDK script in <head>. The game's own scripts are
 * parked as type="text/x-fastrix" and run here only after bridge.initialize()
 * and the save load finish (Bridge required steps 2 and 4).
 */
(function () {
  var SAVE_KEY = 'fastrix_save';

  // Browser-storage stand-in: the build rewrites the game's browser-storage calls to
  // window.__fxStore. All settings and progress live in one Bridge storage key,
  // written at most once a second and when the page is hidden.
  var store = window.__fxStore = {
    _d: {}, _t: 0, _dirty: false,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem: function (k, v) { v = String(v); if (this._d[k] === v) return; this._d[k] = v; this._queue(); },
    removeItem: function (k) { if (!(k in this._d)) return; delete this._d[k]; this._queue(); },
    _queue: function () { var s = this; s._dirty = true; clearTimeout(s._t); s._t = setTimeout(function () { s.flush(); }, 1000); },
    flush: function () {
      if (!this._dirty) return; this._dirty = false; clearTimeout(this._t);
      try { return window.bridge.storage.set(SAVE_KEY, JSON.stringify(this._d)).catch(function () {}); } catch (e) {}
    }
  };
  // For the game: call before a page reload so the last change is not lost.
  // Returns a promise that settles when Bridge storage has the data.
  window.__fxBridge = true;
  window.__fxSaveNow = function () { return Promise.resolve(store.flush()); };
  addEventListener('pagehide', function () { store.flush(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) store.flush(); });

  // Game hooks (window.__fx) are defined at the end of the game script.
  var paused = false, audioOn = true;
  window.__fxPaused = false;
  function applyAudio() { if (window.__fx) window.__fx.audio(audioOn && !paused); }

  function runGame() {
    var parked = Array.prototype.slice.call(document.querySelectorAll('script[type="text/x-fastrix"]'));
    var i = 0;
    (function next() {
      if (i >= parked.length) return started();
      var old = parked[i++], s = document.createElement('script');
      if (old.dataset.src) { s.src = old.dataset.src; s.onload = next; s.onerror = next; old.parentNode.replaceChild(s, old); }
      else { s.textContent = old.textContent; old.parentNode.replaceChild(s, old); next(); }
    })();
  }

  function started() {
    applyAudio();
    var B = window.bridge;
    try {
      B.platform.on(B.EVENT_NAME.PAUSE_STATE_CHANGED, function (p) {
        paused = !!p; window.__fxPaused = paused;
        if (paused && window.__fx) window.__fx.pause();
        applyAudio();
      });
      B.platform.on(B.EVENT_NAME.AUDIO_STATE_CHANGED, function (on) { audioOn = !!on; applyAudio(); });
    } catch (e) {}
    // game_ready once the menu is usable: two frames after the loading screen (window.__fxL, v22+) is gone,
    // or after 12 s at most, so Playgama's load time matches when a player can really press «Играть».
    var t0 = Date.now(), sent = false;
    var ready = function () {
      if (sent) return; sent = true;
      try { B.platform.sendMessage('game_ready'); window.__fxReady = true; } catch (e) { console.warn('[fastrix] game_ready failed', e); }
    };
    (function wait() {
      if ((window.__fxL && window.__fxL.on) && Date.now() - t0 < 12000) { setTimeout(wait, 100); return; }
      requestAnimationFrame(function () { requestAnimationFrame(ready); });
    })();
  }

  // Interstitial at natural pauses (end of a match). Bridge decides whether one
  // is actually shown; no timers of our own.
  window.__fxAd = function () { try { window.bridge.advertisement.showInterstitial(); } catch (e) {} };

  // Rewarded ads (opt-in, e.g. "x2 coins"). The game shows its button only when
  // window.__fxRewarded exists, so platforms without rewarded ads never see it.
  // cb(true) only in the "rewarded" state; cb(false) if closed or failed first.
  function setupRewarded(B) {
    try { if (!B.advertisement.isRewardedSupported) return; } catch (e) { return; }
    var pending = null, granted = false;
    B.advertisement.on(B.EVENT_NAME.REWARDED_STATE_CHANGED, function (st) {
      if (!pending) return;
      if (st === 'rewarded') { granted = true; var cb = pending; pending = null; cb(true); }
      else if (st === 'closed' || st === 'failed') { var cb2 = pending; pending = null; if (!granted) cb2(false); }
    });
    window.__fxRewarded = function (cb) {
      if (pending) return; pending = cb; granted = false;
      try { B.advertisement.showRewarded(); } catch (e) { pending = null; cb(false); }
    };
  }

  function boot() {
    var B = window.bridge;
    if (!B) return runGame(); // SDK failed to load: still let the game run
    B.initialize()
      .then(function () {
        window.__fxLang = B.platform.language || 'en';
        audioOn = B.platform.isAudioEnabled !== false;
        setupRewarded(B);
        return B.storage.get([SAVE_KEY]);
      })
      .then(function (v) {
        var raw = Array.isArray(v) ? v[0] : v;
        if (raw) { try { var o = typeof raw === 'string' ? JSON.parse(raw) : raw; if (o && typeof o === 'object') store._d = o; } catch (e) {} }
      })
      .catch(function (e) { console.warn('[fastrix] bridge init/storage failed', e); })
      .then(runGame);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
