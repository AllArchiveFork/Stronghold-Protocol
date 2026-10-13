#!/usr/bin/env python3
"""Install a pushed mainland-China allowlist for ark_geo.lua (Jinan proxy, 2026-10-13).

usage: install_cn_allow.py <incoming> <target>
<incoming> must sit in the target's directory (atomic rename). Checks the header digest, the line format,
order and counts, and a few known inside/outside addresses; keeps the replaced file as <target>.prev.
The proxy workers pick the new file up within a minute; no reload.
"""
import hashlib, ipaddress, os, re, sys

HEAD = re.compile(r'^# ark-geo-cn v1 generated=\S+ v4=(\d+) v6=(\d+) v4addrs=(\d+) sources=\S+ sha256=([0-9a-f]{64})$')
INSIDE = ['223.5.5.5', '114.114.114.114', '119.29.29.29', '2400:3200::1']
OUTSIDE = ['8.8.8.8', '1.1.1.1', '103.151.172.1', '43.243.192.91', '2001:4860:4860::8888']


def main(incoming, target):
    if os.path.dirname(os.path.abspath(incoming)) != os.path.dirname(os.path.abspath(target)):
        raise SystemExit('incoming must be in the target directory')
    with open(incoming, 'rb') as f:
        data = f.read().decode('ascii')
    head, _, body = data.partition('\n')
    m = HEAD.match(head)
    if not m:
        raise SystemExit('bad header')
    n4, n6, addrs, digest = int(m[1]), int(m[2]), int(m[3]), m[4]
    if hashlib.sha256(body.encode()).hexdigest() != digest:
        raise SystemExit('digest mismatch')
    fam = {'4': [], '6': []}
    for line in body.splitlines():
        p = line.split(' ')
        if len(p) != 3 or p[0] not in fam:
            raise SystemExit(f'bad line {line!r}')
        if p[0] == '4':
            a, b = int(p[1]), int(p[2])
            if not (p[1].isdigit() and p[2].isdigit() and a <= b < 2 ** 32):
                raise SystemExit(f'bad line {line!r}')
        else:
            if not (re.fullmatch(r'[0-9a-f]{16}', p[1]) and re.fullmatch(r'[0-9a-f]{16}', p[2])):
                raise SystemExit(f'bad line {line!r}')
            a, b = int(p[1], 16), int(p[2], 16)
            if a > b:
                raise SystemExit(f'bad line {line!r}')
        rs = fam[p[0]]
        if rs and a <= rs[-1][1] + 1:
            raise SystemExit(f'unsorted or unmerged at {line!r}')
        rs.append((a, b))
    if len(fam['4']) != n4 or len(fam['6']) != n6 or sum(b - a + 1 for a, b in fam['4']) != addrs:
        raise SystemExit('counts do not match the header')
    if n4 < 1000 or n6 < 500 or not 200_000_000 <= addrs <= 450_000_000:
        raise SystemExit('implausible table size')

    def inside(ip):
        x = ipaddress.ip_address(ip)
        key, rs = (int(x), fam['4']) if x.version == 4 else (int(x) >> 64, fam['6'])
        return any(a <= key <= b for a, b in rs)

    bad = [ip for ip in INSIDE if not inside(ip)] + [ip for ip in OUTSIDE if inside(ip)]
    if bad:
        raise SystemExit(f'probe mismatch {bad}')
    os.chmod(incoming, 0o644)
    if os.path.exists(target):
        with open(target, 'rb') as src, open(target + '.prev.tmp', 'wb') as dst:
            dst.write(src.read())
        os.chmod(target + '.prev.tmp', 0o644)
        os.replace(target + '.prev.tmp', target + '.prev')
    os.replace(incoming, target)
    print(f'installed {head}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
