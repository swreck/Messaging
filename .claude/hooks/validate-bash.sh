#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

if [[ "$COMMAND" =~ ^[[:space:]]*# ]]; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Commands starting with # (comments) cannot be auto-approved. Use plain commands."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qE '\bfor\s+\w+\s+in\b'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"For loops cannot be auto-approved. Split into separate Bash calls, or use Glob/Grep for file searching."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qE '\bwhile\b'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"While loops cannot be auto-approved. Split into separate Bash calls."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qF '&&'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Chained commands with && cannot be auto-approved. Split into separate Bash calls."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qF ';'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Chained commands with ; cannot be auto-approved. Split into separate Bash calls."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qF '$(' && ! echo "$COMMAND" | grep -qE '^[[:space:]]*gcloud (builds (list|log|describe)|run (services logs|jobs logs))\b'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Command substitution $() cannot be auto-approved. Split into separate Bash calls and use the output of the first as a literal value in the second."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qF '`'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Backtick command substitution cannot be auto-approved. Split into separate Bash calls and use the output of the first as a literal value in the second."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qE '\bgit\s+(--git-dir|--work-tree|-C)\b'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"git -C, --git-dir, and --work-tree are not allowed. Git auto-discovers .git by walking up from CWD, so just use absolute file paths as arguments (e.g., git add /full/path/to/file, git diff /full/path/to/file). Repo-level commands like git status and git commit work from any subdirectory."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qE '\bGIT_(DIR|WORK_TREE)='; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"GIT_DIR and GIT_WORK_TREE environment variables are not allowed. Git auto-discovers .git by walking up from CWD, so just use absolute file paths as arguments (e.g., git add /full/path/to/file, git diff /full/path/to/file). Repo-level commands like git status and git commit work from any subdirectory."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qE '\b(bash|sh|zsh|source)\s'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Running shell scripts (bash/sh/zsh/source) cannot be auto-approved. Run commands directly instead."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qE '\bcat\s.*>'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Writing files with cat/heredoc cannot be auto-approved. Use the Write tool instead."}}'
  exit 0
fi

if echo "$COMMAND" | grep -qE '<<'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Heredocs cannot be auto-approved. Use the Write tool to create files or run commands directly."}}'
  exit 0
fi

exit 0
