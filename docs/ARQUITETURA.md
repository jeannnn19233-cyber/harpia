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
| 3 | Na task, cada participante conversa com o próprio agente (Claude ou Codex) num chat, numa worktree própria; terminal embaixo do chat; a equipe acompanha tudo ao vivo | **pronta** |
| 5 | GitHub: abrir PR pelo Harpia; task vai para "Feito" sozinha quando o PR tem merge | próxima |
| 4 | Agente vigia: avisa task duplicada, gente mexendo nos mesmos arquivos, task parada há muito tempo, task pronta e ainda aberta | |
| 2 | Chat de IA com Claude e Codex usando o login de cada pessoa | |

## Onde roda

No Coolify, como container Docker (veja [COOLIFY.md](COOLIFY.md)), no mesmo servidor do
Clarumi. Os dados ficam no volume `/data`. Por isso:

- **Limites de recursos** no Coolify, para o Harpia não disputar CPU e memória com o Clarumi.
- **Agentes:** rodam dentro do container do Harpia. Cada pessoa tem um usuário Linux próprio
  (`h<id>`), com o login do Claude Code e do Codex guardado na pasta dela no volume `/data`. As
  sessões continuam rodando quando o navegador fecha, mas terminam a cada deploy. Antes de ligar
  os terminais, siga o checklist de [COOLIFY.md](COOLIFY.md#ligar-os-agentes-de-ia-fase-3).

## Como está organizado

```
server/   Node.js + TypeScript (roda direto, sem etapa de build)
  src/auth/       contas, sessões, convites
  src/projects/   projetos e clone dos repositórios
  src/tasks/      tasks, participantes e histórico (task_events)
  src/agents/     usuários Linux por pessoa, cópias de trabalho, sessões no tmux, terminal ao vivo
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

## Tela da task

Inspirada no Orca: a conversa com o agente é o centro do trabalho.

```
┌ ← Quadro · T-12 Tela de checkout ───────────────────────────────── Em andamento ┐
│ Conversas         │ Chat com o agente (centro)                │ Task             │
│  + Claude + Codex │   mensagens, comandos, edições,           │  status, dono    │
│  Minhas           │   pedidos de aprovação                    │  quem está       │
│  Da equipe        │   [caixa de mensagem]                     │  descrição       │
│                   ├───────────────────────────────────────────┤  histórico e     │
│                   │ Terminal (embaixo, no centro)             │  comentários     │
└───────────────────┴───────────────────────────────────────────┴──────────────────┘
```

## Regras de negócio da fase 3

- Cada pessoa abre conversas com o Claude ou o Codex na task. Só quem abriu envia mensagens e
  responde aos pedidos de aprovação; o resto da equipe acompanha ao vivo, em modo leitura.
- Modos de permissão por conversa: **Pedir aprovação** (padrão), **Aceitar edições** e
  **Autônomo**.
- O processo do agente só começa na primeira mensagem e fica rodando no servidor. Conversas
  paradas há mais de 20 minutos têm o processo desligado para poupar memória; a próxima
  mensagem retoma a mesma conversa (o Claude e o Codex guardam o histórico na pasta da pessoa).
- Se o servidor reinicia no meio de uma resposta, a conversa avisa e volta a esperar mensagem.
- O terminal embaixo do chat é de apoio: abre só quando a pessoa pede, na cópia dela, e não
  mexe no histórico da task. Os terminais dos colegas aparecem como abas só de leitura.

- Os terminais ficam desligados até o administrador definir `HARPIA_TERMINALS=on`.
- Cada pessoa trabalha numa cópia própria do repositório, na branch `harpia/T-<número>-<nome>-<id>`,
  criada a partir da branch principal. Duas pessoas na mesma task não se atropelam.
- Abrir um agente coloca a pessoa na task. Se a task estava no Backlog, ela vai para
  "Em andamento" e, sem responsável, quem abriu assume.
- Só quem abriu a sessão digita nela; o resto da equipe assiste em modo leitura. O terminal
  pessoal (usado para conectar as contas de IA) só a própria pessoa vê.
- Só quem abriu a sessão, ou um administrador, encerra. Fechar a tela não encerra o agente.
- Abrir, encerrar e o fim de cada sessão ficam no histórico da task.

### Como funciona por dentro

Chat:

```
navegador ──HTTP/WebSocket──▶ servidor (ChatManager) ──▶ adaptador do provedor
                                                           ├─ Claude: Claude Agent SDK, com o processo
                                                           │  iniciado como runuser -u h<id> claude …
                                                           └─ Codex: codex app-server (JSON-RPC por
                                                              linhas), como runuser -u h<id>
```

- Cada mensagem, texto do agente, comando, edição e aprovação vira um item da conversa
  (`chat_items`), salvo no banco e transmitido para quem está olhando.
- O Claude usa o mesmo caminho do Orca: o Agent SDK com uma função própria para iniciar o
  processo (`spawnClaudeCodeProcess`), o que permite rodar como o usuário da pessoa.
- O Codex fala o protocolo do `codex app-server` (o mesmo que os editores usam). O sandbox
  próprio do Codex não funciona dentro do container; o isolamento vem do usuário Linux.

Terminal:

```
navegador (xterm.js) ──WebSocket──▶ servidor ──node-pty──▶ runuser -u h<id> tmux attach
                                                              │
                         tmux (um servidor por pessoa) ◀───────┘
                            └── claude / codex / bash, na cópia de trabalho da pessoa
```

- O servidor guarda cada repositório como espelho (`git clone --mirror`) em `/data/repos`. Só o
  espelho fala com o GitHub, usando `HARPIA_GITHUB_TOKEN`. As cópias de cada pessoa são clonadas
  do espelho, então o token nunca chega aos agentes.
- Cada pessoa que assiste abre uma conexão própria ao tmux; quem só assiste entra com
  `read-only,ignore-size`, para não mudar o tamanho da tela de quem digita.
- A cada 15 segundos (e ao iniciar) o servidor confere quais sessões ainda existem e registra as
  que terminaram.

## Uso do Orca

O [Orca](https://github.com/stablyai/orca) (licença MIT) foi a referência de estudo. O Harpia
usa os mesmos caminhos do Orca para falar com os agentes (Claude Agent SDK e `codex app-server`)
e as mesmas bibliotecas de terminal (`node-pty`, `xterm.js`), mas com um desenho próprio e mais
simples (tmux no lugar do processo de terminais do Orca); nenhum código foi copiado. Para a
fase 4, os hooks do Claude Code e do Codex que o Orca usa para saber se um agente está
trabalhando, esperando ou parado (`src/main/agent-hooks`) são a próxima referência. Trechos
copiados do Orca devem manter o aviso de licença original em `THIRD_PARTY_NOTICES.md`.
