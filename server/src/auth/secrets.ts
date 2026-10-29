import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Segredos de cada pessoa (ex.: o token do GitHub) ficam cifrados no banco, com uma chave que só
// existe num arquivo do servidor. Um backup do banco sozinho não expõe os tokens.
export class SecretBox {
  private readonly key: Buffer

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('A chave de segredos precisa ter 32 bytes.')
    this.key = key
  }

  // Lê (ou cria, na primeira vez) a chave em <pasta do servidor>/secret.key, só para o root.
  static fromDir(serverDir: string): SecretBox {
    const file = join(serverDir, 'secret.key')
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
    }
    chmodSync(file, 0o600)
    return new SecretBox(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'))
  }

  seal(text: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':')
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(':')
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Segredo em formato desconhecido.')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
  }
}
