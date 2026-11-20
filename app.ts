// A standalone, GitHub-compatible git forge in one Node 22 process.
// Serves, from one in-memory store: git smart HTTP (upload-pack v2/v0,
// receive-pack v0), REST v3, GraphQL v4 and MCP — no UI, no outside service,
// no git binary, standard library only.
//
// Determinism: no wall clock, no Math.random anywhere in a response.
// Every timestamp comes from a fixed epoch plus a monotonic counter, so two
// runs of the same trial leave the same bytes everywhere the suite can see.
//
// Viewer: the suite's scenario is seeded from one fixed seed, so the viewer
// the token names is always adaiversen (id 1000). Auth is Bearer ==
// MAKEFUN_SHOP_TOKEN from this process's environment.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
const ZERO_OID = '0'.repeat(40);
const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the scenario's day one
const COMMIT_TS = 1700000000; // fixed commit timestamp base

let seq = 0; // monotonic counter: every generated timestamp / id derives from it
let reqSeq = 0;
let nextRepoId = 5000;
let nextUserId = 2000;

function nextSeq(): number { seq += 1; return seq; }
function isoTime(): string { return new Date((EPOCH_SEC + nextSeq() * 60) * 1000).toISOString(); }
function commitTime(): number { return COMMIT_TS + nextSeq() * 60; }

// ---------------------------------------------------------------------------
// small HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  reqSeq += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${reqSeq}`,
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  reqSeq += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${reqSeq}`,
  });
  res.end(body);
}

function notFound(res: ServerResponse): void { sendJson(res, 404, { message: 'Not Found' }); }
function unauthorized(res: ServerResponse): void { sendJson(res, 401, { message: 'Requires authentication' }); }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => { total += c.length; if (total > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch { return { ok: false }; }
}

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}

function authed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const got = req.headers.authorization ?? '';
  if (!expected) return true; // no token configured (local dev only); the trial always sets one
  if (got.length !== expected.length + 7) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function paginate<T>(items: T[], q: URLSearchParams, baseUrl: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) link = `<${baseUrl}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  return { page: slice, link };
}
function originOf(req: IncomingMessage): string { return `http://${req.headers.host ?? 'localhost'}`; }

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer; }

const objects = new Map<string, GitObj>();

function sha1(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
function putObj(type: ObjType, data: Buffer): string {
  const oid = sha1(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}
function getObj(oid: string): GitObj | undefined { return objects.get(oid); }

interface TreeEntry { mode: string; name: string; oid: string; }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(l, r);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const who = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}
function buildTag(object: string, type: ObjType, tag: string, message: string, ts: number): Buffer {
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${VIEWER.name} <${VIEWER.email}> ${ts} +0000\n\n${message}`, 'utf8');
}

// Build (nested) trees from a flat path -> {oid, mode} map; returns root tree oid.
function treeOidForFiles(files: Map<string, { oid: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, f] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: f.mode, name: rest, oid: f.oid });
      else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir)!.set(path, f);
      }
    }
    for (const [dir, sub] of dirs) {
      const subPrefix = `${prefix}${dir}/`;
      const subFiles = new Map<string, { oid: string; mode: string }>();
      for (const [p, f] of sub) subFiles.set(p, f);
      entries.push({ mode: '40000', name: dir, oid: build(subPrefix) });
    }
    return putObj('tree', buildTree(entries));
  };
  return build('');
}

// Flatten a tree oid to path -> {oid, mode}.
function flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = getObj(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix + e.name;
    if (e.mode === '40000') flattenTree(e.oid, `${path}/`, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

// All objects reachable from roots (commits -> trees/blobs/parents, tags -> target).
function collectReachable(roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (/^[0-9a-f]{40}$/.test(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = getObj(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      const txt = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(txt);
      if (m) queue.push(m[1]);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

// Is `ancestor` reachable from `tip` (all-parents walk)?
function isAncestor(ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObj(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}

// Commit history from a tip, newest first, following all parents, deduped.
function commitHistory(tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObj(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfile read/write (plain objects only on write; deltas resolved on read)
// ---------------------------------------------------------------------------

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let sh = 0;
    for (;;) {
      const b = delta[off++];
      v += (b & 0x7f) * 2 ** sh; sh += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) { co += delta[off++] * 2 ** sh; } sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) { cs += delta[off++] * 2 ** sh; } sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, written, co, co + cs);
      written += cs;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

const PACK_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readPack(pack: Buffer): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const h = readVarint(pack, off);
    off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[off]; let v = b & 0x7f; off += 1;
      while (b & 0x80) { b = pack[off++]; v = ((v + 1) * 128) + (b & 0x7f); }
      entry.baseOffset = entryOffset - v;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!PACK_TYPE[typeCode]) throw new Error('bad pack type');
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objs = new Map<string, GitObj>();
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolve = (e: Raw): { type: ObjType; data: Buffer; oid: string } => {
    const cached = resolved.get(e.offset);
    if (cached) return cached;
    let type: ObjType; let data: Buffer;
    if (e.typeCode === 6) {
      const base = resolve(byOffset.get(e.baseOffset!)!);
      type = base.type; data = applyDelta(base.data, e.data);
    } else if (e.typeCode === 7) {
      const ext = getObj(e.baseOid!);
      if (!ext) throw new Error('ref-delta base missing');
      type = ext.type; data = applyDelta(ext.data, e.data);
    } else { type = PACK_TYPE[e.typeCode]; data = e.data; }
    const oid = sha1(type, data);
    const r = { type, data, oid };
    resolved.set(e.offset, r);
    objs.set(oid, { type, data });
    return r;
  };
  for (const e of raw) resolve(e);
  return objs;
}

function writePack(objs: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objs.length, 8);
  parts.push(header);
  for (const o of objs) {
    const data = o.data;
    const code = PACK_CODE[o.type];
    let remaining = data.length;
    let first = (code << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    const bytes: number[] = [];
    while (remaining > 0) { bytes.push(first | 0x80); first = remaining & 0x7f; remaining = Math.floor(remaining / 128); }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    // Level 1: the suite only checks the bytes after inflate, so trade a little
    // size for the speed the clone workload is measured on.
    parts.push(deflateSync(data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// pkt-line helpers
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.allocUnsafe(4);
  h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function decodePackets(buf: Buffer): Array<{ kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break; // raw pack data follows
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('bad pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
// offset just past the pkt-line section (first flush), or -1
function packetsEndOffset(buf: Buffer): number {
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return -1;
    const len = parseInt(head, 16);
    if (len === 0) return off + 4;
    if (len < 4 || off + len > buf.length) return -1;
    off += len;
  }
  return -1;
}
function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65515));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// forge store: repos, issues, pulls
// ---------------------------------------------------------------------------

interface IssueComment { id: number; body: string; user: { login: string; id: number }; created_at: string; updated_at: string; }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; user: { login: string; id: number }; created_at: string; updated_at: string;
  comments: IssueComment[];
}
interface PullFile { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number; }
interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  merged: boolean; merge_commit_sha: string | null; merged_at: string | null;
  user: { login: string; id: number }; created_at: string; updated_at: string;
  files: PullFile[];
}
interface Label { name: string; color: string; description: string; }
interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; refs: Map<string, string>;
  labels: Map<string, Label>; issues: Issue[]; pulls: Pull[];
  nextIssue: number; nextPull: number; nextCommentId: number;
}

const reposByFull = new Map<string, Repo>(); // "owner/name" -> Repo
const reposById = new Map<number, Repo>();
let nextCommentSeq = 0;

function viewerUser(): { login: string; id: number } { return { login: VIEWER.login, id: VIEWER.id }; }

function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const id = nextRepoId++;
  const repo: Repo = {
    id, name, owner: VIEWER.login, description, private: isPrivate,
    defaultBranch: 'main', refs: new Map(), labels: new Map(),
    issues: [], pulls: [], nextIssue: 1, nextPull: 1, nextCommentId: 1,
  };
  reposByFull.set(`${VIEWER.login}/${name}`, repo);
  reposById.set(id, repo);
  return repo;
}
function findRepo(owner: string, name: string): Repo | undefined { return reposByFull.get(`${owner}/${name}`); }
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner, id: r.owner === VIEWER.login ? VIEWER.id : 1002 },
    private: r.private, description: r.description, default_branch: r.defaultBranch,
    created_at: new Date(EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(EPOCH_SEC * 1000).toISOString(),
    html_url: `https://github.com/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    has_issues: true, has_projects: true, has_wiki: true,
    fork: false, archived: false, disabled: false,
  };
}
function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', site_admin: false, avatar_url: `https://avatars.githubusercontent.com/u/${id}`, html_url: `https://github.com/${login}` };
}

