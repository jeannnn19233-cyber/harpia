export interface GitHubRepo {
  owner: string
  name: string
}

export interface PullRequestInfo {
  number: number
  url: string
  state: 'open' | 'closed'
  merged: boolean
}

// PR aberto, como a lista do GitHub mostra (usado pela revisão automática).
export interface OpenPullRequest {
  number: number
  nodeId: string
  title: string
  url: string
  body: string
  draft: boolean
  authorLogin: string
  headSha: string
  headRef: string
  // "dono/repo" de onde vem a branch; diferente do repositório do projeto = fork (sem push).
  headRepo: string | null
  baseRef: string
  labels: string[]
  requestedReviewers: string[]
  updatedAt: string
}

export interface PullDetail extends OpenPullRequest {
  state: 'open' | 'closed'
  // null enquanto o GitHub ainda calcula; "dirty" = em conflito com a base.
  mergeable: boolean | null
  mergeableState: string
}

export interface PullReviewInfo {
  id: number
  login: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  body: string
  commitId: string | null
  submittedAt: string | null
}

export interface ReviewCommentInfo {
  path: string
  line: number | null
  body: string
  diffHunk: string
}

export interface CheckRunInfo {
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface IssueCommentInfo {
  id: number
  login: string
  body: string
}

export interface ReviewComment {
  path: string
  line: number
  body: string
  side?: 'RIGHT' | 'LEFT'
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

export interface GitHubClient {
  // Dono do token (para conectar o GitHub de cada pessoa).
  getViewer(): Promise<{ login: string }>
  listOpenPullRequests(repo: GitHubRepo): Promise<OpenPullRequest[]>
  getPull(repo: GitHubRepo, number: number): Promise<PullDetail>
  listReviews(repo: GitHubRepo, number: number): Promise<PullReviewInfo[]>
  listReviewComments(repo: GitHubRepo, number: number, reviewId: number): Promise<ReviewCommentInfo[]>
  // Arquivos do PR com o patch de cada um (o que o GitHub aceita comentar).
  listPullFiles(repo: GitHubRepo, number: number): Promise<{ filename: string; patch: string | null }[]>
  listCheckRuns(repo: GitHubRepo, sha: string): Promise<CheckRunInfo[]>
  getBranchSha(repo: GitHubRepo, branch: string): Promise<string>
  listIssueComments(repo: GitHubRepo, number: number): Promise<IssueCommentInfo[]>
  createReview(
    repo: GitHubRepo,
    number: number,
    input: { commitId: string; event: ReviewEvent; body: string; comments: ReviewComment[] }
  ): Promise<{ id: number; url: string }>
  updateReviewBody(repo: GitHubRepo, number: number, reviewId: number, body: string): Promise<void>
  updatePullBody(repo: GitHubRepo, number: number, body: string): Promise<void>
  updateIssueComment(repo: GitHubRepo, commentId: number, body: string): Promise<void>
  requestReviewers(repo: GitHubRepo, number: number, logins: string[]): Promise<void>
  // Põe ou tira o PR de rascunho (só existe na API GraphQL).
  setDraft(nodeId: string, draft: boolean): Promise<void>
  createPullRequest(repo: GitHubRepo, input: { title: string; body: string; head: string; base: string }): Promise<PullRequestInfo>
  // PR aberto a partir de uma branch, se já existir.
  findOpenPullRequest(repo: GitHubRepo, head: string): Promise<PullRequestInfo | null>
  getPullRequest(repo: GitHubRepo, number: number): Promise<PullRequestInfo>
}

// Aceita https://github.com/dono/repo(.git), git@github.com:dono/repo.git e ssh://git@github.com/dono/repo.git.
export function parseGitHubRepo(url: string): GitHubRepo | null {
  const match =
    url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/) ??
    url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/) ??
    url.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  return match ? { owner: match[1], name: match[2] } : null
}

interface ApiPullRequest {
  number: number
  node_id?: string
  html_url: string
  state: 'open' | 'closed'
  merged?: boolean
  merged_at?: string | null
  title?: string
  body?: string | null
  draft?: boolean
  updated_at?: string
  user?: { login: string } | null
  head?: { sha: string; ref: string; repo?: { full_name: string } | null }
  base?: { ref: string }
  labels?: { name: string }[]
  requested_reviewers?: { login: string }[]
  mergeable?: boolean | null
  mergeable_state?: string
}

function toOpen(pr: ApiPullRequest): OpenPullRequest {
  return {
    number: pr.number,
    nodeId: pr.node_id ?? '',
    title: pr.title ?? '',
    url: pr.html_url,
    body: pr.body ?? '',
    draft: pr.draft === true,
    authorLogin: pr.user?.login ?? '',
    headSha: pr.head?.sha ?? '',
    headRef: pr.head?.ref ?? '',
    headRepo: pr.head?.repo?.full_name ?? null,
    baseRef: pr.base?.ref ?? '',
    labels: (pr.labels ?? []).map((label) => label.name),
    requestedReviewers: (pr.requested_reviewers ?? []).map((reviewer) => reviewer.login),
    updatedAt: pr.updated_at ?? ''
  }
}

function toInfo(pr: ApiPullRequest): PullRequestInfo {
  return { number: pr.number, url: pr.html_url, state: pr.state, merged: pr.merged === true || Boolean(pr.merged_at) }
}

