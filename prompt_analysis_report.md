# AgentForge System Prompt Analysis & Improvement Proposals

## Current State Analysis

### 1. Dual Orchestrator Prompts (Inconsistent)
- **src/prompts/orchestrator.md** (67 lines) - Simpler, markdown format
- **src/server.ts** ORCH_PROMPT constant (~100 lines) - More detailed, inline string
- Both exist but serve different purposes; server.ts version is what's actually used at runtime

### 2. Worker Role Prompts Location Mismatch
- **dist/prompts/agent-roles.js** defines 5 roles: coder, reviewer, tester, docs, planner
- **src/server.ts** references 9 roles: coder, tester, reviewer, docs, planner, researcher, verifier, debugger, searcher, idea
- **Missing roles** in agent-roles.js: researcher, verifier, debugger, searcher, idea

### 3. Communication Protocol Fragmentation
- Orchestrator uses: `[SPAWN]`, `[TALK]`, `[STOP]`, `[RESUME]`, `[DELETE]`, `[CREATE ROLE]`
- Workers use: `[TO: <target-id>]` format (defined in WORKER_FORMAT_BLOCK)
- Two different reporting formats:
  - Orchestrator expects: `=== TASK REPORT ===` with AGENT_ID, STATUS, FILES, WHAT I DID
  - Worker roles define their own formats (TASK REPORT, REVIEW REPORT, TEST REPORT, DOCS REPORT, PLAN REPORT)

### 4. Validation Gaps
- `validateWorkerCompletion()` only checks for `[TO: orchestrator]` + `=== TASK REPORT ===` + `STATUS: completed`
- Doesn't validate role-specific report formats
- No schema validation for agent-to-agent messages

### 5. Context Building Issues
- `buildTeam()` adds `WORKER_FORMAT_BLOCK` suffix for workers but not for orchestrator
- Team context format differs between initial spawn and resume
- No standardized way to pass file references, error contexts, or dependencies

---

## Proposed Improvements

### 1. Unified Prompt Architecture

**Create a single source of truth** at `src/prompts/` with:
```
src/prompts/
├── orchestrator.md          # Main orchestrator system prompt
├── worker-base.md           # Shared worker communication rules
├── roles/
│   ├── coder.md
│   ├── reviewer.md
│   ├── tester.md
│   ├── docs.md
│   ├── planner.md
│   ├── researcher.md        # NEW
│   ├── verifier.md          # NEW
│   ├── debugger.md          # NEW
│   ├── searcher.md          # NEW
│   └── idea.md              # NEW
└── formats/
    ├── task-report.md       # Standardized completion format
    ├── agent-message.md     # Inter-agent communication format
    └── error-report.md      # Standardized error reporting
```

### 2. Standardized Communication Protocol

**Single message format for ALL agents:**
```markdown
=== AGENT MESSAGE ===
FROM: <agent-id>
TO: <target-id>           # orchestrator | agent-id | broadcast
TYPE: task_report | status | question | handoff | error
TASK_ID: <correlation-id>  # Links related messages
CONTENT: <structured payload>
=== END MESSAGE ===
```

**Benefits:**
- Parseable by both humans and code
- Enables message routing, filtering, debugging
- Task correlation across agent handoffs

### 3. Structured Report Schemas

**Task Report (all workers):**
```json
{
  "agent_id": "agent-xyz",
  "role": "coder",
  "task_id": "task-123",
  "status": "completed|failed|blocked",
  "summary": "Brief description",
  "files_changed": ["path/to/file.ts"],
  "details": "Optional detailed explanation",
  "issues": [{"severity": "high|medium|low", "description": "..."}],
  "next_steps": ["suggestion 1", "suggestion 2"],
  "artifacts": {"test_results": "...", "coverage": "85%"}
}
```

**Review Report (reviewer):**
```json
{
  "agent_id": "...",
  "role": "reviewer",
  "task_id": "...",
  "overall": "approve|request_changes",
  "issues": [
    {"file": "x.ts", "line": 42, "severity": "critical", "message": "...", "suggestion": "..."}
  ],
  "summary": "..."
}
```