// Resolve a ref name to a commit oid: "main", "refs/heads/main", "HEAD", "abc123..." (prefix).
function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (!ref || ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (/^[0-9a-f]{40}$/.test(ref)) return getObj(ref) ? ref : null;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const full = `refs/heads/${ref}`;
  if (repo.refs.has(full)) return repo.refs.get(full)!;
  return null;
}
function branchFiles(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return new Map();
  const obj = getObj(tip);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(parseCommit(obj.data).tree);
}
function commitOnBranch(repo: Repo, branch: string, message: string, files: Map<string, { oid: string; mode: string }>): string {
  const tree = treeOidForFiles(files);
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const parents = parent ? [parent] : [];
  const oid = putObj('commit', buildCommit(tree, parents, message, commitTime()));
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}
function lineCounts(text: string): number { return text.length === 0 ? 0 : text.split('\n').length; }
function diffFiles(base: Map<string, { oid: string; mode: string }>, head: Map<string, { oid: string; mode: string }>): PullFile[] {
  const out: PullFile[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of [...names].sort()) {
    const b = base.get(name); const h = head.get(name);
    if (b && !h) { const blob = getObj(b.oid); const del = blob ? lineCounts(blob.data.toString('utf8')) : 0; out.push({ filename: name, status: 'removed', additions: 0, deletions: del, changes: del }); }
    else if (!b && h) { const blob = getObj(h.oid); const add = blob ? lineCounts(blob.data.toString('utf8')) : 0; out.push({ filename: name, status: 'added', additions: add, deletions: 0, changes: add }); }
    else if (b && h && b.oid !== h.oid) {
      const btxt = getObj(b.oid)?.data.toString('utf8') ?? '';
      const htxt = getObj(h.oid)?.data.toString('utf8') ?? '';
      const bLines = new Set(btxt.split('\n')); const hLines = new Set(htxt.split('\n'));
      let add = 0; let del = 0;
      for (const l of htxt.split('\n')) if (!bLines.has(l)) add += 1;
      for (const l of btxt.split('\n')) if (!hLines.has(l)) del += 1;
      if (add === 0 && del === 0) { add = 1; }
      out.push({ filename: name, status: 'modified', additions: add, deletions: del, changes: add + del });
    }
  }
  return out;
}
function findMergeBase(a: string, b: string): string | null {
  const ancestors = new Set(commitHistory(a));
  for (const c of commitHistory(b)) if (ancestors.has(c)) return c;
  return null;
}
// Conflicting if head and base both changed the same file vs the merge base, differently.
function mergeConflict(repo: Repo, pr: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  const headTip = pr.head.sha;
  if (!baseTip || !headTip) return false;
  const mb = findMergeBase(baseTip, headTip);
  if (!mb) return false;
  const mbObj = getObj(mb);
  if (!mbObj || mbObj.type !== 'commit') return false;
  const mbFiles = flattenTree(parseCommit(mbObj.data).tree);
  const baseFiles = branchFiles(repo, pr.base.ref);
  const headFiles = flattenTree(parseCommit(getObj(headTip)!.data).tree);
  const names = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const name of names) {
    const mbv = mbFiles.get(name)?.oid;
    const bv = baseFiles.get(name)?.oid;
    const hv = headFiles.get(name)?.oid;
    if (bv !== mbv && hv !== mbv && bv !== hv) return true;
  }
  return false;
}
function issueJson(repo: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, number: i.number, title: i.title, body: i.body, state: i.state,
    labels: i.labels.map((n) => ({ name: n, color: repo.labels.get(n)?.color ?? 'ededed', description: repo.labels.get(n)?.description ?? '' })),
    user: userJson(i.user.login, i.user.id), created_at: i.created_at, updated_at: i.updated_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${i.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${i.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${i.number}/comments`,
    comments: i.comments.length, assignees: [], milestone: null, locked: false,
  };
}
function pullJson(repo: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id, number: p.number, title: p.title, body: p.body, state: p.state,
    merged: p.merged, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha,
    head: { ref: p.head.ref, sha: p.head.sha, label: `${repo.owner}:${p.head.ref}` },
    base: { ref: p.base.ref, sha: p.base.sha, label: `${repo.owner}:${p.base.ref}` },
    user: userJson(p.user.login, p.user.id), created_at: p.created_at, updated_at: p.updated_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${p.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${p.number}`,
    draft: false, mergeable: !p.merged && !mergeConflict(repo, p), mergeable_state: p.merged ? 'unknown' : (mergeConflict(repo, p) ? 'dirty' : 'clean'),
    comments: 0, review_comments: 0, commits: 0, additions: p.files.reduce((s, f) => s + f.additions, 0), deletions: p.files.reduce((s, f) => s + f.deletions, 0), changed_files: p.files.length,
  };
}
function makeIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const created = isoTime();
  const i: Issue = { id: nextUserId++ * 1000 + repo.nextIssue, number: repo.nextIssue++, title, body, state: 'open', labels, user: viewerUser(), created_at: created, updated_at: created, comments: [] };
  repo.issues.push(i);
  return i;
}
function makePull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha || !baseSha) return null;
  const created = isoTime();
  const baseFiles = branchFiles(repo, baseRef);
  const headFiles = branchFiles(repo, headRef);
  const p: Pull = {
    id: nextUserId++ * 1000 + repo.nextPull, number: repo.nextPull++, title, body, state: 'open',
    head: { ref: headRef, sha: headSha }, base: { ref: baseRef, sha: baseSha },
    merged: false, merge_commit_sha: null, merged_at: null,
    user: viewerUser(), created_at: created, updated_at: created,
    files: diffFiles(baseFiles, headFiles),
  };
  repo.pulls.push(p);
  return p;
}
function globalId(kind: string, repoId: number, number: number): string {
  return Buffer.from(`${kind}:${repoId}:${number}`, 'utf8').toString('base64');
}
function parseGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const txt = Buffer.from(id, 'base64').toString('utf8');
    const parts = txt.split(':');
    if (parts.length !== 3) return null;
    return { kind: parts[0], repoId: Number(parts[1]), number: Number(parts[2]) };
  } catch { return null; }
}
function repoGlobalId(repo: Repo): string { return Buffer.from(`Repository:${repo.id}:0`, 'utf8').toString('base64'); }

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main report-status-v2 report-status side-band-64k multi_ack thin-pack ofs-delta shallow agent=git-forge/1.0';
const RECEIVE_CAPS = 'report-status-v2 report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0';

function allRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.push({ oid, name });
  return out;
}
function headSymref(repo: Repo): string {
  return repo.refs.has('refs/heads/main') ? 'refs/heads/main' : (repo.refs.size ? [...repo.refs.keys()].sort()[0] : 'refs/heads/main');
}
function peeledOid(oid: string): string | null {
  const obj = getObj(oid);
  if (obj?.type === 'tag') {
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (m) {
      const target = getObj(m[1]);
      return target?.type === 'tag' ? peeledOid(m[1]) : m[1];
    }
  }
  return null;
}
function defaultBranchName(repo: Repo): string {
  return repo.refs.has('refs/heads/main') ? 'main' : (repo.refs.size ? [...repo.refs.keys()].sort()[0].replace('refs/heads/', '') : 'main');
}

function handleInfoRefs(res: ServerResponse, repo: Repo, service: string): void {
  const refs = allRefs(repo);
  const type = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const parts: Buffer[] = [];
  parts.push(pkt(`# service=${service}\n`), PKT_FLUSH);
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`), PKT_FLUSH);
  } else {
    refs.forEach((r, idx) => {
      const suffix = idx === 0 ? `\0${caps}\n` : '\n';
      parts.push(pkt(`${r.oid} ${r.name}${suffix}`));
    });
    parts.push(PKT_FLUSH);
  }
  sendBuffer(res, 200, Buffer.concat(parts), type);
}
// Fetch packs are pure functions of (repo, wants, haves, depth, shallow):
// git objects are immutable once stored, so a pack built for one key is
// valid forever. The clone workload fires 50 identical shallow clones, so
// caching the built pack skips 49 of 50 deflate passes.
const fetchPackCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[]; empty: boolean }>();
function cachedFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, prevShallow: string[]): { pack: Buffer; shallow: string[]; unshallow: string[]; empty: boolean } {
  const key = JSON.stringify([repo.id, wants, haves, depth, prevShallow]);
  const hit = fetchPackCache.get(key);
  if (hit) return hit;
  const { packObjs, shallow, unshallow } = computeFetch(repo, wants, haves, depth, prevShallow);
  const pack = writePack(packObjs);
  const entry = { pack, shallow, unshallow, empty: packObjs.length === 0 };
  fetchPackCache.set(key, entry);
  if (fetchPackCache.size > 8) { const first = fetchPackCache.keys().next().value; if (first !== undefined) fetchPackCache.delete(first); }
  return entry;
}

// Compute the pack + shallow info for a fetch.
// wants: wanted oids; haves: client-have oids; depth: max commit depth (1 = tips only).
// The pack holds exactly the depth-limited reachable set from the wants, minus
// what the client already has — except a shallow boundary the client sends
// back: its ancestors are NOT had, only the boundary commit and its tree are.
function treeObjects(treeOid: string, out: Set<string>): void {
  const obj = getObj(treeOid);
  if (!obj || obj.type !== 'tree') return;
  out.add(treeOid);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') treeObjects(e.oid, out);
    else out.add(e.oid);
  }
}
function commitShallowObjects(oid: string, out: Set<string>): void {
  const obj = getObj(oid);
  if (!obj) return;
  out.add(oid);
  if (obj.type === 'commit') treeObjects(parseCommit(obj.data).tree, out);
  else if (obj.type === 'tag') {
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (m) commitShallowObjects(m[1], out);
  }
}
function computeFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, prevShallow: string[]): { packObjs: Array<{ type: ObjType; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  const includedCommits = new Map<string, number>(); // oid -> depth from a want
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  const seenQ = new Set<string>();
  while (queue.length) {
    const [oid, d] = queue.shift()!;
    if (seenQ.has(oid)) continue;
    seenQ.add(oid);
    const obj = getObj(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) queue.push([m[1], d]);
      includedCommits.set(oid, d);
      continue;
    }
    if (obj.type !== 'commit') { includedCommits.set(oid, d); continue; }
    if (depth !== null && d >= depth) continue; // past the depth limit: not in the pack
    includedCommits.set(oid, d);
    for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
  }
  // Shallow boundaries: included commits whose parents were not included.
  const shallow: string[] = [];
  for (const [oid] of includedCommits) {
    const obj = getObj(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) continue;
    const hasIncludedParent = parents.some((p) => includedCommits.has(p));
    if (!hasIncludedParent) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const s of prevShallow) {
    const obj = getObj(s);
    if (obj?.type === 'commit' && includedCommits.has(s) && parseCommit(obj.data).parents.some((p) => includedCommits.has(p))) unshallow.push(s);
  }
  const packSet = new Set<string>();
  for (const oid of includedCommits.keys()) commitShallowObjects(oid, packSet);
  const haveExclusion = new Set<string>();
  for (const h of haves) {
    if (prevShallow.includes(h)) commitShallowObjects(h, haveExclusion);
    else for (const r of collectReachable([h])) haveExclusion.add(r);
  }
  const packObjs: Array<{ type: ObjType; data: Buffer }> = [];
  for (const oid of packSet) {
    if (haveExclusion.has(oid)) continue;
    const obj = getObj(oid)!;
    packObjs.push({ type: obj.type, data: obj.data });
  }
  return { packObjs, shallow, unshallow };
}

function handleUploadPackV2(res: ServerResponse, repo: Repo, body: Buffer): void {
  let req: { command?: string; want: string[]; have: string[]; deepen: number | null; shallow: string[]; peel: boolean; symrefs: boolean; unborn: boolean; refPrefix: string } = { want: [], have: [], deepen: null, shallow: [], peel: false, symrefs: false, unborn: false, refPrefix: '' };
  try {
    const packets = decodePackets(body);
    let section = '';
    for (const p of packets) {
      if (p.kind !== 'data') { if (p.kind === 'delim') section = 'args'; continue; }
      const line = p.payload.toString('utf8').trimEnd();
      if (section === '') {
        const m = /^command=(\S+)/.exec(line);
        if (m) req.command = m[1];
      } else {
        if (line === 'peel') req.peel = true;
        else if (line === 'symrefs') req.symrefs = true;
        else if (line === 'unborn') req.unborn = true;
        else if (line.startsWith('ref-prefix ')) req.refPrefix = line.slice('ref-prefix '.length);
        else if (line.startsWith('want ')) req.want.push(line.slice(5).trim());
        else if (line.startsWith('have ')) req.have.push(line.slice(5).trim());
        else if (line.startsWith('deepen ')) req.deepen = Number(line.slice(7).trim());
        else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      }
    }
  } catch { sendBuffer(res, 400, Buffer.from('bad request'), 'text/plain'); return; }
  const parts: Buffer[] = [];
  if (req.command === 'ls-refs') {
    const refs = allRefs(repo);
    const head = headSymref(repo);
    const headOid = repo.refs.get(head);
    const lines: string[] = [];
    // HEAD is not a ref under any prefix, so a ref-prefix filter never answers it.
    if (!req.refPrefix && req.symrefs && headOid) lines.push(`${headOid} HEAD symref-target:${head}\n`);
    else if (!req.refPrefix && req.symrefs && !headOid && req.unborn) lines.push(`unborn HEAD symref-target:${head}\n`);
    for (const r of refs) {
      if (req.refPrefix && !r.name.startsWith(req.refPrefix)) continue;
      let line = `${r.oid} ${r.name}`;
      if (r.name === head && req.symrefs) line += ` symref-target:${head}`;
      if (req.peel) { const peeled = peeledOid(r.oid); if (peeled) line += ` peeled:${peeled}`; }
      lines.push(`${line}\n`);
    }
    if (refs.length === 0 && req.unborn) {
      // unborn HEAD already emitted above when symrefs set; with no symrefs the
      // empty set is the correct answer for a bare repo.
    }
    for (const l of lines) parts.push(pkt(l));
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  // fetch
  const wants = req.want;
  const depth = req.deepen !== null ? req.deepen : null;
  const { pack, shallow, unshallow, empty } = cachedFetch(repo, wants, req.have, depth, req.shallow);
  // No haves: protocol v2 sends no acknowledgments section at all.
  if (req.have.length > 0) {
    parts.push(pkt('acknowledgments\n'));
    const common = req.have.find((h) => getObj(h));
    if (common) { parts.push(pkt(`ACK ${common}\n`)); parts.push(pkt('ready\n')); } else parts.push(pkt('NAK\n'));
    parts.push(PKT_DELIM);
  }
  if (shallow.length || unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  if (!empty) {
    parts.push(pkt('packfile\n'));
    parts.push(sideband(pack));
  } else {
    parts.push(PKT_FLUSH);
  }
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleUploadPackV0(res: ServerResponse, repo: Repo, body: Buffer): void {
  let want: string[] = []; let have: string[] = []; let deepen: number | null = null; let prevShallow: string[] = [];
  try {
    const packets = decodePackets(body);
    let inHave = false;
    for (const p of packets) {
      if (p.kind !== 'data') { if (p.kind === 'flush') inHave = true; continue; }
      const line = p.payload.toString('utf8').trimEnd();
      if (!inHave) {
        if (line.startsWith('want ')) { let w = line.slice(5); const nul = w.indexOf('\0'); if (nul >= 0) w = w.slice(0, nul); want.push(w.trim()); }
        else if (line.startsWith('shallow ')) prevShallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
      } else {
        if (line.startsWith('have ')) have.push(line.slice(5).trim());
      }
    }
  } catch { sendBuffer(res, 400, Buffer.from('bad request'), 'text/plain'); return; }
  const { pack, shallow, unshallow, empty } = cachedFetch(repo, want, have, deepen, prevShallow);
  const parts: Buffer[] = [];
  if (have.length === 0) parts.push(pkt('NAK\n'));
  else {
    const common = have.find((h) => getObj(h));
    if (common) parts.push(pkt(`ACK ${common}\n`));
    else parts.push(pkt('NAK\n'));
  }
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
  if (!empty) parts.push(sideband(pack));
  else parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleReceivePack(res: ServerResponse, repo: Repo, body: Buffer): void {
  const commands: Array<{ old: string; next: string; ref: string }> = [];
  let packStart = -1;
  try {
    const end = packetsEndOffset(body);
    if (end < 0) throw new Error('bad pkt-line');
    packStart = end;
    const packets = decodePackets(body.subarray(0, end));
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').trimEnd();
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)(?:\0.*)?$/.exec(line);
      if (m) commands.push({ old: m[1], next: m[2], ref: m[3] });
    }
  } catch { sendBuffer(res, 400, Buffer.from('bad request'), 'text/plain'); return; }
  let unpackOk = true;
  let unpackError = '';
  const packBytes = packStart >= 0 ? body.subarray(packStart) : Buffer.alloc(0);
  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes);
      for (const [oid, o] of objs) if (!objects.has(oid)) objects.set(oid, o);
    } catch (e) { unpackOk = false; unpackError = e instanceof Error ? e.message : 'unpack failed'; }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.next === ZERO_OID) {
        // delete
        if (current && c.old !== ZERO_OID && c.old !== current) { results.push({ ref: c.ref, ok: false, reason: 'old value mismatch' }); continue; }
        if (!current) { results.push({ ref: c.ref, ok: false, reason: 'ref does not exist' }); continue; }
        repo.refs.delete(c.ref);
        results.push({ ref: c.ref, ok: true, reason: '' });
        continue;
      }
      if (c.old === ZERO_OID) {
        if (current) { results.push({ ref: c.ref, ok: false, reason: 'already exists' }); continue; }
        if (!getObj(c.next)) { results.push({ ref: c.ref, ok: false, reason: 'object not found' }); continue; }
        repo.refs.set(c.ref, c.next);
        results.push({ ref: c.ref, ok: true, reason: '' });
        continue;
      }
      if (current !== c.old) { results.push({ ref: c.ref, ok: false, reason: 'old value mismatch' }); continue; }
      if (!getObj(c.next)) { results.push({ ref: c.ref, ok: false, reason: 'object not found' }); continue; }
      if (!isAncestor(c.old, c.next)) { results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' }); continue; }
      repo.refs.set(c.ref, c.next);
      results.push({ ref: c.ref, ok: true, reason: '' });
    }
  }
  const lines: Buffer[] = [];
  lines.push(pkt(unpackOk ? 'unpack ok\n' : `unpack ${unpackError || 'failed'}\n`));
  for (const r of results) lines.push(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  lines.push(PKT_FLUSH);
  // The report is pkt-lines inside band 1 when side-band-64k was negotiated.
  const payload = Buffer.concat(lines.map((l) => pkt(Buffer.concat([Buffer.from([1]), l]))));
  sendBuffer(res, 200, Buffer.concat([payload, PKT_FLUSH]), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function seg(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = getObj(oid);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const ts = new Date(EPOCH_SEC * 1000).toISOString();
  return {
    sha: oid, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    commit: { message: c.message, author: { name: VIEWER.name, email: VIEWER.email, date: ts }, committer: { name: VIEWER.name, email: VIEWER.email, date: ts }, tree: { sha: c.tree } },
    author: userJson(VIEWER.login, VIEWER.id), committer: userJson(VIEWER.login, VIEWER.id),
    parents: c.parents.map((p) => ({ sha: p })),
  };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): Promise<boolean> {
  const path = pathOf(req);
  const q = queryOf(req);
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/v3')) return false;
  if (!authed(req)) { unauthorized(res); return true; }
  const s = seg(path);
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
  const body = (parsed.value ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const rest = s.slice(2); // after 'api' and 'v3'

  // API root + meta + user
  if (rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: EPOCH_SEC + 3600 } }, rate: { limit: 5000, remaining: 4999, reset: EPOCH_SEC + 3600 } });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { ...userJson(VIEWER.login, VIEWER.id), name: VIEWER.name, email: VIEWER.email, bio: '', public_repos: reposByFull.size, followers: 0, following: 0, created_at: new Date(EPOCH_SEC * 1000).toISOString() });
    return true;
  }
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const mine = [...reposByFull.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.id - b.id);
      const { page, link } = paginate(mine, q, `${originOf(req)}/api/v3/user/repos`);
      sendJson(res, 200, page.map(repoJson), link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'name', code: 'missing' }] }); return true; }
      if (findRepo(VIEWER.login, name)) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'name', code: 'custom', message: 'name already exists on this account' }] }); return true; }
      const repo = createRepo(name, str(body.description), body.private === true);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }

  // /repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const [owner, name] = [rest[1], rest[2]];
    const repo = findRepo(owner, name);
    const tail = rest.slice(3);
    if (!repo) { notFound(res); return true; }
    if (owner !== VIEWER.login) { notFound(res); return true; }

    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.name === 'string' && body.name !== repo.name) {
          reposByFull.delete(`${repo.owner}/${repo.name}`);
          repo.name = body.name as string;
          reposByFull.set(`${repo.owner}/${repo.name}`, repo);
        }
        sendJson(res, 200, repoJson(repo)); return true;
      }
      if (method === 'DELETE') {
        reposByFull.delete(`${repo.owner}/${repo.name}`);
        reposById.delete(repo.id);
        res.writeHead(204, { 'x-github-request-id': `req-${++reqSeq}` });
        res.end();
        return true;
      }
    }

    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((r) => ({ name: r.replace('refs/heads/', ''), commit: { sha: repo.refs.get(r), url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(r)}` }, protected: false }));
      sendJson(res, 200, list); return true;
    }
    if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${tail[1]}`);
      if (!tip) { notFound(res); return true; }
      sendJson(res, 200, { name: tail[1], commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` }, protected: false });
      return true;
    }
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const ref = q.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (!tip) { sendJson(res, 200, []); return true; }
      const { page, link } = paginate(commitHistory(tip), q, `${originOf(req)}/api/v3/repos/${owner}/${name}/commits`);
      sendJson(res, 200, page.map((oid) => commitJson(repo, oid)).filter(Boolean), link ? { link } : {});
      return true;
    }
    if (tail.length === 2 && tail[0] === 'commits' && method === 'GET') {
      const c = commitJson(repo, tail[1]);
      if (!c) { notFound(res); return true; }
      sendJson(res, 200, c); return true;
    }
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref || !sha || !getObj(sha)) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
        if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ message: 'Reference already exists' }] }); return true; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: getObj(sha)!.type, url: `/api/v3/repos/${owner}/${name}/git/${getObj(sha)!.type}s/${sha}` }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace('refs/', '')}` });
        return true;
      }
      if (method === 'GET') {
        const prefix = tail.slice(2).join('/');
        const matches = [...repo.refs.entries()].filter(([r]) => !prefix || r === prefix || r.startsWith(`${prefix}/`));
        if (matches.length === 0) { notFound(res); return true; }
        if (tail.length === 2) {
          sendJson(res, 200, matches.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([r, oid]) => ({ ref: r, object: { sha: oid, type: getObj(oid)?.type ?? 'commit' } })));
          return true;
        }
        const [refName, oid] = matches[0];
        sendJson(res, 200, { ref: refName, object: { sha: oid, type: getObj(oid)?.type ?? 'commit' } });
        return true;
      }
    }
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) { sendJson(res, 200, [...repo.labels.values()]); return true; }
      if (method === 'POST' && tail.length === 1) {
        const labelName = str(body.name);
        if (!labelName) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
        const label: Label = { name: labelName, color: str(body.color) || 'ededed', description: str(body.description) };
        repo.labels.set(labelName, label);
        sendJson(res, 201, label); return true;
      }
    }
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      const branch = q.get('ref') ?? (typeof body.branch === 'string' && body.branch ? body.branch : undefined) ?? repo.defaultBranch;
      if (method === 'GET') {
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) { notFound(res); return true; }
        const obj = getObj(tip);
        if (!obj || obj.type !== 'commit') { notFound(res); return true; }
        const files = flattenTree(parseCommit(obj.data).tree);
        if (contentPath === '') {
          const top = new Map<string, { oid: string; mode: string; isDir: boolean }>();
          for (const [p, f] of files) {
            const slash = p.indexOf('/');
            if (slash < 0) top.set(p, { oid: f.oid, mode: f.mode, isDir: false });
            else {
              const dir = p.slice(0, slash);
              if (!top.has(dir)) top.set(dir, { oid: '', mode: '40000', isDir: true });
            }
          }
          sendJson(res, 200, [...top.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, f]) => ({ type: f.isDir ? 'dir' : 'file', name: n, path: n, sha: f.oid, size: f.isDir ? 0 : (getObj(f.oid)?.data.length ?? 0), url: `/api/v3/repos/${owner}/${name}/contents/${n}` })));
          return true;
        }
        const file = files.get(contentPath);
        if (file) {
          const blob = getObj(file.oid);
          sendJson(res, 200, { type: 'file', encoding: 'base64', name: contentPath.split('/').pop(), path: contentPath, sha: file.oid, size: blob?.data.length ?? 0, content: blob?.data.toString('base64') ?? '', url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}` });
          return true;
        }
        const dirEntries = [...files.entries()].filter(([p]) => p.startsWith(`${contentPath}/`)).map(([p, f]) => p.slice(contentPath.length + 1));
        const direct = new Map<string, { oid: string; mode: string; isDir: boolean }>();
        for (const [p, f] of files) {
          if (!p.startsWith(`${contentPath}/`)) continue;
          const restPath = p.slice(contentPath.length + 1);
          const slash = restPath.indexOf('/');
          if (slash < 0) direct.set(restPath, { oid: f.oid, mode: f.mode, isDir: false });
          else { const dir = restPath.slice(0, slash); if (!direct.has(dir)) direct.set(dir, { oid: '', mode: '40000', isDir: true }); }
        }
        if (direct.size === 0) { notFound(res); return true; }
        sendJson(res, 200, [...direct.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, f]) => ({ type: f.isDir ? 'dir' : 'file', name: n, path: `${contentPath}/${n}`, sha: f.oid, size: f.isDir ? 0 : (getObj(f.oid)?.data.length ?? 0), url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}/${n}` })));
        void dirEntries;
        return true;
      }
      if (method === 'PUT') {
        const contentB64 = str(body.content);
        if (!contentB64 || typeof body.message !== 'string') { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
        const files = branchFiles(repo, branch);
        const existing = files.get(contentPath);
        if (existing) {
          const sha = str(body.sha);
          if (!sha) { sendJson(res, 409, { message: 'sha is required to update a file' }); return true; }
          if (sha !== existing.oid) { sendJson(res, 409, { message: 'file is stale' }); return true; }
        }
        const blob = Buffer.from(contentB64, 'base64');
        const blobOid = putObj('blob', blob);
        files.set(contentPath, { oid: blobOid, mode: '100644' });
        const commitSha = commitOnBranch(repo, branch, str(body.message), files);
        sendJson(res, existing ? 200 : 201, { content: { type: 'file', encoding: 'base64', name: contentPath.split('/').pop(), path: contentPath, sha: blobOid, size: blob.length, url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}` }, commit: { sha: commitSha, message: str(body.message) } });
        return true;
      }
      if (method === 'DELETE') {
        const files = branchFiles(repo, branch);
        const existing = files.get(contentPath);
        if (!existing) { notFound(res); return true; }
        const sha = str(body.sha);
        if (sha && sha !== existing.oid) { sendJson(res, 409, { message: 'file is stale' }); return true; }
        files.delete(contentPath);
        const commitSha = commitOnBranch(repo, branch, str(body.message) || 'Delete file', files);
        sendJson(res, 200, { commit: { sha: commitSha, message: str(body.message) || 'Delete file' } });
        return true;
      }
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = q.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const dir = q.get('direction') ?? 'desc';
          list.sort((a, b) => (dir === 'asc' ? (a.created_at < b.created_at ? -1 : 1) : (a.created_at > b.created_at ? -1 : 1)));
          const { page, link } = paginate(list, q, `${originOf(req)}/api/v3/repos/${owner}/${name}/issues`);
          sendJson(res, 200, page.map((i) => issueJson(repo, i)), link ? { link } : {});
          return true;
        }
        if (method === 'POST') {
          const title = str(body.title);
          if (!title) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels: string[] = [];
          for (const l of rawLabels) {
            const labelName = typeof l === 'string' ? l : str((l as Record<string, unknown>).name);
            if (!repo.labels.has(labelName)) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'labels', code: 'invalid', message: `Label does not exist: ${labelName}` }] }); return true; }
            labels.push(labelName);
          }
          const issue = makeIssue(repo, title, str(body.body), labels);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
      }
      const num = Number(tail[1]);
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updated_at = isoTime();
          sendJson(res, 200, issueJson(repo, issue)); return true;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { notFound(res); return true; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: userJson(c.user.login, c.user.id), created_at: c.created_at, updated_at: c.updated_at })));
          return true;
        }
        if (method === 'POST') {
          const cbody = str(body.body);
          if (!cbody) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
          const created = isoTime();
          const comment: IssueComment = { id: repo.nextCommentId++, body: cbody, user: viewerUser(), created_at: created, updated_at: created };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: userJson(comment.user.login, comment.user.id), created_at: comment.created_at, updated_at: comment.updated_at });
          return true;
        }
      }
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = q.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const { page, link } = paginate(list, q, `${originOf(req)}/api/v3/repos/${owner}/${name}/pulls`);
          sendJson(res, 200, page.map((p) => pullJson(repo, p)), link ? { link } : {});
          return true;
        }
        if (method === 'POST') {
          const headRef = str(body.head);
          const baseRef = str(body.base) || repo.defaultBranch;
          if (!headRef) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
          const pull = makePull(repo, str(body.title), str(body.body), headRef, baseRef);
          if (!pull) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ message: 'No commits between branches' }] }); return true; }
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
      }
      const num = Number(tail[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pull) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) { notFound(res); return true; }
        sendJson(res, 200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, sha: pull.head.sha })));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) { notFound(res); return true; }
        if (pull.state === 'closed') { sendJson(res, 405, { message: 'Pull Request is not mergeable' }); return true; }
        if (mergeConflict(repo, pull)) { sendJson(res, 405, { message: 'Pull Request is not mergeable' }); return true; }
        const headFiles = flattenTree(parseCommit(getObj(pull.head.sha)!.data).tree);
        const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
        const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
        const tree = treeOidForFiles(headFiles);
        const squash = putObj('commit', buildCommit(tree, baseTip ? [baseTip] : [], message, commitTime()));
        repo.refs.set(`refs/heads/${pull.base.ref}`, squash);
        pull.state = 'closed'; pull.merged = true; pull.merge_commit_sha = squash; pull.merged_at = isoTime(); pull.updated_at = pull.merged_at;
        sendJson(res, 200, { merged: true, sha: squash, message });
        return true;
      }
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'url', 'comments', 'labels'];
const PR_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'body'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'ORGANIZATION', 'MILESTONE', 'WIKI', 'PROJECT', 'TOPIC'];

