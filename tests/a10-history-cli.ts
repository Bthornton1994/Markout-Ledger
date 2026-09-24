// A10 history scan (docs/M2_DATA_CONTRACT.md section 6.5): runs the repository rule of tests/jsonl-policy.ts over every
// commit of a range, so a disallowed file that was added and deleted again inside the range is still found.
//
//   tsx tests/a10-history-cli.ts --base <sha> --head <sha>   CI: a pull request's range, or a push to main; an empty
//                                                           or all-zero base, or one that is not in this clone (the
//                                                           before of a force-push), scans every commit reachable
//                                                           from head (CI is triggered by nothing else, contract
//                                                           section 6.5)
//   tsx tests/a10-history-cli.ts --revs <rev-list args...>   the opt-in pre-push hook (.githooks/pre-push)
//   tsx tests/a10-history-cli.ts --tag <sha>                 the hook, for each annotated tag it pushes: the content
//                                                           check of the tag's message (and of any tag it points to)
//
// Exit status: 0 when no commit in the range carries a disallowed file, 1 when one does, 2 when the range cannot be
// scanned (missing arguments, a git failure, or a policy module that cannot load), so a scan that cannot run fails
// closed. It detects; run after a push, it cannot un-publish what the push already sent.
import { execFileSync } from 'node:child_process';

/** Whether `sha` names a commit in this clone. */
const hasCommit = (sha: string): boolean => {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

function revArgs(argv: string[]): string[] | undefined {
  if (argv[0] === '--revs') return argv.length > 1 ? argv.slice(1) : undefined;
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const head = value('--head');
  if (head === undefined || head.length === 0 || /^0+$/.test(head)) return undefined;
  const base = value('--base') ?? '';
  if (base.length === 0 || /^0+$/.test(base)) return [head];
  if (!hasCommit(base)) {
    console.log(`A10 history: base ${base} is not in this clone (a force-push, for example); scanning every commit reachable from ${head}`);
    return [head];
  }
  return [`${base}..${head}`];
}

async function tagMain(sha: string | undefined): Promise<number> {
  if (sha === undefined || sha.length === 0) {
    console.error('A10 tag: give --tag <sha>; nothing was scanned');
    return 2;
  }
  try {
    const { tagMessageViolations } = await import('./jsonl-policy.js');
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const violations = tagMessageViolations(root, sha);
    for (const v of violations) console.error(`A10 tag: ${v.commit} ${v.path}: ${v.reason}`);
    return violations.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(`A10 tag: the tag could not be scanned: ${(e as Error).message}`);
    return 2;
  }
}

async function main(): Promise<number> {
  if (process.argv[2] === '--tag') return tagMain(process.argv[3]);
  const args = revArgs(process.argv.slice(2));
  if (args === undefined) {
    console.error('A10 history: give --base <sha> --head <sha>, or --revs <rev-list arguments>; nothing was scanned');
    return 2;
  }
  try {
    // Loaded here, not at the top, so that a rule that cannot load (a broken schema) is a scan that could not run (2).
    const { historyViolations } = await import('./jsonl-policy.js');
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const scan = historyViolations(root, args);
    for (const v of scan.violations) console.error(`A10 history: ${v.commit} ${JSON.stringify(v.path)}: ${v.reason}`);
    console.log(`A10 history: ${scan.commits} commits (${args.join(' ')}), ${scan.blobsChecked} covered files and ${scan.otherBlobsChecked} other files checked, commit messages included, ${scan.violations.length} violations`);
    return scan.violations.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(`A10 history: the range could not be scanned: ${(e as Error).message}`);
    return 2;
  }
}

// exitCode rather than exit(), so that output written to a pipe is flushed before the process ends.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`A10 history: the range could not be scanned: ${(e as Error).message}`);
    process.exitCode = 2;
  },
);
