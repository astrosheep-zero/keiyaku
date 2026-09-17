"""Reproduce pinned test changes; require exact Git trees before publishing new review branches."""
import json
from pathlib import Path
import subprocess
import sys


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


branches = {1: 'test-diet/04-unit-boundaries', 2: 'test-diet/05-akuma-lifecycle', 3: 'test-diet/06-git-cli-composition', 4: 'test-diet/07-owner-boundary-tests', 5: 'test-diet/08-native-runner-fixtures', 6: 'test-diet/09-smaller-integration-witnesses'}
allowed_scripts = {'scripts/compile-tests.mjs', 'scripts/run-tests.mjs', 'scripts/architecture/policy-capabilities.ts'}
for recipe_file in sorted(Path(sys.argv[1]).glob('batch-*.json')):
    recipe = json.loads(recipe_file.read_text())
    number = int(recipe_file.stem.split('-')[1])
    branch = branches[number]
    assert git('rev-parse', 'HEAD^{tree}') == recipe['parent_tree'], 'unexpected parent tree'
    for name, edits in recipe['changes'].items():
        path = Path(name)
        assert (path.parts[0] == 'tests' or name in allowed_scripts) and '..' not in path.parts, name
        old = path.read_text().splitlines(keepends=True) if path.exists() else []
        lines = old[:]
        for first, last, pieces in reversed(edits):
            assert 0 <= first <= last <= len(old), name
            replacement = []
            for piece in pieces:
                if isinstance(piece, str):
                    replacement.append(piece)
                else:
                    start, end, indent = piece
                    assert 0 <= start <= end <= len(old), name
                    replacement.append(''.join(' ' * indent + line if indent >= 0 else line[-indent:] for line in old[start:end]))
            lines[first:last] = ''.join(replacement).splitlines(keepends=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(lines))
    subprocess.run(['git', 'add', '--', *recipe['changes']], check=True)
    subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
    tree = git('write-tree')
    assert tree == recipe['tree'], f'candidate differs from validated patch: {tree}'
    existing = git('ls-remote', '--heads', 'origin', f'refs/heads/{branch}')
    if existing:
        remote_sha = existing.split()[0]
        subprocess.run(['git', 'fetch', 'origin', remote_sha], check=True)
        assert git('rev-parse', remote_sha + '^{tree}') == tree, 'refusing to replace an existing branch'
        subprocess.run(['git', 'reset', '--hard', remote_sha], check=True)
    else:
        subprocess.run(['git', 'commit', '-m', f'test: focus test-diet candidate batch {number + 3}'], check=True)
        subprocess.run(['git', 'push', 'origin', f'HEAD:refs/heads/{branch}'], check=True)
    print(json.dumps({'branch': branch, 'sha': git('rev-parse', 'HEAD'), 'tree': tree}), flush=True)