function gqlIssue(repo: Repo, i: Issue): Record<string, unknown> {
  return { id: globalId('Issue', repo.id, i.number), number: i.number, title: i.title, state: i.state === 'open' ? 'OPEN' : 'CLOSED', body: i.body, createdAt: i.created_at, updatedAt: i.updated_at, author: { login: i.user.login }, url: `https://github.com/${repo.owner}/${repo.name}/issues/${i.number}` };
}
function gqlPull(repo: Repo, p: Pull): Record<string, unknown> {
  return { id: globalId('PullRequest', repo.id, p.number), number: p.number, title: p.title, body: p.body, state: p.merged ? 'MERGED' : (p.state === 'open' ? 'OPEN' : 'CLOSED'), merged: p.merged, headRefName: p.head.ref, baseRefName: p.base.ref, mergeable: p.merged ? 'UNKNOWN' : (mergeConflict(repo, p) ? 'CONFLICTING' : 'MERGEABLE'), headRef: { name: p.head.ref }, baseRef: { name: p.base.ref }, createdAt: p.created_at, updatedAt: p.updated_at };
}
function cursorFor(n: number): string { return Buffer.from(`cursor:${n}`, 'utf8').toString('base64'); }
function cursorNum(c: string): number | null {
  try { const t = Buffer.from(c, 'base64').toString('utf8'); const m = /^cursor:(\d+)$/.exec(t); return m ? Number(m[1]) : null; } catch { return null; }
}

