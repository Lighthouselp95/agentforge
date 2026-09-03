import { Router } from 'express';

export interface ModelsRouteDeps {
  getAvailableModels: (force?: boolean) => Promise<string[]>;
  getCachedModels: () => string[];
}

export function createModelsRouter(deps: ModelsRouteDeps): Router {
  const router = Router();

  // GET /api/models
  router.get('/', async (req, res) => {
    try {
      const force = req.query.refresh === 'true';
      const models = await deps.getAvailableModels(force);
      res.json({ models });
    } catch (e: any) {
      res.json({ models: deps.getCachedModels(), error: e.message });
    }
  });

  return router;
}
