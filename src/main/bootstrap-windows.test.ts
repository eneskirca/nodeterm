import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const describeWindows = process.platform === 'win32' ? describe : describe.skip
const sourceBootstrap = path.resolve(__dirname, '../../bootstrap-windows.bat')
const scratchDirectories: string[] = []

interface ProbeResult {
  status: number | null
  stdout: string
  stderr: string
  installation: string
  invocations: string[]
}

interface ProbeOptions {
  createVswhere?: boolean
  testingSentinel?: string | null
  inheritInternalOverride?: boolean
}

function readInvocationLog(invocationLog: string): string {
  try {
    return readFileSync(invocationLog, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function runVisualStudioProbe(vswhereBody: string, options: ProbeOptions = {}): ProbeResult {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nodeterm-bootstrap-'))
  scratchDirectories.push(scratch)
  const installation = path.join(scratch, 'VS Build Tools')
  mkdirSync(installation)

  const checkout = path.join(scratch, 'checkout with spaces')
  mkdirSync(checkout)
  const bootstrap = path.join(checkout, 'bootstrap-windows.bat')
  copyFileSync(sourceBootstrap, bootstrap)

  // The space in the filename makes this fixture exercise the quoting around VSWHERE too.
  const fakeVswhere = path.join(scratch, 'fake vswhere.cmd')
  const invocationLog = path.join(scratch, 'vswhere-arguments.txt')
  const invocationState = path.join(scratch, 'vswhere-invocation-state')
  if (options.createVswhere !== false) {
    writeFileSync(
      fakeVswhere,
      `@echo off\r\necho %*>>"%NODETERM_TEST_VSWHERE_ARGS_LOG%"\r\n${vswhereBody}\r\n`,
      'utf8'
    )
  }

  const controlledKeys = new Set([
    '_NODETERM_VSWHERE_OVERRIDE',
    'NODETERM_BOOTSTRAP_TESTING',
    'NODETERM_TEST_VSWHERE',
    'NODETERM_TEST_VSWHERE_ARGS_LOG',
    'NODETERM_TEST_VS_INSTALLATION',
    'NODETERM_TEST_VSWHERE_STATE',
    'VS_INSTALLATION'
  ])
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !controlledKeys.has(key.toUpperCase()))
  )
  env.NODETERM_TEST_VSWHERE_ARGS_LOG = invocationLog
  env.NODETERM_TEST_VS_INSTALLATION = installation
  env.NODETERM_TEST_VSWHERE_STATE = invocationState
  env.NODETERM_TEST_VSWHERE = fakeVswhere
  env.VS_INSTALLATION = installation
  if (options.testingSentinel !== null) {
    env.NODETERM_BOOTSTRAP_TESTING = options.testingSentinel ?? '1'
  }
  if (options.inheritInternalOverride) {
    env._NODETERM_VSWHERE_OVERRIDE = fakeVswhere
  }
  // Keep the batch path and its argument as separate argv entries. Node quotes the path for
  // CreateProcess, so a checkout directory containing spaces reaches cmd.exe intact.
  const result = spawnSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/c', bootstrap, '--check-vs-build-tools'],
    {
      encoding: 'utf8',
      env,
      timeout: 10_000,
      windowsHide: true
    }
  )

  expect(result.error).toBeUndefined()
  const invocationText = readInvocationLog(invocationLog).trim()
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    installation,
    invocations: invocationText ? invocationText.split(/\r?\n/) : []
  }
}

const expectedVswhereArguments =
  '-products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath'

function expectVswhereInvocations(result: ProbeResult, count: number): void {
  expect(result.invocations).toEqual(Array(count).fill(expectedVswhereArguments))
}

