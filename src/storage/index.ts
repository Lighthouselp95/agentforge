import { StorageEngine } from './engine.js';
import { AgentStorage } from './agent-storage.js';
import { MessageStorage } from './message-storage.js';
import { QueueStorage } from './queue-storage.js';
import { SettingsStorage } from './settings-storage.js';
import { TeamSettingsStorage } from './team-settings.js';
import { LogStorage } from './log-storage.js';
import type {
  OutboxReport,
  ChatQueueItem,
  SystemLogEntry,
  StorageSchema,
  HistoryPageOptions,
  LogFilterOptions,
  ModelSettings,
  UpdateAgentOptions,
  TeamSettings,
  SpawnGateUsage,
  SpawnGateResult
} from './types.js';

export class AppStorage {
  public engine: StorageEngine;
  public agents: AgentStorage;
  public messages: MessageStorage;
  public queues: QueueStorage;
  public settings: SettingsStorage;
  public teamSettings: TeamSettingsStorage;
  public logs: LogStorage;

  constructor() {
    this.engine = new StorageEngine();
    this.agents = new AgentStorage(this.engine);
    this.messages = new MessageStorage(this.engine);
    this.queues = new QueueStorage(this.engine);
    this.settings = new SettingsStorage(this.engine);
    this.teamSettings = new TeamSettingsStorage(this.engine);
    this.logs = new LogStorage(this.engine);
  }

  // Delegate Agent methods
  saveAgent(agent: any): void {
    this.agents.saveAgent(agent);
  }

  updateAgent(id: string, updates: UpdateAgentOptions): void {
    this.agents.updateAgent(id, updates);
  }

  deleteAgent(id: string): void {
    this.agents.deleteAgent(id);
  }

  getAllAgents(): any[] {
    return this.agents.getAllAgents();
  }

  getAgent(id: string): any {
    return this.agents.getAgent(id);
  }

  updateAgentModel(id: string, model: string | null): boolean {
    return this.agents.updateAgentModel(id, model);
  }

  loadAgents(): any[] {
    return this.agents.loadAgents();
  }

  // Delegate Message methods
  saveMessage(msg: any): void {
    this.messages.saveMessage(msg);
  }

  getHistory(limit?: number, teamId?: string): any[] {
    return this.messages.getHistory(limit, teamId);
  }

  getHistoryByAgent(agentId: string, limit = 100): any[] {
    return this.messages.getHistoryByAgent(agentId, limit);
  }

  getHistoryPage(opts?: HistoryPageOptions): any[] {
    return this.messages.getHistoryPage(opts);
  }

  clearOrchestratorConversation(): void {
    this.messages.clearOrchestratorConversation();
  }

  clearAgentConversation(agentId: string): void {
    this.messages.clearAgentConversation(agentId);
  }

  loadHistory(limit?: number): any[] {
    return this.messages.loadHistory(limit);
  }

  // Delegate Queue methods
  enqueueOutbox(item: OutboxReport): void {
    this.queues.enqueueOutbox(item);
  }

  markOutboxDelivered(id: string): void {
    this.queues.markOutboxDelivered(id);
  }

  markOutboxInFlight(id: string): void {
    this.queues.markOutboxInFlight(id);
  }

  markOutboxFailed(id: string, err?: any): void {
    this.queues.markOutboxFailed(id, err);
  }

  getPendingOutbox(): OutboxReport[] {
    return this.queues.getPendingOutbox();
  }

  getOutboxRecord(id: string): OutboxReport | undefined {
    return this.queues.getOutboxRecord(id);
  }

  getOutboxForRetry(): OutboxReport[] {
    return this.queues.getOutboxForRetry();
  }

  resetOutboxAttempts(ids: string[]): void {
    this.queues.resetOutboxAttempts(ids);
  }

  pruneDeliveredOutbox(keep = 200): void {
    this.queues.pruneDeliveredOutbox(keep);
  }

  enqueueChatRetry(item: ChatQueueItem): void {
    this.queues.enqueueChatRetry(item);
  }

  getPendingChatQueue(): ChatQueueItem[] {
    return this.queues.getPendingChatQueue();
  }

  updateChatQueueItem(item: ChatQueueItem): void {
    this.queues.updateChatQueueItem(item);
  }

  removeChatQueueItem(id: string): void {
    this.queues.removeChatQueueItem(id);
  }

