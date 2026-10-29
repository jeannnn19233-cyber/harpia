import { getGitHubAccount } from '../auth/github-accounts.ts'
import { listUsers } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import type { GitHubClient } from './client.ts'

// Leitura no GitHub: com o token do servidor, se houver; senão com o de alguém da equipe que
// conectou o próprio GitHub (cada sócio tem o dele). Só para ler.
export async function withGitHubReader<T>(ctx: AppContext, action: (client: GitHubClient) => Promise<T>): Promise<T> {
  try {
    return await action(ctx.github)
  } catch (error) {
    for (const user of listUsers(ctx.db).filter((person) => person.githubConnected)) {
      const account = getGitHubAccount(ctx.db, ctx.secrets, user.id)
      if (!account) continue
      try {
        return await action(ctx.githubFor(account.token))
      } catch {
        // Este token não lê o repositório: tenta o de outra pessoa.
      }
    }
    throw error
  }
}
