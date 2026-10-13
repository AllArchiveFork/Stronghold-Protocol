#!/bin/bash
# Daily (ark-geo-cn.timer): rebuild the mainland-China allowlist and install it on the proxy host.
# The proxy workers pick it up within a minute (ark_geo.lua); nothing is reloaded.
# target.env next to this script (not in Git) sets ARK_GEO_TARGET (ssh user@host), ARK_GEO_DIR (the site's geo/
# directory on that host), ARK_GEO_INSTALLER (install_cn_allow.py there) and optionally ARK_GEO_SSH_KEY.
set -euo pipefail
D=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
[ -f "$D/target.env" ] && . "$D/target.env"
: "${ARK_GEO_TARGET:?}" "${ARK_GEO_DIR:?}" "${ARK_GEO_INSTALLER:?}"
O=(-4 -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20)
[ -n "${ARK_GEO_SSH_KEY:-}" ] && O+=(-i "$ARK_GEO_SSH_KEY")
mkdir -p "$D/out"
python3 "$D/build_cn_allow.py" --state "$D/state" --out "$D/out/cn-allow.txt"
scp -q "${O[@]}" "$D/out/cn-allow.txt" "$ARK_GEO_TARGET:$ARK_GEO_DIR/.incoming.txt"
ssh -n "${O[@]}" "$ARK_GEO_TARGET" python3 "$ARK_GEO_INSTALLER" "$ARK_GEO_DIR/.incoming.txt" "$ARK_GEO_DIR/cn-allow.txt"
