#!/usr/bin/env python3
"""Build a Playgama-ready archive from any single-file version of the arena.

Usage:  python3 -I tools/build.py [--no-bridge] <arena.html> [out_dir]
        (run from /mnt/project-files/shooter_game)

The single-file HTML stays the source of truth while the main arena thread
keeps editing it. This step only rewires what Playgama forbids (rule 1.2.5:
no external resources) and checks the result; it never edits game code.

  - three.js r128 from cdnjs  -> vendor/three.min.js (same version, local)
  - Google Fonts (Bangers, Nunito, Fira Sans Extra Condensed) -> vendor/fonts.css + woff2 files
  - Playgama Bridge (stage 1): SDK first in <head>, game scripts start only
    after bridge.initialize() and the save load, localStorage -> Bridge
    storage, pause/audio events, game_ready, interstitial after each match
    (tools/bridge_boot.js + hooks below). --no-bridge skips this.
  - reports anything still loaded from the network and other known blockers
  - writes out_dir/ and out_dir.zip (index.html at the archive root)
"""
import os, re, shutil, sys, zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(HERE, 'vendor')

THREE_RE = re.compile(r'<script\s+src="https://cdnjs\.cloudflare\.com/ajax/libs/three\.js/r128/three\.min\.js"\s*>\s*</script>')
FONTS_RE = re.compile(r'<link[^>]+href="https://fonts\.googleapis\.com/[^"]*"[^>]*>')
PRECONNECT_RE = re.compile(r'<link[^>]+rel="preconnect"[^>]*>')
EXTERNAL_RE = re.compile(r'''(?:src|href)\s*=\s*["'](https?:)?//''', re.I)
CSS_URL_RE = re.compile(r'''url\(\s*["']?https?://''', re.I)
BRIDGE_CDN = 'https://bridge.playgama.com/v2/stable/playgama-bridge.js'
BOOT_JS = os.path.join(HERE, 'tools', 'bridge_boot.js')
# Names the hooks rely on in the main game script; the build stops if one is gone.
HOOK_NAMES = ('function endMatch', 'function frame', 'function initAudio', 'function showStart',
              'playing', 'matchOver', 'actx')
HOOKS_JS = r'''
;/* fastrix bridge hooks (tools/build.py) */
window.__fx = {
  pause: function () { if (playing && matchOver <= 0) showStart(window.__fxLang && window.__fxLang.indexOf('ru') !== 0 ? 'Paused' : '\u041f\u0430\u0443\u0437\u0430'); },
  audio: function (on) { window.__fxAudioOn = on; try { if (actx) { if (on) actx.resume(); else actx.suspend(); } } catch (e) {} }
};
(function () {
  var em = endMatch; endMatch = function () { var r = em.apply(this, arguments); if (window.__fxAd) window.__fxAd(); return r; };
  var fr = frame; frame = function () { if (window.__fxPaused) { requestAnimationFrame(frame); return; } return fr.apply(this, arguments); };
  var ia = initAudio; initAudio = function () { var r = ia.apply(this, arguments); if (window.__fxAudioOn === false && actx) { try { actx.suspend(); } catch (e) {} } return r; };
})();
'''
TOUCH_RE = re.compile(r"matchMedia\('\(pointer: coarse\)'\)\.matches \|\| 'ontouchstart' in window")
STORE_TITLE = 'Fastrix: FPS Arena Shooter Online'   # rule 3.5.1: matches the Playgama form title
SCRIPT_RE = re.compile(r'<script(\s[^>]*)?>(.*?)</script>', re.S | re.I)


def inject_bridge(html):
    """Park the game's scripts behind Bridge init and wire the required steps."""
    main_idx, parked = None, []

    def park(m):
        attrs, body = m.group(1) or '', m.group(2)
        if re.search(r'type\s*=\s*["\']application/json', attrs):
            return m.group(0)
        src = re.search(r'src\s*=\s*["\']([^"\']+)', attrs)
        if src:
            parked.append(src.group(1))
            return '<script type="text/x-fastrix" data-src="%s"></script>' % src.group(1)
        body = re.sub(r'\blocalStorage\b', 'window.__fxStore', body)
        # rule 1.5.4: touch controls follow Bridge device.type, not the pointer or screen
        body = TOUCH_RE.sub(lambda m: "(window.__fxTouch !== undefined ? window.__fxTouch : (%s))" % m.group(0), body)
        parked.append(len(body))
        return '<script type="text/x-fastrix">%s</script>' % body

    html = SCRIPT_RE.sub(park, html)
    # The main game script is the largest inline one: append the hooks to it.
    blocks = [(m.start(1), m.end(1)) for m in re.finditer(r'<script type="text/x-fastrix">(.*?)</script>', html, re.S)]
    if not blocks:
        sys.exit('bridge: no game scripts found')
    a, b = max(blocks, key=lambda x: x[1] - x[0])
    main = html[a:b]
    missing = [n for n in HOOK_NAMES if n not in main]
    if missing:
        sys.exit('bridge: hook anchors missing in the game script: %s' % ', '.join(missing))
    # The game runs inside one IIFE: the hooks go inside it, before the final
    # "})();", so they see endMatch, frame, actx and the rest.
    tail = re.search(r'\}\s*\)\s*\(\s*\)\s*;?\s*$', main)
    main = main[:tail.start()] + HOOKS_JS + main[tail.start():] if tail else main + HOOKS_JS
    html = html[:a] + main + html[b:]
    boot = open(BOOT_JS, encoding='utf-8').read()
    head = '<script src="%s"></script>\n<script>%s</script>\n' % (BRIDGE_CDN, boot)
    html = re.sub(r'<head>\s*', lambda m: m.group(0) + head, html, count=1)
    html = re.sub(r'<title>[^<]*</title>', '<title>%s</title>' % STORE_TITLE, html, count=1)
    return html, len(parked)


