#!/usr/bin/env python3
"""Compose a NEW WG-less co-located stack from a verified core bundle; no SSH, Docker or activation.

The coordinator, the sixteen games and N local ingress share the core bridge on one host. Core keys and
runtime files are reused untouched; ingress dial the bridge directly and nothing is published on the WG
address. The root host manager does not cover this stack (no leases, priority or CAS), see LOCAL-STACK.md.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

_DEPLOY_SPEC = importlib.util.spec_from_file_location('cluster_local_deploy', Path(__file__).resolve().with_name('cluster-deploy.py'))
deploy = importlib.util.module_from_spec(_DEPLOY_SPEC)
sys.modules[_DEPLOY_SPEC.name] = deploy
_DEPLOY_SPEC.loader.exec_module(deploy)
profiles, Refused, require = deploy.profiles, deploy.Refused, deploy.require
# Local ingress sit after the sixteen games on the core bridge: .31 .. .38.
LOCAL_INGRESS_OFFSET = 30


def local_project(profile='beta'):
    return 'ark-cluster-' + profiles.get_profile(profile).name + '-local'


def protected(path, profile, *, missing=False):
    path = Path(os.path.abspath(path))
    require(all(path != repo and repo not in path.parents for repo in deploy.FORBIDDEN_REPOS), 'protected path must be outside repository')
    require(profiles.path_allowed(path, profile), 'cross-profile protected path refused')
    return deploy.no_symlink(path, missing=missing)


def compose(core_bundle, out, *, profile='beta', ingress_instances=1):
    p = profiles.get_profile(profile)
    require(type(ingress_instances) is int and 1 <= ingress_instances <= p.max_ingress_instances, 'invalid fixed ingress instance count')
    core_bundle, out = protected(core_bundle, profile), protected(out, profile, missing=True)
    require(not out.exists(), 'output already exists; never overwrite a release')
    parent = out.parent.stat()
    require(parent.st_uid == os.geteuid() and not parent.st_mode & 0o022, 'output parent must be protected and owned')
    policy = json.loads((core_bundle / 'host-policy.json').read_text())
    raw = (core_bundle / 'compose.json').read_bytes()
    require(policy.get('host_role') == 'core' and policy.get('namespace') == p.name and policy.get('bundle') == str(core_bundle)
            and hashlib.sha256(raw).hexdigest() == policy.get('compose_sha256'), 'unverified core bundle refused')
    core = json.loads(raw)
    expected = {'coordinator': p.core_ip(2), **{'game-%02d' % i: p.core_ip(10 + i) for i in range(1, 17)}}
    require(set(core['services']) == set(expected)
            and all(core['services'][name]['networks']['default']['ipv4_address'] == ip for name, ip in expected.items()),
            'core bundle inventory changed')
    project, services = local_project(profile), {}
    for name, value in core['services'].items():
        value = json.loads(json.dumps(value))
        value['container_name'] = project + '-' + name
        # The WG address does not exist on a co-located host; only the loopback publications remain.
        value['ports'] = [port for port in value['ports'] if not port.startswith(p.wg_core + ':')]
        require(value['ports'] and all(port.startswith('127.0.0.1:') for port in value['ports']), 'non-loopback publication refused')
        # No root manager restarts these roles, so Docker restores them after a crash or host boot.
        value['restart'] = 'unless-stopped'
        services[name] = value
    deploy.mkdir_new(out)
    deploy.mkdir_new(out / 'runtime')
    config = {'role': 'ingress', 'host': '0.0.0.0', 'port': 3000, 'coordinatorUrl': f'http://{p.core_ip(2)}:3000',
              'nodes': [{'nodeId': 'game-%02d' % i, 'url': f'http://{p.core_ip(10 + i)}:3000'} for i in range(1, 17)],
              'origins': [p.origin], 'wsCompression': 'on', 'trustProxy': 'auto'}
    ingress = []
    for instance in range(1, ingress_instances + 1):
        name = deploy.ingress_service(instance, profile)
        directory = out / 'runtime' / name
        deploy.mkdir_new(directory)
        deploy.write_new(directory / 'runtime.json', deploy.canonical(config))
        ip, port = p.core_ip(LOCAL_INGRESS_OFFSET + instance), p.ingress_host_port(instance)
        value = deploy.service('ingress', project + '-' + name, directory, image=policy['image_id'], build=policy['build'],
                               kind=policy['source_kind'], manifest=policy['manifest_sha256'], profile=profile, ip=ip,
                               ports=[f'127.0.0.1:{port}:3000'])
        value['restart'] = 'unless-stopped'
        services[name] = value
        ingress.append({'service': name, 'container_ip': ip, 'host_port': port})
    compose_bytes = deploy.canonical({'name': project, 'services': services, 'networks': core['networks']})
    deploy.write_new(out / 'compose.json', compose_bytes, mode=0o600, gid=0)
    # This summary contains no secret bytes and is safe to inspect. It is not an activation receipt.
    summary = {'version': 1, 'profile': p.name, 'prepared': True, 'activated': False, 'project': project,
               'coreBundle': str(core_bundle), 'coreComposeSha256': policy['compose_sha256'],
               'composeSha256': hashlib.sha256(compose_bytes).hexdigest(), 'imageId': policy['image_id'],
               'build': policy['build'], 'sourceKind': policy['source_kind'], 'manifestSha256': policy['manifest_sha256'],
               'gameNodes': 16, 'ingress': ingress, 'coordinatorPort': p.coordinator_port, 'hostManagerLeases': False}
    deploy.write_new(out / 'stack-summary.json', deploy.canonical(summary), mode=0o600, gid=0)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='beta', choices=tuple(profiles.PROFILES))
    parser.add_argument('--core-bundle', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--ingress-instances', type=int, default=1, choices=range(1, 9))
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, 'host root required for protected stack generation')
        summary = compose(args.core_bundle, args.out, profile=args.profile, ingress_instances=args.ingress_instances)
        print(json.dumps({'event': 'cluster-local-stack-prepared', 'project': summary['project'],
                          'ingress': len(summary['ingress']), 'activated': False}))
        return 0
    except (Refused, OSError, ValueError, KeyError):
        print('{"event":"refused","reason":"protected local stack preparation refused"}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
