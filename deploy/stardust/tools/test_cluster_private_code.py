"""Pinned TREE private-code tests; no Git writes, SSH, actual secrets or activation."""
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cluster_private_code_tested', BASE / 'cluster-private-code.py')
code = importlib.util.module_from_spec(spec)
spec.loader.exec_module(code)


class PrivateCodeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='ark-cluster-private-code-'))
        self.addCleanup(shutil.rmtree, self.root)
        self.source, self.output = self.root / 'app', self.root / 'stage'
        self.rows = []
        for path, body in [('public/js/main.js', b'export const fixture = "private";\n'),
                           ('public/js/ui/panel.js', b'export const panel = 1;\n'),
                           ('public/css/theme.css', b'body { color: #123456; }\n'),
                           ('public/css/screens/game.css', b'.game { display: grid; }\n')]:
            file = self.source / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(body)
            file.chmod(0o644)
            self.rows.append({'path': path, 'bytes': len(body), 'sha256': code.sha(body), 'mode': '0o644'})
        # Out-of-scope app files are neither executed, published nor silently copied.
        for path in ('data/private.json', 'server/index.js', 'public/index.html', 'public/assets/test.png', 'public/vendor/test.js'):
            file = self.source / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'explicit excluded fixture')
        self.manifest = self.root / 'source-manifest.json'
        self.value = {'version': 1, 'kind': 'tree', 'baseRevision': 'a' * 40,
                      'files': sorted(self.rows, key=lambda row: row['path'])}
        self.refresh()

    def refresh(self):
        raw = code.canonical(self.value)
        self.manifest.write_bytes(raw)
        self.digest, self.build = code.sha(raw), code.sha(raw)[:40]

    def prepare(self):
        return code.prepare(self.source, self.manifest, self.digest, self.build, self.output)

    def verify(self):
        return code.verify(self.output, self.manifest, self.digest, self.build)

    def test_reproducible_tree_snapshot_inventory_bytes_mode_and_provenance(self):
        value = self.prepare()
        self.assertEqual(value, self.verify())
        self.assertEqual((value['namespace'], value['sourceKind'], value['build']), ('beta', 'tree', self.build))
        self.assertFalse(value['activated'])
        self.assertEqual(len(value['files']), 4)
        self.assertEqual(value['preparer']['sha256'], code.sha((BASE / 'cluster-private-code.py').read_bytes()))
        for row in value['files']:
            file = self.output / ('localcode/cluster-' + self.build) / row['path']
            self.assertEqual(file.read_bytes(), (self.source / row['sourcePath']).read_bytes())
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o644)
            self.assertEqual(file.stat().st_nlink, 1)
        other = self.root / 'stage2'
        self.assertEqual(code.prepare(self.source, self.manifest, self.digest, self.build, other), value)
        self.assertEqual((other / 'SHA256SUMS').read_bytes(), (self.output / 'SHA256SUMS').read_bytes())
        self.assertFalse((self.output / 'data').exists())
        self.assertFalse((self.output / 'public').exists())

    def test_exact_aliases_gate_after_access_fallback_and_every_stock_security_header(self):
        value = self.prepare()
        include = (self.output / value['nginx'][0]['path']).read_text()
        self.assertEqual(include.count('location = /'), 4)
        self.assertEqual(include.count('auth_request /_gate/check;'), 7)
        stock = (BASE.parent / 'nginx' / 'ark-proto-beta.conf').read_text().split('proxy_hide_header')[0]
        # Like business ACAO, the server-level Allow header only describes the anonymous health
        # route's methods; location-level add_header blocks inheritance and private code never emits it.
        headers = [line.strip() for line in stock.splitlines() if line.strip().startswith('add_header ')
                   and not line.strip().startswith(('add_header Access-Control-Allow-Origin', 'add_header Allow '))]
        # Private code revalidates (ETag/304, still gated) instead of the vhost's no-store.
        self.assertIn('add_header Cache-Control "private, no-store" always;', headers)
        headers = [h.replace('"private, no-store"', '"private, no-cache"') for h in headers]
        for directive in headers:
            with self.subTest(header=directive):
                self.assertEqual(include.count(directive), 7)
        self.assertNotIn('add_header Access-Control-Allow-Origin', include)
        self.assertNotIn('auth_request off', include)
        self.assertNotIn('try_files', include)
        self.assertNotIn('rewrite', include)
        self.assertNotIn('http://10.253.77.', include)
        self.assertNotIn('/opt/ark-proto/', include)
        self.assertNotIn('ark-proto.stardust.matce.cn', include)
        self.assertEqual(include.count('error_page 404 = @ark_beta_cluster_code;'), 4)
        self.assertEqual(include.count('proxy_pass http://10.253.78.2:35300;'), 3)
        self.assertIn('location @ark_beta_cluster_code {', include)
        self.assertIn('location ^~ /js/ {', include)
        self.assertIn('location ^~ /css/ {', include)
        self.assertIn('default_type application/javascript;', include)
        self.assertIn('default_type text/css;', include)
        self.assertIn('disable_symlinks on;', include)
        self.assertIn('an empty $ark_beta_csp emits no CSP header', include)
        self.assertNotIn('gitBlob', json.dumps(value))
        self.assertNotIn('fullref', json.dumps(value))

    def test_local_topology_dials_the_core_bridge_coordinator_and_default_stays_wg(self):
        default = self.prepare()
        self.assertNotIn('topology', default)
        include = (self.output / default['nginx'][0]['path']).read_text()
        self.assertEqual(include.count('proxy_pass http://10.253.78.2:35300;'), 3)
        self.assertNotIn('Topology=', include)
        selected = code.source_manifest(self.manifest, self.digest, self.build)[1]
        self.assertEqual(include.encode(), code.render_include(self.build, selected))
        self.assertEqual(include.encode(), code.render_include(self.build, selected, topology='wg'))
        local = self.root / 'local'
        value = code.prepare(self.source, self.manifest, self.digest, self.build, local, topology='local')
        self.assertEqual(value['topology'], 'local')
        text = (local / value['nginx'][0]['path']).read_text()
        self.assertEqual(text.count('proxy_pass http://172.30.242.2:3000;'), 3)
        self.assertEqual(text.count('proxy_pass '), 3)
        self.assertNotIn('10.253.78.', text)
        self.assertEqual(text.count('auth_request /_gate/check;'), 7)
        self.assertEqual(code.verify(local, self.manifest, self.digest, self.build), value)
        self.assertEqual(code.verify(local, self.manifest, self.digest, self.build, topology='local'), value)
        with self.assertRaises(code.Refused): code.verify(local, self.manifest, self.digest, self.build, topology='wg')
        with self.assertRaises(code.Refused): code.verify(self.output, self.manifest, self.digest, self.build, topology='local')
        self.assertEqual(code.verify(self.output, self.manifest, self.digest, self.build, topology='wg'), default)
        for bad in ('LOCAL', '', None, 'wg ', 'direct'):
            with self.subTest(topology=bad), self.assertRaises(code.Refused):
                code.prepare(self.source, self.manifest, self.digest, self.build, self.root / 'bad', topology=bad)
            self.assertFalse((self.root / 'bad').exists())

    def test_recorded_topology_cannot_be_forged_or_dropped(self):
        for case in ('drop', 'wg', 'other', 'duplicate'):
            with self.subTest(case=case):
                fixture = PrivateCodeTests()
                fixture.setUp()
                try:
                    value = code.prepare(fixture.source, fixture.manifest, fixture.digest, fixture.build, fixture.output, topology='local')
                    file = fixture.output / 'release-manifest.json'
                    changed = deepcopy(value)
                    if case == 'drop': changed.pop('topology')
                    if case in ('wg', 'other'): changed['topology'] = 'direct' if case == 'other' else 'wg'
                    raw = code.canonical(changed)
                    if case == 'duplicate': raw = raw.replace(b'"topology":"local"', b'"topology":"wg","topology":"local"')
                    file.write_bytes(raw)
                    with self.assertRaises(code.Refused): fixture.verify()
                finally:
                    fixture.doCleanups()

    def test_bytes_source_mode_extra_js_css_noncodes_missing_and_empty_dirs_refused(self):
        cases = ('bytes', 'mode', 'extra-js', 'extra-css', 'extra-map', 'extra-txt', 'missing', 'empty-dir')
        for case in cases:
            with self.subTest(case=case):
                fixture = PrivateCodeTests()
                fixture.setUp()
                try:
                    file = fixture.source / 'public/js/main.js'
                    if case == 'bytes': file.write_bytes(b'forged bytes')
                    if case == 'mode': file.chmod(0o755)
                    if case == 'missing': file.unlink()
                    if case == 'empty-dir': (fixture.source / 'public/js/unknown').mkdir()
                    paths = {'extra-js': 'public/js/unknown.js', 'extra-css': 'public/css/unknown.css',
                             'extra-map': 'public/js/main.js.map', 'extra-txt': 'public/css/notes.txt'}
                    if case in paths: (fixture.source / paths[case]).write_bytes(b'unknown')
                    with self.assertRaises((code.Refused, OSError)): fixture.prepare()
                    self.assertFalse(fixture.output.exists())
                finally:
                    fixture.doCleanups()

    def test_links_hardlinks_fifo_ancestor_link_and_manifest_link_refused(self):
        for case in ('symlink', 'hardlink', 'fifo', 'directory-link', 'source-link', 'manifest-link'):
            with self.subTest(case=case):
                fixture = PrivateCodeTests()
                fixture.setUp()
                try:
                    file = fixture.source / 'public/js/main.js'
                    target = fixture.root / 'target.js'
                    target.write_bytes(file.read_bytes())
                    if case in ('symlink', 'hardlink', 'fifo'):
                        file.unlink()
                        if case == 'symlink': file.symlink_to(target)
                        if case == 'hardlink': os.link(target, file)
                        if case == 'fifo': os.mkfifo(file)
                    if case == 'directory-link':
                        directory = fixture.source / 'public/js/ui'
                        directory.rename(fixture.root / 'ui')
                        directory.symlink_to(fixture.root / 'ui')
                    if case == 'source-link':
                        fixture.source.rename(fixture.root / 'real-app')
                        fixture.source.symlink_to(fixture.root / 'real-app')
                    if case == 'manifest-link':
                        fixture.manifest.rename(fixture.root / 'real-manifest.json')
                        fixture.manifest.symlink_to(fixture.root / 'real-manifest.json')
                    with self.assertRaises((code.Refused, OSError)): fixture.prepare()
                    self.assertFalse(fixture.output.exists())
                finally:
                    fixture.doCleanups()

    def test_unsafe_manifest_paths_schema_kind_and_duplicate_entries_refused(self):
        for bad in ('../private.js', 'public/js/.secret.js', 'public/js/hello world.js',
                    'public/js/bad;name.js', 'public/js/$host.js', 'public/js/%2e.js',
                    'public/js/quoted"name.js', 'public/js/back\\slash.js', 'public/js/final.js\n'):
            original = deepcopy(self.value)
            self.value['files'][0]['path'] = bad
            self.value['files'].sort(key=lambda row: row['path'])
            self.refresh()
            with self.assertRaises(code.Refused): self.prepare()
            self.value = original
        for key, bad in (('kind', 'commit'), ('version', True), ('baseRevision', 'HEAD')):
            original = deepcopy(self.value)
            self.value[key] = bad
            self.refresh()
            with self.assertRaises(code.Refused): self.prepare()
            self.value = original
        self.value['files'].append(deepcopy(self.value['files'][0]))
        self.value['files'].sort(key=lambda row: row['path'])
        self.refresh()
        with self.assertRaises(code.Refused): self.prepare()

    def test_pinned_digest_build_canonical_json_and_duplicate_keys_are_required(self):
        original = self.manifest.read_bytes()
        self.manifest.write_bytes(original + b' ')
        with self.assertRaises(code.Refused): self.prepare()
        self.manifest.write_bytes(original)
        with self.assertRaises(code.Refused):
            code.prepare(self.source, self.manifest, self.digest, 'f' * 40, self.output)
        noncanonical = json.dumps(self.value, indent=2).encode()
        self.manifest.write_bytes(noncanonical)
        digest = code.sha(noncanonical)
        with self.assertRaises(code.Refused):
            code.prepare(self.source, self.manifest, digest, digest[:40], self.output)
        duplicate = original.replace(b'"kind":"tree"', b'"kind":"tree","kind":"tree"')
        self.manifest.write_bytes(duplicate)
        digest = code.sha(duplicate)
        with self.assertRaises(code.Refused):
            code.prepare(self.source, self.manifest, digest, digest[:40], self.output)

    def test_new_directory_and_protected_source_boundary(self):
        self.output.mkdir()
        with self.assertRaises(code.Refused): self.prepare()
        self.output.rmdir()
        self.output.symlink_to(self.source)
        with self.assertRaises(code.Refused): self.prepare()
        self.output.unlink()
        with self.assertRaises(code.Refused):
            code.prepare(self.source, self.manifest, self.digest, self.build, self.source / 'stage')
        with self.assertRaises(code.Refused):
            code.prepare(str(self.source) + '/../app', self.manifest, self.digest, self.build, self.output)

    def test_verify_refuses_altered_metadata_include_sums_extra_dirs_bytes_and_mode(self):
        for case in ('metadata', 'include', 'sums', 'extra-file', 'extra-dir', 'bytes', 'mode', 'hardlink'):
            with self.subTest(case=case):
                fixture = PrivateCodeTests()
                fixture.setUp()
                try:
                    value = fixture.prepare()
                    file = fixture.output / ('localcode/cluster-' + fixture.build) / value['files'][0]['path']
                    if case == 'metadata': (fixture.output / 'release-manifest.json').write_bytes(b'forged metadata')
                    if case == 'include': (fixture.output / value['nginx'][0]['path']).write_bytes(b'auth_request off;')
                    if case == 'sums': (fixture.output / 'SHA256SUMS').write_bytes(b'forged sums')
                    if case == 'extra-file': (fixture.output / 'unknown').write_bytes(b'unknown')
                    if case == 'extra-dir': (fixture.output / 'unknown').mkdir()
                    if case == 'bytes': file.write_bytes(b'forged source')
                    if case == 'mode': file.chmod(0o666)
                    if case == 'hardlink': os.link(file, fixture.root / 'extra-link')
                    with self.assertRaises((code.Refused, OSError)): fixture.verify()
                finally:
                    fixture.doCleanups()


