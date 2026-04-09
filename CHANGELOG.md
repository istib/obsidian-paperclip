# Changelog

## 0.4.1

### Added
- Full-page kanban board view, available from the header toggle or the `Paperclip: Open kanban board` command

## 0.4.0

### Fixed
- Resolve all remaining Obsidian community plugin review issues
- Fix sentence case for all UI text (ribbon tooltip, modal headings, setting descriptions, placeholders)
- Remove forbidden `eslint-disable` directives for `obsidianmd/ui/sentence-case` in settings
- Replace inline `style.display` with CSS classes (`is-hidden`) in PaperclipView and CreateIssueModal
- Replace technical placeholders with sentence-case-compliant text in settings

## 0.3.0

### Added
- Inline comment form with toggle button
- @mention autocomplete in comment textarea
- Status bounce on agent assign (backlog → in_progress)
- Detail view refresh button

## 0.2.0

### Added
- AI-powered issue creation from selection or full document
- Kanban board view
- Assign-to-me option
- Collapsible project groups
- Vault file linking in descriptions

### Fixed
- Address initial Obsidian review bot feedback (floating promises, command IDs, onunload leaf detach, `any` types, `require()` imports)

## 0.1.0

### Added
- Initial release
- Browse and manage Paperclip issues from the sidebar
- Create issues with agent assignment
- Comment on issues
- Settings for API URL, API key, company ID