// Cliente da API REST do GitHub, autenticado com HARPIA_GITHUB_TOKEN.
export function createGitHubClient(options: { token: string | null; apiUrl?: string }): GitHubClient {
  const apiUrl = options.apiUrl ?? 'https://api.github.com'

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!options.token) {
      throw new Error('Configure HARPIA_GITHUB_TOKEN no servidor para o Harpia falar com o GitHub (veja docs/COOLIFY.md).')
    }
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'harpia',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    const data = (await response.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] }
    if (!response.ok) {
      const detail = data.errors?.map((error) => error.message).filter(Boolean).join('; ')
      throw new Error(`GitHub respondeu ${response.status}: ${data.message ?? 'erro'}${detail ? ` (${detail})` : ''}`)
    }
    return data as T
  }

  const base = (repo: GitHubRepo) => `/repos/${repo.owner}/${repo.name}`

  return {
    async getViewer() {
      const viewer = await call<{ login: string }>('GET', '/user')
      return { login: viewer.login }
    },
    async listOpenPullRequests(repo) {
      const list = await call<ApiPullRequest[]>('GET', `${base(repo)}/pulls?state=open&per_page=100&sort=updated&direction=desc`)
      return list.map(toOpen)
    },
    async getPull(repo, number) {
      const pr = await call<ApiPullRequest>('GET', `${base(repo)}/pulls/${number}`)
      return { ...toOpen(pr), state: pr.state, mergeable: pr.mergeable ?? null, mergeableState: pr.mergeable_state ?? 'unknown' }
    },
    async listReviews(repo, number) {
      const list = await call<
        { id: number; user: { login: string } | null; state: PullReviewInfo['state']; body: string | null; commit_id: string | null; submitted_at: string | null }[]
      >('GET', `${base(repo)}/pulls/${number}/reviews?per_page=100`)
      return list.map((review) => ({
        id: review.id,
        login: review.user?.login ?? '',
        state: review.state,
        body: review.body ?? '',
        commitId: review.commit_id,
        submittedAt: review.submitted_at
      }))
    },
    async listReviewComments(repo, number, reviewId) {
      const list = await call<{ path: string; line: number | null; original_line?: number | null; body: string; diff_hunk: string }[]>(
        'GET',
        `${base(repo)}/pulls/${number}/reviews/${reviewId}/comments?per_page=100`
      )
      return list.map((comment) => ({ path: comment.path, line: comment.line ?? comment.original_line ?? null, body: comment.body, diffHunk: comment.diff_hunk }))
    },
    async listPullFiles(repo, number) {
      const files: { filename: string; patch: string | null }[] = []
      for (let page = 1; page <= 30; page++) {
        const list = await call<{ filename: string; patch?: string }[]>('GET', `${base(repo)}/pulls/${number}/files?per_page=100&page=${page}`)
        files.push(...list.map((file) => ({ filename: file.filename, patch: file.patch ?? null })))
        if (list.length < 100) break
      }
      return files
    },
    async listCheckRuns(repo, sha) {
      const result = await call<{ check_runs: { name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }[] }>(
        'GET',
        `${base(repo)}/commits/${sha}/check-runs?per_page=100`
      )
      return result.check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        startedAt: run.started_at,
        completedAt: run.completed_at
      }))
    },
    async getBranchSha(repo, branch) {
      const commit = await call<{ sha: string }>('GET', `${base(repo)}/commits/${encodeURIComponent(branch)}`)
      return commit.sha
    },
    async listIssueComments(repo, number) {
      const list = await call<{ id: number; user: { login: string } | null; body: string | null }[]>(
        'GET',
        `${base(repo)}/issues/${number}/comments?per_page=100`
      )
      return list.map((comment) => ({ id: comment.id, login: comment.user?.login ?? '', body: comment.body ?? '' }))
    },
    async createReview(repo, number, input) {
      const review = await call<{ id: number; html_url: string }>('POST', `${base(repo)}/pulls/${number}/reviews`, {
        commit_id: input.commitId,
        event: input.event,
        body: input.body,
        comments: input.comments.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side ?? 'RIGHT', body: comment.body }))
      })
      return { id: review.id, url: review.html_url }
    },
    async updateReviewBody(repo, number, reviewId, body) {
      await call('PUT', `${base(repo)}/pulls/${number}/reviews/${reviewId}`, { body })
    },
    async updatePullBody(repo, number, body) {
      await call('PATCH', `${base(repo)}/pulls/${number}`, { body })
    },
    async updateIssueComment(repo, commentId, body) {
      await call('PATCH', `${base(repo)}/issues/comments/${commentId}`, { body })
    },
    async requestReviewers(repo, number, logins) {
      await call('POST', `${base(repo)}/pulls/${number}/requested_reviewers`, { reviewers: logins })
    },
    async setDraft(nodeId, draft) {
      const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview'
      const result = await call<{ errors?: { message: string }[] }>('POST', '/graphql', {
        query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
        variables: { id: nodeId }
      })
      if (result.errors?.length) throw new Error(`GitHub: ${result.errors.map((error) => error.message).join('; ')}`)
    },
    async createPullRequest(repo, input) {
      return toInfo(await call<ApiPullRequest>('POST', `/repos/${repo.owner}/${repo.name}/pulls`, input))
    },
    async findOpenPullRequest(repo, head) {
      const list = await call<ApiPullRequest[]>(
        'GET',
        `/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}`
      )
      return list[0] ? toInfo(list[0]) : null
    },
    async getPullRequest(repo, number) {
      return toInfo(await call<ApiPullRequest>('GET', `/repos/${repo.owner}/${repo.name}/pulls/${number}`))
    }
  }
}
