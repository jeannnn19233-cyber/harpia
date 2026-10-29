# Arquitetura e plano do Harpia

## O que é

Um workspace para a equipe trabalhar junta em tasks, cada pessoa com o próprio agente de IA
(Claude Code, Codex), rodando 24h numa VPS. Duas partes:

1. **Workspace de tasks** (centro do produto): várias pessoas na mesma task, sessões dos agentes
   ao vivo para todos, histórico completo e um agente vigia acompanhando o andamento.
2. **Chat de IA**: conversas comuns com o modelo que cada um preferir, usando o login de cada
   pessoa no Claude Code e no Codex (sem chave de API).

## Fases

Ordem aprovada: 1 → 3 → 5 → 4 → 2.

| Fase | Entrega | Situação |
|---|---|---|
| 1 | Login, convites, projetos (clone do repositório), quadro de tasks em tempo real, histórico e comentários, serviço 24h | **pronta** |
| 3 | Na task, cada participante abre o próprio agente (Claude Code ou Codex) numa worktree própria; terminais ao vivo para a equipe; sessões persistentes (tmux) | próxima |
| 5 | GitHub: abrir PR pelo Harpia; task vai para "Feito" sozinha quando o PR tem merge | |
| 4 | Agente vigia: avisa task duplicada, gente mexendo nos mesmos arquivos, task parada há muito tempo, task pronta e ainda aberta | |
| 2 | Chat de IA com Claude e Codex usando o login de cada pessoa | |

## Onde roda

No Coolify, como container Docker (veja [COOLIFY.md](COOLIFY.md)), no mesmo servidor do
Clarumi. Os dados ficam no volume `/data`. Por isso:

- **Limites de recursos** no Coolify, para o Harpia não disputar CPU e memória com o Clarumi.
- **Fase 3:** os agentes rodam dentro do container do Harpia. Cada pessoa terá um usuário Linux
  próprio dentro do container, com o login do Claude Code e do Codex guardado na pasta dela no
  volume `/data`. As sessões continuam rodando quando o navegador fecha, mas reiniciam a cada
  deploy. Antes de ligar os terminais, o acesso ao domínio será restrito e o Harpia ficará numa
  rede Docker separada da do Clarumi.

## Como está organizado

```
server/   Node.js + TypeScript (roda direto, sem etapa de build)
  src/auth/       contas, sessões, convites
  src/projects/   projetos e clone dos repositórios
  src/tasks/      tasks, participantes e histórico (task_events)
  src/realtime/   WebSocket: presença online e mudanças ao vivo
  src/db/         SQLite embutido no Node (node:sqlite) e migrações
web/      React + Vite + Tailwind + zustand
shared/   tipos usados pelo servidor e pela interface
deploy/   serviço systemd e exemplo de configuração (instalação sem Coolify)
Dockerfile  imagem usada pelo Coolify
```

Escolhas principais:

- **SQLite embutido no Node**: nenhuma dependência nativa para compilar na VPS; um arquivo só
  para fazer backup.
- **Tudo vira evento** (`task_events`): criação, mudança de status, responsável, quem entrou
  ou saiu, comentários. É a base do histórico e será a matéria-prima do agente vigia.
- **Tempo real por WebSocket**: o servidor transmite cada mudança para todos; a interface só
  escuta e, ao reconectar, recarrega o estado.
- **Segurança**: senhas com scrypt; sessões e convites guardados só como hash; cookie
  HttpOnly; bloqueio de requisições de outros sites (CSRF); limite de tentativas de login;
  criação do administrador protegida por código (`HARPIA_SETUP_CODE`).

## Regras de negócio da fase 1

- Tasks são numeradas por projeto (T-1, T-2…).
- Quem move uma task sem responsável para "Em andamento" vira o responsável.
- O responsável sempre participa da task e não pode sair sem passar a responsabilidade.
- Ir para "Feito" registra a data de conclusão; reabrir limpa. Na fase 5, "Feito" passa a
  depender do merge do PR.

## Uso do Orca

O [Orca](https://github.com/stablyai/orca) (licença MIT) é a referência para as partes difíceis
das próximas fases: terminais persistentes com `node-pty` e tmux, detecção do estado dos agentes
pelos hooks do Claude Code e do Codex (`src/main/agent-hooks`), e gestão de contas. Trechos
copiados do Orca devem manter o aviso de licença original em `THIRD_PARTY_NOTICES.md`.
