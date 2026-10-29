# Instalando o Harpia numa VPS

Guia para deixar o Harpia rodando 24h numa VPS Linux (Ubuntu 24.04), acessível só pela
equipe através do Tailscale.

## O que você precisa

- Uma VPS com Ubuntu 24.04. Para a fase 1 basta 1 vCPU e 1 GB de RAM; quando os agentes de
  IA rodarem na VPS (fase 3), o recomendado é 8 vCPU e 16–32 GB para 3–4 pessoas.
- Uma conta no [Tailscale](https://tailscale.com) (gratuita para equipes pequenas).

## 1. Preparar a máquina

```bash
sudo apt update && sudo apt install -y git curl
# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # precisa ser 22.18 ou mais novo

# Usuário próprio para o serviço
sudo useradd --system --create-home --home-dir /var/lib/harpia --shell /bin/bash harpia
```

## 2. Instalar o Harpia

```bash
sudo git clone https://github.com/jeannnn19233-cyber/harpia.git /opt/harpia
sudo chown -R harpia:harpia /opt/harpia
cd /opt/harpia
sudo -u harpia npm ci
sudo -u harpia npm run build
```

## 3. Ligar o Tailscale

Instale na VPS e no computador de cada pessoa da equipe:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Publique o Harpia dentro da rede da equipe, com HTTPS:

```bash
sudo tailscale serve --bg 7420
tailscale serve status   # mostra o endereço, ex.: https://harpia.seu-tailnet.ts.net
```

Não abra a porta 7420 no firewall da VPS. O acesso é só pelo Tailscale.

## 4. Configurar e iniciar o serviço

```bash
sudo cp deploy/harpia.env.example /etc/harpia.env
sudo nano /etc/harpia.env   # coloque em HARPIA_ALLOWED_ORIGINS o endereço do passo 3
sudo cp deploy/harpia.service /etc/systemd/system/harpia.service
sudo systemctl daemon-reload
sudo systemctl enable --now harpia
sudo systemctl status harpia
```

Abra o endereço do Tailscale no navegador. A primeira tela cria a conta de administrador.
Depois, em **Equipe**, gere um link de convite para cada colega.

## 5. Repositórios privados

O Harpia clona os repositórios usando o usuário `harpia` da VPS. Para repositórios privados
do GitHub, faça o login uma vez:

```bash
sudo apt install -y gh
sudo -u harpia -i gh auth login      # escolha HTTPS e siga o link
sudo -u harpia -i gh auth setup-git
```

## Atualizar

```bash
cd /opt/harpia
sudo -u harpia git pull
sudo -u harpia npm ci
sudo -u harpia npm run build
sudo systemctl restart harpia
```

## Backup

Os dados ficam em `/var/lib/harpia/harpia.db`. Uma cópia segura com o serviço ligado:

```bash
sudo -u harpia node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/var/lib/harpia/harpia.db').exec(\"VACUUM INTO '/var/lib/harpia/backup-$(date +%F).db'\")"
```

## Ver os logs

```bash
journalctl -u harpia -f
```
