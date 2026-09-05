import type { StorageEngine } from './engine.js';
import type { TeamSettings, SpawnGateUsage, SpawnGateResult } from './types.js';
import { DEFAULT_TEAM_SETTINGS } from './types.js';

const STORE_KEY = 'teamSettings';

function isValidCount(v: any, min: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min;
}

function normRole(role: string): string {
  return (role || '').toLowerCase().trim();
}

export class TeamSettingsStorage {
  constructor(private engine: StorageEngine) {}

  private all(): Record<string, TeamSettings> {
    const raw = this.engine.inMemorySettings[STORE_KEY];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, TeamSettings>;
    return {};
  }

  private persistAll(map: Record<string, TeamSettings>): void {
    this.engine.inMemorySettings[STORE_KEY] = map;
    this.engine.schedulePersist();
  }

  /** Lấy settings của team (merge với default — team chưa custom vẫn trả đủ field). */
  getTeamSettings(teamId: string): TeamSettings {
    const tid = teamId || 'default';
    const saved = this.all()[tid] || {};
    return {
      taskLimit: isValidCount((saved as any).taskLimit, 1) ? (saved as any).taskLimit : DEFAULT_TEAM_SETTINGS.taskLimit,
      agentLimits: { ...DEFAULT_TEAM_SETTINGS.agentLimits, ...((saved as any).agentLimits && typeof (saved as any).agentLimits === 'object' ? (saved as any).agentLimits : {}) },
      maxTeamSize: isValidCount((saved as any).maxTeamSize, 1) ? (saved as any).maxTeamSize : DEFAULT_TEAM_SETTINGS.maxTeamSize,
      maxRoles: isValidCount((saved as any).maxRoles, 1) ? (saved as any).maxRoles : DEFAULT_TEAM_SETTINGS.maxRoles
    };
  }

  /**
   * Cập nhật settings của team (merge patch đã validate).
   * Ném Error với message mô tả khi giá trị không hợp lệ (route chuyển thành 400).
   */
  setTeamSettings(teamId: string, patch: Partial<TeamSettings>): TeamSettings {
    const tid = teamId || 'default';
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Settings patch phải là object.');
    }
    const current = this.getTeamSettings(tid);
    const next: TeamSettings = {
      taskLimit: current.taskLimit,
      agentLimits: { ...current.agentLimits },
      maxTeamSize: current.maxTeamSize,
      maxRoles: current.maxRoles
    };
    if (patch.taskLimit !== undefined) {
      if (!isValidCount(patch.taskLimit, 1)) throw new Error('taskLimit phải là số nguyên >= 1.');
      next.taskLimit = patch.taskLimit;
    }
    if (patch.maxTeamSize !== undefined) {
      if (!isValidCount(patch.maxTeamSize, 1)) throw new Error('maxTeamSize phải là số nguyên >= 1.');
      next.maxTeamSize = patch.maxTeamSize;
    }
    if (patch.maxRoles !== undefined) {
      if (!isValidCount(patch.maxRoles, 1)) throw new Error('maxRoles phải là số nguyên >= 1.');
      next.maxRoles = patch.maxRoles;
    }
    if (patch.agentLimits !== undefined) {
      if (!patch.agentLimits || typeof patch.agentLimits !== 'object' || Array.isArray(patch.agentLimits)) {
        throw new Error('agentLimits phải là object { role: limit }.');
      }
      for (const [rawRole, rawLimit] of Object.entries(patch.agentLimits)) {
        const role = normRole(rawRole);
        if (!role) throw new Error('agentLimits chứa role rỗng.');
        if (!isValidCount(rawLimit, 0)) throw new Error(`agentLimits["${rawRole}"] phải là số nguyên >= 0.`);
        next.agentLimits[role] = rawLimit as number;
      }
    }
    const map = this.all();
    map[tid] = next;
    this.persistAll(map);
    return next;
  }

  /** Xóa custom settings của team, quay về default. */
  resetTeamSettings(teamId: string): TeamSettings {
    const tid = teamId || 'default';
    const map = this.all();
    delete map[tid];
    this.persistAll(map);
    return this.getTeamSettings(tid);
  }

  /** Trần role hiệu lực: ưu tiên agentLimits của team, fallback coder 4 / researcher 2 / khác 1. */
  getRoleLimit(settings: TeamSettings, role: string): number {
    const r = normRole(role);
    if (r && Object.prototype.hasOwnProperty.call(settings.agentLimits, r)) {
      return settings.agentLimits[r];
    }
    if (r === 'coder') return 4;
    if (r === 'researcher') return 2;
    return 1;
  }

  /**
   * Cổng kiểm tra sống trước mỗi spawn: UI và server dùng chung logic này.
   * Thứ tự gate: TEAM_LIMIT → ROLE_LIMIT → ROLES_LIMIT.
   */
  checkSpawnGate(settings: TeamSettings, role: string, usage: SpawnGateUsage): SpawnGateResult {
    const r = normRole(role) || '(unknown)';
    if (usage.teamSize >= settings.maxTeamSize) {
      return {
        canSpawn: false,
        reason: `Team đã đạt tối đa ${settings.maxTeamSize} thành viên (hiện có ${usage.teamSize}).`,
        code: 'TEAM_LIMIT'
      };
    }
    const roleLimit = this.getRoleLimit(settings, role);
    if (usage.roleCount >= roleLimit) {
      return {
        canSpawn: false,
        reason: `Đã đạt giới hạn vai trò '${r}' trong team (hiện có ${usage.roleCount}/${roleLimit}). Tái sử dụng agent hiện có.`,
        code: 'ROLE_LIMIT'
      };
    }
    if (!usage.roleExists && usage.distinctRoles >= settings.maxRoles) {
      return {
        canSpawn: false,
        reason: `Team đã đạt tối đa ${settings.maxRoles} vai trò phân biệt (role '${r}' chưa tồn tại trong team).`,
        code: 'ROLES_LIMIT'
      };
    }
    return { canSpawn: true, reason: 'OK', code: 'OK' };
  }
}
