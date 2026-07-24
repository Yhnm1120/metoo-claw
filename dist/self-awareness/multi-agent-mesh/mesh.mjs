/**
 * Multi-Agent Mesh — 多 Agent 协同认知
 * 多个 Agent 同时运行时，知道彼此在干嘛，避免重复工作。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class MultiAgentMesh {
  constructor(agentId, storageDir) {
    this.agentId = agentId;
    this.storageDir = storageDir;
    this.meshFile = storageDir ? join(storageDir, 'agent-mesh.json') : null;
    if (storageDir && !existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }
  }

  /** 注册自己的状态（心跳） */
  announce(status) {
    const mesh = this.loadMesh();
    mesh[this.agentId] = {
      ...status,
      agent_id: this.agentId,
      last_heartbeat: Date.now(),
    };
    this.saveMesh(mesh);
  }

  /** 完成任务后通知 */
  completeTask(taskId, resultSummary) {
    const mesh = this.loadMesh();
    if (mesh[this.agentId]) {
      mesh[this.agentId].status = 'idle';
      mesh[this.agentId].completed_task = {
        task_id: taskId,
        result: resultSummary,
        completed_at: Date.now(),
      };
    }
    this.saveMesh(mesh);
  }

  /** 获取其他活跃 Agent（心跳 5 分钟内） */
  getActiveAgents() {
    const mesh = this.loadMesh();
    const now = Date.now();
    return Object.values(mesh)
      .filter(a => a.agent_id !== this.agentId && (now - a.last_heartbeat) < 5 * 60 * 1000)
      .sort((a, b) => b.last_heartbeat - a.last_heartbeat);
  }

  /** 检查是否有其他 Agent 在做相似任务（避免重复） */
  isAnyoneDoing(taskDescription) {
    const active = this.getActiveAgents();
    const keywords = taskDescription.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    for (const agent of active) {
      if (!agent.current_task) continue;
      const agentKeywords = agent.current_task.toLowerCase();
      const overlap = keywords.filter(k => agentKeywords.includes(k));
      if (overlap.length >= Math.min(2, keywords.length)) {
        return {
          found: true,
          agent: agent.agent_id,
          their_task: agent.current_task,
          overlap,
        };
      }
    }
    return { found: false };
  }

  /** 认领任务（防止多个 Agent 同时做同一件事） */
  claimTask(taskId, taskDescription) {
    const mesh = this.loadMesh();
    // 检查是否已被认领
    for (const agent of Object.values(mesh)) {
      if (agent.agent_id !== this.agentId && agent.claimed_task_id === taskId) {
        const age = Date.now() - (agent.last_heartbeat || 0);
        if (age < 5 * 60 * 1000) {
          return { claimed: false, by: agent.agent_id };
        }
      }
    }
    mesh[this.agentId] = {
      ...(mesh[this.agentId] || {}),
      agent_id: this.agentId,
      claimed_task_id: taskId,
      current_task: taskDescription,
      status: 'working',
      last_heartbeat: Date.now(),
    };
    this.saveMesh(mesh);
    return { claimed: true };
  }

  loadMesh() {
    if (!this.meshFile || !existsSync(this.meshFile)) return {};
    try {
      return JSON.parse(readFileSync(this.meshFile, 'utf-8'));
    } catch {
      return {};
    }
  }

  saveMesh(mesh) {
    if (!this.meshFile) return;
    writeFileSync(this.meshFile, JSON.stringify(mesh, null, 2));
  }
}
