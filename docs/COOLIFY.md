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
| `HARPIA_GITHUB_TOKEN` | token do GitHub (marque como secreto) | Para clonar repositórios privados. |

Para gerar o código de configuração: `openssl rand -base64 24`.

O token do GitHub pode ser um *fine-grained token* com acesso só aos repositórios da equipe e
permissão **Contents: Read** (na fase 5, quando o Harpia abrir PRs, ela passa a ser
**Read and write**, mais **Pull requests: Read and write**).

## 4. Limites de recursos

O mesmo servidor roda o Clarumi. Para o Harpia nunca disputar recursos com ele, em
**Resource Limits** defina limites. Para a fase 1 bastam 1 CPU e 1 GB de memória. Na fase 3,
quando os agentes de IA rodarem dentro do Harpia, esses limites vão precisar subir.

## 5. Deploy e primeiro acesso

1. Clique em **Deploy**. O Coolify usa o `HEALTHCHECK` do Dockerfile (`/api/health`) para saber
   quando o Harpia está pronto.
2. Abra o domínio. A primeira tela pede o código de configuração e cria a conta de administrador.
3. Em **Equipe**, gere um link de convite para cada colega.

## Atualizar

Cada push no `main` pode disparar um deploy automático (opção **Auto Deploy** do Coolify), ou
clique em **Redeploy**. Os dados ficam no volume `/data` e sobrevivem ao deploy.

## Backup

O banco é o arquivo `/data/harpia.db`. Uma cópia consistente com o Harpia ligado, pelo
terminal do container no Coolify:

```bash
node --disable-warning=ExperimentalWarning -e "require('node:sqlite'); new (require('node:sqlite').DatabaseSync)('/data/harpia.db').exec(\"VACUUM INTO '/data/backup.db'\")"
```

Depois copie `/data/backup.db` para fora do servidor (ou ative os backups de volume do Coolify).

## Segurança

- **Fase 1:** tudo exige login, convites valem uma vez só e a criação do administrador exige o
  código de configuração.
- **Antes da fase 3:** a fase 3 coloca terminais com agentes de IA dentro do Harpia, ou seja,
  quem entrar consegue rodar comandos no servidor. Antes de ativá-la, vamos restringir quem
  alcança o domínio (lista de IPs no proxy do Coolify, Cloudflare Access ou Tailscale) e colocar
  o Harpia numa rede Docker separada da do Clarumi, para os agentes não enxergarem o banco do
  Clarumi.
