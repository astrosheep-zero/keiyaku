import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zlib

raw = Path(sys.argv[1]).read_text().strip()
# Repair the one-character transport transcription, then verify exact bytes.
raw = raw.replace('HA3Zbniy', 'HA3Z3bniy')
blob = raw.encode()
assert hashlib.sha1(f'blob {len(blob)}\0'.encode() + blob).hexdigest() == '44e724b8ac2dda7ed31cc8619f85374223600b4d'
delta = json.loads(zlib.decompress(base64.b64decode(raw, validate=True)))
for name, changes in delta['edits'].items():
    path = Path(name)
    assert path.parts[0] == 'tests' and '..' not in path.parts and not path.is_absolute()
    lines = path.read_text().splitlines(keepends=True) if path.exists() else []
    last = len(lines)
    for start, end, text in reversed(changes):
        assert 0 <= start <= end <= last
        lines[start:end] = text.splitlines(keepends=True)
        last = start
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(lines))
subprocess.run(['git', 'add', '--', 'tests'], check=True)
actual = subprocess.check_output(['git', 'write-tree'], text=True).strip()
assert actual == delta['tree'], (actual, delta['tree'])
print('Verified exact previously tested tree:', actual)
