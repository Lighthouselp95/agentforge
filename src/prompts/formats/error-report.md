# Error Report Format

Standardized format for reporting errors, failures, and blocked states.

## When to Use

- Agent encounters an error it cannot resolve
- Agent is blocked and needs help
- Task fails verification/testing
- Unexpected behavior occurs

## Format

```
[TO: orchestrator] I'm blocked.
=== ERROR REPORT ===
AGENT_ID: <your-id>
STATUS: blocked|failed
TASK_ID: <task-id>
ERROR: <brief error description>
CONTEXT: <what you were doing when error occurred>
DETAILS: <technical details, stack traces, error messages>
ATTEMPTED: <what you tried to fix it>
WHAT I NEED: <specific help needed - info, file access, decision, etc.>
=== END REPORT ===
```

## JSON Format (Preferred)

```json
{
  "agent_id": "string",
  "role": "string",
  "task_id": "string",
  "status": "blocked|failed",
  "error": "string",
  "context": "string",
  "details": "string",
  "attempted": ["string"],
  "what_i_need": "string",
  "severity": "high|medium|low"
}
```

## Severity Levels

| Severity | Description | Example |
|----------|-------------|---------|
| high | Task cannot proceed, critical failure | Missing required dependency, API key invalid |
| medium | Task delayed, workaround possible | Flaky test, ambiguous requirement |
| low | Minor issue, can continue | Typo in comment, non-critical warning |

## Examples

### Missing Dependency
```
[TO: orchestrator] I'm blocked.
=== ERROR REPORT ===
AGENT_ID: agent-123
STATUS: blocked
TASK_ID: task-456
ERROR: Cannot find module 'express' - not in package.json
CONTEXT: Setting up API server in src/server.ts
DETAILS: import express from 'express' fails with "Module not found"
ATTEMPTED: Checked package.json, express not listed. Tried npm install express but no package.json in project root.
WHAT I NEED: Confirm if I should add express to package.json or if there's a different HTTP library to use.
SEVERITY: high
=== END REPORT ===
```

### Ambiguous Requirement
```
[TO: orchestrator] I'm blocked.
=== ERROR REPORT ===
AGENT_ID: agent-123
STATUS: blocked
TASK_ID: task-456
ERROR: Requirement "handle errors gracefully" is ambiguous
CONTEXT: Implementing user authentication in src/auth.ts
DETAILS: Spec doesn't specify which error types to handle (network, validation, auth, server)
ATTEMPTED: Reviewed similar files in codebase. Found error handling patterns in src/api.ts but inconsistent.
WHAT I NEED: Clarification on which error types to handle and what "gracefully" means (retry, log, return error code, etc.)
SEVERITY: medium
=== END REPORT ===
```

### Test Failure
```
[TO: orchestrator] I'm blocked.
=== ERROR REPORT ===
AGENT_ID: agent-123
STATUS: failed
TASK_ID: task-456
ERROR: Integration test failing - database connection timeout
CONTEXT: Running tests for user service in test/user.service.test.ts
DETAILS: Test "should create user" fails after 5s with "connection timeout". Database appears to be running (port 5432 open).
ATTEMPTED: Checked database logs - no errors. Increased timeout to 10s. Test passes locally but fails in CI.
WHAT I NEED: Check if CI database config differs. May need to adjust test setup or use testcontainers.
SEVERITY: high
=== END REPORT ===
```

## Response Expectations

After sending an error report, the Orchestrator should:
1. Acknowledge receipt
2. Provide clarification, missing info, or decision
3. Or reassign task to another agent with context
4. Or adjust task scope/requirements

The agent should wait for Orchestrator response before continuing (unless the error is clearly transient and can be retried).