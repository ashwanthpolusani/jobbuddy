# Project Rules & Guidelines: Rolenaut / Scrapperbuddy

## 1. Git Operations & Push Policy (CRITICAL - STRICT ENFORCEMENT)
- **NEVER execute `git push` without explicit user permission.**
- Staging (`git add`) and local commits (`git commit`) are permitted after verification, but the repository MUST remain in a local-only state until the user reviews the changes and explicitly commands you to push (e.g., "push it", "go ahead and push", "deploy").
- When changes are committed, display a clear summary with the commit hash, changed files, and verified behavior, and ask the user if they would like to push to remote.
- Even if subagents finish, tests pass, or directors recommend deployment, DO NOT push automatically.

## 2. Zero Native Popups
- Do NOT use browser native dialogs: `alert()`, `confirm()`, or `prompt()`.
- Use accessible custom modals (`#db-modal`, `#delete-modal-backdrop`), `.inline-feedback` messages, and custom notifications.

## 3. Credential & URI Privacy
- Never log, display, or commit plain-text MongoDB Atlas connection strings containing passwords.
- Always normalize and mask connection strings (e.g., `cluster0.abcde.mongodb.net`) in the UI.
- Never transmit `[CONFIGURED]` mask strings in network request headers.

## 4. Error Isolation & UI Rendering
- Never conflate client-side JavaScript rendering exceptions with network or database connection errors.
- Any rendering error must fail gracefully and be logged to `console.error` without falsely triggering database connection failure banners.
