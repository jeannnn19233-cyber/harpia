# Instalando o Harpia no Coolify

O Harpia vem com um `Dockerfile` pronto. No Coolify ele roda como qualquer outra aplicação:
o Coolify monta a imagem, cuida do HTTPS e reinicia o container se ele cair.

## 1. Criar a aplicação

1. No Coolify: **+ New** → **Application**.
2. Escolha o repositório `jeannnn19233-cyber/harpia` (pelo GitHub App do Coolify, ou como
   repositório privado com deploy key), branch `main`.
3. **Build Pack:** `Dockerfile`.
4. **Ports Exposes:** `7420`.
5. **Domains:** o endereço do Harpia, por exemplo `https://harpia.seudominio.com.br`.

## 2. Volume persistente (obrigatório)

Em **Persistent Storage** → **+ Add** → **Volume**:

- **Name:** `harpia-data`
- **Destination Path:** `/data`

Sem esse volume, cada deploy apagaria contas, tasks e repositórios clonados.

## 3. Variáveis de ambiente

Em **Environment Variables**:

| Variável | Valor | Para quê |
|---|---|---|
| `HARPIA_SETUP_CODE` | um código longo e aleatório | Só quem tem o código cria a primeira conta (o administrador). **Defina antes do primeiro deploy.** |
| `HARPIA_COOKIE_SECURE` | `true` | O Coolify serve o Harpia por HTTPS. |
| `HARPIA_ALLOWED_ORIGINS` | `https://harpia.seudominio.com.br` | O mesmo domínio do passo 1, sem barra no fim. |
| `HARPIA_GITHUB_TOKEN` | token do GitHub (marque como secreto) | Para clonar repositórios privados, abrir os PRs das tasks e ler os PRs. As revisões usam o token de cada pessoa (veja abaixo). |
| `HARPIA_TERMINALS` | `on` | Liga os terminais com agentes de IA (fase 3). **Só ligue depois do checklist da seção "Ligar os agentes de IA".** |
| `HARPIA_MAX_SESSIONS_PER_USER` | `5` (padrão) | Quantos agentes cada pessoa pode ter abertos ao mesmo tempo. |
| `HARPIA_TELEGRAM_BOT_TOKEN` | token do bot (marque como secreto) | Avisos no Telegram. Crie o bot com o [@BotFather](https://t.me/BotFather). |
| `HARPIA_STALE_HOURS` | `48` (padrão) | Depois de quantas horas sem atividade o vigia avisa que a task está parada. |
| `HARPIA_REVIEW_HOURS` | `24` (padrão) | Depois de quantas horas em Revisão sem PR o vigia pergunta se dá para concluir. |
| `HARPIA_REVIEW_POLL_SECONDS` | `180` (padrão) | De quanto em quanto tempo o Harpia olha os PRs abertos para a revisão automática. |
| `HARPIA_REVIEW_SETTLE_SECONDS` | `180` (padrão) | Quanto tempo um PR precisa ficar sem commits novos antes de ser revisado. |
| `HARPIA_MAX_CONCURRENT_RUNS` | `3` (padrão) | Quantas rotinas podem rodar ao mesmo tempo no servidor. |
| `HARPIA_COOLIFY_URL` | `https://coolify.seudominio.com.br` | Vigias do deploy: endereço do painel do Coolify. |
| `HARPIA_COOLIFY_TOKEN` | token **só de leitura** do Coolify (marque como secreto) | Vigias do deploy. Veja "Vigias do deploy" abaixo. |
| `HARPIA_MONITOR_POLL_SECONDS` | `300` (padrão) | De quanto em quanto tempo os vigias olham o Coolify. |
| `HARPIA_AI_INSIGHTS` | ligado (padrão) | `off` desliga o vigia com IA: tasks parecidas confirmadas, resumos, aprendizados e sugestões no Codex. |

Para gerar o código de configuração: `openssl rand -base64 24`.

O token do servidor pode ser um *fine-grained token* com acesso só aos repositórios da equipe e
as permissões **Contents: Read and write** (para enviar as branches das tasks) e **Pull
requests: Read and write** (para abrir os PRs e saber quando tiveram merge).

### Token do GitHub de cada pessoa (revisor de PRs)

O revisor publica, corrige e aprova **em nome de quem revisa**, então cada pessoa conecta o
próprio token em "Minhas IAs" (nunca pelo Coolify). Recomendado: *fine-grained token* da própria
conta, só para os repositórios da equipe, com:

- **Contents: Read and write** — enviar as correções para a branch do PR;
- **Pull requests: Read and write** — publicar revisões, marcar revisor, rascunho, editar o corpo;
- **Issues: Read and write** — limpar assinatura de ferramenta nos comentários do PR;
- **Checks: Read** — ver o CI.

O token fica cifrado no volume (`/data/server/secret.key` guarda a chave; ela entra no backup
junto com o banco). Se a chave se perder, cada pessoa conecta o token de novo.

## 4. Limites de recursos

O mesmo servidor roda o Clarumi. Para o Harpia nunca disputar recursos com ele, em
**Resource Limits** defina limites. Sem os terminais ligados, 1 CPU e 1 GB de memória bastam.
Com os agentes de IA ligados, conte cerca de 1 GB de memória por agente aberto ao mesmo tempo
(por exemplo, 4 CPUs e 6 GB para 3 pessoas com 2 agentes cada).

O revisor de PRs roda as suítes do projeto dentro do container. A integração do Clarumi sobe um
Postgres por suíte e usa até 1 GB por processo do Jest: conte mais **3 GB e 2 CPUs** por revisor
rodando a integração ao mesmo tempo (o Harpia roda no máximo `HARPIA_MAX_CONCURRENT_RUNS`
execuções juntas).

## 5. Deploy e primeiro acesso

1. Clique em **Deploy**. O Coolify usa o `HEALTHCHECK` do Dockerfile (`/api/health`) para saber
   quando o Harpia está pronto.
2. Abra o domínio. A primeira tela pede o código de configuração e cria a conta de administrador.
3. Em **Equipe**, gere um link de convite para cada colega.

## Atualizar

Cada push no `main` pode disparar um deploy automático (opção **Auto Deploy** do Coolify), ou
clique em **Redeploy**. Os dados ficam no volume `/data` e sobrevivem ao deploy.

## Backup

O banco é o arquivo `/data/server/harpia.db`. Uma cópia consistente com o Harpia ligado, pelo
terminal do container no Coolify:

```bash
node --disable-warning=ExperimentalWarning -e "require('node:sqlite'); new (require('node:sqlite').DatabaseSync)('/data/server/harpia.db').exec(\"VACUUM INTO '/data/backup.db'\")"
```

Depois copie `/data/backup.db` para fora do servidor (ou ative os backups de volume do Coolify).

Copie também `/data/server/secret.key`: é a chave que abre os tokens do GitHub que cada pessoa
conectou. Sem ela, o banco restaurado funciona, mas cada pessoa precisa conectar o token de novo.

## Ligar os agentes de IA (fase 3)

Com `HARPIA_TERMINALS=on`, cada pessoa conversa com o próprio Claude ou Codex dentro das tasks
(e tem um terminal embaixo do chat).
Isso significa que **quem entra no Harpia consegue rodar comandos no servidor**. Antes de ligar:

1. **Rede separada do Clarumi.** No Coolify, crie um *Destination* novo (Servers → seu servidor →
   Destinations → uma rede Docker própria, por exemplo `harpia`) e faça o deploy do Harpia nele.
   Para conferir, abra um terminal no Harpia e tente alcançar o banco do Clarumi pelo nome do
   container dele (`getent hosts <nome-do-container>`). Não pode responder.
2. **Acesso só para a equipe.** O login do Harpia já protege, mas uma senha vazada passaria a dar
   acesso a um terminal. Coloque uma segunda barreira na frente do domínio: Cloudflare Access
   (login pelo e-mail da equipe), Tailscale (o domínio só abre na rede da equipe) ou uma lista de
   IPs no proxy do Coolify.
3. **Limites de recursos** da seção 4.
4. **Nada de segredos de produção no Harpia.** Não coloque chaves do Clarumi nas variáveis do
   Harpia, e nunca monte o socket do Docker (`/var/run/docker.sock`) nele.

Depois, adicione `HARPIA_TERMINALS=on` e faça um novo deploy. Cada pessoa abre **Minhas IAs**
e conecta a própria conta do Claude Code e do Codex.

### Como os agentes ficam isolados

- O container roda o servidor como root só para criar um usuário Linux por pessoa (`h1`, `h2`…).
  Os agentes nunca rodam como root: cada um roda com o usuário de quem o abriu.
- Cada pessoa tem uma pasta própria em `/data/homes`, que só ela acessa. O login do Claude Code
  e do Codex fica ali e sobrevive aos deploys.
- O banco do Harpia fica em `/data/server`, fora do alcance dos agentes. Nenhuma variável do
  servidor (token do GitHub, código de configuração) chega aos agentes.
- Quem assiste ao terminal de outra pessoa só lê; não consegue digitar.

### O que acontece num deploy

Os agentes rodam dentro do container. Um novo deploy (ou reinício) interrompe os agentes que
estavam trabalhando: a conversa avisa e, na próxima mensagem, continua de onde parou. As
conversas, cópias de trabalho, branches e logins continuam no volume.

### Vigias do deploy

Os vigias leem a API do Coolify, nunca o banco dele, e nunca usam SSH. Para ligar:

1. No Coolify, **Settings → Advanced**: ligue o acesso à API.
2. **Keys & Tokens → API tokens**: crie um token com a permissão **read** apenas (sem
   `read:sensitive`, `write`, `deploy` ou `root`). Assim o Harpia não consegue reiniciar, fazer
   deploy, nem ler variáveis de ambiente das aplicações.
3. No Harpia (Environment Variables): `HARPIA_COOLIFY_URL` com o endereço do painel e
   `HARPIA_COOLIFY_TOKEN` com o token (marque como secreto). Faça o deploy.
4. No quadro do projeto, botão **Deploy**: escolha a aplicação, as URLs de saúde e quem recebe
   os avisos, e ligue.

Sem `read:sensitive` o Coolify pode esconder o log dos deploys; nesse caso o aviso de deploy que
falhou diz "veja no Coolify" em vez de trazer as linhas de erro.

### Rotinas, revisões e o agente do Telegram (fase 6)

Usam o mesmo login do Claude Code de cada pessoa (em "Minhas IAs") e precisam de
`HARPIA_TERMINALS=on`. O agente do Telegram precisa de `HARPIA_TELEGRAM_BOT_TOKEN`. O Obsidian
Sync (`obsidian-headless`) já vem na imagem; cada pessoa conecta o dela em "Meu agente".

## Segurança

- Tudo exige login, convites valem uma vez só e a criação do administrador exige o código de
  configuração.
- Os terminais ficam desligados até `HARPIA_TERMINALS=on`. Veja o checklist acima antes de ligar.
- Rotinas, revisões e o agente do Telegram rodam sem ninguém aprovando, então nunca têm
  terminal: só as ferramentas de arquivo (presas a uma pasta, inclusive contra links simbólicos)
  e, quando liberada, a web.
- O revisor de PRs é a exceção: precisa do terminal para rodar tipos, lint e testes, como no
  Hermes. Roda como o usuário Linux da pessoa, numa cópia do PR sem nenhuma credencial do GitHub;
  `git push`, `gh`, chamadas à API do GitHub, rebase e leitura de `.env` e das pastas de
  credenciais são barrados. Quem envia os commits e publica é o servidor, depois do portão.
- O container do Harpia nunca recebe o `docker.sock` do servidor. Para a integração, a imagem
  traz o Postgres 16 (só os binários, sem serviço): cada suíte sobe um servidor descartável do
  próprio usuário Linux da pessoa, ouvindo só em `127.0.0.1` e com senha. Suítes que precisam
  de Docker para outra coisa ficam puladas na revisão.
