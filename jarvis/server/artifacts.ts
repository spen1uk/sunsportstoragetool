import { type DB, tx, id, now, sha256 } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { completeTask, createTask, logEvent } from './tasks.ts';

export type Source = { url: string; finalUrl: string; title: string; retrievedAt: string; sha256: string; flagged?: boolean };

export function createArtifact(db: DB, a: { taskId?: string | null; projectId?: string | null; title: string; content: string; sources: Source[]; createdBy: string; isDemo?: boolean; note?: string }) {
  const aid = id();
  tx(db, () => {
    db.prepare('INSERT INTO artifacts(id,task_id,project_id,title,current_version,status,is_demo,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(aid, a.taskId ?? null, a.projectId ?? null, a.title, 1, 'in_review', a.isDemo ? 1 : 0, now());
    db.prepare('INSERT INTO artifact_versions(artifact_id,version,content,sources,created_by,note,based_on,content_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(aid, 1, a.content, JSON.stringify(a.sources), a.createdBy, a.note ?? 'initial draft', null, sha256(a.content), now());
  });
  audit(db, a.createdBy, 'artifact.created', aid, { title: a.title });
  publish({ type: 'artifacts' });
  return aid;
}

/** Append-only: every change (revision or restore) is a new version; originals are never overwritten. */
export function addVersion(db: DB, artifactId: string, v: { content: string; sources?: Source[]; createdBy: string; note: string; basedOn: number }) {
  return tx(db, () => {
    const a = db.prepare('SELECT current_version, status FROM artifacts WHERE id=?').get(artifactId) as any;
    if (!a) throw new Error('artifact not found');
    if (a.status === 'deleted') throw new Error('artifact deleted');
    const base = db.prepare('SELECT sources FROM artifact_versions WHERE artifact_id=? AND version=?').get(artifactId, v.basedOn) as any;
    const next = a.current_version + 1;
    db.prepare('INSERT INTO artifact_versions(artifact_id,version,content,sources,created_by,note,based_on,content_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(artifactId, next, v.content, v.sources ? JSON.stringify(v.sources) : base?.sources ?? '[]', v.createdBy, v.note, v.basedOn, sha256(v.content), now());
    // A new version invalidates earlier acceptance: it must be reviewed again.
    db.prepare("UPDATE artifacts SET current_version=?, status='in_review' WHERE id=?").run(next, artifactId);
    audit(db, v.createdBy, 'artifact.version_added', artifactId, { version: next, basedOn: v.basedOn });
    publish({ type: 'artifacts' });
    return next;
  });
}

export function restoreVersion(db: DB, artifactId: string, version: number) {
  const old = db.prepare('SELECT content FROM artifact_versions WHERE artifact_id=? AND version=?').get(artifactId, version) as { content: string } | undefined;
  if (!old) throw new Error('version not found');
  return addVersion(db, artifactId, { content: old.content, createdBy: 'luke', note: `restored from v${version}`, basedOn: version });
}

/** Accepting a draft is NOT publishing. It records review evidence and completes the originating task. */
export function acceptArtifact(db: DB, artifactId: string, version: number) {
  const a = db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactId) as any;
  if (!a || a.current_version !== version || a.status !== 'in_review') return false;
  db.prepare("UPDATE artifacts SET status='approved' WHERE id=?").run(artifactId);
  const sha = (db.prepare('SELECT content_sha256 s FROM artifact_versions WHERE artifact_id=? AND version=?').get(artifactId, version) as any).s;
  audit(db, 'luke', 'artifact.accepted', artifactId, { version, sha256: sha });
  if (a.task_id) completeTask(db, a.task_id, 'luke', `accepted ${a.title} v${version} (sha256:${sha.slice(0, 12)})`);
  publish({ type: 'artifacts' });
  return true;
}

/** Anchored change request → revision task (original preserved; comparison is v(n) vs v(n+1)). */
export function requestRevision(db: DB, artifactId: string, anchor: string, instruction: string) {
  const a = db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactId) as any;
  if (!a) throw new Error('artifact not found');
  const rid = id();
  const taskId = createTask(db, { title: `Revise: ${a.title}`, description: instruction, kind: 'revision', projectId: a.project_id, priority: 2,
    input: { artifactId, baseVersion: a.current_version, anchor, instruction, requestId: rid }, idempotencyKey: `rev:${artifactId}:${a.current_version}:${sha256(anchor + '|' + instruction)}`, isDemo: !!a.is_demo });
  db.prepare("INSERT INTO review_requests(id,artifact_id,base_version,anchor,instruction,task_id,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(rid, artifactId, a.current_version, anchor, instruction, taskId, now());
  logEvent(db, taskId, 'revision_requested', instruction);
  return { requestId: rid, taskId };
}
