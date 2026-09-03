import { Router } from 'express';
import { createSystemRouter, type SystemRouteDeps } from './system.js';
import { createSettingsRouter, type SettingsRouteDeps } from './settings.js';
import { createModelsRouter, type ModelsRouteDeps } from './models.js';
import { createTerminalRouter, type TerminalRouteDeps } from './terminal.js';
import { createAgentsRouter, type AgentsRouteDeps } from './agents.js';
import { createChatRouter, type ChatRouteDeps } from './chat.js';

export interface RouteDependencies {
  system: SystemRouteDeps;
  settings: SettingsRouteDeps;
  models: ModelsRouteDeps;
  terminal?: TerminalRouteDeps;
  agents?: AgentsRouteDeps;
  chat?: ChatRouteDeps;
}

export function createApiRouter(deps: RouteDependencies): Router {
  const router = Router();

  router.use('/', createSystemRouter(deps.system));
  router.use('/settings', createSettingsRouter(deps.settings));
  router.use('/models', createModelsRouter(deps.models));
  if (deps.agents) router.use('/agents', createAgentsRouter(deps.agents));
  if (deps.chat) router.use('/chat', createChatRouter(deps.chat));

  return router;
}

export {
  createSystemRouter,
  createSettingsRouter,
  createModelsRouter,
  createTerminalRouter,
  createAgentsRouter,
  createChatRouter,
  type SystemRouteDeps,
  type SettingsRouteDeps,
  type ModelsRouteDeps,
  type TerminalRouteDeps,
  type AgentsRouteDeps,
  type ChatRouteDeps
};
