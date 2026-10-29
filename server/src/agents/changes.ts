import type { ChangedFile } from '../../../shared/types.ts'

// Junta a saída de "git diff --name-status", "git diff --numstat" e dos arquivos não
// versionados numa lista só.
export function parseChangedFiles(input: { nameStatus: string; numstat: string; untracked: string }): ChangedFile[] {
  const counts = new Map<string, { additions: number | null; deletions: number | null }>()
  for (const line of input.numstat.split('\n').filter(Boolean)) {
    const [added, deleted, ...rest] = line.split('\t')
    // Arquivos binários aparecem com "-".
    counts.set(rest.join('\t'), {
      additions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted)
    })
  }
  const files: ChangedFile[] = []
  for (const line of input.nameStatus.split('\n').filter(Boolean)) {
    const [code, ...rest] = line.split('\t')
    const path = rest.join('\t')
    const status = code.startsWith('A') ? 'A' : code.startsWith('D') ? 'D' : 'M'
    files.push({ path, status, ...(counts.get(path) ?? { additions: null, deletions: null }) })
  }
  for (const path of input.untracked.split('\n').filter(Boolean)) {
    files.push({ path, status: '?', additions: null, deletions: null })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
