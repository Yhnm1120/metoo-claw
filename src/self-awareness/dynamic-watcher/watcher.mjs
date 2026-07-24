/**
 * Dynamic Capability Watcher — 动态能力感知（JavaScript 版本）
 */

import { watch } from 'node:fs';
import { join } from 'node:path';

export class DynamicCapabilityWatcher {
  constructor(registry) {
    this.registry = registry;
    this.watchers = new Map();
  }

  start(targets) {
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

  stop() {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  async refresh() {
    // TODO: 重新扫描所有目录，更新注册表
  }
}
