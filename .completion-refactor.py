from pathlib import Path
import base64
import hashlib
import lzma
import subprocess

BRANCH = 'codex/complete-contract-execution-20260905'
EXPECTED_SHA256 = '3d0b1004e836c9137eff295cd4f1eba924b424ffa4fd815af5c9ef24a0915af4'

branch = subprocess.check_output(['git', 'branch', '--show-current'], text=True).strip()
if branch != BRANCH:
    raise RuntimeError('Refusing to apply the reviewed patch outside its dedicated branch')
encoded = ''.join(Path(f'.completion-refactor-part-{index}.txt').read_text().strip() for index in range(6))
patch = lzma.decompress(base64.b64decode(encoded, validate=True))
if hashlib.sha256(patch).hexdigest() != EXPECTED_SHA256:
    raise RuntimeError('Refactor patch transfer failed its SHA-256 integrity check')
for line in patch.decode('utf-8').splitlines():
    if line.startswith('+++ b/') or line.startswith('--- a/'):
        path = line[6:]
        if not (path.startswith(('src/', 'scripts/', 'tests/', 'docs/')) or path == 'tsconfig.tests.json'):
            raise RuntimeError(f'Unexpected patch destination: {path}')
        if '..' in Path(path).parts:
            raise RuntimeError('Unsafe patch destination')
reverse = subprocess.run(['git', 'apply', '--reverse', '--check', '--unidiff-zero', '-'], input=patch, capture_output=True)
if reverse.returncode == 0:
    print('Verified refactor patch already applied; leaving the working tree unchanged.')
else:
    subprocess.run(['git', 'apply', '--check', '--unidiff-zero', '-'], input=patch, check=True)
    subprocess.run(['git', 'apply', '--unidiff-zero', '-'], input=patch, check=True)
    print(f'Applied reviewed contract execution patch ({len(patch)} bytes, SHA-256 {EXPECTED_SHA256}).')
