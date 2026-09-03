import type { StorageEngine } from './engine.js';
import type { ModelSettings } from './types.js';

export class SettingsStorage {
  constructor(private engine: StorageEngine) {}

  getSetting(key: string, defaultValue?: any): any {
    if (key in this.engine.inMemorySettings) return this.engine.inMemorySettings[key];
    return defaultValue;
  }

  setSetting(key: string, value: any): any {
    this.engine.inMemorySettings[key] = value;
    this.engine.schedulePersist();
    return value;
  }

  getAllSettings(): Record<string, any> {
    return { ...this.engine.inMemorySettings };
  }

  getModelSettings(): ModelSettings {
    return {
      orchestratorModel: this.engine.inMemorySettings.orchestratorModel || null,
      defaultSubagentModel: this.engine.inMemorySettings.defaultSubagentModel || null,
      agentModelOverrides: this.engine.inMemorySettings.agentModelOverrides || {}
    };
  }

  setModelSettings(settings: {
    orchestratorModel?: string | null;
    defaultSubagentModel?: string | null;
    agentModelOverrides?: Record<string, string>;
  }): ModelSettings {
    if ('orchestratorModel' in settings) {
      this.engine.inMemorySettings.orchestratorModel = settings.orchestratorModel || null;
    }
    if ('defaultSubagentModel' in settings) {
      this.engine.inMemorySettings.defaultSubagentModel = settings.defaultSubagentModel || null;
    }
    if ('agentModelOverrides' in settings) {
      this.engine.inMemorySettings.agentModelOverrides = settings.agentModelOverrides || {};
    }
    this.engine.schedulePersist();
    return this.getModelSettings();
  }
}