### 4. Enhanced Orchestrator Prompt (src/prompts/orchestrator.md)

Key additions:
- **Task decomposition template** with required fields
- **Agent selection guide** mapping task types to roles
- **Parallel execution rules** with dependency graph notation
- **Failure recovery patterns** (retry, reassign, escalate)
- **Synthesis instructions** for combining multi-agent results
- **Context passing standards** (file refs, error logs, test results)

### 5. Worker Base Prompt (src/prompts/worker-base.md)

Shared by all workers:
- Communication protocol (`[TO:]` format)
- Report format requirements
- Error handling (how to report blocked/failed)
- Tool usage guidelines (read before write, test before commit)
- Session management (preserve context across retries)

### 6. Role-Specific Prompts (src/prompts/roles/*.md)

Each role gets:
- **Purpose & scope** (what they do/don't do)
- **Input expectations** (what they receive from orchestrator)
- **Output contract** (structured report schema)
- **Best practices** for that role
- **Common pitfalls** to avoid

### 7. Server.ts Integration Changes

```typescript
// Load prompts from files at startup
const ORCH_PROMPT = await loadPrompt('orchestrator.md');
const WORKER_BASE = await loadPrompt('worker-base.md');
const ROLE_PROMPTS = await loadRolePrompts('roles/');

// Build worker prompt dynamically
function buildWorkerPrompt(role: string, agent: Agent): string {
  return `${WORKER_BASE}\n\n${ROLE_PROMPTS[role]}\n\n${WORKER_FORMAT_BLOCK}`;
}
```

---

## Implementation Priority

| Priority | Change | Impact |
|----------|--------|--------|
| **P0** | Consolidate dual orchestrator prompts | Eliminates confusion, single source of truth |
| **P0** | Add missing role prompts (researcher, verifier, debugger, searcher, idea) | Enables all 9 documented roles |
| **P1** | Standardize message format with TYPE field | Enables parsing, routing, debugging |
| **P1** | Structured JSON report schemas | Machine-parseable, enables automation |
| **P2** | Worker base prompt extraction | Reduces duplication, easier maintenance |
| **P2** | Role-specific prompt files | Clear contracts, easier onboarding |
| **P3** | Prompt hot-reload (dev mode) | Faster iteration on prompt engineering |

---

## Migration Strategy

1. **Phase 1**: Create new prompt files in `src/prompts/` mirroring current behavior
2. **Phase 2**: Update `server.ts` to load from files (with fallback to inline constants)
3. **Phase 3**: Add structured report parsing in `validateWorkerCompletion()` and `parseAgentOutput()`
4. **Phase 4**: Deprecate inline constants, remove `dist/prompts/agent-roles.js`
5. **Phase 5**: Add unit tests for prompt loading and message parsing

---

## Example: Improved Researcher Prompt

```markdown
# Role: Researcher

## Purpose
Find accurate, sourced information to unblock the team. Never guess — verify.

## Input Expectations
- Topic/question from orchestrator
- Optional: specific sources to check, constraints

## Output Contract (RESEARCH REPORT)
```json
{
  "agent_id": "...",
  "role": "researcher",
  "task_id": "...",
  "status": "completed",
  "findings": [
    {"claim": "...", "source": "url", "confidence": "high|medium|low", "date": "2026-01-15"}
  ],
  "recommendation": "Actionable next step",
  "caveats": ["Limitations", "Conflicting info"]
}
```

## Rules
1. Cite every claim with source + access date
2. Distinguish facts from opinions
3. Cross-reference multiple sources
4. Flag outdated information
5. Summarize — don't dump raw data
```

---

## Conclusion

The current system works but has **technical debt in prompt management** that will compound as roles grow. The proposed structure:
- **Single source of truth** for all prompts
- **Machine-parseable communication** enabling better monitoring/debugging
- **Role contracts** making agent behavior predictable
- **Extensible** for new roles without code changes

This aligns with AgentForge's goal of robust, scalable multi-agent collaboration.