describeWindows('bootstrap-windows Visual Studio probe', () => {
  afterEach(() => {
    for (const directory of scratchDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports a missing vswhere executable without invoking a fixture', () => {
    const result = runVisualStudioProbe('', { createVswhere: false })

    expect(result.status).toBe(1)
    expect(result.stdout, result.stderr).toContain(
      '[MISSING] Visual Studio Build Tools were not found (vswhere.exe absent).'
    )
    expect(result.invocations).toEqual([])
  })

  it('rejects fixture overrides unless the test sentinel is exactly 1', () => {
    for (const testingSentinel of [null, '0']) {
      const result = runVisualStudioProbe('echo FIXTURE-MUST-NOT-RUN', {
        testingSentinel,
        inheritInternalOverride: true
      })

      expect(result.invocations).toEqual([])
      expect(result.stdout).not.toContain('FIXTURE-MUST-NOT-RUN')
    }
  })

  it('keeps fixture state inside the check-only dispatch boundary', () => {
    const source = readFileSync(sourceBootstrap, 'utf8')
    const overrideClear = source.indexOf('set "_NODETERM_VSWHERE_OVERRIDE="')
    const checkOnlyDispatch = source.indexOf(
      'if /i "%~1"=="--check-vs-build-tools" goto :check_vs_build_tools_only'
    )
    const checkOnlyLabel = source.search(/^:check_vs_build_tools_only\r?$/m)
    const fixtureAssignment = source.indexOf(
      'if "%NODETERM_BOOTSTRAP_TESTING%"=="1" set "_NODETERM_VSWHERE_OVERRIDE=%NODETERM_TEST_VSWHERE%"'
    )
    const sharedProbeLabel = source.search(/^:check_vs_build_tools\r?$/m)

    expect(overrideClear).toBeGreaterThan(-1)
    expect(checkOnlyDispatch).toBeGreaterThan(overrideClear)
    expect(checkOnlyLabel).toBeGreaterThan(checkOnlyDispatch)
    expect(fixtureAssignment).toBeGreaterThan(checkOnlyLabel)
    expect(sharedProbeLabel).toBeGreaterThan(fixtureAssignment)
  })

  it('rejects a successful vswhere query with empty output', () => {
    const result = runVisualStudioProbe('exit /b 0')

    expect(result.status).toBe(1)
    expect(result.stdout, result.stderr).toContain(
      '[MISSING] No Visual Studio installation with the C++ build tools component was found.'
    )
    expect(result.stdout).not.toContain('[OK] Visual Studio C++ build tools')
    expectVswhereInvocations(result, 2)
  })

  it('keeps a failed query distinct from an empty successful query', () => {
    const result = runVisualStudioProbe('exit /b 7')

    expect(result.status).toBe(1)
    expect(result.stdout, result.stderr).toContain(
      '[FAILED] vswhere could not query Visual Studio installations.'
    )
    expect(result.stdout).not.toContain('[MISSING] No Visual Studio installation')
    expectVswhereInvocations(result, 2)
  })

  it('does not launder a later query failure into a missing installation', () => {
    const result = runVisualStudioProbe(
      'if exist "%NODETERM_TEST_VSWHERE_STATE%" exit /b 7\r\ntype nul >"%NODETERM_TEST_VSWHERE_STATE%"\r\nexit /b 0'
    )

    expect(result.status).toBe(1)
    expect(result.stdout, result.stderr).toContain(
      '[FAILED] vswhere could not query Visual Studio installations.'
    )
    expect(result.stdout).not.toContain('[MISSING] No Visual Studio installation')
    expectVswhereInvocations(result, 2)
  })

  it('rejects a reported C++ toolchain path that does not exist', () => {
    const result = runVisualStudioProbe(
      'echo %NODETERM_TEST_VS_INSTALLATION%\\missing-installation'
    )
    const missingInstallation = path.join(result.installation, 'missing-installation')

    expect(result.status).toBe(1)
    expect(result.stdout, result.stderr).toContain(
      `[FAILED] vswhere reported a Visual Studio path that does not exist: "${missingInstallation}"`
    )
    expect(result.stdout).not.toContain('[OK] Visual Studio C++ build tools')
    expectVswhereInvocations(result, 1)
  })

  it('uses the first path when vswhere reports multiple installations', () => {
    const result = runVisualStudioProbe(
      'echo %NODETERM_TEST_VS_INSTALLATION%\r\necho %NODETERM_TEST_VS_INSTALLATION%\\missing-installation'
    )

    expect(result.status).toBe(0)
    expect(result.stdout, result.stderr).toContain(
      `[OK] Visual Studio C++ build tools: "${result.installation}"`
    )
    expect(result.stdout).not.toContain('Running npm ci')
    expectVswhereInvocations(result, 1)
  })

  it('accepts a reported C++ toolchain path, including spaces', () => {
    const result = runVisualStudioProbe('echo %NODETERM_TEST_VS_INSTALLATION%')

    expect(result.status).toBe(0)
    expect(result.stdout, result.stderr).toContain(
      `[OK] Visual Studio C++ build tools: "${result.installation}"`
    )
    expectVswhereInvocations(result, 1)
  })
})
