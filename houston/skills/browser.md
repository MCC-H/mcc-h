---
name: chrome-devtools
description: Uses Chrome DevTools via MCP for efficient debugging, troubleshooting and browser automation. Use when debugging web pages, automating browser interactions, analyzing performance, or inspecting network requests.
---

**Houston**: All tools are prefixed with `browser__` (e.g. `browser__navigate_page`, `browser__take_snapshot`, `browser__click`).

## Core Concepts

**Browser lifecycle**: Browser starts automatically on first tool call using a persistent Chrome profile. Configure via CLI args in the MCP server configuration: `npx chrome-devtools-mcp@latest --help`.

**Page selection**: Tools operate on the currently selected page. Use `browser__list_pages` to see available pages, then `browser__select_page` to switch context.

**Element interaction**: Use `browser__take_snapshot` to get page structure with element `uid`s. Each element has a unique `uid` for interaction. If an element isn't found, take a fresh snapshot - the element may have been removed or the page changed.

## Workflow Patterns

### Before interacting with a page

1. Navigate: `browser__navigate_page` or `browser__new_page`
2. Wait: `browser__wait_for` to ensure content is loaded if you know what you look for.
3. Snapshot: `browser__take_snapshot` to understand page structure
4. Interact: Use element `uid`s from snapshot for `browser__click`, `browser__fill`, etc.

### Efficient data retrieval

- Use `filePath` parameter for large outputs (screenshots, snapshots, traces)
- Use pagination (`pageIdx`, `pageSize`) and filtering (`types`) to minimize data
- Set `includeSnapshot: false` on input actions unless you need updated page state

### Tool selection

- **Automation/interaction**: `browser__take_snapshot` (text-based, faster, better for automation)
- **Visual inspection**: `browser__take_screenshot` (when user needs to see visual state)
- **Additional details**: `browser__evaluate_script` for data not in accessibility tree

### Parallel execution

You can send multiple tool calls in parallel, but maintain correct order: navigate → wait → snapshot → interact.

## Houston: Chrome on VM

Houston connects to Chrome on the VM via SSH tunnel (port 9222). **Chrome must be started on the VM** with remote debugging. The standard path is `http://127.0.0.1:9222/json/version`.

### Chrome 136+ (March 2025): /json/version returns 404

Google disabled remote debugging for the default Chrome profile. You **must** use `--user-data-dir` with an **absolute path** (Chrome does not expand `~`):

```bash
# On the VM - use absolute path (not ~/...)
google-chrome --remote-debugging-port=9222 --user-data-dir=/home/user/Desktop/chromiumData
```

Or with Chromium:
```bash
chromium --remote-debugging-port=9222 --user-data-dir=/home/user/Desktop/chromiumData
```

**Via run_ssh_command**: Redirect output or the SSH command will hang (Chrome keeps stderr open). Use:
```bash
DISPLAY=:0 chromium --remote-debugging-port=9222 --user-data-dir=/home/user/Desktop/chromiumData >/dev/null 2>&1 &
```

**Alternatives** if Chrome 136+ blocks you:
- **Chrome for Testing** – not affected by this restriction
- **Chromium** (open-source) – may still support default profile
- **Edge** or **Opera** – Chromium-based, may work

Verify on the VM: `curl http://127.0.0.1:9222/json/version` should return JSON with `webSocketDebuggerUrl`.

## Troubleshooting

If `chrome-devtools-mcp` is insufficient, guide users to use Chrome DevTools UI:

- https://developer.chrome.com/docs/devtools
- https://developer.chrome.com/docs/devtools/ai-assistance

If there are errors launching `chrome-devtools-mcp` or Chrome, refer to https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md.
