import cloneDeep from 'lodash/cloneDeep';
import each from 'lodash/each';
import sortBy from 'lodash/sortBy';
import { transformCollectionToSaveToExportAsFile } from 'utils/collections/index';
import { deleteUidsInItems, deleteUidsInEnvs, deleteSecretsInEnvs, transformItem } from 'utils/collections/export';
import { sanitizeName } from 'utils/common/regex';
import { enhancePostmanExport, EnhanceResult } from './postman-enhance';

export const EXPORTED_USING = 'Bruno for Obsidian';

const REQUEST_TYPES = ['http-request', 'graphql-request', 'grpc-request', 'ws-request'];
const POSTMAN_EXPORTABLE_TYPES = ['folder', 'http-request', 'graphql-request'];
const POSTMAN_UNSUPPORTED_TYPES: Record<string, string> = {
  'grpc-request': 'gRPC',
  'ws-request': 'WebSocket'
};

type Invoke = (channel: string, ...args: any[]) => Promise<any>;

const walk = (items: any[] = [], fn: (item: any) => void) => {
  each(items, (item) => {
    if (!item) return;
    fn(item);
    if (item.items?.length) walk(item.items, fn);
  });
};

/**
 * The sidebar tree only carries request metadata until a request is opened
 * (`partial: true`, empty url/body/headers/scripts). Anything exported from such
 * an item silently loses data, so every partial request must be parsed first.
 */
export const getPartialRequestPathnames = (collection: any): string[] => {
  const pathnames: string[] = [];
  walk(collection?.items, (item) => {
    if (REQUEST_TYPES.includes(item.type) && (item.partial || !item.request) && item.pathname) {
      pathnames.push(item.pathname);
    }
  });
  return pathnames;
};

/** Returns a copy of `collection` with partial items replaced by their fully parsed data. */
export const mergeLoadedRequests = (collection: any, loaded: Record<string, any> = {}) => {
  const copy = cloneDeep(collection);
  walk(copy.items, (item) => {
    const data = item.pathname && loaded[item.pathname];
    if (!data) return;
    item.name = data.name ?? item.name;
    item.type = data.type ?? item.type;
    item.seq = data.seq ?? item.seq;
    item.tags = data.tags ?? item.tags;
    item.settings = data.settings ?? item.settings;
    item.request = data.request;
    item.examples = data.examples ?? [];
    item.partial = false;
  });
  return copy;
};

/**
 * Resolves partial items via the extension. Throws if any request cannot be
 * loaded: exporting it as an empty stub would be silent data loss.
 */
export const loadFullCollection = async (collection: any, invoke: Invoke) => {
  const pathnames = getPartialRequestPathnames(collection);
  if (!pathnames.length) return cloneDeep(collection);

  const { loaded = {}, errors = {} } = (await invoke('renderer:load-requests-for-export', { pathnames })) || {};
  const failed = pathnames.filter((p) => !loaded[p]);
  if (failed.length) {
    const details = failed.map((p) => `${p}: ${errors[p] || 'not loaded'}`).join('\n');
    throw new Error(`Failed to load ${failed.length} request(s) for export:\n${details}`);
  }
  return mergeLoadedRequests(collection, loaded);
};

/** Sibling order as shown in the sidebar: by seq, then name. */
const sortItemsBySeq = (items: any[] = []): any[] => {
  const sorted = sortBy(items, [(i) => (typeof i.seq === 'number' ? i.seq : Number.MAX_SAFE_INTEGER), (i) => i.name]);
  each(sorted, (i) => {
    if (i.items?.length) i.items = sortItemsBySeq(i.items);
  });
  return sorted;
};

/**
 * Bruno JSON export (re-importable via "Import collection → Bruno").
 * Expects a fully loaded collection (see loadFullCollection).
 */
export const buildBrunoExport = (collection: any) => {
  const exported = transformCollectionToSaveToExportAsFile(cloneDeep(collection));

  delete exported.uid;
  delete exported.activeEnvironmentUid;
  deleteUidsInItems(exported.items);
  transformItem(exported.items);
  deleteUidsInEnvs(exported.environments);
  deleteSecretsInEnvs(exported.environments);

  exported.exportedAt = new Date().toISOString();
  exported.exportedUsing = EXPORTED_USING;
  return exported;
};

/**
 * Input for the extension-side brunoToPostman converter. It expects app item
 * types (`http-request`, ...) and does not order siblings itself. Only items the
 * converter keeps are passed, so its output mirrors this tree one-to-one
 * (enhancePostmanExport relies on that).
 */
export const buildPostmanSource = (collection: any) => {
  const source = transformCollectionToSaveToExportAsFile(cloneDeep(collection));
  const keep = (items: any[] = []): any[] =>
    items
      .filter((i) => i && POSTMAN_EXPORTABLE_TYPES.includes(i.type))
      .map((i) => (i.type === 'folder' ? { ...i, items: keep(i.items) } : i));
  source.items = sortItemsBySeq(keep(source.items));
  return source;
};

export const buildPostmanExport = async (collection: any, invoke: Invoke): Promise<EnhanceResult> => {
  const source = buildPostmanSource(collection);
  const converted = await invoke('renderer:convert-bruno-to-postman', source);
  return enhancePostmanExport(source, converted);
};

/** Request types Postman cannot represent, found anywhere in the tree. */
export const getPostmanUnsupportedTypes = (collection: any): string[] => {
  const types = new Set<string>();
  walk(collection?.items, (item) => {
    if (POSTMAN_UNSUPPORTED_TYPES[item.type]) types.add(POSTMAN_UNSUPPORTED_TYPES[item.type]);
  });
  return [...types];
};

export const getExportFileName = (collectionName: string, suffix = '') => {
  const base = sanitizeName(collectionName || '') || 'collection';
  return `${base}${suffix}.json`;
};
