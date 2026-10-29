# Estudo: Hermes Agent

O [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research, licença MIT) é um
agente que **lembra, aprende e age sozinho**: memória entre sessões, skills criadas a partir do
próprio trabalho, tarefas agendadas e acesso por Telegram, WhatsApp e outros. Foi estudado lendo o
código-fonte (commit `eaf03cb`, outubro de 2026), como fizemos com o Orca.

Do Orca o Harpia herdou a forma de trabalhar (chat com Claude e Codex, worktrees, terminal). Do
Hermes vêm as ideias para a parte que acompanha a equipe sozinha. **Nenhum código do Hermes foi
copiado**; se algum trecho for, registre o aviso MIT em `THIRD_PARTY_NOTICES.md`.

## O que vale trazer

| Ideia do Hermes | Onde está no Hermes | Como fica no Harpia |
|---|---|---|
| Regras fixas primeiro, IA só quando há novidade ("script antes do job", modo monitor por hash, resposta `[SILENT]`) | `cron/scheduler_prompt.py`, `cron/monitor.py` | **Vigia (fase 4):** task parada, task pronta e aberta e arquivos repetidos entre worktrees são detectados com SQL e git; a IA só entra para julgar possíveis tasks duplicadas. Cada aviso tem uma impressão digital para não se repetir. |
| Assinaturas de aviso com cursor por pessoa | `hermes_cli/kanban_db.py` (`kanban_notify_subs`) | Cada pessoa recebe só os avisos novos, na tela e no Telegram. |
| Detecção de task parada | `hermes_cli/kanban_db_dispatch.py` (`detect_stale_running`) | Sem eventos nem mensagens de agente há X horas. |
| Memória curta, com limite, injetada como "retrato" no início da conversa | `tools/memory_tool_store.py` | Memória por projeto (2–4 mil caracteres) entra no prompt do Claude e do Codex ao abrir uma conversa. |
| Busca no histórico com FTS5 (sem embeddings) | `hermes_state_fts.py`, `tools/session_search_tool.py` | Resumo de cada task concluída, pesquisável: "alguém já fez algo parecido?". O `node:sqlite` já tem FTS5. |
| Revisão de aprendizado no fim do trabalho, com regras do que **não** guardar | `agent/background_review.py` | Ao concluir a task, a IA **sugere** um ajuste no `AGENTS.md` ou uma skill; um sócio aprova e vira PR. |
| Gateway de mensagens com pareamento por código | `gateway/session.py`, `gateway/pairing.py` | Avisos no **Telegram** para os sócios, com vínculo por código. WhatsApp só pela API oficial. |
| Disciplina de agendamento ("no máximo uma vez", tempo limite, pausa quando a cota acaba) | `cron/scheduler.py`, `cron/quota_hold.py` | Resumo diário e varreduras do vigia. |

## O que não trazer

- O loop de agente, os provedores e a delegação do Hermes: Claude Code e Codex já fazem isso.
- Biblioteca de skills com curador automático: para 3–5 pessoas, revisão humana no PR basta.
- Embeddings e provedores externos de memória: FTS5 resolve neste tamanho.
- Os 20 gateways de mensagem: só o Telegram interessa agora.
- Memória que o agente escreve sozinho a cada turno: com várias pessoas na mesma task, isso
  contamina a memória (o próprio Hermes recomenda um agente por memória).

## Ponto em aberto (resolvido)

As partes com IA do vigia (fase 4b) vão rodar no Claude Code de cada pessoa envolvida, nunca
numa conta central (decisão dos sócios).

## Cron, cofre e revisão de PR (fase 6)

O Hermes não tem uma função pronta de "cofre" nem de "revisor de PR": as duas são montadas com
três peças genéricas, que o Harpia reproduziu:

- **Cron** (`cron/scheduler_tick.py`, `cron/scheduler_prompt.py`, `cron/executions.py`): o
  próximo horário é avançado antes de rodar ("no máximo uma vez"); horário perdido roda uma vez
  dentro de uma tolerância; cada execução é uma sessão nova; `[SILENT]` não entrega; falhas
  avisam uma vez por motivo; cota esgotada estaciona o job. No Harpia: `server/src/routines/`.
- **Cofre**: uma pasta do Obsidian que o agente lê e escreve com as ferramentas de arquivo,
  seguindo as skills `note-taking/obsidian` e `research/llm-wiki` (SCHEMA/index/log, `raw/`
  imutável com sha256, wikilinks, regras para criar páginas, contradições registradas). A
  conversa do Telegram é o próprio agente. No Harpia: `server/src/vault/`, com a captura do
  original feita antes da IA (o Hermes não guarda o original sozinho).
- **Revisão de PR** (guias `github-pr-review-agent.md` e `webhook-github-pr-review.md`, skills
  `code-review` e `requesting-code-review`): checklist de correção, segurança, desempenho e
  testes; "não invente problemas"; diff marcado como dado não confiável; saída estruturada com
  falha fechada. O Hermes não guarda qual commit já revisou (usa janela de tempo); o Harpia
  revisa cada head SHA uma vez, no Claude do autor, e nunca aprova. No Harpia:
  `server/src/reviews/`.
