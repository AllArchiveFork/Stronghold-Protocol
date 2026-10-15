#!/usr/bin/env python3
"""Compose a NEW WG-less co-located stack from a verified core bundle; no SSH, Docker or activation.

The coordinator, the bundle's fixed 16 or 32 games and N local ingress share the core bridge on one host.
The node count and per-game worker pools come only from the verified core policy. Core keys and runtime
files are reused untouched; ingress dial the bridge directly and nothing is published on the WG address.
The root host manager does not cover this stack (no leases or CAS), see LOCAL-STACK.md; Main-thread priority is
main-thread-priority.py --profile local (MAIN-THREAD-PRIORITY.md).

Opt-in --ingress-link: one new 32-byte key per local ingress (only here, never copied), each ingress mounting only its
own key and naming the coordinator's private bridge listener; the coordinator gets a DERIVED runtime (the verified core
runtime plus `ingresses`) and the link-key directory. Without it the output is byte-identical.

Opt-in --valkey: the match checkpoints' store (docs/DEPLOY.md「断点续玩」, server/persist/): one Valkey container on the
core bridge (VALKEY_IMAGE pinned by digest, nothing published, AOF on the project's named volume, a new random password
in a 0440 config only it mounts), and the coordinator and every game get SP_REDIS_URL / SP_REDIS_PASSWORD_FILE /
SP_REDIS_PREFIX. Without it the output is byte-identical.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys

_DEPLOY_SPEC = importlib.util.spec_from_file_location('cluster_local_deploy', Path(__file__).resolve().with_name('cluster-deploy.py'))
deploy = importlib.util.module_from_spec(_DEPLOY_SPEC)
sys.modules[_DEPLOY_SPEC.name] = deploy
_DEPLOY_SPEC.loader.exec_module(deploy)
profiles, Refused, require = deploy.profiles, deploy.Refused, deploy.require
# Local ingress sit after the games on the core bridge (profile.local_ingress_ip/host_port): behind
# sixteen games (.11 .. .26) .31 .. .38 on the edge loopback ports 35401..; behind thirty-two
# (.11 .. .42) up to sixteen at .51 .. .66 on 35451 .. 35466 (Formal values).


def local_project(profile='beta'):
    return 'ark-cluster-' + profiles.get_profile(profile).name + '-local'


def protected(path, profile, *, missing=False):
    path = Path(os.path.abspath(path))
    require(all(path != repo and repo not in path.parents for repo in deploy.FORBIDDEN_REPOS), 'protected path must be outside repository')
    require(profiles.path_allowed(path, profile), 'cross-profile protected path refused')
    return deploy.no_symlink(path, missing=missing)


def local_ingress_service(instance, profile, game_nodes):
    # Validated against the stack layout: up to 16 only behind the expanded Formal inventory.
    profiles.get_profile(profile).local_ingress_ip(instance, game_nodes)
    return 'ingress' if instance == 1 else 'ingress-' + format(instance, '02d')


# The coordinator's hot-reloadable online cap and room / AI caps (server/onlineLimit.js; e.g. {"limit": 0,
# "maxRoomsPerAddr": 24, "maxBotsPerAddr": 60}): the host DIRECTORY is mounted read-only (an editor's or mv's
# replacement keeps working) and the file inside it may be absent (= no cap).
ONLINE_LIMIT_MOUNT = '/run/limits'
ONLINE_LIMIT_FILE = ONLINE_LIMIT_MOUNT + '/online-limit.json'
# The owner (服主) file of the same directory (server/ownerFile.js; {"names": [...], "keySha256": "<64 hex>"}); absent = off.
OWNER_FILE = ONLINE_LIMIT_MOUNT + '/owner.json'
# The checkpoint store (--valkey): the newest stable Valkey (9.1.2, 2026-09-01) pinned by digest; it runs as the image's
# own user (uid 999, gid 1000 — the group every project secret file already has) at core_ip(5), which no role uses.
VALKEY_IMAGE = 'valkey/valkey:9.1.2-alpine3.24@sha256:48332870af354a799964c0012ae1194a0bf2bf894eb508f945810596dc2d8d11'
VALKEY_SUFFIX = 5
# Not under /run/secrets: the coordinator mounts its whole keys directory read-only there, and runc cannot create a
# nested mount point inside a read-only bind (rel17 2026-10-16: the coordinator did not start).
VALKEY_PASSWORD_MOUNT = '/run/store/valkey.pass'
VALKEY_MAXMEMORY_MB = 2048
# The server switches an operator may set on the coordinator and every game (--server-env KEY=VALUE), each with the
# values the server understands (server/plugins/policy.js, server/match/host/childHost.js, server/index.js,
# server/studio/gate.js, server/match/Match.js). Production since rel17 (owner 2026-10-16): SP_PLUGINS=off SP_CSP=off
# SP_STUDIO=off; SP_PLUGIN_SCRIPTS and SP_BOT_REHEARSAL stay unset.
SERVER_ENV = {'SP_PLUGINS': ('off', 'host', 'fixed'), 'SP_PLUGIN_SCRIPTS': ('off', 'sandbox'), 'SP_CSP': ('off',),
              'SP_STUDIO': ('off', 'local', 'lan'), 'SP_BOT_REHEARSAL': ('host',)}


def valkey_config(password, maxmemory_mb):
    # The bridge is the only network it is on (no published port); AOF every second on the named volume keeps the
    # checkpoints through a recreate; when full, the keys closest to expiry go first (every key has a TTL).
    return ('bind 0.0.0.0\nport 6379\nprotected-mode yes\nrequirepass ' + password + '\ndir /data\n'
            'appendonly yes\nappendfsync everysec\nsave ""\n'
            'maxmemory ' + str(maxmemory_mb) + 'mb\nmaxmemory-policy volatile-ttl\n').encode()


def compose(core_bundle, out, *, profile='beta', ingress_instances=1, ingress_link=False, online_limit_dir=None,
            valkey=False, valkey_maxmemory_mb=VALKEY_MAXMEMORY_MB, server_env=None):
    p = profiles.get_profile(profile)
    if online_limit_dir is not None:
        online_limit_dir = protected(online_limit_dir, profile)
        st = online_limit_dir.stat()
        require(online_limit_dir.is_dir() and st.st_uid == os.geteuid() and not st.st_mode & 0o022,
                'online limit directory must exist, be a directory, owned and not group/world writable')
    # The exact per-inventory bound is checked once the verified core policy fixes the node count.
    require(type(ingress_instances) is int and ingress_instances >= 1, 'invalid fixed ingress instance count')
    require(ingress_link in (True, False), 'invalid ingress link option')
    require(valkey in (True, False) and type(valkey_maxmemory_mb) is int and 256 <= valkey_maxmemory_mb <= 65536,
            'invalid checkpoint store option')
    server_env = dict(server_env or {})
    require(all(type(k) is str and type(v) is str and v in SERVER_ENV.get(k, ()) for k, v in server_env.items()),
            'invalid server switch')
    core_bundle, out = protected(core_bundle, profile), protected(out, profile, missing=True)
    require(not out.exists(), 'output already exists; never overwrite a release')
    parent = out.parent.stat()
    require(parent.st_uid == os.geteuid() and not parent.st_mode & 0o022, 'output parent must be protected and owned')
    policy = json.loads((core_bundle / 'host-policy.json').read_text())
    raw = (core_bundle / 'compose.json').read_bytes()
    require(policy.get('host_role') == 'core' and policy.get('namespace') == p.name and policy.get('bundle') == str(core_bundle)
            and hashlib.sha256(raw).hexdigest() == policy.get('compose_sha256'), 'unverified core bundle refused')
    core = json.loads(raw)
    # Absent is the original sixteen; the generator writes the field only for another fixed count.
    nodes = policy.get('game_nodes', 16)
    require(type(nodes) is int and nodes in deploy.GAME_NODE_COUNTS and nodes <= p.max_game_nodes
            and ('game_nodes' not in policy or nodes != 16), 'invalid fixed game node count')
    require(ingress_instances <= p.max_local_ingress_instances(nodes), 'invalid fixed ingress instance count')
    expected = {'coordinator': p.core_ip(2), **{'game-%02d' % i: p.game_ip(i) for i in range(1, nodes + 1)}}
    require(set(core['services']) == set(expected)
            and all(core['services'][name]['networks']['default']['ipv4_address'] == ip for name, ip in expected.items()),
            'core bundle inventory changed')
    # The generator's per-game pools (cluster-deploy --combat-workers/--trial-workers): every game's
    # Compose environment and runtime must carry the targets' pair; the coordinator runs none.
    workers = deploy.game_workers(policy.get('targets'))
    require(workers is not None and workers != (0, 0), 'invalid per-game worker counts')
    for name, value in core['services'].items():
        env, game = value.get('environment'), name != 'coordinator'
        require(isinstance(env, dict) and (env.get('SP_COMBAT_WORKERS'), env.get('SP_TRIAL_WORKERS'))
                == (tuple(map(str, workers)) if game else ('0', '0')), 'core bundle worker environment changed')
        if game:
            runtime = json.loads((core_bundle / 'runtime' / name / 'runtime.json').read_bytes())
            pair = (runtime.get('combatWorkers'), runtime.get('trialWorkers')) if isinstance(runtime, dict) else (None, None)
            require(deploy.valid_workers(*pair) and pair == workers, 'core bundle worker runtime changed')
    coordinator_runtime = None
    if ingress_link:
        target = next((row for row in policy.get('targets', []) if row.get('service') == 'coordinator'), None)
        runtime_file = core_bundle / 'runtime' / 'coordinator' / 'runtime.json'
        raw_runtime = runtime_file.read_bytes()
        require(target is not None and target.get('runtime_file') == str(runtime_file)
                and hashlib.sha256(raw_runtime).hexdigest() == target.get('runtime_sha256'), 'unverified coordinator runtime refused')
        coordinator_runtime = json.loads(raw_runtime)
        require(coordinator_runtime.get('role') == 'coordinator' and 'ingresses' not in coordinator_runtime, 'unexpected coordinator runtime')
    project, services = local_project(profile), {}
    for name, value in core['services'].items():
        value = json.loads(json.dumps(value))
        value['container_name'] = project + '-' + name
        # The WG address does not exist on a co-located host; only the loopback publications remain.
        value['ports'] = [port for port in value['ports'] if not port.startswith(p.wg_core + ':')]
        require(value['ports'] and all(port.startswith('127.0.0.1:') for port in value['ports']), 'non-loopback publication refused')
        # No root manager restarts these roles, so Docker restores them after a crash or host boot.
        value['restart'] = 'unless-stopped'
        if name == 'coordinator' and online_limit_dir is not None:
            value['volumes'] = [*value['volumes'], str(online_limit_dir) + ':' + ONLINE_LIMIT_MOUNT + ':ro']
            value['environment'] = {**value['environment'], 'SP_ONLINE_LIMIT_FILE': ONLINE_LIMIT_FILE, 'SP_OWNER_FILE': OWNER_FILE}
        services[name] = value
    original_config = str(core_bundle / 'runtime' / 'coordinator') + ':/run/config:ro'
    require(not ingress_link or services['coordinator']['volumes'][0] == original_config, 'unexpected coordinator config mount')
    deploy.mkdir_new(out)
    deploy.mkdir_new(out / 'runtime')
    names = [local_ingress_service(instance, profile, nodes) for instance in range(1, ingress_instances + 1)]
    if ingress_link:
        # New per-ingress link keys exist only in this stack; the coordinator reads the directory, each ingress its own file.
        deploy.mkdir_new(out / 'link-keys')
        for name in names:
            deploy.write_new(out / 'link-keys' / (name + '.key'), secrets.token_bytes(32))
        runtime = {**coordinator_runtime, 'ingresses': [{'ingressId': name, 'keyFile': '/run/link-secrets/' + name + '.key'} for name in names]}
        deploy.mkdir_new(out / 'runtime' / 'coordinator')
        deploy.write_new(out / 'runtime' / 'coordinator' / 'runtime.json', deploy.canonical(runtime))
        volumes = services['coordinator']['volumes']
        services['coordinator']['volumes'] = [str(out / 'runtime' / 'coordinator') + ':/run/config:ro', *volumes[1:],
                                              str(out / 'link-keys') + ':/run/link-secrets:ro']
    store_volumes = None
    if valkey:
        # A new password exists only in this stack: the store's config (only the store mounts it) and the clients' file.
        deploy.mkdir_new(out / 'valkey')
        password = secrets.token_hex(32)
        deploy.write_new(out / 'valkey' / 'valkey.conf', valkey_config(password, valkey_maxmemory_mb))
        deploy.write_new(out / 'valkey.pass', password.encode())
        store_ip = p.core_ip(VALKEY_SUFFIX)
        require(store_ip not in expected.values(), 'checkpoint store address taken')
        services['valkey'] = {
            'image': VALKEY_IMAGE, 'pull_policy': 'never', 'container_name': project + '-valkey', 'restart': 'unless-stopped',
            'user': '999:1000', 'command': ['valkey-server', '/run/valkey/valkey.conf'],
            'labels': {'cn.stardust.cluster.role': 'store', 'cn.stardust.cluster.namespace': p.name},
            'ports': [], 'volumes': [str(out / 'valkey') + ':/run/valkey:ro', 'valkey-data:/data'],
            'read_only': True, 'tmpfs': ['/tmp:rw,noexec,nosuid,size=16m'],
            'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'pids_limit': 64,
            'healthcheck': {'disable': True}, 'networks': {'default': {'ipv4_address': store_ip}},
            'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
        }
        for name in expected:
            value = services[name]
            value['environment'] = {**value['environment'], 'SP_REDIS_URL': f'redis://{store_ip}:6379/0',
                                    'SP_REDIS_PASSWORD_FILE': VALKEY_PASSWORD_MOUNT, 'SP_REDIS_PREFIX': p.name + ':'}
            value['volumes'] = [*value['volumes'], str(out / 'valkey.pass') + ':' + VALKEY_PASSWORD_MOUNT + ':ro']
            # stopped after the roles (their last checkpoints), started before them
            value['depends_on'] = ['valkey']
        store_volumes = {'valkey-data': {}}
    for name in expected:
        value = services[name]
        require(not set(server_env) & set(value['environment']), 'server switch already set by the core bundle')
        value['environment'] = {**value['environment'], **server_env}
    config = {'role': 'ingress', 'host': '0.0.0.0', 'port': 3000, 'coordinatorUrl': f'http://{p.core_ip(2)}:3000',
              'nodes': [{'nodeId': 'game-%02d' % i, 'url': f'http://{p.game_ip(i)}:3000'} for i in range(1, nodes + 1)],
              'origins': [p.origin], 'wsCompression': 'on', 'trustProxy': 'auto'}
    ingress = []
    for instance, name in enumerate(names, start=1):
        directory = out / 'runtime' / name
        deploy.mkdir_new(directory)
        own = {**config, 'link': {'url': f'http://{p.core_ip(2)}:3001/', 'ingressId': name, 'keyFile': '/run/secrets/link.key'}} if ingress_link else config
        deploy.write_new(directory / 'runtime.json', deploy.canonical(own))
        ip, port = p.local_ingress_ip(instance, nodes), p.local_ingress_host_port(instance, nodes)
        value = deploy.service('ingress', project + '-' + name, directory, image=policy['image_id'], build=policy['build'],
                               kind=policy['source_kind'], manifest=policy['manifest_sha256'], profile=profile, ip=ip,
                               ports=[f'127.0.0.1:{port}:3000'],
                               secrets_mounts=[str(out / 'link-keys' / (name + '.key')) + ':/run/secrets/link.key:ro'] if ingress_link else ())
        value['restart'] = 'unless-stopped'
        services[name] = value
        ingress.append({'service': name, 'container_ip': ip, 'host_port': port})
    compose_bytes = deploy.canonical({'name': project, 'services': services, 'networks': core['networks'],
                                      **({'volumes': store_volumes} if store_volumes else {})})
    deploy.write_new(out / 'compose.json', compose_bytes, mode=0o600, gid=0)
    # This summary contains no secret bytes and is safe to inspect. It is not an activation receipt.
    summary = {'version': 1, 'profile': p.name, 'prepared': True, 'activated': False, 'project': project,
               'coreBundle': str(core_bundle), 'coreComposeSha256': policy['compose_sha256'],
               'composeSha256': hashlib.sha256(compose_bytes).hexdigest(), 'imageId': policy['image_id'],
               'build': policy['build'], 'sourceKind': policy['source_kind'], 'manifestSha256': policy['manifest_sha256'],
               'gameNodes': nodes, 'ingress': ingress, 'coordinatorPort': p.coordinator_port, 'hostManagerLeases': False,
               **({'onlineLimitDir': str(online_limit_dir)} if online_limit_dir is not None else {}),
               **({'checkpointStore': {'service': 'valkey', 'image': VALKEY_IMAGE, 'container_ip': p.core_ip(VALKEY_SUFFIX),
                                       'maxmemoryMb': valkey_maxmemory_mb, 'prefix': p.name + ':'}} if valkey else {}),
               **({'serverEnv': dict(sorted(server_env.items()))} if server_env else {})}
    deploy.write_new(out / 'stack-summary.json', deploy.canonical(summary), mode=0o600, gid=0)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='beta', choices=tuple(profiles.PROFILES))
    parser.add_argument('--core-bundle', required=True)
    parser.add_argument('--out', required=True)
    # 1..8 behind sixteen nodes (Beta 1..2); Formal 32-node stacks accept 1..16.
    parser.add_argument('--ingress-instances', type=int, default=1, choices=range(1, 17))
    # Opt-in multiplexed ingress links: new per-ingress keys exist only in this stack (LOCAL-STACK.md).
    parser.add_argument('--ingress-link', action='store_true')
    # optional: mount this host directory for the coordinator's online cap (online-limit.json inside, may be absent)
    parser.add_argument('--online-limit-dir')
    # opt-in match checkpoints: a Valkey store on the bridge for the coordinator and the games (docs/DEPLOY.md「断点续玩」)
    parser.add_argument('--valkey', action='store_true')
    parser.add_argument('--valkey-maxmemory-mb', type=int, default=VALKEY_MAXMEMORY_MB)
    # server switches for the coordinator and every game, e.g. --server-env SP_PLUGINS=off (SERVER_ENV)
    parser.add_argument('--server-env', action='append', default=[], metavar='KEY=VALUE')
    args = parser.parse_args()
    try:
        require(all('=' in item for item in args.server_env), 'invalid server switch')
        server_env = dict(item.split('=', 1) for item in args.server_env)
        require(len(server_env) == len(args.server_env), 'server switch given twice')
        require(os.geteuid() == 0, 'host root required for protected stack generation')
        summary = compose(args.core_bundle, args.out, profile=args.profile, ingress_instances=args.ingress_instances,
                          ingress_link=args.ingress_link, online_limit_dir=args.online_limit_dir,
                          valkey=args.valkey, valkey_maxmemory_mb=args.valkey_maxmemory_mb, server_env=server_env)
        print(json.dumps({'event': 'cluster-local-stack-prepared', 'project': summary['project'],
                          'ingress': len(summary['ingress']), 'activated': False}))
        return 0
    except (Refused, OSError, ValueError, KeyError):
        print('{"event":"refused","reason":"protected local stack preparation refused"}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
