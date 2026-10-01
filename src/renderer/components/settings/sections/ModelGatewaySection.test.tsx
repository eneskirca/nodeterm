// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MODEL_GATEWAY_SECRET_REF } from '@shared/agents/model-gateway'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../../../state/settings'
import { useModelGateway } from '../../../state/modelGateway'
import { ModelGatewaySection } from './ModelGatewaySection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ModelGatewaySection credential modes', () => {
  let host: HTMLElement
  let root: Root
  let saveCredential: ReturnType<typeof vi.fn>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    saveCredential = vi.fn(async () => ({ hasStoredKey: true, storage: 'encrypted' as const }))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      settings: { save: vi.fn() },
      agent: {
        discoverModels: vi.fn(async () => ({ models: [] })),
        gatewayCredentialStatus: vi.fn(async () => ({
          hasStoredKey: false,
          storage: 'encrypted' as const
        })),
        saveGatewayCredential: saveCredential,
        clearGatewayCredential: vi.fn(async () => ({
          hasStoredKey: false,
          storage: 'encrypted' as const
        }))
      }
    }
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        modelGateway: {
          baseUrl: 'https://gateway.example.test',
          apiKey: '${env:BIFROST_VK}'
        }
      },
      hydrated: true
    })
    useModelGateway.setState({ models: [], status: 'idle', error: '' })
  })

  afterEach(() => {
    act(() => root?.unmount())
    host.remove()
  })

  const mount = async (): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root.render(<ModelGatewaySection isActive />)
    })
  }

  it('shows an environment name as ordinary text while persisting the expansion token', async () => {
    await mount()
    const input = host.querySelector<HTMLInputElement>('#model-gateway-env-name')!
    expect(input.type).toBe('text')
    expect(input.value).toBe('BIFROST_VK')
    expect(host.querySelector('#model-gateway-key')).toBeNull()

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'GATEWAY_KEY'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(useSettings.getState().settings.modelGateway.apiKey).toBe('${env:GATEWAY_KEY}')
  })

  it('persists the selected discovery path and previews its resolved endpoint', async () => {
    await mount()
    expect(host.textContent).toContain(
      'Discovery: https://gateway.example.test/v1/models'
    )

    const openAiPath = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (input) => input.parentElement?.textContent?.includes('/openai/v1/models')
    )!
    await act(async () => {
      openAiPath.click()
    })

    expect(useSettings.getState().settings.modelGateway.discoveryPath).toBe(
      '/openai/v1/models'
    )
    expect(openAiPath.checked).toBe(true)
    expect(host.textContent).toContain(
      'Discovery: https://gateway.example.test/openai/v1/models'
    )
  })

  it('keeps a literal key write-only and stores only the secret sentinel in settings', async () => {
    await mount()
    const source = host.querySelector<HTMLSelectElement>('#model-gateway-credential-source')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
        source,
        'stored'
      )
      source.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const input = host.querySelector<HTMLInputElement>('#model-gateway-key')!
    expect(input.type).toBe('password')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'literal-secret'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save key'
    )!
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(saveCredential).toHaveBeenCalledWith('literal-secret')
    expect(useSettings.getState().settings.modelGateway.apiKey).toBe(
      MODEL_GATEWAY_SECRET_REF
    )
    expect(input.value).toBe('')
    expect(host.textContent).not.toContain('literal-secret')
  })

  it('invalidates a stored-key catalogue before discovering with its replacement', async () => {
    useSettings.setState({
      settings: {
        ...useSettings.getState().settings,
        modelGateway: {
          ...useSettings.getState().settings.modelGateway,
          apiKey: MODEL_GATEWAY_SECRET_REF
        }
      }
    })
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.agent.gatewayCredentialStatus =
      vi.fn(async () => ({ hasStoredKey: true, storage: 'encrypted' as const }))
    useModelGateway.setState({
      models: [{ id: 'old/model' }],
      status: 'ready',
      error: ''
    })
    await mount()

    const input = host.querySelector<HTMLInputElement>('#model-gateway-key')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'replacement-secret'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save key'
    )!
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useModelGateway.getState().models).toEqual([])
    expect(window.nodeTerminal.agent.discoverModels).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: MODEL_GATEWAY_SECRET_REF })
    )
  })
})
