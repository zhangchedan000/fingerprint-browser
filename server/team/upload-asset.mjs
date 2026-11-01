// Puts a private file on the team server (pb_hooks/assets.pb.js), e.g. after the server was rebuilt:
//   on the server:  T=$(head -c 24 /dev/urandom | base64 | tr -d '/+='); echo -n "$T" > pb_data/assets/.upload-token; echo "$T"
//   on any computer with the file:  node upload-asset.mjs <file> <name> <token> [server]
// The token works once; the server removes it after the upload.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [file, name, token, server = 'https://temu.orenge.ccwu.cc'] = process.argv.slice(2)
if (!file || !name || !token) throw new Error('usage: node upload-asset.mjs <file> <name> <token> [server]')
const data = readFileSync(file)
console.log('local', data.length, createHash('sha256').update(data).digest('hex'))
const response = await fetch(`${server.replace(/\/+$/, '')}/api/team/assets/${encodeURIComponent(name)}`, {
  method: 'PUT',
  headers: { 'X-Upload-Token': token, 'content-type': 'application/octet-stream' },
  body: data
})
console.log(response.status, await response.text())
