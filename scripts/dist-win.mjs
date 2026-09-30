// Windows packaging entry point — repo tooling, not product code. `npm run dist:win` and the
// release workflow's `release-win` job both end here, so a local build and a tag build take the
// SAME decision about code signing.
//
// THE CONTRACT: signing is decided by the environment, and absence means UNSIGNED, silently.
//   - WIN_SIGN_PROVIDER unset/empty (a contributor's machine, a fork's CI, the manual
//     win-package-smoke workflow) ⇒ exactly the unsigned build this script replaced:
//     `electron-builder --win --x64 --publish never -c.extraMetadata.nodeTermUpdates=disabled`.
//   - WIN_SIGN_PROVIDER set and every variable that provider needs present ⇒ signed, with
//     `forceCodeSigning` on, so a file that failed to sign fails the build instead of shipping a
//     half-signed installer.
//   - WIN_SIGN_PROVIDER set but something missing, or a provider we do not know ⇒ refuse. A
//     half-configured signing setup is a mistake to report, never a reason to quietly publish an
//     unsigned installer from a pipeline that believes it signs.
//
// TWO PROVIDERS, because which one is usable depends on who is signing, not on taste:
//   - `esigner` — an OV (organization) or IV (individual) certificate held by SSL.com's eSigner
//     cloud HSM, driven by their CodeSignTool. Available worldwide; the default recommendation.
//   - `azure` — Azure Artifact Signing (formerly Trusted Signing) through electron-builder's
//     `win.azureSignOptions`. Cheaper, but Microsoft only issues Public Trust certificates to
//     organizations in a fixed list of countries and to individuals in the US/Canada — so it is
//     here for a publisher that qualifies, not as the default.
//
// The trigger is our OWN WIN_SIGN_PROVIDER, deliberately not any credential variable: a developer
// who uses the Azure CLI commonly has AZURE_TENANT_ID / AZURE_CLIENT_ID exported for unrelated
// work, and that must not turn their local `dist:win` into a signing attempt (or a refusal).
//
// Config reaches electron-builder through the programmatic `config` option, which is the same
// deep-merge over package.json's `build` block that the CLI's `-c.x.y=z` flags perform. Going
// through the API rather than building a `-c.…` argv keeps a publisher name with spaces, commas
// or non-ASCII letters (a legal name is exactly that) out of yargs' dotted-flag parser, and it is
// the only way to hand electron-builder a sign FUNCTION rather than a module path.

import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Selects the provider. Non-secret — a repository VARIABLE in CI. */
export const PROVIDER_ENV = 'WIN_SIGN_PROVIDER'

/**
 * MUST equal the certificate subject's CN exactly: it is written into latest.yml as
 * `publisherName`, and electron-updater refuses an update whose signer does not match. Required by
 * every provider, because a wrong value here fails LATER, on users' machines, not in this build.
 */
export const PUBLISHER_ENV = 'WIN_SIGN_PUBLISHER'

export const PROVIDERS = {
  esigner: {
    // ESIGNER_* are secrets. CODESIGNTOOL_DIR is where the workflow unpacked SSL.com's
    // CodeSignTool (the Linux/macOS zip — plain jar, run with the runner's own Java).
    required: ['ESIGNER_USERNAME', 'ESIGNER_PASSWORD', 'ESIGNER_TOTP_SECRET', 'CODESIGNTOOL_DIR'],
    // Needed only when the SSL.com account holds more than one eSigner certificate.
    optional: ['ESIGNER_CREDENTIAL_ID']
  },
  azure: {
    // WIN_SIGN_ENDPOINT/ACCOUNT/PROFILE are variables; AZURE_* are the service principal secrets
    // Azure.Identity's EnvironmentCredential reads inside Microsoft's TrustedSigning module.
    required: [
      'WIN_SIGN_ENDPOINT',
      'WIN_SIGN_ACCOUNT',
      'WIN_SIGN_PROFILE',
      'AZURE_TENANT_ID',
      'AZURE_CLIENT_ID',
      'AZURE_CLIENT_SECRET'
    ],
    optional: []
  }
}

