import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  PROVIDER_ENV,
  PUBLISHER_ENV,
  PROVIDERS,
  winSigningPlan,
  builderConfigFor,
  codeSignToolArgs,
  findCodeSignToolJar
  // @ts-expect-error — plain .mjs repo tooling, deliberately outside the typechecked projects.
} from './dist-win.mjs'

const ESIGNER = {
  WIN_SIGN_PROVIDER: 'esigner',
  WIN_SIGN_PUBLISHER: 'Kırca, Enes',
  ESIGNER_USERNAME: 'u',
  ESIGNER_PASSWORD: 'p',
  ESIGNER_TOTP_SECRET: 't',
  CODESIGNTOOL_DIR: '/opt/cst'
}
const AZURE = {
  WIN_SIGN_PROVIDER: 'azure',
  WIN_SIGN_PUBLISHER: 'Kırca, Enes',
  WIN_SIGN_ENDPOINT: 'https://weu.codesigning.azure.net/',
  WIN_SIGN_ACCOUNT: 'nodeterm',
  WIN_SIGN_PROFILE: 'nodeterm-public',
  AZURE_TENANT_ID: 't',
  AZURE_CLIENT_ID: 'c',
  AZURE_CLIENT_SECRET: 's'
}

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('winSigningPlan', () => {
  it('builds unsigned when no provider is selected (local dist:win, forks, the smoke workflow)', () => {
    expect(winSigningPlan({})).toEqual({ mode: 'unsigned' })
    // An unset GitHub variable expands to "", which must read as absent.
    expect(winSigningPlan({ WIN_SIGN_PROVIDER: '  ' })).toEqual({ mode: 'unsigned' })
  })

  it('ignores credentials lying around without a provider — an Azure CLI user must not trip signing', () => {
    const { WIN_SIGN_PROVIDER: _p, ...rest } = AZURE
    expect(winSigningPlan(rest)).toEqual({ mode: 'unsigned' })
    const { WIN_SIGN_PROVIDER: _q, ...rest2 } = ESIGNER
    expect(winSigningPlan(rest2)).toEqual({ mode: 'unsigned' })
  })

  it('refuses an unknown provider rather than falling back to unsigned', () => {
    const plan = winSigningPlan({ ...ESIGNER, WIN_SIGN_PROVIDER: 'constructor' })
    expect(plan.mode).toBe('error')
    expect(plan.message).toContain('constructor')
  })

  it('refuses a half-configured provider and names every missing variable', () => {
    const { ESIGNER_TOTP_SECRET: _t, WIN_SIGN_PUBLISHER: _w, ...partial } = ESIGNER
    const plan = winSigningPlan(partial)
    expect(plan.mode).toBe('error')
    expect(plan.message).toContain('WIN_SIGN_PUBLISHER, ESIGNER_TOTP_SECRET')
  })

  it('checks the SELECTED provider’s variables, not the other one’s', () => {
    expect(winSigningPlan({ ...AZURE, WIN_SIGN_PROVIDER: 'esigner' }).mode).toBe('error')
    expect(winSigningPlan({ ...ESIGNER, WIN_SIGN_PROVIDER: 'azure' }).mode).toBe('error')
  })

  it('esigner: passes values through trimmed; credential id only when given', () => {
    const plan = winSigningPlan({ ...ESIGNER, ESIGNER_USERNAME: ' u ' })
    expect(plan).toEqual({
      mode: 'esigner',
      publisherName: 'Kırca, Enes',
      esigner: { username: 'u', password: 'p', totpSecret: 't', credentialId: undefined, toolDir: '/opt/cst' }
    })
    expect(winSigningPlan({ ...ESIGNER, ESIGNER_CREDENTIAL_ID: 'abc' }).esigner.credentialId).toBe('abc')
  })

  it('azure: maps onto electron-builder azureSignOptions field names', () => {
    expect(winSigningPlan(AZURE)).toEqual({
      mode: 'azure',
      publisherName: 'Kırca, Enes',
      azureSignOptions: {
        endpoint: 'https://weu.codesigning.azure.net/',
        codeSigningAccountName: 'nodeterm',
        certificateProfileName: 'nodeterm-public',
        publisherName: 'Kırca, Enes'
      }
    })
  })
})

