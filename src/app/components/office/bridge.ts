import type { Tool } from './library'

// Match the browsing context as well as the origin: another tab must not impersonate an editor.
export function editorMessage(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, origin: string, frames: Partial<Record<Tool, { contentWindow: Window | null } | null>>): Tool | undefined {
  if (event.origin !== origin || !event.source || !event.data || typeof event.data !== 'object') return
  const tool = (Object.keys(frames) as Tool[]).find(id => frames[id]?.contentWindow === event.source)
  if (!tool || !['gridcraft', 'pdfcraft'].includes(tool)) return
  if (!['ready', 'dirty', 'failed', 'save'].some(kind => event.data.type === `${tool}:${kind}`)) return
  return tool
}
