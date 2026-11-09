const { GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_TOKEN } = process.env;
if (GITHUB_EVENT_NAME !== 'push' || GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Production deployments require a push to main from a merged pull request');
}
let found = false;
for (let page = 1; page <= 10; page++) {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/pulls?per_page=100&page=${page}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`Cannot verify merged pull request: HTTP ${response.status}`);
  const pulls = await response.json();
  found = pulls.some(pr => pr.merged_at && pr.merge_commit_sha === GITHUB_SHA && pr.base.ref === 'main' && pr.base.repo.full_name === GITHUB_REPOSITORY);
  if (found || pulls.length < 100) break;
}
if (!found) throw new Error('Commit is not the merge result of a pull request to main. Deployment refused.');
console.log('Verified a merged pull request for this deployment commit.');