class RuntimeStaticTests(unittest.TestCase):
    """Opt-in --runtime-static: /shared/, /sim/ and /data/ aliases beside the default /js/ /css/ code."""

    def setUp(self):
        self.base = PrivateCodeTests()
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        b = self.base
        # The default fixture's out-of-scope files under the new roots are replaced by a real runtime inventory.
        (b.source / 'data/private.json').unlink()
        for path, body in [('shared/constants.js', b'export const SHARED = 1;\n'),
                           ('server/sim/Battle.js', b'export class Battle {}\n'),
                           ('server/sim/battle/step.js', b'export const step = 1;\n'),
                           ('server/sim/nodeData.js', b'export const nodeOnly = true;\n'),
                           ('server/sim/content/kits/README.md', b'# kits\n'),
                           ('data/chess.json', b'{"chess":[' + b'1,' * 400 + b'1]}\n'),
                           ('data/i18n/en.json', b'{"en":true}\n')]:
            file = b.source / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(body)
            file.chmod(0o644)
            b.value['files'].append({'path': path, 'bytes': len(body), 'sha256': code.sha(body), 'mode': '0o644'})
        (b.source / 'data/local-assets.json').write_bytes(b'{"generated":"index"}')  # ignored by Git, never aliased
        b.value['files'].sort(key=lambda row: row['path'])
        b.refresh()

    def test_default_output_is_unchanged_and_runtime_is_recorded_only_when_opted_in(self):
        b = self.base
        default = code.prepare(b.source, b.manifest, b.digest, b.build, b.output)
        self.assertNotIn('runtimeStatic', default)
        self.assertEqual([row['path'] for row in default['files']], ['css/screens/game.css', 'css/theme.css', 'js/main.js', 'js/ui/panel.js'])
        runtime = b.root / 'runtime'
        value = code.prepare(b.source, b.manifest, b.digest, b.build, runtime, runtime=True)
        self.assertIs(value['runtimeStatic'], True)
        self.assertEqual(sorted(row['path'] for row in value['files']), sorted([
            'css/screens/game.css', 'css/theme.css', 'js/main.js', 'js/ui/panel.js',
            'shared/constants.js', 'sim/Battle.js', 'sim/battle/step.js', 'data/chess.json', 'data/i18n/en.json']))
        for row in value['files']:
            self.assertEqual((runtime / ('localcode/cluster-' + b.build) / row['path']).read_bytes(), (b.source / row['sourcePath']).read_bytes())
        self.assertFalse((runtime / ('localcode/cluster-' + b.build) / 'sim/nodeData.js').exists())
        self.assertFalse((runtime / ('localcode/cluster-' + b.build) / 'data/local-assets.json').exists())
        self.assertEqual(code.verify(runtime, b.manifest, b.digest, b.build), value)
        self.assertEqual(code.verify(runtime, b.manifest, b.digest, b.build, runtime=True), value)
        with self.assertRaises(code.Refused): code.verify(runtime, b.manifest, b.digest, b.build, runtime=False)
        with self.assertRaises(code.Refused): code.verify(b.output, b.manifest, b.digest, b.build, runtime=True)
        self.assertEqual(code.verify(b.output, b.manifest, b.digest, b.build), default)

    def test_runtime_include_gates_every_alias_and_falls_back_to_the_same_coordinator(self):
        b = self.base
        value = code.prepare(b.source, b.manifest, b.digest, b.build, b.output, runtime=True, topology='local')
        include = (b.output / value['nginx'][0]['path']).read_text()
        self.assertEqual(include.count('location = /'), 9)
        self.assertEqual(include.count('auth_request /_gate/check;'), 9 + 6)
        self.assertEqual(include.count('error_page 404 = @ark_beta_cluster_code;'), 9)
        for prefix in ('/js/', '/css/', '/shared/', '/sim/', '/data/'):
            self.assertIn('location ^~ ' + prefix + ' {', include)
        self.assertEqual(include.count('proxy_pass http://172.30.242.2:3000;'), 6)
        self.assertEqual(include.count('proxy_pass '), 6)
        self.assertIn('location = /sim/battle/step.js {', include)
        self.assertIn('location = /data/i18n/en.json {', include)
        self.assertNotIn('nodeData', include)
        self.assertNotIn('local-assets', include)
        self.assertNotIn('README', include)
        self.assertEqual(include.count('default_type application/json;'), 2)
        self.assertEqual(include.count('gzip on;'), 5)
        self.assertEqual(include.count('add_header Cache-Control "private, no-cache" always;'), 9 + 6)
        self.assertNotIn('no-store', include)
        self.assertNotIn('Access-Control-Allow-Origin "', include)
        self.assertNotIn('auth_request off', include)

    def test_runtime_inventory_drift_links_and_missing_roots_are_refused(self):
        for case in ('extra-sim', 'extra-data-dir', 'bytes', 'link', 'missing-shared', 'ignored-link'):
            with self.subTest(case=case):
                fixture = RuntimeStaticTests()
                fixture.setUp()
                try:
                    b = fixture.base
                    if case == 'extra-sim': (b.source / 'server/sim/unlisted.js').write_bytes(b'unlisted')
                    if case == 'extra-data-dir': (b.source / 'data/cache').mkdir()
                    if case == 'bytes': (b.source / 'data/chess.json').write_bytes(b'{"forged":1}\n')
                    if case == 'link':
                        target = b.root / 'outside.js'; target.write_bytes(b'export const SHARED = 1;\n')
                        (b.source / 'shared/constants.js').unlink(); (b.source / 'shared/constants.js').symlink_to(target)
                    if case == 'ignored-link':
                        (b.source / 'data/local-assets.json').unlink(); (b.source / 'data/local-assets.json').symlink_to(b.root / 'outside.json')
                    if case == 'missing-shared':
                        b.value['files'] = [row for row in b.value['files'] if not row['path'].startswith('shared/')]
                        (b.source / 'shared/constants.js').unlink(); b.refresh()
                    with self.assertRaises((code.Refused, OSError)):
                        code.prepare(b.source, b.manifest, b.digest, b.build, b.output, runtime=True)
                    self.assertFalse(b.output.exists())
                    if case in ('extra-sim', 'extra-data-dir', 'ignored-link'):
                        # The default code-only stage never looks at these roots.
                        code.prepare(b.source, b.manifest, b.digest, b.build, b.root / 'default')
                finally:
                    fixture.doCleanups()

    def test_runtime_metadata_flag_cannot_be_forged(self):
        b = self.base
        value = code.prepare(b.source, b.manifest, b.digest, b.build, b.output, runtime=True)
        file = b.output / 'release-manifest.json'
        for forged in (False, 'true', 1):
            changed = deepcopy(value); changed['runtimeStatic'] = forged
            file.write_bytes(code.canonical(changed))
            with self.assertRaises(code.Refused): code.verify(b.output, b.manifest, b.digest, b.build)
        changed = deepcopy(value); changed.pop('runtimeStatic')
        file.write_bytes(code.canonical(changed))
        with self.assertRaises(code.Refused): code.verify(b.output, b.manifest, b.digest, b.build)


