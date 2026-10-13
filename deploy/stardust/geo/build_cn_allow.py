#!/usr/bin/env python3
"""Build the mainland-China allowlist read by ark_geo.lua on the Jinan proxy (2026-10-13).

Sources, united: APNIC delegated stats (CN allocations, daily, md5-checked) and Loyalsoldier/geoip
release text/cn.txt (GeoLite2 + ipip based, rebuilt weekly). Each source is checked on its own; one that
cannot be fetched or fails a check falls back to its last good copy when that is at most MAX_AGE_DAYS old.
The union must not move more than MAX_SHIFT from the previous output unless --force.

Output (stdout path given by --out), consumed line by line by ark_geo.lua:
  # ark-geo-cn v1 generated=<UTC> v4=<ranges> v6=<ranges> v4addrs=<n> sources=<...> sha256=<body digest>
  4 <first> <last>    IPv4, decimal, merged and sorted
  6 <first> <last>    IPv6, first 64 bits as 16 lowercase hex digits, merged and sorted
"""
import argparse, hashlib, ipaddress, json, os, sys, time, urllib.request

APNIC_URL = 'https://ftp.apnic.net/stats/apnic/delegated-apnic-latest'
LOYAL_URL = 'https://raw.githubusercontent.com/Loyalsoldier/geoip/release/text/cn.txt'
MAX_AGE_DAYS = 14
MAX_SHIFT = 0.10
V4_ADDRS = (200_000_000, 450_000_000)
MIN_V6 = 500
INSIDE = ['223.5.5.5', '114.114.114.114', '119.29.29.29', '180.76.76.76', '1.2.4.8', '2400:3200::1', '240e::1']
OUTSIDE = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '208.67.222.222', '168.95.1.1', '202.175.3.3', '103.151.172.1',
           '43.243.192.91', '135.136.22.28', '2001:4860:4860::8888', '2606:4700:4700::1111']


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'ark-geo-cn/1'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            raise RuntimeError(f'{url}: HTTP {r.status}')
        return r.read()


def parse_apnic(raw):
    nets = []
    for line in raw.decode('ascii', 'strict').splitlines():
        p = line.split('|')
        if len(p) < 7 or p[0] != 'apnic' or p[1] != 'CN' or p[6] not in ('allocated', 'assigned'):
            continue
        if p[2] == 'ipv4':
            first = ipaddress.IPv4Address(p[3])
            last = ipaddress.IPv4Address(int(first) + int(p[4]) - 1)
            nets.extend(ipaddress.summarize_address_range(first, last))
        elif p[2] == 'ipv6':
            nets.append(ipaddress.IPv6Network(f'{p[3]}/{p[4]}'))
    return nets


def parse_cidrs(raw):
    nets = []
    for line in raw.decode('ascii', 'strict').splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            nets.append(ipaddress.ip_network(line, strict=True))
    return nets


def ranges(nets):
    """Merged [first, last] integer ranges per family; IPv6 reduced to its first 64 bits."""
    v4, v6 = [], []
    for n in nets:
        if n.version == 4:
            v4.append((int(n.network_address), int(n.broadcast_address)))
        else:
            v6.append((int(n.network_address) >> 64, int(n.broadcast_address) >> 64))
    out = []
    for items in (v4, v6):
        items.sort()
        merged = []
        for a, b in items:
            if merged and a <= merged[-1][1] + 1:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        out.append(merged)
    return out


def contains(rs, ip):
    a = ipaddress.ip_address(ip)
    key = int(a) if a.version == 4 else int(a) >> 64
    return any(x <= key <= y for x, y in rs[0 if a.version == 4 else 1])


def check(name, nets):
    """Raise unless a source looks like a sane CN table."""
    for n in nets:
        if (n.version == 4 and n.prefixlen < 8) or (n.version == 6 and n.prefixlen < 16):
            raise ValueError(f'{name}: implausibly short prefix {n}')
    rs = ranges(nets)
    addrs = sum(b - a + 1 for a, b in rs[0])
    if not V4_ADDRS[0] <= addrs <= V4_ADDRS[1]:
        raise ValueError(f'{name}: {addrs} IPv4 addresses outside {V4_ADDRS}')
    if len(rs[1]) < MIN_V6:
        raise ValueError(f'{name}: only {len(rs[1])} IPv6 ranges')
    missing = [ip for ip in INSIDE if not contains(rs, ip)]
    leaked = [ip for ip in OUTSIDE if contains(rs, ip)]
    if missing or leaked:
        raise ValueError(f'{name}: missing {missing} / unexpected {leaked}')
    return rs


