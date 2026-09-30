#!/usr/bin/env python3
"""Non-executing source, immutable artifact, and packed sidecar admission."""
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile

SPEC = importlib.util.spec_from_file_location('signing', Path(__file__).with_name('sign-macos-sidecars.py'))
signing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(signing)
require = signing.require
MAX_BYTES = signing.MAX_BYTES
REPOSITORY = 'hraness/local-custody'
PAIRS = ('linux-x64', 'darwin-arm64', 'darwin-x64')


def command(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=180, check=False)
    require(result.returncode == 0 and len(result.stdout) <= 1024 * 1024, 'release authority command failed or exceeded its bound')
    return result.stdout.strip()


def context():
    require(os.environ.get('GITHUB_REPOSITORY') == REPOSITORY, 'unexpected repository')
    sha = os.environ.get('GITHUB_SHA', '')
    require(re.fullmatch(r'[a-f0-9]{40}', sha), 'invalid source SHA')
    version = signing.version_value(json.loads(Path('package.json').read_text())['version'])
    require(os.environ.get('GITHUB_REF') == 'refs/tags/v' + version
            and os.environ.get('GITHUB_REF_NAME') == 'v' + version, 'workflow must use the exact package version tag')
    for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        require(re.fullmatch(r'[1-9][0-9]*', os.environ.get(key, '')), 'invalid run identity')
    return version, sha


def outputs(values):
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        for name, value in values.items():
            output.write(f'{name}={value}\n')


def verify_tag():
    version, sha = context()
    command(['git', 'fetch', '--no-tags', '--depth=1', 'origin', 'refs/tags/v' + version])
    require(command(['git', 'rev-parse', 'FETCH_HEAD^{commit}']) == sha, 'remote release tag moved')


def qualify():
    version, sha = context()
    require(command(['git', 'rev-parse', 'HEAD']) == sha, 'checkout source mismatch')
    fetch = ['git', 'fetch', '--no-tags']
    if command(['git', 'rev-parse', '--is-shallow-repository']) == 'true':
        fetch.append('--unshallow')
    command(fetch + ['origin', 'refs/heads/main:refs/remotes/origin/main'])
    command(['git', 'merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'])
    rows = command(['git', 'ls-remote', '--refs', '--tags', 'origin', 'refs/tags/v*'])
    versions = []
    for row in rows.splitlines():
        match = re.fullmatch(r'[a-f0-9]{40}\trefs/tags/v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))', row)
        if match:
            versions.append(tuple(map(int, match[1].split('.'))))
    require(versions and max(versions) == tuple(map(int, version.split('.'))), 'release is not the newest stable tag')
    verify_tag()
    outputs({'tag': 'v' + version, 'version': version})


def api(path):
    return json.loads(command(['gh', 'api', f'repos/{REPOSITORY}/{path}']))


def admit_metadata(metadata, name, expected_id=None, expected_digest=None):
    _, sha = context()
    artifact_id, digest = metadata.get('id'), metadata.get('digest', '')
    require(type(artifact_id) is int and artifact_id > 0 and metadata.get('name') == name, 'artifact identity mismatch')
    require(metadata.get('expired') is False and type(metadata.get('size_in_bytes')) is int
            and 0 < metadata['size_in_bytes'] <= MAX_BYTES, 'artifact expired or oversized')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', digest), 'artifact digest missing')
    run = metadata.get('workflow_run', {})
    require(str(run.get('id')) == os.environ['GITHUB_RUN_ID'] and run.get('head_sha') == sha, 'artifact run/source mismatch')
    require(expected_id is None or str(artifact_id) == expected_id, 'artifact ID differs from job output')
    require(expected_digest is None or digest == 'sha256:' + expected_digest, 'artifact digest differs from job output')
    return artifact_id, digest[7:]


def unpack_zip(archive, digest, names, destination):
    require(hashlib.sha256(signing.regular_file(archive)).hexdigest() == digest, 'artifact ZIP digest mismatch')
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        require(len(entries) == len(names) and {e.filename for e in entries} == set(names), 'artifact ZIP inventory mismatch')
        for entry in entries:
            require(not entry.is_dir() and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG)
                    and not entry.flag_bits & 1 and 0 < entry.file_size <= MAX_BYTES, 'unsafe ZIP entry')
        destination.mkdir(mode=0o700)
        for entry in entries:
            with source.open(entry) as stream:
                data = stream.read(entry.file_size + 1)
            require(len(data) == entry.file_size, 'artifact ZIP member size mismatch')
            with (destination / entry.filename).open('xb') as output:
                output.write(data)


