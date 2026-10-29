# App de computador do Harpia

O app abre o mesmo Harpia que a equipe usa no navegador (o servidor no Coolify) numa janela
própria, como o Orca. Ele não roda agentes nem guarda dados da equipe: só o endereço do servidor,
a posição da janela e o login (no armazenamento da própria janela, como um navegador).

O código fica em `desktop/`, fora dos workspaces do npm de propósito: o Electron (~100 MB) não
entra na imagem do servidor.

## O que o app faz a mais que o navegador

- **Avisos do sistema** quando um agente seu pede aprovação ou termina e a janela está em segundo
  plano. O clique no aviso abre a task. (Rotinas e revisões de PR continuam avisando pelo Telegram.)
- **Contador no ícone** (Dock no Mac) com as aprovações que esperam por você.
- **Janela própria**, com menu em português, atalhos nativos, posição lembrada e, no Mac, a barra
  do Harpia ao lado dos botões da janela.
- **Servidor fora do ar** (um deploy, por exemplo): uma página que tenta de novo a cada 15 s.

## Segurança

- A página do servidor roda isolada (`contextIsolation`, `sandbox`, sem Node). Ela só enxerga
  `window.harpiaDesktop`: contador, aviso e "abrir task".
- Só o endereço do servidor abre dentro da janela. Links para fora (GitHub, links das conversas)
  vão para o navegador; `file:` e afins não abrem.
- Permissões (notificação, área de transferência, tela cheia) valem só para o servidor; câmera,
  microfone e o resto são negados.
- O processo principal confere de onde veio cada pedido: as páginas locais do app não mandam
  avisos, e o servidor não troca o endereço configurado.
- O endereço precisa ser `https://` (http só para a própria máquina).

## Gerar e instalar

Precisa do Node 24.

```bash
cd desktop
npm run setup          # instala as dependências e baixa o Electron (o npm 11 não roda o instalador sozinho)
npm run check          # tipos, testes e build
npm start              # abre o app sem empacotar, para testar
```

### Mac

Gere no próprio Mac:

```bash
npm run dist:mac       # release/Harpia-0.1.0-arm64.dmg (Apple Silicon) e Harpia-0.1.0.dmg (Intel)
```

Abra o `.dmg` e arraste o Harpia para Aplicativos. O app não é assinado com uma conta de
desenvolvedor da Apple, então o macOS bloqueia na primeira vez:

- Clique com o botão direito no Harpia em Aplicativos → **Abrir** → **Abrir**. Ou rode
  `xattr -dr com.apple.quarantine /Applications/Harpia.app`.
- Se o macOS disser que o app está "danificado", assine localmente (sem conta da Apple):
  `codesign --force --deep -s - /Applications/Harpia.app`.

Para distribuir sem esses avisos é preciso a conta de desenvolvedor da Apple (assinatura e
notarização); dá para ligar depois sem mudar o app.

### Windows

Gere numa máquina Windows: `npm run dist:win` → `release/Harpia Setup 0.1.0.exe`. Sem
certificado de assinatura, o SmartScreen avisa na primeira vez: **Mais informações** →
**Executar assim mesmo**.

### Linux

`npm run dist:linux` → `release/Harpia-0.1.0.AppImage`.

### Atualizar

O app não se atualiza sozinho. Como ele só abre o servidor, quase toda mudança do Harpia chega
sem reinstalar (é a página do servidor). Só mudanças em `desktop/` pedem gerar e instalar de novo.

## Testes

- `npm test` em `desktop/`: regras do endereço, da navegação, da janela, do contador e dos avisos.
- Teste de ponta a ponta (Playwright + Electron, numa tela virtual) contra o servidor de teste do
  Harpia: tela de endereço (recusa http), conexão, cadastro, task, aviso e contador na aprovação e
  no fim do agente, clique no aviso abrindo a task, link externo indo para o navegador, bloqueio de
  navegação para fora do servidor, página de fora do ar sem poder mandar aviso e reabertura já
  logada. O pacote de Linux gerado também abre.
