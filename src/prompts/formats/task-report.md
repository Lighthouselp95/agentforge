# Task Report Format

Standardized JSON schema for all worker completion reports.

## Base Schema (All Workers)
```json
{
  "agent_id": "string",
  "role": "coder|tester|reviewer|docs|planner|researcher|verifier|debugger|searcher|idea",
  "task_id": "string",
  "status": "completed|failed|blocked",
  "summary": "Brief description of what was done",
  "files_changed": ["path/to/file.ts"],
  "details": "Optional detailed explanation",
  "issues": [
    {"severity": "high|medium|low", "description": "..."}
  ],
  "next_steps": ["suggestion 1", "suggestion 2"],
  "artifacts": {"key": "value"}
}
```

## Role-Specific Extensions

### Coder
```json
{
  "key_decisions": "Architectural choices made",
  "artifacts": {"build": "passed", "lint": "passed"}
}
```

### Tester
```json
{
  "test_results": "passed|failed",
  "coverage": "85%",
  "failures": [
    {"test": "name", "error": "details"}
  ]
}
```

### Reviewer
```json
{
  "overall": "approve|request_changes",
  "issues": [
    {"file": "x.ts", "line": 42, "severity": "critical", "message": "...", "suggestion": "..."}
  ]
}
```

### Verifier
```json
{
  "requirements_checked": 10,
  "requirements_passed": 9,
  "requirements_failed": 1,
  "details": [
    {"requirement": "Req 1", "result": "PASS", "evidence": "..."}
  ],
  "edge_cases_covered": true,
  "error_handling_verified": true,
  "regressions_found": []
}
```

### Debugger
```json
{
  "bug": "Description",
  "root_cause": "Exact cause",
  "fix": "What changed and why",
  "files_modified": ["file.ts"],
  "verification": "How fix was confirmed",
  "regression_risk": "low|medium|high",
  "similar_patterns_checked": ["file:line"]
}
```

### Researcher
```json
{
  "topic": "What was researched",
  "findings": [
    {"claim": "...", "source": "url", "confidence": "high|medium|low", "date_accessed": "2026-01-15"}
  ],
  "recommendation": "Actionable next step",
  "caveats": ["Limitation 1", "Conflicting info"],
  "sources": ["url1", "url2"]
}
```

### Searcher
```json
{
  "query": "What was searched",
  "results": 15,
  "matches": [
    {"file": "src/x.ts", "line": 23, "context": "function call"}
  ],
  "pattern": "Description of pattern found",
  "related": ["Related finding 1"]
}
```

### Planner
```json
{
  "plan": "High-level approach",
  "steps": [
    {"id": "1", "role": "coder", "task": "...", "depends_on": []}
  ],
  "dependencies": {"2": ["1"], "3": ["2"]}
}
```

### Docs
```json
{
  "documents_created": ["README.md", "API.md"],
  "sections": ["Installation", "Usage", "API Reference"]
}
```

### Idea
```json
{
  "prompt": "Original prompt",
  "top_recommendation": "Best idea with reasoning",
  "ideas": [
    {"title": "...", "description": "...", "why_it_fits": "...", "effort": "S|M|L", "risk": "low|medium|high", "affected_files": ["..."]}
  ],
  "next_steps": "What planner/coder should do next"
}
```

## Example Usage

### 1. XML Report Tag (Khuyến nghị):
```xml
<report status="completed">
AGENT_ID: agent-123
STATUS: completed
FILES: src/calculator.py
WHAT I DID: Created calculator with add, subtract, multiply, divide
KEY_DECISIONS: Used float type hints, ZeroDivisionError for divide by zero
</report>
```

Hoặc JSON bên trong thẻ `<report>`:
```xml
<report status="completed">
{
  "agent_id": "agent-123",
  "role": "coder",
  "task_id": "task-456",
  "status": "completed",
  "summary": "Created calculator with basic operations",
  "files_changed": ["src/calculator.py"],
  "key_decisions": "Used float type hints, ZeroDivisionError for divide by zero"
}
</report>
```

### 2. Classic Format (Tương thích):
```
[TO: orchestrator] Task complete.
=== TASK REPORT ===
AGENT_ID: agent-123
STATUS: completed
FILES: src/calculator.py
WHAT I DID: Created calculator with add, subtract, multiply, divide
KEY_DECISIONS: Used float type hints, ZeroDivisionError for divide by zero
=== END REPORT ===
```

## Reporting Frequency Rule
Mỗi agent chỉ báo cáo kết quả đúng 1 lần duy nhất. Nếu nội dung đã báo cáo y nguyên rồi thì tuyệt đối không báo cáo lại để tránh spam heartbeat/incoming loop.