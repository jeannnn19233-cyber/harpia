---
name: instalar-app
description: Gera e instala o app de computador do Harpia na máquina da pessoa (Mac ou Windows). Use quando pedirem para instalar, baixar, atualizar ou reinstalar o app do Harpia.
---

# Instalar o app do Harpia nesta máquina

O app é gerado aqui mesmo, a partir deste repositório: por isso o sistema não bloqueia a
primeira abertura e ninguém precisa de conta de desenvolvedor da Apple ou certificado do Windows.
Detalhes do app em `docs/DESKTOP.md`.

## Antes de começar

1. Confira que está na raiz deste repositório (tem `desktop/scripts/instalar-mac.sh`). Se a
   pessoa só passou o link, clone: `git clone https://github.com/jeannnn19233-cyber/harpia.git`.
   Se já existe um clone, atualize com `git pull` (é assim que se atualiza o app depois).
2. Precisa do Node 22 ou mais novo (o projeto usa o 24). Confira com `node -v`; no Mac, o script
   também procura o `node@24` do Homebrew. Se faltar, **pergunte antes de instalar** e sugira
   `brew install node@24` (Mac) ou o instalador do nodejs.org (Windows).
3. Nunca use `sudo`. Não mexa em outras pastas além de `desktop/` e da pasta de Aplicativos.

## Mac

```bash
bash desktop/scripts/instalar-mac.sh
```

O script instala as dependências, roda os testes do app, gera o app para o processador da
máquina, copia para `/Applications/Harpia.app`, assina localmente e abre. Leva alguns minutos na
primeira vez (baixa o Electron, ~100 MB). Se algum passo falhar, mostre a mensagem para a pessoa
e pare; não tente contornar desligando testes ou a assinatura.

## Windows

No PowerShell, dentro de `desktop`:

```powershell
npm install --no-audit --no-fund
node node_modules/electron/install.js
npm run check
npx electron-builder --win nsis --x64
```

Depois abra o instalador gerado em `desktop\release\` (`Harpia Setup <versão>.exe`). Se o
SmartScreen avisar, é porque o app não tem certificado: **Mais informações → Executar assim
mesmo**.

## Depois de instalar

Na primeira abertura, o app pede o endereço do Harpia da equipe (o mesmo do navegador, com
`https://`). Se a pessoa não souber, peça para ela confirmar com quem administra o Harpia. Se
aparecer "respondeu 401", o endereço tem uma senha do proxy na frente (Basic Auth do Coolify) que
precisa ser desligada pelo administrador; o login do próprio Harpia continua valendo.

Ao terminar, diga em uma frase onde o app ficou e como abrir.
