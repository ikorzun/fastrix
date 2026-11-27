#!/usr/bin/env python3
"""Build the online test page: arena + tools/mp_patch.js, packed by build.py (with Bridge).

Usage:  python3 -I tools/build_mp.py <arena.html> <out_dir> [--test-hook]
Open out_dir/index.html?mp=bridge (Playgama rooms) or ?mp=local (two tabs, no servers).
"""
import os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        sys.exit(__doc__)
    src, out = args
    html = open(src, encoding='utf-8').read()
    patch = open(os.path.join(HERE, 'tools', 'mp_patch.js'), encoding='utf-8').read()
    if '--test-hook' in sys.argv:
        patch += '\nwindow.__ev = (c) => eval(c);\n'
    i = html.rfind('\nframe();')
    if i < 0:
        sys.exit('build_mp: no "frame();" call found in ' + src)
    html = html[:i] + '\n' + patch + html[i:]
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, os.path.basename(src))
        open(p, 'w', encoding='utf-8').write(html)
        r = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'tools', 'build.py'), p, out])
    sys.exit(r.returncode)

if __name__ == '__main__':
    main()
