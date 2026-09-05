from pathlib import Path
import re

for name in ['SOUL.md', 'docs/model.md', 'docs/verification.md', 'docs/git.md', 'docs/git-reconciliation.md', 'docs/workspace.md', 'docs/settlement.md', 'docs/cli.md', 'docs/cli-output.md', 'docs/akuma-requests.md']:
    print('\n=== OWNER ' + name + ' ===\n' + Path(name).read_text())
print('\n=== NESTED REPOSITORY GUIDES ===')
for p in Path('.').rglob('AGENTS.md'):
    if 'node_modules' not in p.parts and '.git' not in p.parts:
        print(str(p))
        if str(p) != 'AGENTS.md': print(p.read_text())
print('\n=== RESULT AND EXECUTION CALL SITES ===')
pattern = re.compile(r'completeMutation\(|completionInput\(|completeHolderMutation\(|projectMutationFinality\(|\.cleanup\b|\.leak\b|\.seatClose\b|deliverOperation\(|reviewOperation\(|completeCandidate\(|continueDeliveryOperation\(')
for folder in ['src/library', 'src/protocol', 'src/cli', 'tests']:
    for p in sorted(Path(folder).rglob('*.ts')):
        for i, line in enumerate(p.read_text().splitlines(), 1):
            if pattern.search(line): print(f'{p}:{i}: {line}')
print('\n=== CAPABILITY RULES ===\n' + Path('scripts/architecture/policy-capabilities.ts').read_text())
