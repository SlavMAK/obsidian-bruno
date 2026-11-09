/**
 * Builds the in-memory (Redux) shape of a fixture collection the way the
 * plugin does: files written with the real filestore, requests loaded
 * metadata-only (`partial`) through the extension's own parseFileMeta, folder
 * and collection roots parsed fully. Also provides an `invoke` that answers
 * the export IPC channels with the same code the extension runs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import type { FixtureCollection } from './collections';

const require = createRequire(import.meta.url);
const filestore = require('@usebruno/filestore');
const converters = require('@usebruno/converters');

let uidCounter = 0;
const uid = () => `uid${++uidCounter}`.padEnd(21, 'x');

/** Same as collection-watcher's hydrateCollectionRootWithUuid. */
const hydrateRoot = (root: any) => {
  for (const key of ['params', 'headers']) (root?.request?.[key] || []).forEach((r: any) => (r.uid = uid()));
  for (const key of ['req', 'res']) (root?.request?.vars?.[key] || []).forEach((r: any) => (r.uid = uid()));
  return root;
};

export const writeCollectionToDisk = (fixture: FixtureCollection): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-export-'));
  fs.writeFileSync(path.join(dir, 'bruno.json'), JSON.stringify({ version: '1', name: fixture.name, type: 'collection' }));
  if (fixture.root) {
    fs.writeFileSync(path.join(dir, 'collection.bru'), filestore.stringifyCollection(fixture.root, {}, { format: 'bru' }));
  }
  for (const folder of fixture.folders) {
    const folderPath = path.join(dir, folder.dir);
    fs.mkdirSync(folderPath, { recursive: true });
    if (folder.root) {
      fs.writeFileSync(path.join(folderPath, 'folder.bru'), filestore.stringifyFolder(folder.root, { format: 'bru' }));
    }
  }
  for (const req of fixture.requests) {
    const file = path.join(dir, req.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, filestore.stringifyRequest({ settings: {}, tags: [], ...req.item }, { format: 'bru' }));
  }
  return dir;
};

/** Mirrors collection-watcher + the collections slice reducer. */
export const loadCollectionLikeWatcher = (dir: string, fixture: FixtureCollection, parseFileMeta: (c: string) => any) => {
  const collection: any = {
    uid: uid(),
    name: fixture.name,
    pathname: dir,
    collapsed: false,
    mountStatus: 'mounted',
    brunoConfig: { version: '1', name: fixture.name, type: 'collection' },
    processEnvVariables: { HOME: '/home/user' },
    activeEnvironmentUid: null,
    environments: fixture.environments.map((env) => ({
      uid: uid(),
      ...env,
      variables: env.variables.map((v: any) => ({ uid: uid(), ...v }))
    })),
    items: []
  };
  if (fs.existsSync(path.join(dir, 'collection.bru'))) {
    collection.root = hydrateRoot(filestore.parseCollection(fs.readFileSync(path.join(dir, 'collection.bru'), 'utf8'), { format: 'bru' }));
  }

  const readDir = (abs: string, items: any[], depth: number) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name);
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || (abs === dir && entry.name === 'environments')) continue;
      if (entry.isDirectory()) {
        const folder: any = { uid: uid(), pathname: full, name: entry.name, filename: entry.name, type: 'folder', collapsed: true, depth, items: [] };
        const folderBru = path.join(full, 'folder.bru');
        if (fs.existsSync(folderBru)) {
          folder.root = hydrateRoot(filestore.parseFolder(fs.readFileSync(folderBru, 'utf8'), { format: 'bru' }));
          if (folder.root?.meta?.name) folder.name = folder.root.meta.name;
          if (folder.root?.meta?.seq) folder.seq = folder.root.meta.seq;
        }
        items.push(folder);
        readDir(full, folder.items, depth + 1);
      } else if (entry.name.endsWith('.bru') && entry.name !== 'folder.bru' && entry.name !== 'collection.bru') {
        const data = parseFileMeta(fs.readFileSync(full, 'utf8'));
        items.push({
          uid: uid(),
          name: data.name,
          type: data.type,
          seq: data.seq,
          tags: data.tags,
          request: data.request,
          settings: data.settings,
          examples: data.examples,
          filename: entry.name,
          pathname: full,
          depth,
          draft: null,
          partial: true,
          loading: false,
          size: 0.001
        });
      }
    }
  };
  readDir(dir, collection.items, 1);
  return collection;
};

/** Same logic as the extension's IPC handlers for these channels. */
export const createInvoke = () => {
  const calls: Record<string, number> = {};
  const invoke = async (channel: string, ...args: any[]) => {
    calls[channel] = (calls[channel] || 0) + 1;
    if (channel === 'renderer:load-requests-for-export') {
      const loaded: Record<string, unknown> = {};
      const errors: Record<string, string> = {};
      for (const p of args[0].pathnames) {
        try {
          loaded[p] = filestore.parseRequest(fs.readFileSync(p, 'utf8'), { format: 'bru' });
        } catch (e: any) {
          errors[p] = e.message;
        }
      }
      return { loaded, errors };
    }
    if (channel === 'renderer:convert-bruno-to-postman') {
      // Structured clone mimics the IPC boundary.
      return converters.brunoToPostman(JSON.parse(JSON.stringify(args[0])));
    }
    throw new Error(`Unexpected channel ${channel}`);
  };
  return { invoke, calls };
};

export { filestore, converters };
