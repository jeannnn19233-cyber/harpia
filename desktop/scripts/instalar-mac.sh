#!/bin/bash
# Gera e instala o app do Harpia neste Mac (Apple Silicon ou Intel), sem conta de desenvolvedor da
# Apple: o app é gerado aqui mesmo, assinado localmente e copiado para Aplicativos.
set -euo pipefail
cd "$(dirname "$0")/.."

# O Node 24 do Homebrew fica fora do PATH quando instalado como "node@24".
for dir in /opt/homebrew/opt/node@24/bin /usr/local/opt/node@24/bin; do
  if [ -x "$dir/node" ]; then export PATH="$dir:$PATH"; fi
done
if ! command -v node >/dev/null 2>&1; then
  echo "Não achei o Node. Instale com: brew install node@24"
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "O Node é o $(node -v); o app precisa do 22 ou mais novo. Instale com: brew install node@24"
  exit 1
fi

if [ "$(uname -m)" = "arm64" ]; then
  arch_flag=--arm64
  built=release/mac-arm64/Harpia.app
else
  arch_flag=--x64
  built=release/mac/Harpia.app
fi

echo "1/4 Instalando as dependências (Node $(node -v))…"
npm install --no-audit --no-fund
node node_modules/electron/install.js

echo "2/4 Conferindo (tipos e testes)…"
npm run check

echo "3/4 Gerando o app…"
rm -rf release
npx electron-builder --mac dir "$arch_flag"

echo "4/4 Instalando em Aplicativos…"
osascript -e 'quit app "Harpia"' >/dev/null 2>&1 || true
rm -rf /Applications/Harpia.app
ditto "$built" /Applications/Harpia.app
xattr -dr com.apple.quarantine /Applications/Harpia.app 2>/dev/null || true
# Assinatura local: o macOS exige alguma assinatura para rodar apps em Apple Silicon.
codesign --force --deep --sign - /Applications/Harpia.app
open /Applications/Harpia.app
echo "Pronto: o Harpia está em Aplicativos. Na primeira abertura, informe o endereço do servidor da equipe."
