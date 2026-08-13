# SSH Server Picker Overflow and Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every saved SSH server reachable in the Connect over SSH dialog and add fast case-insensitive filtering for large imported server collections.

**Architecture:** Keep the change within `SshProjectDialog`. The pick step becomes a bounded flex column whose server-list child owns vertical scrolling, while local React state filters the existing Zustand server collection without changing persistence or connection behaviour. The Settings surface remains unchanged because its parent page already scrolls.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, jsdom, inline layout styles consistent with the existing component.

## Global Constraints

- Implement against `eneskirca/nodeterm` main at commit `711f34b1656a370c673b02e2b63a4bde699953d4`.
- Keep the change restricted to issue 141, its tests, and the approved design and plan.
- Preserve existing SSH connection, cancellation, browse-master teardown, folder browsing, and Add server behaviour.
- Only the server-row list scrolls. The title, explanatory text, filter, Cancel, and Add server actions remain outside the scroll region.
- Match label, host, user, and `user@host` case-insensitively after trimming the query.
- Do not modify Settings because `SettingsPage` already supplies page-level `overflow-y-auto`.
- Use test-first development and watch every new regression test fail for the expected missing behaviour before changing production code.
- Required final gates are the focused component test, `npm run typecheck`, full `npm test`, `npm run build`, and `git diff --check`.

---

### Task 1: Pin the overflow and filtering regressions, then implement the picker fix

**Files:**
- Modify: `src/renderer/components/SshProjectDialog.test.tsx`
- Modify: `src/renderer/components/SshProjectDialog.tsx`

**Interfaces:**
- Consumes: `useSshServers((state) => state.servers)` and the existing `SshServer` fields `label`, `host`, and `user`.
- Produces: no new public TypeScript interface. The rendered pick step gains an input labelled `Filter saved SSH servers` and a server list labelled `Saved SSH servers`.

- [ ] **Step 1: Generalise the test harness without changing production code**

Keep the existing real component and store setup. Add these helpers below `buttonByText`.

```tsx
  const setInputValue = (input: HTMLInputElement, value: string): void => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const serverButtons = (): HTMLButtonElement[] =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Saved SSH servers"] button')]
```

- [ ] **Step 2: Write the failing layout regression test**

```tsx
  it('keeps a large server collection in its own scroll region above the actions', () => {
    useSshServers.setState({
      servers: Array.from({ length: 25 }, (_, index) => ({
        id: `server-${index}`,
        label: `Server ${index}`,
        host: `host-${index}.example.com`,
        user: 'matt'
      }))
    })
    render()

    const list = document.querySelector<HTMLElement>('[aria-label="Saved SSH servers"]')!
    const cancel = buttonByText('Cancel')
    expect(serverButtons()).toHaveLength(25)
    expect(list.style.flex).toBe('1 1 auto')
    expect(list.style.minHeight).toBe('0px')
    expect(list.style.overflowY).toBe('auto')
    expect(serverButtons().every((button) => button.style.flexShrink === '0')).toBe(true)
    expect(list.contains(cancel)).toBe(false)
    expect(cancel.parentElement?.style.flexShrink).toBe('0')
    expect(list.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
```

Run `npx vitest run src/renderer/components/SshProjectDialog.test.tsx`. The new test must fail because the current list has no accessible label, flexible scroll contract, or non-shrinking rows.

- [ ] **Step 3: Write the failing filtering tests**

```tsx
  it('filters saved servers by label, host, user, and user-at-host without case sensitivity', () => {
    useSshServers.setState({ servers: [
      { id: 'prod', label: 'Production', host: 'api.example.com', user: 'deploy' },
      { id: 'stage', label: 'Staging', host: 'stage.internal', user: 'ubuntu' }
    ] })
    render()
    const filter = document.querySelector<HTMLInputElement>('[aria-label="Filter saved SSH servers"]')!

    setInputValue(filter, 'PRODUCTION')
    expect(serverButtons().map((button) => button.textContent)).toEqual([expect.stringContaining('Production')])
    setInputValue(filter, 'API.EXAMPLE.COM')
    expect(serverButtons().map((button) => button.textContent)).toEqual([expect.stringContaining('Production')])
    setInputValue(filter, 'ubuntu@stage.internal')
    expect(serverButtons().map((button) => button.textContent)).toEqual([expect.stringContaining('Staging')])
    setInputValue(filter, '')
    expect(serverButtons()).toHaveLength(2)
  })

  it('shows a no-results message instead of server rows when the filter has no match', () => {
    render()
    const filter = document.querySelector<HTMLInputElement>('[aria-label="Filter saved SSH servers"]')!
    setInputValue(filter, 'missing-host')
    expect(serverButtons()).toHaveLength(0)
    expect(document.body.textContent).toContain('No saved servers match')
  })
```

Run `npx vitest run src/renderer/components/SshProjectDialog.test.tsx`. Both tests must fail because the filter input and derived visible collection do not yet exist.