const present = (env, name) => typeof env[name] === 'string' && env[name].trim() !== ''
const val = (env, name) => (present(env, name) ? env[name].trim() : undefined)

/**
 * Pure decision: what does this environment ask for?
 * @returns {{mode:'unsigned'}
 *   | {mode:'esigner', publisherName:string, esigner:object}
 *   | {mode:'azure', publisherName:string, azureSignOptions:object}
 *   | {mode:'error', message:string}}
 */
export function winSigningPlan(env) {
  const provider = val(env, PROVIDER_ENV)
  if (!provider) return { mode: 'unsigned' }
  const spec = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined
  if (!spec) {
    return {
      mode: 'error',
      message: `unknown ${PROVIDER_ENV} "${provider}" — expected one of ${Object.keys(PROVIDERS).join(', ')}`
    }
  }
  const missing = [PUBLISHER_ENV, ...spec.required].filter((n) => !present(env, n))
  if (missing.length) {
    return {
      mode: 'error',
      message: `${PROVIDER_ENV}=${provider} but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`
    }
  }
  const publisherName = val(env, PUBLISHER_ENV)
  if (provider === 'azure') {
    return {
      mode: 'azure',
      publisherName,
      azureSignOptions: {
        endpoint: val(env, 'WIN_SIGN_ENDPOINT'),
        codeSigningAccountName: val(env, 'WIN_SIGN_ACCOUNT'),
        certificateProfileName: val(env, 'WIN_SIGN_PROFILE'),
        publisherName
      }
    }
  }
  return {
    mode: 'esigner',
    publisherName,
    esigner: {
      username: val(env, 'ESIGNER_USERNAME'),
      password: val(env, 'ESIGNER_PASSWORD'),
      totpSecret: val(env, 'ESIGNER_TOTP_SECRET'),
      credentialId: val(env, 'ESIGNER_CREDENTIAL_ID'),
      toolDir: val(env, 'CODESIGNTOOL_DIR')
    }
  }
}

/**
 * The CodeSignTool argv for one file (after `java`). Pure, so the exact shape is testable.
 *
 * CREDENTIALS ON ARGV — a known, bounded exception to the repo rule that a credential never rides
 * argv. CodeSignTool accepts them no other way (1.3.3: no stdin, no env, no config-file option).
 * It is tolerable ONLY because the one place this runs with real secrets is an ephemeral,
 * single-tenant GitHub-hosted VM that is destroyed after the job; nothing here logs the argv. Do
 * not run a signing build on a shared host.
 *
 * No `-output_dir_path`, so CodeSignTool signs the file in place — which is what electron-builder
 * expects of a sign hook (it reads the same path back afterwards). `-override=true` is NOT
 * optional: without it 1.3.3 stops at an interactive "replace the original file? [y/n]" prompt,
 * which under a CI step (stdin open, nobody typing) hangs until the job times out. MEASURED
 * against SSL.com's sandbox before this line existed.
 */
export function codeSignToolArgs(jarPath, file, c) {
  return [
    '-jar',
    jarPath,
    'sign',
    `-username=${c.username}`,
    `-password=${c.password}`,
    `-totp_secret=${c.totpSecret}`,
    ...(c.credentialId ? [`-credential_id=${c.credentialId}`] : []),
    `-input_file_path=${file}`,
    '-override=true'
  ]
}

/** The newest `jar/code_sign_tool-<v>.jar` in the unpacked tool directory. */
export function findCodeSignToolJar(toolDir, list = (d) => readdirSync(d)) {
  const jars = list(join(toolDir, 'jar'))
    .filter((f) => /^code_sign_tool-[\d.]+\.jar$/.test(f))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (!jars.length) throw new Error(`no code_sign_tool-*.jar under ${join(toolDir, 'jar')}`)
  return join(toolDir, 'jar', jars[jars.length - 1])
}

const javaBin = (env) => (env.JAVA_HOME ? join(env.JAVA_HOME, 'bin', 'java') : 'java')

