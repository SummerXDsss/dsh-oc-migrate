export const nonEmpty = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
export function conversationLabel(title, messages, sourceID) {
  if (nonEmpty(title)) return { title: nonEmpty(title), titleOrigin: 'source' };
  const first = messages.find(message => message.role === 'user' && nonEmpty(message.text));
  if (first) {
    const characters = Array.from(first.text.replace(/\s+/g, ' ').trim());
    return { title: characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : ''), titleOrigin: 'first-message' };
  }
  return { title: '空白对话 · ' + sourceID.slice(-8), titleOrigin: 'empty' };
}
export function dshLabel(session) {
  const persisted = session.events.findLast(e => e.type === 'session/title' && nonEmpty(e.data?.title))?.data.title;
  const messages = session.events.filter(e => e.type === 'user/message').map(e => ({ role: 'user', text: e.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n') }));
  const label = conversationLabel(persisted ?? session.title, messages, session.header.id);
  if (!persisted && session.titleOrigin) label.titleOrigin = session.titleOrigin;
  return label;
}
export function openCodeLabel(transcript) {
  const messages = transcript.messages.filter(r => (r.info?.role ?? r.type) === 'user').map(r => ({ role: 'user', text: r.text ?? (r.parts ?? r.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n') }));
  return conversationLabel(transcript.info.title, messages, transcript.info.id);
}
