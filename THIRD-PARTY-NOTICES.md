# Third-Party Notices

nodeterm is licensed under BUSL-1.1 (see `LICENSE`), and it is built on and bundles the
following open-source components. Each is the property of its respective authors
and is used under its own license. Their license terms are not affected by
nodeterm's license.

| Component | License |
| --- | --- |
| Electron | MIT |
| React, React DOM | MIT |
| @xyflow/react (React Flow) | MIT |
| @xterm/xterm, @xterm/addon-fit | MIT |
| monaco-editor | MIT |
| node-pty | MIT |
| marked | MIT |
| DOMPurify | Apache-2.0 OR MPL-2.0 |
| zustand | MIT |
| electron-updater, electron-builder | MIT |
| @anthropic-ai/claude-agent-sdk | © Anthropic PBC, proprietary (see the package's LICENSE.md) |
| ws | MIT |
| tweetnacl | Unlicense (public domain) |
| tmux (macOS builds only) | ISC |
| libevent (macOS builds only, linked statically into tmux) | BSD-3-Clause |
| utf8proc (macOS builds only, linked statically into tmux) | MIT |

Full license texts are available in each package's directory under
`node_modules/`, and from the projects' upstream repositories.

## Bundled tmux (macOS)

The macOS app ships a copy of [tmux](https://github.com/tmux/tmux) at
`nodeterm.app/Contents/Resources/bin/tmux`, statically linked against
[libevent](https://github.com/libevent/libevent) and
[utf8proc](https://github.com/JuliaStrings/utf8proc). It is used **only** when the
machine has no tmux of its own — a tmux found anywhere on the system takes
precedence — so that terminals keep their sessions across restarts. None of the
three projects is modified; `scripts/build-tmux.mjs` builds the pinned upstream
release tarballs unchanged. Their license texts are in `resources/licenses/`
(`tmux-COPYING.txt`, `libevent-LICENSE.txt`, `utf8proc-LICENSE.md`), refreshed
from the tarballs by that same script.

## Trademarks

"Claude" and "Claude Code" are trademarks of Anthropic, PBC. The Claude Code
icon (`src/renderer/assets/claude.svg`) is used to label the optional
Claude Code terminal preset. nodeterm is not affiliated with, sponsored by, or
endorsed by Anthropic.