// Success is judged POSITIVELY: exit 0 AND CodeSignTool's own "Code signed successfully" line.
// Older builds exited 0 on some failures, and a signature that did not happen must not pass.
const CST_OK = /Code signed successfully/
// A remote HSM call that stops answering must end the build, not park it for the job's 6 h.
const CST_TIMEOUT_MS = 10 * 60 * 1000

function runCodeSignTool(plan, file, env) {
  const c = plan.esigner
  const args = codeSignToolArgs(findCodeSignToolJar(c.toolDir), file, c)
  return new Promise((resolve, reject) => {
    const child = execFile(
      javaBin(env),
      args,
      // cwd + CODE_SIGN_TOOL_PATH: the jar finds conf/code_sign_tool.properties through them.
      {
        cwd: c.toolDir,
        env: { ...env, CODE_SIGN_TOOL_PATH: c.toolDir },
        maxBuffer: 8 << 20,
        timeout: CST_TIMEOUT_MS
      },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`
        if (err || !CST_OK.test(out)) {
          // Never echo args: they carry the password and TOTP secret.
          reject(new Error(`CodeSignTool failed for ${file} (exit ${err?.code ?? 0}):\n${out.trim()}`))
        } else resolve()
      }
    )
    // Belt to -override's braces: any future prompt reads EOF and fails fast instead of hanging.
    child.stdin?.end()
  })
}

/** electron-builder `signtoolOptions.sign` hook for eSigner. One retry: the service is remote. */
export function eSignerSign(plan, env = process.env) {
  return async (task) => {
    try {
      await runCodeSignTool(plan, task.path, env)
    } catch (first) {
      console.warn(`dist-win: ${first.message.split('\n')[0]} — retrying once`)
      await runCodeSignTool(plan, task.path, env)
    }
  }
}

/** The electron-builder `config` overlay for a plan (merged over package.json `build`). */
export function builderConfigFor(plan, env = process.env) {
  // Windows auto-update stays OFF in this change, signed or not: the updater leg (latest.yml on
  // the feed, the electron-updater NSIS path) is its own follow-up and needs its own review.
  const config = { extraMetadata: { nodeTermUpdates: 'disabled' } }
  if (plan.mode === 'azure') {
    return { ...config, forceCodeSigning: true, win: { azureSignOptions: plan.azureSignOptions } }
  }
  if (plan.mode === 'esigner') {
    return {
      ...config,
      forceCodeSigning: true,
      win: {
        signtoolOptions: {
          sign: eSignerSign(plan, env),
          publisherName: plan.publisherName,
          // electron-builder's default is DUAL signing (sha1 then sha256), which calls the hook
          // twice per file — and eSigner bills per signing. SHA-1 Authenticode has been
          // meaningless since Windows 7 SP1 lost it; one SHA-256 signature is the whole job.
          signingHashAlgorithms: ['sha256']
        }
      }
    }
  }
  return config
}

async function main() {
  const plan = winSigningPlan(process.env)
  if (plan.mode === 'error') {
    console.error(
      `dist-win: Windows signing is misconfigured — ${plan.message}.\n` +
        `Unset ${PROVIDER_ENV} to build unsigned, or set everything that provider needs ` +
        `(see PROVIDERS in scripts/dist-win.mjs).`
    )
    process.exit(1)
  }
  console.log(
    plan.mode === 'unsigned'
      ? `dist-win: ${PROVIDER_ENV} not set — building UNSIGNED`
      : `dist-win: signing with ${plan.mode} as "${plan.publisherName}"`
  )
  const { build, Platform, Arch } = await import('electron-builder')
  await build({
    // No explicit target: package.json `win.target` (nsis + zip) applies, as with `--win --x64`.
    targets: Platform.WINDOWS.createTarget(null, Arch.x64),
    publish: 'never',
    config: builderConfigFor(plan)
  })
}

if (process.argv[1] && process.argv[1].endsWith('dist-win.mjs')) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
