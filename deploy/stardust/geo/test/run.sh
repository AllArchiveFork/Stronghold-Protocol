#!/bin/bash
# Functional test of ark_geo.lua in OpenResty 1.27.1.2 (Docker, local only; no production access, no network).
# usage: test/run.sh <cn-allow.txt built by build_cn_allow.py>
set -u
D=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
TABLE=$(readlink -f "${1:?usage: run.sh <cn-allow.txt>}")
IMAGE=${ARK_GEO_TEST_IMAGE:-openresty/openresty:1.27.1.2-focal}
T=$(mktemp -d); trap 'docker rm -f ark-geo-test >/dev/null 2>&1; rm -rf "$T"' EXIT
mkdir -p "$T/geo"; chmod 755 "$T" "$T/geo"
cp "$D/ark_geo.lua" "$T/geo/"; chmod 644 "$T/geo/ark_geo.lua"
docker rm -f ark-geo-test >/dev/null 2>&1
docker run -d --name ark-geo-test -p 127.0.0.1:18080:8080 -v "$T/geo:/geo:ro" -v "$D/test/nginx.conf:/etc/geo-test.conf:ro" \
  "$IMAGE" openresty -g 'daemon off; user nobody nogroup;' -c /etc/geo-test.conf >/dev/null || exit 1
sleep 2
FAILS=0
q() { curl -s -o "$T/body" -w '%{http_code}' -H "X-Real-IP: $1" "http://127.0.0.1:18080${2:-/}"; }
expect() {
  local got; got=$(q "$2" "${3:-/}")
  if [ "$got" = "$1" ]; then echo "PASS $1 $2 ${3:-/}"; else echo "FAIL want $1 got $got for $2 ${3:-/}"; FAILS=$((FAILS + 1)); fi
}
# install <file>: the installer's own path check needs the incoming file next to the target
install_table() { cp "$1" "$T/geo/.incoming.txt"; python3 "$D/install_cn_allow.py" "$T/geo/.incoming.txt" "$T/geo/cn-allow.txt"; }

echo "-- no table: fail open"; expect 200 8.8.8.8; expect 200 223.5.5.5
install_table "$TABLE" | cut -c1-100; sleep 3
echo "-- table loaded"
for ip in 223.5.5.5 114.114.114.114 119.29.29.29 1.2.4.8 2400:3200::1 240e::1 10.1.2.3 127.0.0.1 172.20.0.1 100.64.1.1 \
  ::1 fd00::1 fe80::1 ::ffff:223.5.5.5; do expect 200 "$ip"; done
for ip in 8.8.8.8 1.1.1.1 103.151.172.1 103.151.173.204 168.95.1.1 202.175.3.3 2001:4860:4860::8888 ::ffff:8.8.8.8; do
  expect 403 "$ip"; done
expect 403 8.8.8.8 /x404; expect 404 223.5.5.5 /x404; expect 403 8.8.8.8 /ws
curl -s -D - -o /dev/null -H "X-Real-IP: 8.8.8.8" http://127.0.0.1:18080/ | grep -i -E "content-type|cache-control"

echo "-- hot update: a table that also holds 4.4.4.0/24"; expect 403 4.4.4.4
python3 - "$TABLE" "$T/extra.txt" <<'PY'
import hashlib, re, sys
head, _, body = open(sys.argv[1]).read().partition('\n')
lines = body.splitlines()
v4 = sorted([tuple(map(int, l.split()[1:])) for l in lines if l.startswith('4 ')] + [(67372032, 67372287)])
v6 = [l for l in lines if l.startswith('6 ')]
body = ''.join(f'4 {a} {b}\n' for a, b in v4) + ''.join(l + '\n' for l in v6)
head = re.sub(r'v4=\d+', f'v4={len(v4)}', head)
head = re.sub(r'v4addrs=\d+', f'v4addrs={sum(b - a + 1 for a, b in v4)}', head)
head = re.sub(r'generated=\S+', 'generated=test-extra', head)
head = re.sub(r'sha256=\w+', 'sha256=' + hashlib.sha256(body.encode()).hexdigest(), head)
open(sys.argv[2], 'w').write(head + '\n' + body)
PY
install_table "$T/extra.txt" | cut -c1-100; sleep 3
expect 200 4.4.4.4; expect 403 1.1.1.1

echo "-- the installer refuses a bad push; workers keep their table when the file goes bad"
printf '# ark-geo-cn v1 junk\n4 1 2\n' > "$T/bad.txt"; install_table "$T/bad.txt" 2>&1 | tail -1; rm -f "$T/geo/.incoming.txt"
printf 'garbage\n' > "$T/geo/cn-allow.txt"; sleep 3; expect 200 4.4.4.4; expect 403 1.1.1.1
echo "-- restart with a bad table: fail open"; docker restart ark-geo-test >/dev/null; sleep 2; expect 200 1.1.1.1

echo "-- log"; docker logs ark-geo-test 2>&1 | grep -E "ark_geo|\[(error|crit|alert|emerg)\]" | sed -E 's/^.*\] //' | sort | uniq -c
echo "failures: $FAILS"; exit $((FAILS > 0))