describe('builderConfigFor', () => {
  it('unsigned: only the updater-off stamp the old dist:win passed on the CLI', () => {
    expect(builderConfigFor({ mode: 'unsigned' })).toEqual({
      extraMetadata: { nodeTermUpdates: 'disabled' }
    })
  })

  it('esigner: a sign FUNCTION, sha256 only (eSigner bills per signing), forced, updater off', () => {
    const cfg = builderConfigFor(winSigningPlan(ESIGNER))
    expect(cfg.forceCodeSigning).toBe(true)
    expect(cfg.extraMetadata).toEqual({ nodeTermUpdates: 'disabled' })
    expect(typeof cfg.win.signtoolOptions.sign).toBe('function')
    expect(cfg.win.signtoolOptions.signingHashAlgorithms).toEqual(['sha256'])
    expect(cfg.win.signtoolOptions.publisherName).toBe('Kırca, Enes')
    expect(cfg.win.azureSignOptions).toBeUndefined()
  })

  it('azure: azureSignOptions only, forced, updater off', () => {
    const cfg = builderConfigFor(winSigningPlan(AZURE))
    expect(cfg.forceCodeSigning).toBe(true)
    expect(cfg.win).toEqual({ azureSignOptions: winSigningPlan(AZURE).azureSignOptions })
  })

  it('overlays only keys package.json build.win does not already own (deep-merge must not clobber targets)', () => {
    const pkg = JSON.parse(read('../package.json'))
    for (const env of [ESIGNER, AZURE]) {
      for (const key of Object.keys(builderConfigFor(winSigningPlan(env)).win)) {
        expect(pkg.build.win).not.toHaveProperty(key)
      }
    }
  })
})

describe('CodeSignTool invocation', () => {
  it('signs in place (no output dir, non-interactive) and adds credential_id only when set', () => {
    const c = { username: 'u', password: 'p w', totpSecret: 't=', toolDir: '/x' }
    expect(codeSignToolArgs('/x/jar/cst.jar', 'C:\\a b\\n.exe', c)).toEqual([
      '-jar',
      '/x/jar/cst.jar',
      'sign',
      '-username=u',
      '-password=p w',
      '-totp_secret=t=',
      '-input_file_path=C:\\a b\\n.exe',
      // Without it CodeSignTool 1.3.3 blocks on an interactive [y/n] prompt (measured).
      '-override=true'
    ])
    expect(codeSignToolArgs('j', 'f', { ...c, credentialId: 'id' })).toContain('-credential_id=id')
  })

  it('picks the newest jar numerically, and fails loudly when there is none', () => {
    const list = () => ['code_sign_tool-1.3.3.jar', 'code_sign_tool-1.10.0.jar', 'README']
    expect(findCodeSignToolJar('/t', list)).toMatch(/code_sign_tool-1\.10\.0\.jar$/)
    expect(() => findCodeSignToolJar('/t', () => [])).toThrow(/no code_sign_tool/)
  })
})

describe('wiring', () => {
  it('dist:win goes through this script, so local and release builds decide signing identically', () => {
    const pkg = JSON.parse(read('../package.json'))
    expect(pkg.scripts['dist:win']).toMatch(/node scripts\/dist-win\.mjs$/)
  })

  it('release-win feeds every variable every provider reads, by name', () => {
    const wf = read('../.github/workflows/release.yml')
    const names = [PROVIDER_ENV, PUBLISHER_ENV]
    for (const p of Object.values(PROVIDERS) as { required: string[]; optional: string[] }[]) {
      names.push(...p.required.filter((n) => n !== 'CODESIGNTOOL_DIR'), ...p.optional)
    }
    for (const name of names) expect(wf).toContain(`${name}: \${{`)
    // CODESIGNTOOL_DIR is produced by the workflow's own install step, not by a variable.
    expect(wf).toMatch(/CODESIGNTOOL_DIR=/)
  })
})
