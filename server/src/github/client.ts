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

export interface GitHubClient {
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
  html_url: string
  state: 'open' | 'closed'
  merged?: boolean
  merged_at?: string | null
}

function toInfo(pr: ApiPullRequest): PullRequestInfo {
  return { number: pr.number, url: pr.html_url, state: pr.state, merged: pr.merged === true || Boolean(pr.merged_at) }
}

// Cliente da API REST do GitHub, autenticado com HARPIA_GITHUB_TOKEN.
export function createGitHubClient(options: { token: string | null; apiUrl?: string }): GitHubClient {
  const apiUrl = options.apiUrl ?? 'https://api.github.com'

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!options.token) {
      throw new Error('Configure HARPIA_GITHUB_TOKEN no servidor para o Harpia abrir pull requests (veja docs/COOLIFY.md).')
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

  return {
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
