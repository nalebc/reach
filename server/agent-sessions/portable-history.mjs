// A durable, visible transcript. Context-window compaction belongs to the
// destination agent; transferring a conversation must not shorten its archive.
import { randomUUID } from 'node:crypto';
export function portableMessages(items) {
  return items.map(i => {
    const role = i.role === 'user' ? 'user' : 'assistant';
    const questions = (i.questions || []).map(q => [q.title, ...(q.options || []).map(o => `- ${o}`)].join('\n')).join('\n\n');
    const text = i.role === 'tool' ? `[Historical ${i.kind}${i.status ? ` · ${i.status}` : ''}]\n${i.text || ''}${i.detail ? `\n\n${i.detail}` : ''}`
      : i.role === 'system' ? `[${i.kind}] ${i.text || ''}` : [i.text || '', questions].filter(Boolean).join('\n\n');
    return { role, text, at: i.at, images: i.imageData || [] };
  }).filter(m => m.text || m.images.length);
}
export function codexArchive({ id = randomUUID(), cwd, items, from, name, now = Date.now() }) {
  const messages = portableMessages(items);
  messages.push({ role: 'assistant', text: `Continued with Codex · earlier messages are from ${from}`, at: now, images: [] });
  const e = (type, payload, at = now) => ({ timestamp: new Date(at).toISOString(), type, payload });
  const lines = [e('session_meta', { id, timestamp: new Date(now).toISOString(), cwd, originator: 'reach', cli_version: '0.158.0', source: 'vscode', model_provider: 'openai', history_mode: 'legacy' })];
  let turnId = null, last = '';
  const finish = at => { if (turnId) lines.push(e('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: last }, at)); };
  for (const m of messages) {
    const at = Number.isFinite(m.at) ? m.at : now;
    if (m.role === 'user' || !turnId) { finish(at); turnId = randomUUID(); lines.push(e('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(at / 1000) }, at)); }
    if (m.role === 'user') {
      lines.push(e('event_msg', { type: 'user_message', message: m.text, images: m.images, local_images: [], text_elements: [] }, at));
      lines.push(e('response_item', { type: 'message', role: 'user', content: [...(m.text ? [{ type: 'input_text', text: m.text }] : []), ...m.images.map(image_url => ({ type: 'input_image', image_url }))] }, at));
    } else {
      last = m.text;
      lines.push(e('event_msg', { type: 'agent_message', message: m.text, phase: null }, at));
      lines.push(e('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.text }] }, at));
    }
  }
  finish(now);
  return { id, lines };
}
export function claudeArchive({ id, cwd, title, items, from, version, model, gitBranch, now = Date.now() }) {
  const messages = portableMessages(items);
  messages.push({ role: 'assistant', text: `Continued with Claude Code · earlier messages are from ${from}`, at: now, images: [] });
  let parentUuid = null;
  const rows = [{ type: 'custom-title', customTitle: title, sessionId: id }];
  for (const m of messages) {
    const uuid = randomUUID();
    const content = [{ type: 'text', text: m.text }, ...m.images.map(uri => {
      const [, media_type, data] = /^data:([^;]+);base64,(.*)$/s.exec(uri) || [];
      if (!data) throw new Error('An attachment could not be preserved. The conversation was not moved.');
      return { type: 'image', source: { type: 'base64', media_type, data } };
    })];
    rows.push({ type: m.role, uuid, parentUuid, sessionId: id, cwd, version, gitBranch, timestamp: new Date(m.at || now).toISOString(), entrypoint: 'sdk-cli', isSidechain: false, userType: 'external', message: { role: m.role, content, ...(m.role === 'assistant' ? { id: `msg_${uuid}`, type: 'message', model: model || 'imported', stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } : {}) } });
    parentUuid = uuid;
  }
  return rows;
}