def source(state, name, url, parser, verify=None):
    """Fresh copy when it passes, else the cached last good copy if young enough. Returns (nets, label)."""
    cache = os.path.join(state, f'{name}.cache')
    try:
        raw = fetch(url)
        if verify:
            verify(raw)
        nets = parser(raw)
        check(name, nets)
        tmp = cache + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(raw)
        os.replace(tmp, cache)
        return nets, f'{name}:fresh'
    except Exception as e:  # noqa: BLE001 - any failure falls back to the cached copy
        print(f'{name}: fresh copy rejected: {e}', file=sys.stderr)
    if not os.path.exists(cache):
        raise RuntimeError(f'{name}: no usable copy')
    age = (time.time() - os.path.getmtime(cache)) / 86400
    if age > MAX_AGE_DAYS:
        raise RuntimeError(f'{name}: cached copy is {age:.1f} days old')
    with open(cache, 'rb') as f:
        nets = parser(f.read())
    check(name, nets)
    return nets, f'{name}:cached-{age:.1f}d'


def apnic_md5(raw):
    want = fetch(APNIC_URL + '.md5').decode('ascii').split()[-1].strip().lower()
    got = hashlib.md5(raw).hexdigest()
    if want != got:
        raise ValueError(f'md5 mismatch {got} != {want}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--state', required=True, help='directory for source caches and the last output summary')
    ap.add_argument('--out', required=True)
    ap.add_argument('--force', action='store_true', help='accept a shift larger than MAX_SHIFT')
    args = ap.parse_args()
    os.makedirs(args.state, exist_ok=True)

    apnic, l1 = source(args.state, 'apnic', APNIC_URL, parse_apnic, apnic_md5)
    loyal, l2 = source(args.state, 'loyalsoldier', LOYAL_URL, parse_cidrs)
    extra_path = os.path.join(args.state, 'extra-allow.txt')
    extra = []
    if os.path.exists(extra_path):
        with open(extra_path, 'rb') as f:
            extra = parse_cidrs(f.read())
    rs = check('union', apnic + loyal + extra)
    v4addrs = sum(b - a + 1 for a, b in rs[0])

    summary_path = os.path.join(args.state, 'last.json')
    if os.path.exists(summary_path) and not args.force:
        with open(summary_path) as f:
            prev = json.load(f)
        shift4 = abs(v4addrs - prev['v4addrs']) / prev['v4addrs']
        shift6 = abs(len(rs[1]) - prev['v6']) / prev['v6']
        if shift4 > MAX_SHIFT or shift6 > 2 * MAX_SHIFT:
            raise SystemExit(f'refusing: IPv4 shift {shift4:.1%}, IPv6 shift {shift6:.1%} (use --force)')

    body = ''.join(f'4 {a} {b}\n' for a, b in rs[0]) + ''.join(f'6 {a:016x} {b:016x}\n' for a, b in rs[1])
    digest = hashlib.sha256(body.encode()).hexdigest()
    head = (f'# ark-geo-cn v1 generated={time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} v4={len(rs[0])} '
            f'v6={len(rs[1])} v4addrs={v4addrs} sources={l1},{l2},extra:{len(extra)} sha256={digest}\n')
    tmp = args.out + '.tmp'
    with open(tmp, 'w') as f:
        f.write(head + body)
    os.replace(tmp, args.out)
    with open(summary_path + '.tmp', 'w') as f:
        json.dump({'v4addrs': v4addrs, 'v4': len(rs[0]), 'v6': len(rs[1]), 'sha256': digest}, f)
    os.replace(summary_path + '.tmp', summary_path)
    print(head.strip())


if __name__ == '__main__':
    main()