FETCH_RE = re.compile(r'''(?:fetch|import)\(\s*["'`]https?://''', re.I)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    use_bridge = '--no-bridge' not in sys.argv
    src = args[0]
    out = args[1] if len(args) > 1 else os.path.join(HERE, 'dist')
    html = open(src, encoding='utf-8').read()

    html, n3 = THREE_RE.subn('<script src="three.min.js"></script>', html)
    if n3 != 1:
        sys.exit('three.js r128 cdnjs tag not found exactly once (found %d): check the source' % n3)
    html, nf = FONTS_RE.subn('<link rel="stylesheet" href="fonts.css">', html)
    html = PRECONNECT_RE.sub('', html)

    # The artifact source is a page fragment: claude.ai adds the document
    # skeleton at publish time. A standalone archive needs its own.
    if not re.search(r'<!doctype', html[:200], re.I):
        html = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1, '
                'maximum-scale=1, user-scalable=no, viewport-fit=cover">\n'
                # rule 1.6.3: the page itself never scrolls (browser default body margin is 8 px)
                '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}</style>\n</head>\n<body>\n'
                + html + '\n</body>\n</html>\n')

    nparked = 0
    if use_bridge:
        # Tester mode (economy thread, patch_tester.py) never ships to Playgama: cut its marked spans.
        html, nt1 = re.subn(r'<!--FX_TESTER-->.*?<!--/FX_TESTER-->', '', html, flags=re.S)
        html, nt2 = re.subn(r'/\*FX_TESTER\{\*/.*?/\*\}FX_TESTER\*/', '', html, flags=re.S)
        if nt1 or nt2:
            print('tester  : cut %d html + %d js spans' % (nt1, nt2))
        if 'FX_TESTER' in html or '__fxTester' in html:
            sys.exit('bridge: tester mode code is still in the build after cutting its spans: stop')
        html, nparked = inject_bridge(html)

    problems = []
    for rx, what in ((EXTERNAL_RE, 'src/href to the network'), (CSS_URL_RE, 'css url() to the network'),
                     (FETCH_RE, 'fetch/import from the network')):
        for m in rx.finditer(html):
            if html.startswith(BRIDGE_CDN, m.end() - 2) or BRIDGE_CDN in html[m.start():m.start() + 90]:
                continue  # the Bridge SDK itself is loaded from Playgama's CDN by design
            line = html.count('\n', 0, m.start()) + 1
            problems.append('BLOCKER 1.2.5 %s at line %d: %s' % (what, line, html[m.start():m.start() + 90].replace('\n', ' ')))

    notes = []
    def count(pat, label):
        c = len(re.findall(pat, html))
        if c:
            notes.append('%s: %d' % (label, c))
    count(r'\blocalStorage\b', 'TODO 3.2.1 localStorage uses left (move to bridge.storage)')
    count(r'createOscillator', 'TODO 3.3.2 synthesized sounds (createOscillator)')
    # ★ ☆ ♥ are ordinary font glyphs, not emoji
    count(r'(?![★☆♥])[\U0001F300-\U0001FAFF☀-➿]', 'TODO 4.3.2 emoji characters in the file')
    count(r'Esc\s*[—-]', 'TODO 1.5.2 game text mentions Esc (browser reserves it)')
    if 'playgama-bridge.js' not in html:
        notes.append('TODO 1.1.1 Playgama Bridge script not added yet (stage 1)')

    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(html)
    shutil.copy(os.path.join(VENDOR, 'three.min.js'), out)
    if nf:
        shutil.copy(os.path.join(VENDOR, 'fonts.css'), out)
        shutil.copytree(os.path.join(VENDOR, 'fonts'), os.path.join(out, 'fonts'))
    cfg = os.path.join(HERE, 'playgama-bridge-config.json')
    if os.path.exists(cfg):
        shutil.copy(cfg, out)
    lic = os.path.join(out, 'licenses')
    os.makedirs(lic)
    for f in os.listdir(VENDOR):
        if f.startswith('LICENSE'):
            shutil.copy(os.path.join(VENDOR, f), lic)

    zpath = out.rstrip('/') + '.zip'
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(out):
            for f in files:
                p = os.path.join(root, f)
                z.write(p, os.path.relpath(p, out))

    size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(out) for f in fs)
    print('source  :', src)
    print('built   :', out, '(%.1f MB unpacked)' % (size / 1e6))
    print('archive :', zpath, '(%.1f MB)' % (os.path.getsize(zpath) / 1e6))
    print('replaced: three.js tag x%d, Google Fonts link x%d' % (n3, nf))
    print('bridge  :', 'on, %d game scripts start after bridge.initialize()' % nparked if use_bridge else 'off (--no-bridge)')
    for p in problems:
        print(p)
    for n in notes:
        print(n)
    print('external loads left:', len(problems))
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
