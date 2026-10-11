"""WG-less co-located stack generation from a core bundle; no SSH, Docker or production mutations."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
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


if __name__ == '__main__':
    unittest.main()