  pruneChatQueue(keep = 200): void {
    this.queues.pruneChatQueue(keep);
  }

  saveUnprocessedMessage(targetId: string, text: string): void {
    this.queues.saveUnprocessedMessage(targetId, text);
  }

  getUnprocessedMessages(targetId: string): string[] {
    return this.queues.getUnprocessedMessages(targetId);
  }

  getAllUnprocessedMessages(): Record<string, string[]> {
    return this.queues.getAllUnprocessedMessages();
  }

  clearUnprocessedMessages(targetId: string): void {
    this.queues.clearUnprocessedMessages(targetId);
  }

  // Delegate Settings methods
  getSetting(key: string, defaultValue?: any): any {
    return this.settings.getSetting(key, defaultValue);
  }

  setSetting(key: string, value: any): any {
    return this.settings.setSetting(key, value);
  }

  getAllSettings(): Record<string, any> {
    return this.settings.getAllSettings();
  }

  getModelSettings(): ModelSettings {
    return this.settings.getModelSettings();
  }

  setModelSettings(settings: {
    orchestratorModel?: string | null;
    defaultSubagentModel?: string | null;
    agentModelOverrides?: Record<string, string>;
  }): ModelSettings {
    return this.settings.setModelSettings(settings);
  }

  // Delegate Team Settings methods (live per-team limits)
  getTeamSettings(teamId: string): TeamSettings {
    return this.teamSettings.getTeamSettings(teamId);
  }

  setTeamSettings(teamId: string, patch: Partial<TeamSettings>): TeamSettings {
    return this.teamSettings.setTeamSettings(teamId, patch);
  }

  resetTeamSettings(teamId: string): TeamSettings {
    return this.teamSettings.resetTeamSettings(teamId);
  }

  checkTeamSpawnGate(teamId: string, role: string, usage: SpawnGateUsage): SpawnGateResult {
    return this.teamSettings.checkSpawnGate(this.getTeamSettings(teamId), role, usage);
  }

  // Delegate Log methods
  saveLog(entry: Omit<SystemLogEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number }): SystemLogEntry {
    return this.logs.saveLog(entry);
  }

  getLogs(opts?: LogFilterOptions): SystemLogEntry[] {
    return this.logs.getLogs(opts);
  }

  clearLogs(): void {
    this.logs.clearLogs();
  }

  // Lifecycle & Flush methods
  flush(): void {
    this.engine.flushSync();
  }

  checkpoint(): void {
    this.engine.flushSync();
  }

  close(): void {
    this.engine.flushSync();
  }
}

// Lazy initialization via Proxy: storage singleton is created only on FIRST actual property access,
// NOT during module evaluation. This avoids TDZ when storage is accessed during bootstrap
// (e.g., console.log override calls pushLogLine which accesses storage.saveLog).
let _storageInstance: AppStorage | null = null;
export function getStorageInstance(): AppStorage {
    if (_storageInstance === null) {
        _storageInstance = new AppStorage();
    }
    return _storageInstance;
}
export const storage = new Proxy({} as AppStorage, {
    get(_target, prop) {
        const inst = getStorageInstance();
        return (inst as any)[prop];
    },
    set(_target, prop, value) {
        const inst = getStorageInstance();
        (inst as any)[prop] = value;
        return true;
    },
    has(_target, prop) {
        const inst = getStorageInstance();
        return prop in inst;
    },
    ownKeys() {
        const inst = getStorageInstance();
        return Reflect.ownKeys(inst);
    },
    getOwnPropertyDescriptor(_target, prop) {
        const inst = getStorageInstance();
        return Reflect.getOwnPropertyDescriptor(inst, prop);
    },
});
// Re-exports of granular stores and utilities
export * from './types.js';
export * from './constants.js';
export * from './paths.js';
export * from './file-utils.js';
export * from './atomic-disk.js';
export * from './state-loader.js';
export * from './persistence-scheduler.js';
export * from './team-resolver.js';
export * from './chat-store.js';
export * from './agent-store.js';
export * from './outbox-store.js';
export * from './chat-queue-store.js';
export * from './logs-store.js';
export * from './settings-store.js';
export * from './engine.js';
export * from './agent-storage.js';
export * from './message-storage.js';
export * from './queue-storage.js';
export * from './settings-storage.js';
export * from './team-settings.js';
export * from './log-storage.js';

export default storage;
