# Claude Code plugin runtime facts (docs fetched 2026-11-18, Claude Code 2.1.327)

Sources: code.claude.com/docs/en/plugins/{components,manifest-reference,loading,cli-reference,install}.md, skills.md, headless.md, env-vars.md.

- `plugin/bin/*` is on the Bash tool's `PATH` while the plugin is enabled (after the user's PATH; cannot shadow system commands). Needs the executable bit (`chmod +x`; commit with mode 100755).
- `${CLAUDE_PLUGIN_ROOT}` (versioned cache dir, changes on update) and `${CLAUDE_SKILL_DIR}` are substituted **in SKILL.md text and in `allowed-tools` Bash rules**. They are **not** environment variables inside Bash tool commands — write the literal `${CLAUDE_PLUGIN_ROOT}` in the skill text.
- `${CLAUDE_PLUGIN_DATA}` = `~/.claude/plugins/data/<id>/`, persistent across updates: use it for user-added icon packs and lockfiles.
- Install copies the plugin dir to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`; files outside `plugin/` are not available. A `package.json` + lockfile in the plugin triggers an install at copy time (60 s), so ship a **self-contained bundle** and no package.json in `plugin/`.
- Version: plugin.json `version` wins; users keep the cached copy until it is bumped.
- Skill frontmatter: `allowed-tools: Bash(pcosmo *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/pcosmo.mjs *)`; `argument-hint`; `$ARGUMENTS`; `disable-model-invocation: true` blocks auto-invocation; supporting files linked relatively; keep SKILL.md < 500 lines.
- Headless test: `CLAUDE_CONFIG_DIR=<tmp> claude plugin marketplace add <owner/repo | path>`, `claude plugin install platformcosmo@platformcosmo`, then `claude -p "/platformcosmo:diagram …" --allowedTools "Bash(pcosmo *),Write,Read" --permission-mode acceptEdits`. `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` waits for install. `--plugin-dir <path>` loads a local plugin for one session.
