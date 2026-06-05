# Codex Account Switch Electron

This is an independent Electron shell for the existing `webui`.

The current Windows Win32/WebView2 application remains unchanged. This shell is intended to make the same UI available on macOS later with a small Node host layer for account switching.

## Development

```powershell
cd electron
npm install
npm run dev
```

## Packaging

```powershell
cd electron
npm run dist:mac
```

The first version supports the core desktop flow:

- load and save app config
- list backed-up accounts
- back up the current `~/.codex/auth.json`
- switch to a saved account
- restart Codex or the selected IDE unless proxy stealth mode is enabled

Advanced Windows-only features such as local API proxying, WebDAV sync, OAuth import, quota refresh, and traffic statistics are intentionally stubbed in this shell for now.