def fetch(metadata, name, names, destination, expected_id=None, expected_digest=None):
    artifact_id, digest = admit_metadata(metadata, name, expected_id, expected_digest)
    with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP'], prefix='local-custody-artifact-') as temp:
        archive = Path(temp) / 'artifact.zip'
        with archive.open('xb') as output:
            result = subprocess.run(['gh', 'api', f'repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip'],
                                    stdout=output, stderr=subprocess.PIPE, timeout=180, check=False)
        require(result.returncode == 0, 'artifact download failed')
        unpack_zip(archive, digest, names, destination)


def fetch_output(prefix, producer, names, destination):
    context()
    artifact_id, digest = os.environ.get(prefix + '_ARTIFACT_ID', ''), os.environ.get(prefix + '_ARTIFACT_DIGEST', '')
    require(re.fullmatch(r'[1-9][0-9]*', artifact_id) and re.fullmatch(r'[a-f0-9]{64}', digest), 'missing exact artifact job outputs')
    metadata = api(f'actions/artifacts/{artifact_id}')
    # A successful producer can be reused when only its failed consumer is
    # rerun. The immutable job output selects the artifact, not the consumer's
    # current attempt or a latest-name lookup.
    name = metadata.get('name', '')
    match = re.fullmatch(re.escape(producer) + r'-([1-9][0-9]*)', name)
    require(match is not None and int(match[1]) <= int(os.environ['GITHUB_RUN_ATTEMPT']),
            'artifact producer name or attempt mismatch')
    fetch(metadata, name, names, destination, artifact_id, digest)


def fetch_native(pair, destination):
    require(pair in PAIRS, 'unsupported native artifact target')
    fetch_output(pair.upper().replace('-', '_'), 'local-custody-' + pair, {'local-custody'}, destination)


def prepare_unsigned(destination):
    version, _ = context()
    destination.mkdir(mode=0o700)
    archive = destination / signing.archive_name(version, unsigned=True)
    with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as temp:
        staging = Path(temp)
        with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as bundle:
            for arch in ('arm64', 'x64'):
                pair = 'darwin-' + arch
                fetch_native(pair, staging / pair)
                data = signing.regular_file(staging / pair / 'local-custody')
                member = tarfile.TarInfo(pair + '/local-custody')
                member.size, member.mode = len(data), 0o755
                bundle.addfile(member, io.BytesIO(data))
        Path(str(archive) + '.sha256').write_text(signing.digest(archive.read_bytes()) + '  ' + archive.name + '\n')
        signing.unpack_native(archive, version, staging / 'validated')


def fetch_sidecars(kind, destination):
    version, _ = context()
    name = signing.archive_name(version, unsigned=kind == 'unsigned')
    fetch_output(kind.upper(), 'macos-' + kind, {name, name + '.sha256'}, destination)
    return destination / name


def record_signed(directory):
    version, _ = context()
    with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as temp:
        archive = directory / signing.archive_name(version)
        binaries = signing.unpack_native(archive, version, Path(temp) / 'binaries', unsigned=False)
        outputs({**{arch + '_sha256': signing.digest(signing.regular_file(binary)) for arch, binary in binaries.items()},
                 'archive_sha256': signing.digest(signing.regular_file(archive))})


def expected_hashes():
    hashes = {arch: os.environ.get('SIGNED_' + arch.upper() + '_SHA256', '') for arch in ('arm64', 'x64')}
    require(all(re.fullmatch(r'[a-f0-9]{64}', value) for value in hashes.values()), 'missing signed sidecar job hashes')
    return hashes


def stage(destination):
    version, _ = context()
    hashes = expected_hashes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as temp:
        root = Path(temp)
        archive = fetch_sidecars('signed', root / 'signed')
        signing.unpack_native(archive, version, destination, unsigned=False)
        signing.verify_sidecars(destination, hashes['arm64'], hashes['x64'])
        fetch_native('linux-x64', destination / 'linux-x64')
        (destination / 'linux-x64/local-custody').chmod(0o755)


