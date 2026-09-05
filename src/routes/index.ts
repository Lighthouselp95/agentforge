import { Router } from 'express';
import { createSystemRouter, type SystemRouteDeps } from './system.js';
import { createSettingsRouter, type SettingsRouteDeps } from './settings.js';
import { createModelsRouter, type ModelsRouteDeps } from './models.js';
import { createTerminalRouter, type TerminalRouteDeps } from './terminal.js';
import { createAgentsRouter, type AgentsRouteDeps } from './agents.js';
import { createChatRouter, type ChatRouteDeps } from './chat.js';
import { createTeamSettingsRouter, type TeamSettingsRouteDeps } from './team-settings.js';
import { createOrchestratorRouter, type OrchestratorRouteDeps } from './orchestrator.js';

export interface RouteDependencies {
  system: SystemRouteDeps;
  settings: SettingsRouteDeps;
  models: ModelsRouteDeps;
  terminal?: TerminalRouteDeps;
  agents?: AgentsRouteDeps;
  chat?: ChatRouteDeps;
  teams?: TeamSettingsRouteDeps;
  orchestrator?: OrchestratorRouteDeps;
}

export function createApiRouter(deps: RouteDependencies): Router {
  const router = Router();

  router.use('/', createSystemRouter(deps.system));
  router.use('/settings', createSettingsRouter(deps.settings));
  router.use('/models', createModelsRouter(deps.models));
  if (deps.agents) router.use('/agents', createAgentsRouter(deps.agents));
  // Chat router định nghĩa full path (/history, /messages, /chat, /chat/force-send)
  // nên mount tại `/` để giữ nguyên /api/history, /api/chat... như inline cũ.
  if (deps.chat) router.use('/', createChatRouter(deps.chat));
  if (deps.teams) router.use('/teams', createTeamSettingsRouter(deps.teams));
  if (deps.orchestrator) router.use('/orchestrator', createOrchestratorRouter(deps.orchestrator));

  return router;
}

export {
  createSystemRouter,
  createSettingsRouter,
  createModelsRouter,
  createTerminalRouter,
  createAgentsRouter,
  createChatRouter,
  createTeamSettingsRouter,
  createOrchestratorRouter,
  type SystemRouteDeps,
  type SettingsRouteDeps,
  type ModelsRouteDeps,
  type TerminalRouteDeps,
  type AgentsRouteDeps,
  type ChatRouteDeps,
  type TeamSettingsRouteDeps,
  type OrchestratorRouteDeps
};
