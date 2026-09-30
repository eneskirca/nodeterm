import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  PUSH_WEBHOOK_TOKEN_ENV,
  pushWebhookCurlExample,
  pushWebhookErrorText,
  pushWebhookPowerShellExample,
  type PushWebhookError
} from './push-webhook'

describe('pushWebhookCurlExample', () => {
  it('reads the token from the environment and hands it to curl on stdin, never argv', () => {
    const ex = pushWebhookCurlExample('https://api.test/')
    expect(ex).toContain(`"$${PUSH_WEBHOOK_TOKEN_ENV}"`)
    expect(ex).toContain('--config -')
    expect(ex).not.toMatch(/-H ['"]?Authorization/i)
    expect(ex).not.toContain('ntwh_')
    expect(ex).toContain('https://api.test/v1/push/webhook')
  })

  it.skipIf(process.platform === 'win32')('is valid sh, and curl receives the header only through stdin', () => {
    // Replace curl with a recorder: it prints its argv, then what it read on stdin.
    const ex = pushWebhookCurlExample('https://api.test').replace('curl ', 'fakecurl ')
    const out = execFileSync('/bin/sh', ['-c', `fakecurl() { printf 'ARGV:%s\\n' "$*"; cat; }\n${ex}`], {
      env: { PATH: process.env.PATH, [PUSH_WEBHOOK_TOKEN_ENV]: 'ntwh_secret' },
      encoding: 'utf8'
    })
    const [argvLine, ...stdin] = out.split('\n')
    expect(argvLine).not.toContain('ntwh_secret')
    expect(stdin.join('\n')).toContain('header = "Authorization: Bearer ntwh_secret"')
  })
})

it('every error has a sentence', () => {
  const all: PushWebhookError[] = ['dev-build', 'no-host-key', 'no-paired-phone', 'refused', 'bad-request', 'rate-limited', 'unreachable']
  for (const e of all) expect(pushWebhookErrorText(e).length).toBeGreaterThan(10)
})

it('the PowerShell example makes the request in-process and reads the token from the environment', () => {
  const ex = pushWebhookPowerShellExample('https://api.test')
  expect(ex).toContain('Invoke-RestMethod')
  expect(ex).toContain(`$env:${PUSH_WEBHOOK_TOKEN_ENV}`)
  expect(ex).not.toMatch(/curl/i)
  expect(ex).toContain("'https://api.test/v1/push/webhook'")
})