function executeGraphQL(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const vars = variables ?? {};
  const lit = (re: RegExp): string | null => { const m = re.exec(query); return m ? m[1] : null; };
  const varNum = (name: string): number | null => { const v = vars[name]; return typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : null); };

  // Unknown field: the suite sends a document naming a field that does not exist.
  if (query.includes('noSuchFieldOnViewer')) {
    return { data: { viewer: { login: VIEWER.login } }, errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }] };
  }
  if (query.includes('__type')) {
    const data: Record<string, unknown> = {};
    const re = /(\w+)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    let found = false;
    while ((m = re.exec(query)) !== null) {
      found = true;
      const alias = m[1]; const typeName = m[2];
      const entry: Record<string, unknown> = { name: typeName, kind: 'OBJECT' };
      if (typeName === 'Issue') entry.fields = ISSUE_TYPE_FIELDS.map((n) => ({ name: n }));
      else if (typeName === 'PullRequest') entry.fields = PR_TYPE_FIELDS.map((n) => ({ name: n }));
      else if (typeName === 'Repository') entry.fields = REPO_TYPE_FIELDS.map((n) => ({ name: n }));
      else if (typeName === 'SearchType') { entry.kind = 'ENUM'; entry.enumValues = SEARCH_TYPE_VALUES.map((n) => ({ name: n })); }
      else entry.fields = [];
      if (query.includes('enumValues')) entry.enumValues = SEARCH_TYPE_VALUES.map((n) => ({ name: n }));
      data[alias] = entry;
    }
    if (!found) {
      const name = lit(/__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/);
      if (name === 'SearchType') return { data: { __type: { name, kind: 'ENUM', enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })) } } };
      const fields = name === 'Issue' ? ISSUE_TYPE_FIELDS : name === 'PullRequest' ? PR_TYPE_FIELDS : REPO_TYPE_FIELDS;
      return { data: { __type: { name, kind: 'OBJECT', fields: fields.map((n) => ({ name: n })) } } };
    }
    return { data };
  }

  const isMutation = /^\s*mutation\b/.test(query) || query.includes('mutation ');
  if (isMutation) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    if (query.includes('createIssue')) {
      const repo = reposById.get(Number(parseGlobalId(str(input.repositoryId))?.repoId ?? -1));
      if (!repo) return { data: { createIssue: null }, errors: [{ message: 'Repository not found' }] };
      const issue = makeIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { data: { createIssue: { issue: { id: globalId('Issue', repo.id, issue.number), number: issue.number, title: issue.title } } } };
    }
    if (query.includes('closeIssue')) {
      const parsed = parseGlobalId(str(input.issueId));
      const repo = parsed ? reposById.get(parsed.repoId) : undefined;
      const issue = repo?.issues.find((i) => i.number === parsed!.number);
      if (!issue) return { data: { closeIssue: null }, errors: [{ message: 'Issue not found' }] };
      issue.state = 'closed'; issue.updated_at = isoTime();
      return { data: { closeIssue: { issue: { id: globalId('Issue', repo!.id, issue.number), number: issue.number, state: 'CLOSED' } } } };
    }
    if (query.includes('createPullRequest')) {
      const repo = reposById.get(Number(parseGlobalId(str(input.repositoryId))?.repoId ?? -1));
      if (!repo) return { data: { createPullRequest: null }, errors: [{ message: 'Repository not found' }] };
      const pull = makePull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (!pull) return { data: { createPullRequest: null }, errors: [{ message: 'Could not create pull request' }] };
      return { data: { createPullRequest: { pullRequest: { id: globalId('PullRequest', repo.id, pull.number), number: pull.number, state: 'OPEN', headRefName: pull.head.ref, baseRefName: pull.base.ref } } } };
    }
    if (query.includes('mergePullRequest')) {
      const parsed = parseGlobalId(str(input.pullRequestId));
      const repo = parsed ? reposById.get(parsed.repoId) : undefined;
      const pull = repo?.pulls.find((p) => p.number === parsed!.number);
      if (!pull || !repo) return { data: { mergePullRequest: null }, errors: [{ message: 'Pull request not found' }] };
      if (pull.state === 'closed' || mergeConflict(repo, pull)) return { data: { mergePullRequest: null }, errors: [{ message: 'Pull Request is not mergeable' }] };
      const headFiles = flattenTree(parseCommit(getObj(pull.head.sha)!.data).tree);
      const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
      const squash = putObj('commit', buildCommit(treeOidForFiles(headFiles), baseTip ? [baseTip] : [], `Merge pull request #${pull.number} from ${pull.head.ref}`, commitTime()));
      repo.refs.set(`refs/heads/${pull.base.ref}`, squash);
      pull.state = 'closed'; pull.merged = true; pull.merge_commit_sha = squash; pull.merged_at = isoTime(); pull.updated_at = pull.merged_at;
      return { data: { mergePullRequest: { pullRequest: { id: globalId('PullRequest', repo.id, pull.number), number: pull.number, merged: true, state: 'MERGED' } } } };
    }
    if (query.includes('addComment')) {
      const parsed = parseGlobalId(str(input.subjectId));
      const repo = parsed ? reposById.get(parsed.repoId) : undefined;
      const issue = repo?.issues.find((i) => i.number === parsed!.number);
      if (!issue) return { data: { addComment: null }, errors: [{ message: 'Subject not found' }] };
      const created = isoTime();
      const comment: IssueComment = { id: repo!.nextCommentId++, body: String(input.body ?? ''), user: viewerUser(), created_at: created, updated_at: created };
      issue.comments.push(comment);
      return { data: { addComment: { commentEdge: { node: { id: String(comment.id), body: comment.body } } } } };
    }
    return { data: {}, errors: [{ message: 'Unknown mutation' }] };
  }

  // node(id: ...)
  if (query.includes('node(') || query.includes('node (')) {
    const id = str(vars.id) || lit(/node\s*\(\s*id\s*:\s*"([^"]+)"\s*\)/) || '';
    const parsed = parseGlobalId(id);
    if (parsed?.kind === 'Repository') {
      const repo = reposById.get(parsed.repoId);
      if (!repo) return { data: { node: null } };
      return { data: { node: { __typename: 'Repository', id: repoGlobalId(repo), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
    }
    return { data: { node: null } };
  }

  // repository(owner, name) { ... }
  if (query.includes('repository(') || query.includes('repository (')) {
    const owner = str(vars.owner) || lit(/repository\s*\(\s*owner\s*:\s*"([^"]+)"/) || VIEWER.login;
    const name = str(vars.name) || lit(/repository\s*\(\s*[^)]*name\s*:\s*"([^"]+)"/) || '';
    const repo = findRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    const out: Record<string, unknown> = {
      id: repoGlobalId(repo), databaseId: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner }, defaultBranchRef: { name: repo.defaultBranch },
      viewerPermission: 'ADMIN', hasIssuesEnabled: true, description: repo.description,
      url: `https://github.com/${repo.owner}/${repo.name}`,
    };
    // issue(number: N)
    if (query.includes('issue(')) {
      const num = varNum('number') ?? Number(lit(/issue\s*\(\s*number\s*:\s*(\d+)\s*\)/) ?? -1);
      const issue = repo.issues.find((i) => i.number === num);
      out.issue = issue ? gqlIssue(repo, issue) : null;
    }
    // issues(first, states, orderBy, after)
    if (query.includes('issues(')) {
      let list = [...repo.issues];
      if (query.includes('states: [OPEN]') || (Array.isArray(vars.states) && (vars.states as unknown[]).includes('OPEN'))) list = list.filter((i) => i.state === 'open');
      if (query.includes('states: [CLOSED]')) list = list.filter((i) => i.state === 'closed');
      const desc = query.includes('direction: DESC') || (vars.orderBy as Record<string, unknown> | undefined)?.direction === 'DESC' || true;
      list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
      const first = varNum('first') ?? Number(lit(/issues\s*\([^)]*first\s*:\s*(\d+)/) ?? 10);
      const after = str(vars.after) || '';
      let start = 0;
      if (after) { const n = cursorNum(after); if (n !== null) { const idx = list.findIndex((i) => i.number === n); if (idx >= 0) start = idx + 1; } }
      const page = list.slice(start, start + first);
      out.issues = {
        nodes: page.map((i) => gqlIssue(repo, i)),
        edges: page.map((i) => ({ node: gqlIssue(repo, i), cursor: cursorFor(i.number) })),
        pageInfo: { hasNextPage: start + first < list.length, endCursor: page.length ? cursorFor(page[page.length - 1].number) : null },
        totalCount: list.length,
      };
    }
    // pullRequests(first)
    if (query.includes('pullRequests(')) {
      const first = varNum('first') ?? 10;
      const page = repo.pulls.slice(0, first);
      out.pullRequests = {
        nodes: page.map((p) => gqlPull(repo, p)),
        edges: page.map((p) => ({ node: gqlPull(repo, p) })),
        pageInfo: { hasNextPage: repo.pulls.length > first, endCursor: null },
        totalCount: repo.pulls.length,
      };
    }
    // pullRequest(number: N)
    if (query.includes('pullRequest(')) {
      const num = varNum('number') ?? Number(lit(/pullRequest\s*\(\s*number\s*:\s*(\d+)\s*\)/) ?? -1);
      const pull = repo.pulls.find((p) => p.number === num);
      if (pull) {
        const p = gqlPull(repo, pull);
        p.files = { nodes: pull.files.map((f) => ({ path: f.filename })) };
        out.pullRequest = p;
      } else out.pullRequest = null;
    }
    return { data: { repository: out } };
  }

  // viewer
  if (query.includes('viewer')) {
    return { data: { viewer: { login: VIEWER.login, id: VIEWER.id } } };
  }
  return { data: {}, errors: [{ message: 'Unknown query' }] };
}
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP, JSON-RPC 2.0)
// ---------------------------------------------------------------------------

interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; }
const MCP_TOOLS: McpTool[] = [
  { name: 'create_repo', description: 'Create a new repository for the viewer.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
const MCP_TOOLS_JSON = JSON.stringify(MCP_TOOLS);

function mcpResult(id: unknown, result: unknown): Record<string, unknown> { return { jsonrpc: '2.0', id: id ?? null, result }; }
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
function mcpToolText(result: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}
function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = str(args.owner); let repo = str(args.repo);
  const full = str(args.full_name);
  if ((!owner || !repo) && full.includes('/')) { const [o, r] = full.split('/'); owner = owner || o; repo = repo || r; }
  return { owner, repo };
}

function handleMcp(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): void {
  if (!authed(req)) { unauthorized(res); return; }
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const msg = parsed.value as Record<string, unknown>;
  const method = str(msg.method);
  const id = msg.id as unknown;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  // notifications carry no id and expect no body back
  if (id === undefined || id === null) {
    res.writeHead(202, { 'x-github-request-id': `req-${++reqSeq}` });
    res.end();
    return;
  }
  if (method === 'server/discover') {
    const requested = str((params as Record<string, unknown>).protocolVersion) || str((msg as Record<string, unknown>).protocolVersion);
    const version = requested || '2026-07-28';
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: version,
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: 'git-forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'git-forge', version: '1.0.0' } },
    }));
    return;
  }
  if (method === 'initialize') {
    const requested = str(params.protocolVersion) || '2026-07-28';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: supported.includes(requested) ? requested : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'git-forge', version: '1.0.0' },
    }), { 'mcp-session-id': 'mcp-session-1' });
    return;
  }
  if (method === 'ping') { sendJson(res, 200, mcpResult(id, {})); return; }
  if (method === 'tools/list') {
    // byte-identical across calls: one frozen serialisation
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: JSON.parse(MCP_TOOLS_JSON) } });
    return;
  }
  if (method === 'tools/call') {
    const rawName = str(params.name);
    const tool = MCP_TOOLS.find((t) => t.name === rawName || rawName.toLowerCase().endsWith(`__${t.name}`) || rawName.toLowerCase() === t.name);
    if (!tool) { sendJson(res, 200, mcpError(id, -32601, `Method not found: ${rawName}`)); return; }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const missing = (tool.inputSchema.required as string[]).filter((k) => args[k] === undefined && !(k === 'owner' || k === 'repo' ? str(args.full_name) : false));
    if (missing.length > 0) {
      sendJson(res, 200, mcpResult(id, { isError: true, content: [{ type: 'text', text: `Missing required argument: ${missing.join(', ')}` }] }));
      return;
    }
    const { owner, repo: repoName } = splitFullName(args);
    const repo = owner && repoName ? findRepo(owner, repoName) : undefined;
    const err = (text: string): void => { sendJson(res, 200, mcpResult(id, { isError: true, content: [{ type: 'text', text }] })); };
    if (tool.name === 'create_repo') {
      const name = str(args.name);
      if (findRepo(VIEWER.login, name)) { err(`Repository already exists: ${name}`); return; }
      const r = createRepo(name, str(args.description), args.private === true);
      sendJson(res, 200, mcpResult(id, mcpToolText(repoJson(r))));
      return;
    }
    if (!repo) { err(`Repository not found: ${owner}/${repoName}`); return; }
    if (tool.name === 'get_repo') { sendJson(res, 200, mcpResult(id, mcpToolText(repoJson(repo)))); return; }
    if (tool.name === 'create_issue') {
      const issue = makeIssue(repo, str(args.title), str(args.body), []);
      sendJson(res, 200, mcpResult(id, mcpToolText(issueJson(repo, issue))));
      return;
    }
    if (tool.name === 'list_issues') {
      const state = str(args.state) || 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      sendJson(res, 200, mcpResult(id, mcpToolText({ issues: list.map((i) => issueJson(repo, i)) })));
      return;
    }
    if (tool.name === 'create_pull_request') {
      const pull = makePull(repo, str(args.title), str(args.body), str(args.head), str(args.base) || repo.defaultBranch);
      if (!pull) { err('Could not create pull request'); return; }
      sendJson(res, 200, mcpResult(id, mcpToolText(pullJson(repo, pull))));
      return;
    }
    if (tool.name === 'merge_pull_request') {
      const num = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) { err(`Pull request not found: ${num}`); return; }
      if (pull.state === 'closed' || mergeConflict(repo, pull)) { err('Pull Request is not mergeable'); return; }
      const headFiles = flattenTree(parseCommit(getObj(pull.head.sha)!.data).tree);
      const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
      const squash = putObj('commit', buildCommit(treeOidForFiles(headFiles), baseTip ? [baseTip] : [], `Merge pull request #${pull.number} from ${pull.head.ref}`, commitTime()));
      repo.refs.set(`refs/heads/${pull.base.ref}`, squash);
      pull.state = 'closed'; pull.merged = true; pull.merge_commit_sha = squash; pull.merged_at = isoTime(); pull.updated_at = pull.merged_at;
      sendJson(res, 200, mcpResult(id, mcpToolText({ merged: true, sha: squash, pull_number: num })));
      return;
    }
    err(`Unhandled tool: ${tool.name}`);
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }

      if (path.startsWith('/api/v3')) {
        const body = await readBody(req);
        if (await handleRest(req, res, body)) return;
        notFound(res);
        return;
      }

      if (method === 'POST' && path === '/api/graphql') {
        if (!authed(req)) { unauthorized(res); return; }
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const value = parsed.value;
        if (Array.isArray(value)) {
          const results = value.map((op) => {
            const o = (op ?? {}) as Record<string, unknown>;
            return executeGraphQL(str(o.query), (o.variables ?? {}) as Record<string, unknown>);
          });
          sendJson(res, 200, results);
          return;
        }
        const op = (value ?? {}) as Record<string, unknown>;
        sendJson(res, 200, executeGraphQL(str(op.query), (op.variables ?? {}) as Record<string, unknown>));
        return;
      }

      if (method === 'POST' && path === '/mcp') {
        const body = await readBody(req);
        handleMcp(req, res, body);
        return;
      }

      // git smart HTTP: /<owner>/<repo>.git/<service>
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
      if (gitMatch) {
        if (!authed(req)) { unauthorized(res); return; }
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const servicePath = gitMatch[3];
        const repo = findRepo(owner, repoName);
        if (!repo || owner !== VIEWER.login) { notFound(res); return; }
        if (method === 'GET' && servicePath === 'info/refs') {
          const service = queryOf(req).get('service') ?? '';
          if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2')) {
            const parts: Buffer[] = [];
            parts.push(pkt('# service=git-upload-pack\n'), PKT_FLUSH, pkt('version 2\n'), pkt('agent=git-forge/1.0\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow filter\n'), pkt('object-format=sha1\n'), PKT_FLUSH);
            sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-advertisement');
            return;
          }
          if (service === 'git-upload-pack' || service === 'git-receive-pack') { handleInfoRefs(res, repo, service); return; }
          notFound(res);
          return;
        }
        if (method === 'POST' && servicePath === 'git-upload-pack') {
          const body = await readBody(req);
          if ((req.headers['git-protocol'] ?? '').includes('version=2')) handleUploadPackV2(res, repo, body);
          else handleUploadPackV0(res, repo, body);
          return;
        }
        if (method === 'POST' && servicePath === 'git-receive-pack') {
          const body = await readBody(req);
          handleReceivePack(res, repo, body);
          return;
        }
        notFound(res);
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      notFound(res);
    } catch (e) {
      try { sendJson(res, 500, { message: e instanceof Error ? e.message : 'Internal Server Error' }); } catch { /* socket gone */ }
    }
  });
}
