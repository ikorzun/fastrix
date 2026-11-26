#!/usr/bin/env python3
"""Build a Playgama-ready archive from any single-file version of the arena.

Usage:  python3 -I tools/build.py <arena.html> [out_dir]
        (run from /mnt/project-files/shooter_game)

The single-file HTML stays the source of truth while the main arena thread
keeps editing it. This step only rewires what Playgama forbids (rule 1.2.5:
no external resources) and checks the result; it never edits game code.

  - three.js r128 from cdnjs  -> vendor/three.min.js (same version, local)
  - Google Fonts Rubik/Unbounded -> vendor/fonts.css + woff2 files
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
FETCH_RE = re.compile(r'''(?:fetch|import)\(\s*["'`]https?://''', re.I)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'dist')
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
                'maximum-scale=1, user-scalable=no, viewport-fit=cover">\n</head>\n<body>\n'
                + html + '\n</body>\n</html>\n')

    problems = []
    for rx, what in ((EXTERNAL_RE, 'src/href to the network'), (CSS_URL_RE, 'css url() to the network'),
                     (FETCH_RE, 'fetch/import from the network')):
        for m in rx.finditer(html):
            line = html.count('\n', 0, m.start()) + 1
            problems.append('BLOCKER 1.2.5 %s at line %d: %s' % (what, line, html[m.start():m.start() + 90].replace('\n', ' ')))

    notes = []
    def count(pat, label):
        c = len(re.findall(pat, html))
        if c:
            notes.append('%s: %d' % (label, c))
    count(r'localStorage', 'TODO 3.2.1 localStorage uses (move to bridge.storage)')
    count(r'createOscillator', 'TODO 3.3.2 synthesized sounds (createOscillator)')
    count(r'[\U0001F300-\U0001FAFF☀-➿]', 'TODO 4.3.2 emoji characters in the file')
    count(r'Esc\s*[—-]', 'TODO 1.5.2 game text mentions Esc (browser reserves it)')
    if 'playgama-bridge' not in html:
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
    for p in problems:
        print(p)
    for n in notes:
        print(n)
    print('external loads left:', len(problems))
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
