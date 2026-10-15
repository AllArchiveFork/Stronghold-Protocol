"""WG-less co-located stack generation from a core bundle; no SSH, Docker or production mutations."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('tested_cluster_local_stack', BASE / 'cluster-local-stack.py')
local = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = local
spec.loader.exec_module(local)
deploy = local.deploy
BUILD, MANIFEST, IMAGE = 'a' * 40, 'a' * 64, 'sha256:' + 'b' * 64


class LocalStackTests(unittest.TestCase):
    profile = 'formal'

    def setUp(self):
        # /tmp itself is world-writable and deliberately not an approved protected-file parent.
        self.root = Path(tempfile.mkdtemp(prefix='ark-cluster-local-tests-',
                                          dir=os.environ.get('CLUSTER_TEST_TMPDIR', '/root' if os.geteuid() == 0 else None)))
        os.chmod(self.root, 0o700)
        self.addCleanup(shutil.rmtree, self.root)
        self.core = self.root / 'core'
        deploy.generate(self.core, image=IMAGE, build=BUILD, manifest_sha256=MANIFEST, source_kind='tree',
                        role='core', profile=self.profile)

    def stack(self, name='local', instances=8):
        summary = local.compose(self.core, self.root / name, profile=self.profile, ingress_instances=instances)
        return summary, json.loads((self.root / name / 'compose.json').read_text())

    def test_ingress_dial_core_bridge_and_all_sixteen_nodes(self):
        summary, compose = self.stack()
        p = local.profiles.get_profile(self.profile)
        self.assertEqual(summary['project'], 'ark-cluster-formal-local')
        self.assertEqual([row['container_ip'] for row in summary['ingress']], ['172.30.245.%d' % i for i in range(31, 39)])
        config = json.loads((self.root / 'local/runtime/ingress-08/runtime.json').read_text())
        self.assertEqual(config['coordinatorUrl'], 'http://172.30.245.2:3000')
        self.assertEqual([row['url'] for row in config['nodes']], ['http://172.30.245.%d:3000' % (10 + i) for i in range(1, 17)])
        self.assertEqual(config['origins'], [p.origin])
        self.assertEqual(len(compose['services']), 25)

    def test_valkey_store_is_opt_in_unpublished_and_named_by_every_core_role(self):
        _, plain = self.stack('plain', 2)
        self.assertNotIn('valkey', plain['services'])
        self.assertNotIn('volumes', plain)
        summary = local.compose(self.core, self.root / 'store', profile=self.profile, ingress_instances=2, valkey=True)
        compose = json.loads((self.root / 'store/compose.json').read_text())
        store = compose['services']['valkey']
        self.assertEqual(store['image'], local.VALKEY_IMAGE)
        self.assertIn('@sha256:', store['image'])
        self.assertEqual(store['ports'], [])
        self.assertEqual(store['networks']['default']['ipv4_address'], '172.30.245.5')
        self.assertEqual(store['user'], '999:1000')
        self.assertTrue(store['read_only'])
        self.assertEqual(store['cap_drop'], ['ALL'])
        self.assertEqual(compose['volumes'], {'valkey-data': {}})
        self.assertIn('valkey-data:/data', store['volumes'])
        config = (self.root / 'store/valkey/valkey.conf').read_text()
        password = (self.root / 'store/valkey.pass').read_text()
        self.assertRegex(password, r'^[0-9a-f]{64}$')
        self.assertIn('requirepass ' + password, config)
        self.assertIn('appendonly yes', config)
        self.assertIn('maxmemory 2048mb', config)
        self.assertNotIn(password, (self.root / 'store/compose.json').read_text())
        self.assertNotIn(password, json.dumps(summary))
        for name in ('valkey/valkey.conf', 'valkey.pass'):
            self.assertEqual(stat.S_IMODE((self.root / 'store' / name).stat().st_mode), 0o440)
        for name, service in compose['services'].items():
            env = service.get('environment', {})
            if name == 'coordinator' or name.startswith('game-'):
                self.assertEqual(env['SP_REDIS_URL'], 'redis://172.30.245.5:6379/0')
                self.assertEqual(env['SP_REDIS_PASSWORD_FILE'], '/run/secrets/valkey.pass')
                self.assertEqual(env['SP_REDIS_PREFIX'], 'formal:')
                self.assertIn(str(self.root / 'store/valkey.pass') + ':/run/secrets/valkey.pass:ro', service['volumes'])
                self.assertEqual(service['depends_on'], ['valkey'])
            elif name != 'valkey':
                self.assertNotIn('SP_REDIS_URL', env)
                self.assertFalse(any('valkey' in v for v in service['volumes']))
        self.assertEqual(summary['checkpointStore']['container_ip'], '172.30.245.5')
        self.assertEqual(len(compose['services']), 1 + 16 + 2 + 1)
        with self.assertRaises(local.Refused):
            local.compose(self.core, self.root / 'tiny', profile=self.profile, valkey=True, valkey_maxmemory_mb=1)

    def test_online_limit_directory_is_mounted_read_only_into_the_coordinator_only(self):
        limits = self.root / 'limits'
        limits.mkdir(mode=0o755)
        summary = local.compose(self.core, self.root / 'limited', profile=self.profile, ingress_instances=2, online_limit_dir=limits)
        compose = json.loads((self.root / 'limited/compose.json').read_text())
        coordinator = compose['services']['coordinator']
        self.assertIn(str(limits) + ':/run/limits:ro', coordinator['volumes'])
        self.assertEqual(coordinator['environment']['SP_ONLINE_LIMIT_FILE'], '/run/limits/online-limit.json')
        self.assertEqual(coordinator['environment']['SP_OWNER_FILE'], '/run/limits/owner.json')
        for name, service in compose['services'].items():
            if name != 'coordinator':
                self.assertNotIn('SP_ONLINE_LIMIT_FILE', service['environment'])
                self.assertNotIn('SP_OWNER_FILE', service['environment'])
                self.assertFalse(any(v.startswith(str(limits)) for v in service['volumes']))
        self.assertEqual(summary['onlineLimitDir'], str(limits))
        plain, plain_compose = self.stack('plain', instances=2)
        self.assertNotIn('onlineLimitDir', plain)
        self.assertNotIn('SP_ONLINE_LIMIT_FILE', plain_compose['services']['coordinator']['environment'])
        self.assertNotIn('SP_OWNER_FILE', plain_compose['services']['coordinator']['environment'])
        loose = self.root / 'loose'
        loose.mkdir()
        os.chmod(loose, 0o777)
        with self.assertRaises(local.Refused):
            local.compose(self.core, self.root / 'loose-stack', profile=self.profile, ingress_instances=2, online_limit_dir=loose)

    def test_nothing_is_published_on_the_wg_address(self):
        _, compose = self.stack()
        ports = [port for service in compose['services'].values() for port in service['ports']]
        self.assertTrue(all(port.startswith('127.0.0.1:') for port in ports))
        self.assertEqual(sorted(int(port.split(':')[1]) for port in ports), [35400, *range(35401, 35409), 35410, *range(35411, 35427)])

    def test_single_bridge_with_unique_fixed_addresses(self):
        _, compose = self.stack()
        core = json.loads((self.core / 'compose.json').read_text())
        self.assertEqual(compose['networks'], core['networks'])
        addresses = [service['networks']['default']['ipv4_address'] for service in compose['services'].values()]
        self.assertEqual(len(addresses), len(set(addresses)))
        self.assertTrue(all(address.startswith('172.30.245.') for address in addresses))

    def test_core_keys_and_runtime_are_reused_untouched_and_ingress_hold_no_keys(self):
        # Fixture keys are compared byte-for-byte, never hashed or printed.
        before = {path: path.read_bytes() for path in self.core.rglob('*') if path.is_file()}
        _, compose = self.stack()
        self.assertTrue(before == {path: path.read_bytes() for path in self.core.rglob('*') if path.is_file()})
        self.assertIn(str(self.core / 'keys') + ':/run/secrets:ro', compose['services']['coordinator']['volumes'])
        for name, service in compose['services'].items():
            if name.startswith('ingress'):
                self.assertEqual(len(service['volumes']), 1)
                self.assertNotIn('secrets', service['volumes'][0])
                self.assertEqual(service['labels']['cn.stardust.cluster.role'], 'ingress')
                self.assertEqual(service['environment']['SP_COMBAT_WORKERS'], '0')
            self.assertEqual(service['restart'], 'unless-stopped')
            self.assertTrue(service['container_name'].startswith('ark-cluster-formal-local-'))

    def test_existing_output_and_tampered_or_edge_bundles_are_refused(self):
        self.stack()
        with self.assertRaises(local.Refused):
            self.stack()
        edge = self.root / 'edge'
        deploy.generate(edge, image=IMAGE, build=BUILD, manifest_sha256=MANIFEST, source_kind='tree',
                        role='edge', entry=2, profile=self.profile, ingress_instances=8)
        with self.assertRaises(local.Refused):
            local.compose(edge, self.root / 'from-edge', profile=self.profile, ingress_instances=8)
        compose_file = self.core / 'compose.json'
        os.chmod(compose_file, 0o600)
        compose_file.write_bytes(compose_file.read_bytes().replace(b'"no"', b'"always"', 1))
        with self.assertRaises(local.Refused):
            local.compose(self.core, self.root / 'tampered', profile=self.profile, ingress_instances=8)

    def test_unit_template_survives_docker_restart_and_excludes_edge(self):
        unit = (BASE.parent / 'cluster' / 'ark-cluster-formal-local.service').read_text().splitlines()
        self.assertIn('Wants=docker.service', unit)
        self.assertFalse(any(line.startswith(('Requires=', 'BindsTo=', 'PartOf=')) for line in unit))
        self.assertIn('After=docker.service network-online.target', unit)
        self.assertIn('Conflicts=ark-cluster-formal-edge.service', unit)

    def test_instance_count_follows_the_fixed_profile(self):
        with self.assertRaises(local.Refused):
            local.compose(self.core, self.root / 'nine', profile=self.profile, ingress_instances=9)
        summary, compose = self.stack('one', 1)
        self.assertEqual([row['service'] for row in summary['ingress']], ['ingress'])
        self.assertEqual(len(compose['services']), 18)


class LocalStackLinkTests(unittest.TestCase):
    """Opt-in ingress links; LocalStackTests above keeps covering the default byte-for-byte output."""
    profile = 'formal'
    setUp = LocalStackTests.setUp
    stack = LocalStackTests.stack

    def option_stack(self, name, **options):
        summary = local.compose(self.core, self.root / name, profile=self.profile, ingress_instances=3, **options)
        return summary, json.loads((self.root / name / 'compose.json').read_text())

    def test_default_output_has_no_link_material(self):
        _, compose = self.stack('plain', 3)
        coordinator = compose['services']['coordinator']
        self.assertEqual(coordinator['volumes'], [str(self.core / 'runtime/coordinator') + ':/run/config:ro', str(self.core / 'keys') + ':/run/secrets:ro'])
        self.assertFalse((self.root / 'plain/link-keys').exists())
        self.assertNotIn('link', json.loads((self.root / 'plain/runtime/ingress/runtime.json').read_text()))

    def test_ingress_link_gives_each_ingress_only_its_own_new_key_and_the_coordinator_a_derived_runtime(self):
        before = {path: path.read_bytes() for path in self.core.rglob('*') if path.is_file()}
        summary, compose = self.option_stack('linked', ingress_link=True)
        self.assertTrue(before == {path: path.read_bytes() for path in self.core.rglob('*') if path.is_file()}, 'core bundle untouched')
        out, names = self.root / 'linked', [row['service'] for row in summary['ingress']]
        self.assertEqual(sorted(path.name for path in (out / 'link-keys').iterdir()), sorted(name + '.key' for name in names))
        for name in names:
            key = out / 'link-keys' / (name + '.key')
            self.assertEqual(len(key.read_bytes()), 32)
            self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o440)
            self.assertEqual(compose['services'][name]['volumes'][1:], [str(key) + ':/run/secrets/link.key:ro'])
            config = json.loads((out / 'runtime' / name / 'runtime.json').read_text())
            self.assertEqual(config['link'], {'url': 'http://172.30.245.2:3001/', 'ingressId': name, 'keyFile': '/run/secrets/link.key'})
            self.assertEqual(config['coordinatorUrl'], 'http://172.30.245.2:3000')
        core_runtime = json.loads((self.core / 'runtime/coordinator/runtime.json').read_text())
        derived = json.loads((out / 'runtime/coordinator/runtime.json').read_text())
        self.assertEqual(derived, {**core_runtime, 'ingresses': [{'ingressId': name, 'keyFile': '/run/link-secrets/' + name + '.key'} for name in names]})
        self.assertEqual(compose['services']['coordinator']['volumes'], [str(out / 'runtime/coordinator') + ':/run/config:ro',
                         str(self.core / 'keys') + ':/run/secrets:ro', str(out / 'link-keys') + ':/run/link-secrets:ro'])
        self.assertEqual(len(set(key.read_bytes() for key in (out / 'link-keys').iterdir())), 3)


class ThirtyTwoNodeLocalStackTests(unittest.TestCase):
    """The node count comes only from the verified core policy; legacy sixteen-node output is covered above."""
    profile = 'formal'

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='ark-cluster-local32-tests-',
                                          dir=os.environ.get('CLUSTER_TEST_TMPDIR', '/root' if os.geteuid() == 0 else None)))
        os.chmod(self.root, 0o700)
        self.addCleanup(shutil.rmtree, self.root)
        self.core = self.root / 'core'
        deploy.generate(self.core, image=IMAGE, build=BUILD, manifest_sha256=MANIFEST, source_kind='tree',
                        role='core', profile=self.profile, game_nodes=32)

    def stack(self, name='local', instances=16):
        summary = local.compose(self.core, self.root / name, profile=self.profile, ingress_instances=instances)
        return summary, json.loads((self.root / name / 'compose.json').read_text())

    def test_sixteen_ingress_follow_thirty_two_games_on_their_own_address_and_port_range(self):
        summary, compose = self.stack()
        self.assertEqual(len(compose['services']), 49)
        self.assertEqual(summary['gameNodes'], 32)
        self.assertEqual([row['service'] for row in summary['ingress']],
                         ['ingress', *('ingress-%02d' % i for i in range(2, 17))])
        self.assertEqual([row['container_ip'] for row in summary['ingress']], ['172.30.245.%d' % i for i in range(51, 67)])
        self.assertEqual([row['host_port'] for row in summary['ingress']], list(range(35451, 35467)))
        for row in summary['ingress']:
            service = compose['services'][row['service']]
            self.assertEqual(service['networks']['default']['ipv4_address'], row['container_ip'])
            self.assertEqual(service['ports'], ['127.0.0.1:%d:3000' % row['host_port']])
            self.assertEqual(int(row['container_ip'].rsplit('.', 1)[1]) + 35400, row['host_port'])
            config = json.loads((self.root / 'local/runtime' / row['service'] / 'runtime.json').read_text())
            self.assertEqual(config['coordinatorUrl'], 'http://172.30.245.2:3000')
            self.assertEqual([node['nodeId'] for node in config['nodes']], ['game-%02d' % i for i in range(1, 33)])
            self.assertEqual([node['url'] for node in config['nodes']], ['http://172.30.245.%d:3000' % i for i in range(11, 43)])
        ports = [port for service in compose['services'].values() for port in service['ports']]
        self.assertTrue(all(port.startswith('127.0.0.1:') for port in ports))
        self.assertEqual(sorted(int(port.split(':')[1]) for port in ports), [35400, 35410, *range(35411, 35443), *range(35451, 35467)])
        addresses = [service['networks']['default']['ipv4_address'] for service in compose['services'].values()]
        self.assertEqual(len(addresses), len(set(addresses)))
        self.assertTrue(all(service['restart'] == 'unless-stopped' for service in compose['services'].values()))

    def test_eight_ingress_keep_the_expanded_layout(self):
        summary, compose = self.stack('eight', 8)
        self.assertEqual(len(compose['services']), 41)
        self.assertEqual([row['container_ip'] for row in summary['ingress']], ['172.30.245.%d' % i for i in range(51, 59)])
        ports = sorted(int(port.split(':')[1]) for service in compose['services'].values() for port in service['ports'])
        self.assertEqual(ports, [35400, 35410, *range(35411, 35443), *range(35451, 35459)])
        game = compose['services']['game-32']
        self.assertEqual(game['networks']['default']['ipv4_address'], '172.30.245.42')
        self.assertEqual(game['ports'], ['127.0.0.1:35442:3000'])
        self.assertEqual(game['environment']['SP_COMBAT_WORKERS'], '8')

    def test_core_keys_and_runtime_are_reused_untouched(self):
        # Fixture keys are compared byte-for-byte, never hashed or printed.
        before = {path: path.read_bytes() for path in self.core.rglob('*') if path.is_file()}
        _, compose = self.stack()
        self.assertTrue(before == {path: path.read_bytes() for path in self.core.rglob('*') if path.is_file()})
        self.assertIn(str(self.core / 'keys') + ':/run/secrets:ro', compose['services']['coordinator']['volumes'])
        self.assertEqual(compose['services']['game-32']['volumes'][1], str(self.core / 'keys/game-32.key') + ':/run/secrets/game.key:ro')
        self.assertEqual(len(list((self.core / 'keys').iterdir())), 32)
        for name, service in compose['services'].items():
            if name.startswith('ingress'):
                self.assertEqual(len(service['volumes']), 1)

    def test_instance_bounds_follow_the_inventory(self):
        for count in (0, 17, True, '16', 16.0):
            with self.subTest(count=count), self.assertRaises(local.Refused):
                local.compose(self.core, self.root / 'bad', profile=self.profile, ingress_instances=count)
            self.assertFalse((self.root / 'bad').exists())
        sixteen = self.root / 'core16'
        deploy.generate(sixteen, image=IMAGE, build=BUILD, manifest_sha256=MANIFEST, source_kind='tree', role='core', profile=self.profile)
        for count in (9, 16):
            with self.subTest(count=count), self.assertRaises(local.Refused):
                local.compose(sixteen, self.root / 'bad16', profile=self.profile, ingress_instances=count)
            self.assertFalse((self.root / 'bad16').exists())

    def test_tampered_core_policy_count_is_refused(self):
        file = self.core / 'host-policy.json'
        original = json.loads(file.read_text())
        os.chmod(file, 0o600)
        for change in ({'game_nodes': 16}, {'game_nodes': 33}, {'game_nodes': True}, {'game_nodes': None}):
            file.write_bytes(deploy.canonical({**original, **change}))
            with self.subTest(change=change), self.assertRaises(local.Refused):
                local.compose(self.core, self.root / 'tampered', profile=self.profile, ingress_instances=8)
            self.assertFalse((self.root / 'tampered').exists())
        file.write_bytes(deploy.canonical({key: value for key, value in original.items() if key != 'game_nodes'}))
        with self.assertRaises(local.Refused):
            local.compose(self.core, self.root / 'tampered', profile=self.profile, ingress_instances=8)
        self.assertFalse((self.root / 'tampered').exists())



class WorkerPoolLocalStackTests(unittest.TestCase):
    """Per-game pools come only from the verified core bundle (cluster-deploy --combat-workers/--trial-workers)."""
    profile = 'formal'

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='ark-cluster-local-pools-tests-',
                                          dir=os.environ.get('CLUSTER_TEST_TMPDIR', '/root' if os.geteuid() == 0 else None)))
        os.chmod(self.root, 0o700)
        self.addCleanup(shutil.rmtree, self.root)

    def core(self, name, combat, trial):
        deploy.generate(self.root / name, image=IMAGE, build=BUILD, manifest_sha256=MANIFEST, source_kind='tree',
                        role='core', profile=self.profile, game_nodes=32, combat_workers=combat, trial_workers=trial)
        return self.root / name

    def test_thirty_two_games_keep_the_bundle_pools_and_the_summary_schema(self):
        default = local.compose(self.core('core-default', 8, 2), self.root / 'local-default', profile=self.profile, ingress_instances=8)
        for combat, trial in ((3, 1), (2, 1)):
            with self.subTest(combat=combat, trial=trial):
                core = self.core('core-%d-%d' % (combat, trial), combat, trial)
                summary = local.compose(core, self.root / ('local-%d-%d' % (combat, trial)), profile=self.profile, ingress_instances=8)
                compose = json.loads((self.root / ('local-%d-%d' % (combat, trial)) / 'compose.json').read_text())
                self.assertEqual(len(compose['services']), 41)
                for name, service in compose['services'].items():
                    expected = (str(combat), str(trial)) if name.startswith('game-') else ('0', '0')
                    self.assertEqual((service['environment']['SP_COMBAT_WORKERS'], service['environment']['SP_TRIAL_WORKERS']), expected)
                for index in range(1, 33):
                    runtime = json.loads((core / 'runtime' / ('game-%02d' % index) / 'runtime.json').read_text())
                    self.assertEqual((runtime['combatWorkers'], runtime['trialWorkers']), (combat, trial))
                # The Nginx preparation consumes this exact summary schema; pools do not appear in it.
                self.assertEqual(set(summary), set(default))
                self.assertEqual({k: v for k, v in summary.items() if not k.endswith(('Sha256', 'coreBundle'))},
                                 {k: v for k, v in default.items() if not k.endswith(('Sha256', 'coreBundle'))})

    def test_bundle_whose_pools_disagree_with_its_targets_is_refused(self):
        core = self.core('core', 3, 1)
        policy_file, compose_file = core / 'host-policy.json', core / 'compose.json'
        policy, compose = json.loads(policy_file.read_text()), json.loads(compose_file.read_text())
        os.chmod(policy_file, 0o600)

        def publish(new_policy, new_compose):
            raw = deploy.canonical(new_compose)
            compose_file.write_bytes(raw)
            policy_file.write_bytes(deploy.canonical({**new_policy, 'compose_sha256': hashlib.sha256(raw).hexdigest()}))

        variants = []
        changed = json.loads(json.dumps(compose)); changed['services']['game-05']['environment']['SP_COMBAT_WORKERS'] = '8'
        variants.append((policy, changed))
        changed = json.loads(json.dumps(compose)); changed['services']['coordinator']['environment']['SP_TRIAL_WORKERS'] = '1'
        variants.append((policy, changed))
        changed = json.loads(json.dumps(policy)); changed['targets'][4]['trial_workers'] = 2
        variants.append((changed, compose))
        changed = json.loads(json.dumps(policy))
        for row in changed['targets'][:32]:
            row['combat_workers'], row['trial_workers'] = 8, 2
        variants.append((changed, compose))
        for index, (new_policy, new_compose) in enumerate(variants):
            publish(new_policy, new_compose)
            with self.subTest(variant=index), self.assertRaises(local.Refused):
                local.compose(core, self.root / 'tampered', profile=self.profile, ingress_instances=8)
            self.assertFalse((self.root / 'tampered').exists())
        publish(policy, compose)
        runtime_file = core / 'runtime' / 'game-07' / 'runtime.json'
        runtime = json.loads(runtime_file.read_text())
        os.chmod(runtime_file, 0o640)
        for change in ({'combatWorkers': 8}, {'trialWorkers': 2}, {'trialWorkers': True}):
            runtime_file.write_bytes(deploy.canonical({**runtime, **change}))
            with self.subTest(runtime=change), self.assertRaises(local.Refused):
                local.compose(core, self.root / 'tampered', profile=self.profile, ingress_instances=8)
            self.assertFalse((self.root / 'tampered').exists())
        runtime_file.write_bytes(deploy.canonical(runtime))
        self.assertEqual(len(local.compose(core, self.root / 'restored', profile=self.profile, ingress_instances=8)['ingress']), 8)


if __name__ == '__main__':
    unittest.main()
