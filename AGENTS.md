# Instruções para agentes de IA neste repositório

Vale para Claude Code, Codex e qualquer outro agente.

- Leia `docs/ARQUITETURA.md` antes de começar: ele tem as fases e as regras de negócio.
- Toda mudança nasce de uma task. Cite o número da task (ex.: `T-12`) na mensagem de commit.
- Textos visíveis para o usuário são em português do Brasil. Nomes no código, em inglês.
- O servidor roda TypeScript direto no Node (sem build): imports relativos levam `.ts`, e não
  use sintaxe que o Node não consegue remover (enum, namespace, parameter properties).
- Banco: nunca edite uma migração existente em `server/src/db/migrations.ts`; acrescente uma nova.
- Toda mudança de estado de uma task gera um evento em `task_events` e é transmitida pelo
  `RealtimeHub`.
- Rode `npm run check` antes de dar a tarefa por concluída.