class ClientBuildTests(unittest.TestCase):
    """Opt-in client build (2026-10-16): the Vite chunks under public/build/assets/ from the export's resource manifest."""

    def setUp(self):
        self.runtime = RuntimeStaticTests()
        self.runtime.setUp()
        self.addCleanup(self.runtime.doCleanups)
        b = self.base = self.runtime.base
        (b.source / 'data/local-fx.json').write_bytes(b'{"generated":"fx"}')  # ignored by Git like local-assets.json
        self.chunks = []
        for name, body in (('index-fZZ6UYkX.js', b'import"/shared/constants.js";\n'), ('app-DPi2_UuZ.js', b'export const app = 1;\n'),
                           ('index-BBPOlTA9.css', b'body{margin:0}\n')):
            file = b.source / 'public/build/assets' / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(body)
            file.chmod(0o644)
            self.chunks.append({'path': 'public/build/assets/' + name, 'bytes': len(body), 'sha256': code.sha(body), 'mode': '0o644'})
        (b.source / 'public/build/index.html').write_bytes(b'<!doctype html><head></head>')  # the coordinator's page, never aliased
        self.resources = b.root / 'resource-manifest.json'
        self.write_resources()

    def write_resources(self, extra=(), **override):
        b = self.base
        rows = sorted([*self.chunks, {'path': 'public/build/index.html', 'bytes': 28, 'sha256': 'c' * 64, 'mode': '0o644'},
                       {'path': 'public/assets/test.png', 'bytes': 25, 'sha256': 'd' * 64, 'mode': '0o644'}, *extra],
                      key=lambda row: row['path'])
        value = {'version': 1, 'sourceKind': 'tree', 'build': b.build, 'sourceManifestSha256': b.digest, 'files': rows, **override}
        raw = code.canonical(value)
        self.resources.write_bytes(raw)
        self.resource_digest = code.sha(raw)

    def prepare(self, out=None, **kw):
        b = self.base
        return code.prepare(b.source, b.manifest, b.digest, b.build, out or b.output, runtime=True, topology='local',
                            resource_manifest=self.resources, resource_digest=self.resource_digest, **kw)

    def test_chunks_are_gated_immutable_aliases_and_verify_needs_the_same_resource_manifest(self):
        b = self.base
        value = self.prepare()
        self.assertEqual(value['clientBuildResourceManifestSha256'], self.resource_digest)
        paths = sorted(row['path'] for row in value['files'])
        self.assertIn('build/assets/index-fZZ6UYkX.js', paths)
        self.assertIn('build/assets/index-BBPOlTA9.css', paths)
        self.assertNotIn('build/index.html', paths)
        self.assertFalse(any('local-fx' in path or 'local-assets' in path for path in paths))
        for row in value['files']:
            self.assertEqual((b.output / ('localcode/cluster-' + b.build) / row['path']).read_bytes(), (b.source / row['sourcePath']).read_bytes())
        include = (b.output / value['nginx'][0]['path']).read_text()
        block = include[include.index('location = /build/assets/index-BBPOlTA9.css {'):]
        block = block[:block.index('\n}\n') + 2]
        for line in ('auth_request /_gate/check;', 'error_page 404 = @ark_beta_cluster_code;', 'default_type text/css;',
                     'add_header Cache-Control "private, max-age=31536000, immutable" always;', 'gzip on;'):
            self.assertIn(line, block)
        self.assertEqual(include.count('add_header Cache-Control "private, max-age=31536000, immutable" always;'), 3)
        self.assertIn('location ^~ /build/ {', include)
        self.assertEqual(include.count('proxy_pass http://172.30.242.2:3000;'), 7)
        self.assertNotIn('public, max-age', include)
        self.assertNotIn('Access-Control-Allow-Origin "', include)
        args = (b.output, b.manifest, b.digest, b.build)
        self.assertEqual(code.verify(*args, resource_manifest=self.resources, resource_digest=self.resource_digest), value)
        with self.assertRaises(code.Refused): code.verify(*args)
        with self.assertRaises(code.Refused): code.verify(*args, resource_manifest=self.resources, resource_digest='e' * 64)
        # without the opt-in nothing changes: no /build/ aliases and the default bytes
        plain = code.prepare(b.source, b.manifest, b.digest, b.build, b.root / 'plain', runtime=True, topology='local')
        self.assertNotIn('clientBuildResourceManifestSha256', plain)
        self.assertNotIn('/build/', (b.root / 'plain' / plain['nginx'][0]['path']).read_text())
        with self.assertRaises(code.Refused):
            code.verify(b.root / 'plain', b.manifest, b.digest, b.build, resource_manifest=self.resources, resource_digest=self.resource_digest)

    def test_chunk_drift_unknown_entries_and_foreign_manifests_are_refused(self):
        for case in ('extra-chunk', 'bytes', 'unhashed', 'subdir', 'other-build', 'digest', 'missing'):
            with self.subTest(case=case):
                fixture = ClientBuildTests()
                fixture.setUp()
                try:
                    b = fixture.base
                    if case == 'extra-chunk': (b.source / 'public/build/assets/extra-AAAAAAAA.js').write_bytes(b'x')
                    if case == 'bytes': (b.source / 'public/build/assets/index-BBPOlTA9.css').write_bytes(b'body{margin:1}\n')
                    if case == 'unhashed':
                        (b.source / 'public/build/assets/plain.js').write_bytes(b'x')
                        fixture.write_resources(extra=[{'path': 'public/build/assets/plain.js', 'bytes': 1, 'sha256': code.sha(b'x'), 'mode': '0o644'}])
                    if case == 'subdir': (b.source / 'public/build/assets/nested').mkdir()
                    if case == 'other-build': fixture.write_resources(build='f' * 40)
                    if case == 'digest': fixture.resource_digest = 'e' * 64
                    if case == 'missing': (b.source / 'public/build/assets/app-DPi2_UuZ.js').unlink()
                    with self.assertRaises((code.Refused, OSError)):
                        fixture.prepare()
                    self.assertFalse(b.output.exists())
                finally:
                    fixture.doCleanups()


if __name__ == '__main__':
    unittest.main()
