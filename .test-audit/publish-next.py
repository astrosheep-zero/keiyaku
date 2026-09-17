"""Apply only the pinned test patch, checking both input and output Git trees."""
import json
from pathlib import Path
import subprocess
import sys


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


recipe = json.loads(Path(sys.argv[1]).read_text())
branch = 'test-diet/11-owned-watchdogs-and-scheduling'
assert git('rev-parse', 'HEAD^{tree}') == recipe['parent_tree']
for name, edits in recipe['changes'].items():
    path = Path(name)
    assert path.parts[0] == 'tests' and '..' not in path.parts
    old = path.read_text().splitlines(keepends=True)
    lines = old[:]
    for first, last, pieces in reversed(edits):
        assert 0 <= first <= last <= len(old)
        replacement = []
        for piece in pieces:
            if isinstance(piece, str):
                replacement.append(piece)
            else:
                start, end, indent = piece
                assert 0 <= start <= end <= len(old)
                replacement.append(''.join(' ' * indent + line if indent >= 0 else line[-indent:] for line in old[start:end]))
        lines[first:last] = ''.join(replacement).splitlines(keepends=True)
    path.write_text(''.join(lines))
subprocess.run(['git', 'add', '--', *recipe['changes']], check=True)
subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
assert git('write-tree') == recipe['tree'], 'patch differs from tested candidate'
existing = git('ls-remote', '--heads', 'origin', f'refs/heads/{branch}')
if existing:
    sha = existing.split()[0]
    subprocess.run(['git', 'fetch', 'origin', sha], check=True)
    assert git('rev-parse', sha + '^{tree}') == recipe['tree'], 'existing branch is different; refusing replacement'
else:
    subprocess.run(['git', 'commit', '-m', 'test: clear settled watchdogs and overlap isolated Git scenarios'], check=True)
    subprocess.run(['git', 'push', 'origin', f'HEAD:refs/heads/{branch}'], check=True)
print(json.dumps({'branch': branch, 'tree': recipe['tree']}))
