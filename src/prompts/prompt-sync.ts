import { join, resolve } from 'path';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { loadPrompt, PROMPTS_CANDIDATE_DIRS } from './prompt-loader.js';

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  coder: 'Writes clean, correct, robust, production-ready code',
  verifier: 'Validates code correctness, edge cases, tests, and compliance',
  researcher: 'Finds information, explores codebases, reads documentation',
  debugger: 'Traces bugs, finds root causes, and fixes issues with minimal changes',
  docs: 'Writes clear, comprehensive, and up-to-date technical documentation',
  idea: 'Generates creative concepts, architectural approaches, and improvements',
  searcher: 'Locates files, functions, patterns, and references fast',
  reviewer: 'Reviews code quality, architecture, security, and performance',
  planner: 'Analyzes user tasks and creates detailed execution plans',
  tester: 'Writes and executes automated unit and integration tests',
  orchestrator: 'Main Orchestrator of AgentForge'
};

export function syncOpencodeAgents(serverProjectRoot: string, targetProjectDir?: string, defaultOrchPrompt?: string) {
  try {
    const isCustomDir = !!(targetProjectDir && resolve(targetProjectDir) !== resolve(serverProjectRoot));
    const agentsDir = isCustomDir ? join(targetProjectDir, '.opencode', 'agents') : join(serverProjectRoot, '.opencode', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    
    const workerBase = loadPrompt('worker-base.md') || '';
    const formatsSection = '';

    // 1. Sync Orchestrator
    const orchPrompt = loadPrompt('orchestrator.md') || defaultOrchPrompt || '';
    const orchAgentContent = `---
name: orchestrator
description: ${ROLE_DESCRIPTIONS.orchestrator}
mode: primary
permission:
  "*": deny
  edit:
    "*": deny
    "*.md": allow
  write:
    "*": deny
    "*.md": allow
  glob: allow
  webfetch: allow
  websearch: allow
  task: deny
  bash: deny
---

${orchPrompt}
`;
    writeFileSync(join(agentsDir, 'orchestrator.md'), orchAgentContent, 'utf-8');
    console.log(`[SSoT] Synced ${isCustomDir ? join(targetProjectDir!, '.opencode', 'agents') : '.opencode/agents'}/orchestrator.md`);

    // 2. Sync all worker roles
    const standardRoles = Object.keys(ROLE_DESCRIPTIONS).filter(r => r !== 'orchestrator');
    const rolesDir = PROMPTS_CANDIDATE_DIRS.map(d => join(d, 'roles')).find(d => existsSync(d)) || join(PROMPTS_CANDIDATE_DIRS[0], 'roles');
    let roleFiles: string[] = [];
    if (existsSync(rolesDir)) {
      roleFiles = readdirSync(rolesDir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
    }
    const allRoles = Array.from(new Set([...standardRoles, ...roleFiles]));

    for (const role of allRoles) {
      const rolePrompt = loadPrompt(join('roles', `${role}.md`));
      const desc = ROLE_DESCRIPTIONS[role] || `${role} worker agent`;
      
      const fullPrompt = `---
name: ${role}
description: ${desc}
mode: primary
permission:
  "*": allow
  task: deny
---

${workerBase}

${rolePrompt ? rolePrompt : `# Role: ${role}\nYou are the ${role} specialist worker agent.`}
`;
      writeFileSync(join(agentsDir, `${role}.md`), fullPrompt, 'utf-8');
      console.log(`[SSoT] Synced ${isCustomDir ? join(targetProjectDir!, '.opencode', 'agents') : '.opencode/agents'}/${role}.md`);
    }
  } catch (err: any) {
    console.warn(`[SSoT] Failed to sync .opencode/agents${targetProjectDir ? ` in ${targetProjectDir}` : ''}: ${err.message}`);
  }
}
