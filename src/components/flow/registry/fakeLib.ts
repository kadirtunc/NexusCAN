/** In-memory `FlowLibClient` with the backend's revision semantics (tests only). */
import type { FlowLibEntryDto, FlowLibRevisionDto } from '../../../types/flowLibrary';
import { parseFlowFile } from './flowBody';
import type { FlowLibClient } from './flowLibClient';

export class FakeLib implements FlowLibClient {
  readonly files = new Map<string, Map<number, string>>();
  readonly deleted = new Set<string>();
  saves = 0;
  async list(includeDeleted: boolean): Promise<FlowLibEntryDto[]> {
    const out: FlowLibEntryDto[] = [];
    for (const [id, revs] of this.files) {
      const latest = Math.max(...revs.keys());
      const parsed = parseFlowFile(revs.get(latest) as string);
      if (!parsed.ok) continue;
      const deleted = this.deleted.has(id);
      if (deleted && !includeDeleted) continue;
      out.push({ id, kind: parsed.file.kind, name: parsed.file.flow.name, latestRevision: latest, updatedAt: parsed.file.flow.updatedAt,
        origin: parsed.file.flow.origin, aiReviewed: parsed.file.flow.aiReviewed, contentHash: parsed.file.contentHash, tags: parsed.file.flow.tags, deleted });
    }
    return out;
  }
  async revisions(id: string): Promise<FlowLibRevisionDto[]> {
    const revs = this.files.get(id);
    if (!revs) throw new Error(`[flowlib:not_found] ${id}`);
    return [...revs.keys()].sort((a, b) => a - b).map((revision) => ({ revision, updatedAt: '', contentHash: '' }));
  }
  async load(id: string, revision: number | null): Promise<string> {
    const revs = this.files.get(id);
    if (!revs) throw new Error(`[flowlib:not_found] ${id}`);
    const text = revs.get(revision ?? Math.max(...revs.keys()));
    if (text === undefined) throw new Error(`[flowlib:not_found] ${id} r${String(revision)}`);
    return text;
  }
  async save(fileJson: string): Promise<FlowLibEntryDto> {
    this.saves += 1;
    const p = parseFlowFile(fileJson);
    if (!p.ok) throw new Error(`[flowlib:invalid] ${p.message}`);
    const revs = this.files.get(p.file.flow.id) ?? new Map<number, string>();
    const latest = revs.size === 0 ? 0 : Math.max(...revs.keys());
    if (p.file.flow.revision !== latest + 1) throw new Error(`[flowlib:conflict] revision ${p.file.flow.revision}, latest ${latest}`);
    revs.set(p.file.flow.revision, fileJson);
    this.files.set(p.file.flow.id, revs);
    this.deleted.delete(p.file.flow.id);
    return (await this.list(true)).find((x) => x.id === p.file.flow.id) as FlowLibEntryDto;
  }
  async delete(id: string): Promise<void> {
    if (!this.files.has(id)) throw new Error(`[flowlib:not_found] ${id}`);
    this.deleted.add(id);
  }
}