def package_name(version):
    return 'hraness-local-custody-' + version + '.tgz'


def verify_package(archive):
    version, _ = context()
    hashes = expected_hashes()
    require(archive.name == package_name(version), 'wrong npm tarball name')
    data = signing.regular_file(archive)
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
        expanded = compressed.read(MAX_BYTES + 1)
    require(len(expanded) <= MAX_BYTES, 'npm tarball exceeds expansion bound')
    expected = {'package/package.json', 'package/dist/rust-artifacts/manifest.json'}
    expected |= {f'package/dist/rust-artifacts/local-custody/{pair}/local-custody' for pair in PAIRS}
    found, names = {}, set()
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as bundle:
        for member in bundle:
            require(len(names) < 4096 and member.name not in names and member.name.startswith('package/')
                    and '..' not in member.name.split('/') and member.isreg() and 0 <= member.size <= MAX_BYTES,
                    'unsafe or duplicate npm tar member')
            names.add(member.name)
            if member.name in expected:
                maximum = 1_048_576 if member.name.endswith('.json') else MAX_BYTES
                require(member.size <= maximum, 'package metadata exceeds byte bound')
                found[member.name] = bundle.extractfile(member).read(maximum + 1)
    require(set(found) == expected, 'npm tarball lacks required sidecars or metadata')
    package = json.loads(found['package/package.json'])
    require(package.get('name') == '@hraness/local-custody' and package.get('version') == version, 'npm package identity mismatch')
    manifest = json.loads(found['package/dist/rust-artifacts/manifest.json'])
    entries = manifest.get('artifacts', [])
    require(manifest.get('version') == 1 and len(entries) == 3 and {e.get('target') for e in entries} == set(PAIRS), 'package native manifest inventory mismatch')
    for entry in entries:
        pair = entry['target']
        primary = f'local-custody/{pair}/local-custody'
        payload = found['package/dist/rust-artifacts/' + primary]
        digest = signing.digest(payload)
        require(entry.get('primary') == primary and entry.get('sha256') == digest and entry.get('bytes') == len(payload), 'package native manifest hash mismatch')
        if pair.startswith('darwin-'):
            require(digest == hashes[pair.removeprefix('darwin-')], 'npm sidecar differs from exact signer output')
    return signing.digest(data)


def record_package(directory):
    version, _ = context()
    require({p.name for p in directory.iterdir()} == {package_name(version)}, 'unexpected packed release files')
    archive = directory / package_name(version)
    digest = verify_package(archive)
    (directory / 'SHA256SUMS').write_text(digest + '  ' + archive.name + '\n')
    outputs({'tarball_sha256': digest})


def fetch_package(destination):
    version, _ = context()
    name = package_name(version)
    fetch_output('PACKAGE', 'npm-release', {name, 'SHA256SUMS'}, destination)
    digest = os.environ.get('PACKAGE_SHA256', '')
    require(re.fullmatch(r'[a-f0-9]{64}', digest), 'missing exact npm tarball job hash')
    require(signing.regular_file(destination / 'SHA256SUMS', 256).decode('ascii') == digest + '  ' + name + '\n', 'package checksum record mismatch')
    require(verify_package(destination / name) == digest, 'npm tarball differs from assembly job')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['qualify', 'verify-tag', 'prepare-unsigned', 'fetch-unsigned', 'record-signed', 'stage', 'record-package', 'fetch-package'])
    parser.add_argument('destination', type=Path, nargs='?')
    args = parser.parse_args()
    if args.command in ('qualify', 'verify-tag'):
        return (qualify if args.command == 'qualify' else verify_tag)()
    require(args.destination is not None, 'destination required')
    if args.command == 'fetch-unsigned':
        return fetch_sidecars('unsigned', args.destination)
    {'prepare-unsigned': prepare_unsigned, 'record-signed': record_signed, 'stage': stage,
     'record-package': record_package, 'fetch-package': fetch_package}[args.command](args.destination)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error) if isinstance(error, signing.SigningError) else type(error).__name__
        raise SystemExit('release blocked: ' + message) from None