- [ ] **Step 4: Implement the minimal approved behaviour**

In `SshProjectDialog.tsx` import `useMemo`, add local `serverFilter` state, and derive `visibleServers`.

```tsx
  const [serverFilter, setServerFilter] = useState('')
  const visibleServers = useMemo(() => {
    const query = serverFilter.trim().toLowerCase()
    if (!query) return servers
    return servers.filter((saved) =>
      [saved.label, saved.host, saved.user, `${saved.user}@${saved.host}`]
        .some((value) => value.toLowerCase().includes(query))
    )
  }, [servers, serverFilter])
```

Wrap the pick step in a flex column with `flex: '1 1 auto'` and `minHeight: 0`. Set `flex: '0 0 auto'` and `overflow: 'visible'` on the title and explanatory paragraphs so the list, rather than the copy, gives up height. Render the shared `Input` above the list when at least one server exists.

```tsx
<Input
  autoFocus
  aria-label="Filter saved SSH servers"
  placeholder="Filter by label, host, or user"
  value={serverFilter}
  onChange={(event) => setServerFilter(event.target.value)}
  className="mb-2"
  style={{ flexShrink: 0 }}
/>
```

Give the list `role="group"`, `aria-label="Saved SSH servers"`, and these critical inline styles.

```tsx
{
  display: 'flex',
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  flexDirection: 'column',
  gap: 6,
  margin: '6px 0 14px'
}
```

Map `visibleServers`, show `No saved servers match “{serverFilter.trim()}”.` when the saved collection is non-empty and the visible collection is empty, and preserve `No saved servers yet.` for an empty saved collection. Add `flexShrink: 0` to `ROW_STYLE` so constrained list rows overflow instead of compressing. Set `flexShrink: 0` on the existing action row so it cannot be compressed into the scrolling list's height budget.

- [ ] **Step 5: Run the focused test and mutation check**

Run `npx vitest run src/renderer/components/SshProjectDialog.test.tsx` and require all tests to pass without warnings.

Temporarily remove `overflowY: 'auto'` from the list and rerun the focused test. Confirm the layout regression test fails specifically on the `overflowY` assertion, then restore the property and rerun to green. This proves the test detects a realistic reintroduction of issue 141.

- [ ] **Step 6: Run the task gate and commit**

Run `npm run typecheck` and `git diff --check`. Inspect `git diff -- src/renderer/components/SshProjectDialog.tsx src/renderer/components/SshProjectDialog.test.tsx` for unrelated changes.

Commit the component and regression tests with `fix(ssh): make the saved-server picker searchable`.

---

### Task 2: Verify the complete change and publish the upstream pull request

**Files:**
- Include: `docs/superpowers/specs/2026-08-13-ssh-server-picker-design.md`
- Include: `docs/superpowers/plans/2026-08-13-ssh-server-picker.md`
- Verify: all files changed on the feature branch

**Interfaces:**
- Consumes: Task 1's complete implementation and tests.
- Produces: a pushed feature branch and a draft pull request targeting `eneskirca/nodeterm:main` that closes issue 141.

- [ ] **Step 1: Review scope and documentation**

Run `git status --short`, `git diff main...HEAD --stat`, and `git diff main...HEAD`. Confirm the branch contains only the approved picker behaviour, regression tests, design, and plan. Confirm Settings has no changes and the design records why.

- [ ] **Step 2: Run all required verification**

Run these commands from the repository root.

```bash
npx vitest run src/renderer/components/SshProjectDialog.test.tsx
npm run typecheck
npm test
npm run build
git diff --check main...HEAD
```

Every command must exit successfully. If the full suite exposes a pre-existing environmental failure, investigate it using the repository guidance and rerun the complete suite before claiming completion.

- [ ] **Step 3: Commit the approved design and plan**

Because `docs/superpowers/` is ignored by default, stage these two exact files with `git add -f` and commit them with `docs: record the SSH server picker fix` if they were not included in the Task 1 commit.

- [ ] **Step 4: Publish through the contributor fork**

Confirm `gh auth status`. If direct push access to `eneskirca/nodeterm` is unavailable, ensure the authenticated user's fork exists, add or reuse a fork remote, and push `codex/fix-ssh-picker-overflow-141` there without changing the authoritative `origin` fetch target.

- [ ] **Step 5: Open the upstream draft pull request**

Create a draft PR against `eneskirca/nodeterm:main`. The title should be `fix(ssh): keep large saved-server lists usable`. The body must explain the flex-list root cause, the dedicated scroll region, the matching fields, the unchanged Settings surface, all verification commands, and the three-surface decision. Include `Closes #141`.

- [ ] **Step 6: Confirm remote state**

Fetch the created PR and confirm its URL, draft state, base branch, head branch, changed-file scope, and current checks. Report any checks still running without describing them as passed.
