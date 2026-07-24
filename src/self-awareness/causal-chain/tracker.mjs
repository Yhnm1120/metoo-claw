/**
 * Causal Chain Tracker — 行为因果链追踪器（JavaScript 版本）
 */

export class CausalChainTracker {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.events = [];
    this.eventIndex = new Map();
  }

  recordEvent(event) {
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const lastEvent = this.events[this.events.length - 1];
    
    const fullEvent = {
      ...event,
      event_id: eventId,
      caused_by: lastEvent ? [lastEvent.event_id] : [],
      caused_events: [],
    };
    
    this.events.push(fullEvent);
    this.eventIndex.set(eventId, fullEvent);
    
    if (lastEvent) {
      lastEvent.caused_events.push(eventId);
    }
    
    return eventId;
  }

  traceRootCause(eventId) {
    const chain = [];
    const visited = new Set();
    
    const trace = (id) => {
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

  predictImpact(action) {
    const similarEvents = this.events.filter(e => 
      e.action.type === action.type && e.action.tool === action.tool
    );
    
    const impactMap = new Map();
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

  generateReport(eventId) {
    const chain = this.traceRootCause(eventId);
    const lines = ['【因果链追溯】'];
    
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

  getChain() {
    return [...this.events];
  }
}
