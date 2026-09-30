"""Exercise exact source/artifact admission and signed bytes inside the npm tarball."""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('artifacts', ROOT / 'scripts/release-artifacts.py')
artifacts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifacts)
WORKFLOW = (ROOT / '.github/workflows/release.yml').read_text()
SHA = 'a' * 40
VERSION = '0.9.1'


def job(name):
    match = re.search(r'^  ' + re.escape(name) + r':\n(.*?)(?=^  [a-z_]+:\n|\Z)', WORKFLOW, re.M | re.S)
    assert match, name
    return match[1]


class Fixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='local-custody-release-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.old_cwd = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.old_cwd)
        (self.root / 'package.json').write_text(json.dumps({'name': '@hraness/local-custody', 'version': VERSION}))
        self.payloads = {pair: (pair + ' signed bytes').encode() for pair in artifacts.PAIRS}
        environment = {
            'GITHUB_REPOSITORY': 'hraness/local-custody', 'GITHUB_SHA': SHA,
            'GITHUB_REF': 'refs/tags/v' + VERSION, 'GITHUB_REF_NAME': 'v' + VERSION,
            'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2', 'RUNNER_TEMP': str(self.root),
            'GITHUB_OUTPUT': str(self.root / 'output'),
            'SIGNED_ARM64_SHA256': hashlib.sha256(self.payloads['darwin-arm64']).hexdigest(),
            'SIGNED_X64_SHA256': hashlib.sha256(self.payloads['darwin-x64']).hexdigest(),
        }
        active = patch.dict(os.environ, environment)
        active.start()
        self.addCleanup(active.stop)


