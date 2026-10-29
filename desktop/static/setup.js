const form = document.getElementById('form')
const input = document.getElementById('server')
const error = document.getElementById('error')
const submit = document.getElementById('submit')

window.harpiaDesktop.getServer().then((server) => {
  if (server) input.value = server
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  error.textContent = ''
  submit.disabled = true
  submit.textContent = 'Conectando…'
  const result = await window.harpiaDesktop.setServer(input.value)
  if (!result.ok) {
    error.textContent = result.error
    submit.disabled = false
    submit.textContent = 'Conectar'
  }
})
