/**
 * Causal Chain Tracker — 行为因果链追踪器
 * Agent 的每个行为都有前因后果，形成可追溯的因果链。
 * 出问题能回溯根因，动手前能预判后果。
 */

export interface CausalEvent {
  event_id: string;
  timestamp: number;
  actor: string;
  triggered_by: {
    type: 'user_request' | 'agent_decision' | 'system_event';
    ref?: string;
    summary: string;
  };
  action: {
    type: 'tool_call' | 'file_modify' | 'config_change' | 'message_send';
    tool?: string;
    params?: Record<string, unknown>;
  };
  effects: Array<{
    type: 'state_change' | 'side_effect' | 'error';
    target: string;
    before?: string;
    after?: string;
  }>;
  caused_by: string[]; // 上游事件 id
  caused_events: string[]; // 下游事件 id
}

export class CausalChainTracker {
  private events: CausalEvent[] = [];
  private eventIndex: Map<string, CausalEvent> = new Map();

  constructor(private readonly sessionId: string) {}

  /** 记录一个行为事件 */
  recordEvent(event: Omit<CausalEvent, 'event_id' | 'caused_by' | 'caused_events'>): string {
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const lastEvent = this.events[this.events.length - 1];
    
    const fullEvent: CausalEvent = {
      ...event,
      event_id: eventId,
      caused_by: lastEvent ? [lastEvent.event_id] : [],
      caused_events: [],
    };
    
    this.events.push(fullEvent);
    this.eventIndex.set(eventId, fullEvent);
    
    // 更新上游事件的 caused_events
    if (lastEvent) {
      lastEvent.caused_events.push(eventId);
    }
    
    return eventId;
  }

  /** 追溯根因：从某个事件反向回溯到源头 */
  traceRootCause(eventId: string): CausalEvent[] {
    const chain: CausalEvent[] = [];
    const visited = new Set<string>();
    
    const trace = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      
      const event = this.eventIndex.get(id);
      if (!event) return;
      
      chain.unshift(event);
      for (const causeId of event.caused_by) {
        trace(causeId);
      }
    };
    
    trace(eventId);
    return chain;
  }

  /** 预测影响：基于历史因果记录预判当前行为的后果 */
  predictImpact(action: CausalEvent['action']): Array<{ effect: string; confidence: number }> {
    const similarEvents = this.events.filter(e => 
      e.action.type === action.type && e.action.tool === action.tool
    );
    
    const impactMap = new Map<string, number>();
    for (const event of similarEvents) {
      for (const effect of event.effects) {
        const key = `${effect.target}:${effect.type}`;
        impactMap.set(key, (impactMap.get(key) || 0) + 1);
      }
    }
    
    return Array.from(impactMap.entries())
      .map(([effect, count]) => ({
        effect,
        confidence: count / similarEvents.length,
      }))
      .filter(p => p.confidence > 0.3)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /** 生成因果链报告（用户问"为什么会这样"时用） */
  generateReport(eventId: string): string {
    const chain = this.traceRootCause(eventId);
    const lines: string[] = ['【因果链追溯】'];
    
    for (let i = 0; i < chain.length; i++) {
      const event = chain[i];
      const time = new Date(event.timestamp).toLocaleTimeString();
      const indent = '  '.repeat(i);
      lines.push(`${indent}${time} ${event.actor}: ${event.triggered_by.summary}`);
      for (const effect of event.effects) {
        lines.push(`${indent}  → ${effect.target}: ${effect.before || '?'} → ${effect.after || '?'}`);
      }
    }
    
    return lines.join('\n');
  }

  /** 获取完整因果链 */
  getChain(): CausalEvent[] {
    return [...this.events];
  }
}
