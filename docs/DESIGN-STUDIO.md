# Harpia — ambiente de trabalho com agentes

Task: T-DESIGN-02. Base do repositório: `4ef4ba859babdb3d0ea9ca6511b3971c385287c4`.

## Referências lidas e vistas

A arquitetura atual define a conversa como centro do trabalho. A interface do Orca orienta o uso de sessões, branches, terminais e acompanhamento da equipe. O estudo do Hermes orienta o Vigia e a memória do projeto; não significa adotar o loop de agentes ou os provedores do Hermes.

As seis capturas do próprio repositório foram abertas e inspecionadas: quadro, task, chat com aprovação, conversa da equipe, abertura de PR e Vigia.

## Organização da interface

A navegação foi reconstruída como um ambiente de operação contínua:

1. Barra superior compacta com projeto, conexão e busca rápida.
2. Barra de ferramentas estreita para explorador, quadro, Vigia, memória, contas e equipe.
3. Explorador com tarefas agrupadas por estado e sessões ativas. A largura é ajustável.
4. Abas das tarefas abertas. O workspace retoma a tarefa anterior do projeto; no primeiro acesso, prioriza a tarefa pessoal em andamento.
5. Sessões de Claude e Codex em abas dentro da tarefa, com identificação da pessoa e estado do agente.
6. Chat no centro e terminal abaixo. A equipe acompanha as sessões de outras pessoas em modo de leitura.
7. Inspector lateral alternando contexto e arquivos alterados. Sua largura é ajustável; ele pode ser recolhido.
8. Barra de estado com conexão, branch, agentes em execução e avisos do Vigia.

O quadro continua disponível como visão complementar. Não há editor de arquivos inventado: a aba Alterações usa o endpoint existente para listar arquivos, adições, remoções e situação do commit. A publicação continua na seção Entrega da tarefa.

## Aparência

Superfícies escuras em verde profundo e carvão, divisórias discretas, alturas compactas, tipografia de interface e monoespaçada nos identificadores. Verde claro indica seleção e ações; âmbar destaca aprovação; cores dos provedores ajudam a reconhecer a sessão. A referência amazônica aparece na paleta e no pequeno ícone ilustrado, ainda provisório.

A entrada usa uma composição compacta de conexão ao workspace. O projeto permanece na arquitetura React/Node existente: esta entrega reformula a experiência do software, sem acrescentar empacotamento nativo ou trocar a infraestrutura.

## Recursos preservados

- Sessões pessoais e acompanhamento da equipe em tempo real.
- Modos de permissão e decisões exclusivas da pessoa que abriu a conversa.
- Mensagens durante o trabalho do agente e sugestões do Claude.
- Terminal por pessoa e branch isolada.
- Arquivos alterados, PR e histórico de entrega.
- Vigia, memória e configuração dos avisos do Telegram.
- Busca de tarefas parecidas na criação.

Os botões exibidos são ligados a recursos existentes. Atalhos: Ctrl/Command + K para busca; Tab e Escape nos diálogos; setas nos divisores para ajustar os painéis. Preferências de largura, tarefa e conversa são locais.

## Validação

- `npm run check`: tipos, 87 testes do servidor em 9 arquivos e build de produção passaram.
- 17 verificações de integração da interface com DOM simulado e a API local do servidor de testes. Incluem retomada de tarefa, sessões, restrição de leitura, aprovação, sugestão, arquivos alterados, memória, Vigia, fechamento de diálogo, ajuste do inspector e busca rápida. O componente gráfico do terminal foi substituído nesse teste de DOM; sua renderização não é coberta por essas 17 verificações.
- A conexão de inspeção com o navegador estava indisponível nesta etapa. Portanto a conferência visual final, o arraste com ponteiro e o comportamento em navegadores reais permanecem pendentes de revisão na prévia.
- O build mantém o aviso de tamanho do bundle que já existia no projeto.

## Prévia

A sessão local usa dados e agentes simulados do servidor de testes do próprio repositório. Ela não conecta assinaturas reais e não envia PRs ou notificações reais.

```sh
npm ci
npm run check
PORT=7422 node --disable-warning=ExperimentalWarning server/test/e2e-server.ts /tmp/harpia-studio-preview
```

Endereço da sessão: http://127.0.0.1:7422. Credenciais exclusivas dessa demonstração: `jean@studio.example` / `harpia-studio-demo`.

## Integração com a `main` (29/10)

O redesign foi feito sobre `4ef4ba8`, antes das fases 4b, 6 e do revisor v2. Na integração:

- A barra de ferramentas ganhou Conversas e Rotinas (as duas visões fora das tarefas), Revisão
  de PRs e Vigias do deploy (com ponto verde quando ligados e vermelho quando um vigia acusa
  problema) e, embaixo, Meu agente. O selo do Vigia soma os avisos e os aprendizados esperando
  aprovação.
- Escolher uma tarefa no explorador, numa aba ou na busca volta para a área de trabalho.
- O chat mantém a escolha do modelo; o contexto da tarefa mantém o resumo, os aprendizados e o
  histórico das revisões de PR.
- O ícone foi reduzido para 128 px (ele aparece no máximo com 28 px).
- Revisão em navegador real (Chromium, 1440×900 e 390×844): cadastro, projeto, tarefa nova,
  sessão do Claude com aprovação e sugestão, Alterações, Vigia, Memória, Revisões, Deploy, Meu
  agente, Minhas IAs, Equipe, Conversas, Rotinas, abas e Ctrl+K, sem erro no console. O arraste
  dos divisores com o ponteiro e o terminal gráfico seguem sem verificação automática.