class ArtifactTests(Fixture):
    def metadata(self):
        return {'id': 7, 'name': 'macos-signed-2', 'expired': False, 'size_in_bytes': 100,
                'digest': 'sha256:' + 'b' * 64, 'workflow_run': {'id': 123, 'head_sha': SHA}}

    def test_artifact_metadata_requires_exact_job_run_source_and_digest(self):
        metadata = self.metadata()
        self.assertEqual(artifacts.admit_metadata(metadata, 'macos-signed-2', '7', 'b' * 64), (7, 'b' * 64))
        for mutation in ({'id': True}, {'id': 8}, {'digest': 'sha256:' + 'c' * 64},
                         {'expired': True}, {'size_in_bytes': artifacts.MAX_BYTES + 1},
                         {'workflow_run': {'id': 124, 'head_sha': SHA}},
                         {'workflow_run': {'id': 123, 'head_sha': 'c' * 40}}, {'name': 'macos-signed-1'}):
            with self.subTest(mutation=mutation), self.assertRaises(artifacts.signing.SigningError):
                artifacts.admit_metadata({**metadata, **mutation}, 'macos-signed-2', '7', 'b' * 64)

    def output_fixture(self, producer='macos-signed', attempt=1):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as bundle:
            bundle.writestr('local-custody', b'producer payload')
        data = stream.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        metadata = {**self.metadata(), 'name': f'{producer}-{attempt}', 'digest': 'sha256:' + digest,
                    'size_in_bytes': len(data)}
        def download(arguments, **kwargs):
            self.assertEqual(arguments, ['gh', 'api', 'repos/hraness/local-custody/actions/artifacts/7/zip'])
            kwargs['stdout'].write(data)
            return SimpleNamespace(returncode=0)
        return digest, metadata, download

    def test_retried_consumer_accepts_exact_successful_earlier_producer(self):
        for prefix, producer in (('UNSIGNED', 'macos-unsigned'), ('SIGNED', 'macos-signed'), ('PACKAGE', 'npm-release')):
            for attempt in (1, 2):
                with self.subTest(producer=producer, attempt=attempt):
                    digest, metadata, download = self.output_fixture(producer, attempt)
                    destination = self.root / f'{prefix}-{attempt}'
                    with patch.dict(os.environ, {prefix + '_ARTIFACT_ID': '7', prefix + '_ARTIFACT_DIGEST': digest}), \
                            patch.object(artifacts, 'api', return_value=metadata) as api, \
                            patch.object(artifacts.subprocess, 'run', download):
                        artifacts.fetch_output(prefix, producer, {'local-custody'}, destination)
                        api.assert_called_once_with('actions/artifacts/7')
                    self.assertEqual((destination / 'local-custody').read_bytes(), b'producer payload')

    def test_retry_never_accepts_future_malformed_or_mismatched_producer(self):
        digest, metadata, _ = self.output_fixture()
        mutations = [
            {'name': 'macos-signed-3'}, {'name': 'macos-signed-0'}, {'name': 'macos-signed-01'},
            {'name': 'macos-unsigned-1'}, {'id': 8}, {'digest': 'sha256:' + '0' * 64},
            {'workflow_run': {'id': 456, 'head_sha': SHA}},
            {'workflow_run': {'id': 123, 'head_sha': 'c' * 40}},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation), patch.dict(os.environ, {
                    'SIGNED_ARTIFACT_ID': '7', 'SIGNED_ARTIFACT_DIGEST': digest}), \
                    patch.object(artifacts, 'api', return_value={**metadata, **mutation}), \
                    patch.object(artifacts.subprocess, 'run') as download:
                with self.assertRaises(artifacts.signing.SigningError):
                    artifacts.fetch_output('SIGNED', 'macos-signed', {'local-custody'}, self.root / 'rejected')
                download.assert_not_called()

    def test_native_matrix_outputs_can_mix_reused_and_retried_producers(self):
        for pair, attempt in (('darwin-arm64', 1), ('darwin-x64', 2), ('linux-x64', 1)):
            with self.subTest(pair=pair):
                digest, metadata, download = self.output_fixture('local-custody-' + pair, attempt)
                prefix = pair.upper().replace('-', '_')
                with patch.dict(os.environ, {prefix + '_ARTIFACT_ID': '7', prefix + '_ARTIFACT_DIGEST': digest}), \
                        patch.object(artifacts, 'api', return_value=metadata) as api, \
                        patch.object(artifacts.subprocess, 'run', download):
                    artifacts.fetch_native(pair, self.root / pair)
                    api.assert_called_once_with('actions/artifacts/7')
                self.assertEqual((self.root / pair / 'local-custody').read_bytes(), b'producer payload')
        # Never pick an artifact by name if its actual job output is missing.
        with patch.dict(os.environ, {'LINUX_X64_ARTIFACT_ID': '', 'LINUX_X64_ARTIFACT_DIGEST': ''}), \
                patch.object(artifacts, 'api') as api:
            with self.assertRaisesRegex(artifacts.signing.SigningError, 'exact artifact job outputs'):
                artifacts.fetch_native('linux-x64', self.root / 'missing')
            api.assert_not_called()

    def test_zip_rejects_digest_inventory_and_symlink_substitution(self):
        path = self.root / 'artifact.zip'
        with zipfile.ZipFile(path, 'w') as bundle:
            bundle.writestr('local-custody', b'payload')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        artifacts.unpack_zip(path, digest, {'local-custody'}, self.root / 'valid')
        for expected_digest, names in ((digest, {'other'}), ('0' * 64, {'local-custody'})):
            with self.assertRaises(artifacts.signing.SigningError):
                artifacts.unpack_zip(path, expected_digest, names, self.root / 'bad')
        with zipfile.ZipFile(path, 'w') as bundle:
            entry = zipfile.ZipInfo('local-custody')
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            bundle.writestr(entry, '/bin/sh')
        with self.assertRaisesRegex(artifacts.signing.SigningError, 'unsafe ZIP'):
            artifacts.unpack_zip(path, hashlib.sha256(path.read_bytes()).hexdigest(), {'local-custody'}, self.root / 'bad')

    def package(self, *, substitute=False, forged_manifest=False, duplicate=False):
        data = {'package/package.json': json.dumps({'name': '@hraness/local-custody', 'version': VERSION}).encode()}
        entries = []
        for pair, payload in self.payloads.items():
            primary = f'local-custody/{pair}/local-custody'
            actual = b'changed after signing' if substitute and pair == 'darwin-arm64' else payload
            data['package/dist/rust-artifacts/' + primary] = actual
            recorded = actual if forged_manifest else payload
            entries.append({'target': pair, 'primary': primary, 'sha256': hashlib.sha256(recorded).hexdigest(), 'bytes': len(recorded)})
        data['package/dist/rust-artifacts/manifest.json'] = json.dumps({'version': 1, 'artifacts': entries}).encode()
        archive = self.root / artifacts.package_name(VERSION)
        with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as bundle:
            for name, contents in data.items():
                member = tarfile.TarInfo(name)
                member.size = len(contents)
                bundle.addfile(member, io.BytesIO(contents))
            if duplicate:
                bundle.addfile(member, io.BytesIO(contents))
        return archive

    def test_original_packed_bytes_and_manifest_are_admitted(self):
        archive = self.package()
        self.assertEqual(artifacts.verify_package(archive), hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_changed_binary_and_even_rewritten_manifest_cannot_impersonate_signer(self):
        for forged in (False, True):
            with self.subTest(forged=forged), self.assertRaises(artifacts.signing.SigningError):
                artifacts.verify_package(self.package(substitute=True, forged_manifest=forged))

    def test_missing_job_hash_and_duplicate_package_members_fail_closed(self):
        archive = self.package()
        with patch.dict(os.environ, {'SIGNED_X64_SHA256': ''}), self.assertRaises(artifacts.signing.SigningError):
            artifacts.verify_package(archive)
        with self.assertRaisesRegex(artifacts.signing.SigningError, 'duplicate'):
            artifacts.verify_package(self.package(duplicate=True))

    def test_tar_expansion_is_bounded_before_tarfile_consumes_extensions(self):
        archive = self.root / artifacts.package_name(VERSION)
        archive.write_bytes(gzip.compress(b'x' * 2048))
        with patch.object(artifacts, 'MAX_BYTES', 1024), patch.object(artifacts.tarfile, 'open') as parser:
            with self.assertRaisesRegex(artifacts.signing.SigningError, 'expansion bound'):
                artifacts.verify_package(archive)
            parser.assert_not_called()

    def test_fetched_package_requires_assembly_hash_not_just_self_declared_checksum(self):
        archive = self.package()
        original = archive.read_bytes()
        expected = hashlib.sha256(original).hexdigest()
        def downloaded(prefix, name, names, destination):
            self.assertEqual(prefix, 'PACKAGE')
            self.assertEqual(name, 'npm-release')
            destination.mkdir()
            (destination / archive.name).write_bytes(original)
            (destination / 'SHA256SUMS').write_text(expected + '  ' + archive.name + '\n')
        with patch.object(artifacts, 'fetch_output', downloaded), patch.dict(os.environ, {'PACKAGE_SHA256': expected}):
            artifacts.fetch_package(self.root / 'good')
        with patch.object(artifacts, 'fetch_output', downloaded), patch.dict(os.environ, {'PACKAGE_SHA256': '0' * 64}):
            with self.assertRaisesRegex(artifacts.signing.SigningError, 'checksum record mismatch'):
                artifacts.fetch_package(self.root / 'bad')


class SourceTests(Fixture):
    def git(self, *arguments, cwd=None):
        return subprocess.run(['git', *arguments], cwd=cwd or self.root, check=True,
                              capture_output=True, text=True, timeout=15).stdout.strip()

    def test_remote_lightweight_annotated_and_moved_tags(self):
        with patch.dict(os.environ, {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
                        'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                        'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}):
            self.git('init', '-q', '-b', 'main')
            self.git('add', 'package.json')
            self.git('commit', '-qm', 'source')
            sha = self.git('rev-parse', 'HEAD')
            self.git('tag', 'v' + VERSION)
            remote = self.root / 'remote.git'
            self.git('clone', '-q', '--bare', str(self.root), str(remote))
            self.git('remote', 'add', 'origin', str(remote))
            with patch.dict(os.environ, {'GITHUB_SHA': sha}):
                artifacts.qualify()
                self.git('tag', '-f', '-a', 'v' + VERSION, '-m', 'annotated', sha, cwd=remote)
                artifacts.verify_tag()
                self.git('commit', '--allow-empty', '-qm', 'other source')
                self.git('push', '-q', 'origin', 'HEAD:refs/heads/main')
                new_sha = self.git('rev-parse', 'HEAD')
                self.git('tag', '-f', 'v' + VERSION, new_sha, cwd=remote)
                with self.assertRaisesRegex(artifacts.signing.SigningError, 'tag moved'):
                    artifacts.verify_tag()

    def test_branch_workflow_ref_is_rejected(self):
        with patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/main'}), self.assertRaisesRegex(artifacts.signing.SigningError, 'exact package version tag'):
            artifacts.context()


class WorkflowTests(unittest.TestCase):
    def test_signing_job_never_builds_or_executes_payloads(self):
        signer = job('macos_sign')
        self.assertIn('environment: hraness-apple-release', signer)
        self.assertIn('needs: [verify, prepare_unsigned]', signer)
        for unsafe in ('cargo ', 'npm ', 'bun ', 'package-smoke'):
            self.assertNotIn(unsafe, signer)
        self.assertLess(signer.index(' cleanup '), signer.index('record-signed'))
        self.assertIn('if: always()', signer)
        for name in ('verify', 'rust_artifacts', 'prepare_unsigned', 'assemble', 'package_smoke', 'publish', 'npm_mirror'):
            self.assertNotIn('secrets.APPLE_', job(name))

    def test_immutable_package_is_uploaded_before_separate_native_smoke(self):
        self.assertNotIn('package-smoke', job('assemble'))
        smoke = job('package_smoke')
        self.assertIn('macos-15-intel', smoke)
        self.assertIn('--archive artifacts/*.tgz --require-rust', smoke)
        self.assertNotIn('upload-artifact', smoke)
        self.assertIn('needs: [verify, assemble, macos_sign, package_smoke]', job('publish'))
        for consumer in ('package_smoke', 'publish', 'npm_mirror'):
            for field in ('artifact_id', 'artifact_digest', 'tarball_sha256'):
                self.assertIn('${{ needs.assemble.outputs.' + field + ' }}', job(consumer))
            for arch in ('arm64', 'x64'):
                self.assertIn('${{ needs.macos_sign.outputs.' + arch + '_sha256 }}', job(consumer))

    def test_native_matrix_exposes_unique_artifact_identities_to_each_consumer(self):
        native = job('rust_artifacts')
        for pair, consumer in (('darwin_arm64', 'prepare_unsigned'), ('darwin_x64', 'prepare_unsigned'), ('linux_x64', 'assemble')):
            for field in ('artifact_id', 'artifact_digest'):
                key = pair + '_' + field
                self.assertIn(key + ': ${{ steps.producer.outputs.' + key + ' }}', native)
                self.assertIn('${{ needs.rust_artifacts.outputs.' + key + ' }}', job(consumer))
        self.assertIn('ARTIFACT_ID: ${{ steps.native.outputs.artifact-id }}', native)
        self.assertIn('ARTIFACT_DIGEST: ${{ steps.native.outputs.artifact-digest }}', native)

    def test_npm_mirror_never_rebuilds_and_verifies_actual_integrity(self):
        mirror = job('npm_mirror')
        for unsafe in ('npm pack ', 'bun ', 'cargo ', 'rust:build'):
            self.assertNotIn(unsafe, mirror)
        self.assertIn('dist.integrity', mirror)
        self.assertIn('npm publish "$tarball" --ignore-scripts --provenance', mirror)
        self.assertIn('release-artifacts.py verify-tag', mirror)
        self.assertIn('release-artifacts.py verify-tag', job('publish'))


if __name__ == '__main__':
    unittest.main()
