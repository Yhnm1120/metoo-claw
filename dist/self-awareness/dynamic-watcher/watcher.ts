/**
 * Capability Watcher — 动态能力感知
 * 监听 skill/plugin 目录变化，实时更新注册表，无需重启。
 */

import { watch } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityRegistry } from '../capability-registry/registry';

export interface WatchTarget {
  path: string;
  type: 'skill' | 'plugin' | 'config';
  handler: (event: 'add' | 'unlink' | 'change', path: string) => void;
}

export class DynamicCapabilityWatcher {
  private watchers: Map<string, ReturnType<typeof watch>> = new Map();

  constructor(private readonly registry: CapabilityRegistry) {}

  /** 开始监听所有目标目录 */
  start(targets: WatchTarget[]): void {
    for (const target of targets) {
      if (this.watchers.has(target.path)) continue;
      
      const watcher = watch(target.path, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const fullPath = join(target.path, filename);
        target.handler(event === 'rename' ? 'add' : 'change', fullPath);
      });
      
      this.watchers.set(target.path, watcher);
    }
  }

  /** 停止所有监听 */
  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  /** 触发手动刷新 */
  async refresh(): Promise<void> {
    // TODO: 重新扫描所有目录，更新注册表
  }
}
