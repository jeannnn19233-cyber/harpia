import type {
  CheckRunInfo,
  GitHubClient,
  GitHubRepo,
  IssueCommentInfo,
  OpenPullRequest,
  PullDetail,
  PullRequestInfo,
  PullReviewInfo,
  ReviewComment,
  ReviewCommentInfo,
  ReviewEvent
} from '../src/github/client.ts'

// GitHub em memória para os testes do revisor: guarda os PRs, as revisões e tudo o que foi publicado.
export class FakeGitHub implements GitHubClient {
  // Quem é o dono do token deste cliente (cada pessoa conecta o próprio GitHub).
  viewer: string
  readonly pulls = new Map<number, PullDetail>()
  readonly reviews = new Map<number, PullReviewInfo[]>()
  readonly reviewComments = new Map<number, ReviewCommentInfo[]>()
  readonly files = new Map<number, { filename: string; patch: string | null }[]>()
  readonly checks = new Map<string, CheckRunInfo[]>()
  readonly branches = new Map<string, string>()
  readonly comments = new Map<number, IssueCommentInfo[]>()
  readonly commits = new Map<string, { sha: string; message: string; date: string }>()
  readonly published: { by: string; number: number; commitId: string; event: ReviewEvent; body: string; comments: ReviewComment[] }[] = []
  readonly edits: { by: string; what: string; id: number; body: string }[] = []
  readonly requested: { by: string; number: number; logins: string[] }[] = []
  readonly drafts: { by: string; nodeId: string; draft: boolean }[] = []
  rejectInline = false
  private nextReview = 9000

  constructor(viewer = 'servidor') {
    this.viewer = viewer
  }

  // O mesmo "GitHub", visto com o token de outra pessoa.
  as(login: string): FakeGitHub {
    const view = Object.create(this) as FakeGitHub
    view.viewer = login
    return view
  }

  addPull(pull: Partial<PullDetail> & { number: number; authorLogin: string; headSha: string }): PullDetail {
    const full: PullDetail = {
      nodeId: `PR_${pull.number}`,
      title: `PR ${pull.number}`,
      url: `https://github.com/clarumi/loja/pull/${pull.number}`,
      body: '',
      draft: false,
      headRef: `branch-${pull.number}`,
      headRepo: 'clarumi/loja',
      baseRef: 'main',
      labels: [],
      requestedReviewers: [],
      updatedAt: '2026-01-01T00:00:00Z',
      state: 'open',
      mergeable: true,
      mergeableState: 'clean',
      ...pull
    }
    this.pulls.set(pull.number, full)
    return full
  }

  async getViewer() {
    return { login: this.viewer }
  }
  async listOpenPullRequests(_repo: GitHubRepo): Promise<OpenPullRequest[]> {
    return [...this.pulls.values()]
      .filter((pull) => pull.state === 'open')
      .map(({ mergeable: _m, mergeableState: _s, state: _state, ...pull }) => ({ ...pull }))
  }
  async getPull(_repo: GitHubRepo, number: number) {
    const pull = this.pulls.get(number)
    if (!pull) throw new Error(`GitHub respondeu 404: PR ${number}`)
    return { ...pull }
  }
  async listReviews(_repo: GitHubRepo, number: number) {
    return this.reviews.get(number) ?? []
  }
  async listReviewComments(_repo: GitHubRepo, _number: number, reviewId: number) {
    return this.reviewComments.get(reviewId) ?? []
  }
  async listPullFiles(_repo: GitHubRepo, number: number) {
    return this.files.get(number) ?? []
  }
  async listCheckRuns(_repo: GitHubRepo, sha: string) {
    return this.checks.get(sha) ?? []
  }
  async getBranchSha(_repo: GitHubRepo, branch: string) {
    return this.branches.get(branch) ?? 'main000'
  }
  async getCommit(_repo: GitHubRepo, ref: string) {
    const commit = this.commits.get(ref)
    if (!commit) throw new Error(`GitHub respondeu 404: commit ${ref}`)
    return commit
  }
  async listIssueComments(_repo: GitHubRepo, number: number) {
    return this.comments.get(number) ?? []
  }
  async createReview(_repo: GitHubRepo, number: number, input: { commitId: string; event: ReviewEvent; body: string; comments: ReviewComment[] }) {
    if (this.rejectInline && input.comments.length > 0) throw new Error('GitHub respondeu 422: Line could not be resolved')
    const id = this.nextReview++
    this.published.push({ by: this.viewer, number, ...input })
    const list = this.reviews.get(number) ?? []
    const state = input.event === 'APPROVE' ? 'APPROVED' : input.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED'
    list.push({ id, login: this.viewer, state, body: input.body, commitId: input.commitId, submittedAt: new Date().toISOString() })
    this.reviews.set(number, list)
    return { id, url: `https://github.com/clarumi/loja/pull/${number}#pullrequestreview-${id}` }
  }
  async updateReviewBody(_repo: GitHubRepo, _number: number, reviewId: number, body: string) {
    this.edits.push({ by: this.viewer, what: 'review', id: reviewId, body })
  }
  async updatePullBody(_repo: GitHubRepo, number: number, body: string) {
    this.edits.push({ by: this.viewer, what: 'pull', id: number, body })
    const pull = this.pulls.get(number)
    if (pull) pull.body = body
  }
  async updateIssueComment(_repo: GitHubRepo, commentId: number, body: string) {
    this.edits.push({ by: this.viewer, what: 'comment', id: commentId, body })
  }
  async requestReviewers(_repo: GitHubRepo, number: number, logins: string[]) {
    this.requested.push({ by: this.viewer, number, logins })
    const pull = this.pulls.get(number)
    if (pull) pull.requestedReviewers = [...new Set([...pull.requestedReviewers, ...logins])]
  }
  async setDraft(nodeId: string, draft: boolean) {
    this.drafts.push({ by: this.viewer, nodeId, draft })
    for (const pull of this.pulls.values()) if (pull.nodeId === nodeId) pull.draft = draft
  }
  async createPullRequest(_repo?: unknown, _input?: { title: string; body: string; head: string; base: string }): Promise<PullRequestInfo> {
    throw new Error('Este teste não configurou a criação de PRs.')
  }
  async findOpenPullRequest() {
    return null
  }
  async getPullRequest(_repo: GitHubRepo, number: number): Promise<PullRequestInfo> {
    return { number, url: `https://github.com/clarumi/loja/pull/${number}`, state: 'open', merged: false }
  }
}
