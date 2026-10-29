const params = new URLSearchParams(location.search)
const server = params.get('servidor')
const reason = params.get('motivo')
const detail = document.getElementById('detail')
detail.textContent = ''
const line = document.createElement('span')
line.textContent = server ? 'O servidor ' : 'O servidor não respondeu.'
detail.append(line)
if (server) {
  const code = document.createElement('code')
  code.textContent = server
  detail.append(code, document.createTextNode(` não respondeu${reason ? ` (${reason})` : ''}.`))
}
document.getElementById('retry').addEventListener('click', () => window.harpiaDesktop.retry())
document.getElementById('change').addEventListener('click', () => window.harpiaDesktop.changeServer())
setInterval(() => window.harpiaDesktop.retry(), 15000)
