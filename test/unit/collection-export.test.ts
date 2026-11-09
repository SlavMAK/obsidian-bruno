import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: {},
  Uri: { file: (p: string) => ({ fsPath: p }) }
}));

import { parseFileMeta } from '../../src/extension/utils/collection';
import {
  loadFullCollection,
  buildBrunoExport,
  buildPostmanExport,
  buildPostmanSource,
  getPartialRequestPathnames,
  getPostmanUnsupportedTypes,
  getExportFileName
} from '../../src/webview/utils/exporters/collection-export';
import { processBrunoCollection } from '../../src/webview/utils/importers/bruno-collection';
import { richCollection, edgeCollection, fixtures, FixtureCollection } from './fixtures/collections';
import { writeCollectionToDisk, loadCollectionLikeWatcher, createInvoke, filestore, converters } from './fixtures/harness';

const parseMeta = (content: string) => parseFileMeta(content, 'bru');

/** Exports go over IPC and into a file: they must survive JSON. */
const viaJson = (x: any) => JSON.parse(JSON.stringify(x));

const findAllKeys = (obj: any, key: string, out: string[] = [], at = '$'): string[] => {
  if (Array.isArray(obj)) obj.forEach((v, i) => findAllKeys(v, key, out, `${at}[${i}]`));
  else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (k === key) out.push(`${at}.${k}`);
      findAllKeys(obj[k], key, out, `${at}.${k}`);
    }
  }
  return out;
};

const flatten = (items: any[] = [], prefix = ''): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const i of items) {
    const p = prefix ? `${prefix}/${i.name}` : i.name;
    out[p] = i;
    Object.assign(out, flatten(i.items || i.item, p));
  }
  return out;
};

const setup = async (fixture: FixtureCollection) => {
  const dir = writeCollectionToDisk(fixture);
  const collection = loadCollectionLikeWatcher(dir, fixture, parseMeta);
  const { invoke, calls } = createInvoke();
  const full = await loadFullCollection(collection, invoke);
  return { dir, collection, full, invoke, calls };
};

describe('partial (metadata-only) requests', () => {
  it('the watcher tree really is lossy until requests are loaded', async () => {
    const { collection } = await setup(richCollection);
    const getUser = flatten(collection.items)['Users/Get user'];
    expect(getUser.partial).toBe(true);
    expect(getUser.request.url).toBe('');
    expect(getUser.request.headers).toEqual([]);
  });

  it('loadFullCollection parses every partial request and leaves the input untouched', async () => {
    const { collection, full, calls } = await setup(richCollection);
    expect(calls['renderer:load-requests-for-export']).toBe(1);
    expect(getPartialRequestPathnames(full)).toEqual([]);
    expect(getPartialRequestPathnames(collection)).toHaveLength(richCollection.requests.length);
    const getUser = flatten(full.items)['Users/Get user'];
    expect(getUser.request.url).toBe('{{baseUrl}}/users/:id?expand=roles&lang=ru');
    expect(getUser.request.method).toBe('GET');
    expect(getUser.examples).toHaveLength(1);
  });

  it('fails loudly instead of exporting empty stubs when a request cannot be read', async () => {
    const dir = writeCollectionToDisk(edgeCollection);
    const collection = loadCollectionLikeWatcher(dir, edgeCollection, parseMeta);
    const invoke = async () => ({ loaded: {}, errors: { x: 'boom' } });
    await expect(loadFullCollection(collection, invoke)).rejects.toThrow(/Failed to load 3 request/);
  });

  it('skips the IPC round-trip when everything is already loaded', async () => {
    const { full } = await setup(edgeCollection);
    const { invoke, calls } = createInvoke();
    await loadFullCollection(full, invoke);
    expect(calls['renderer:load-requests-for-export']).toBeUndefined();
  });
});

describe.each(fixtures.map((f) => [f.name, f] as const))('Bruno export: %s', (_name, fixture) => {
  let exported: any;
  let full: any;

  beforeAll(async () => {
    ({ full } = await setup(fixture));
    exported = viaJson(buildBrunoExport(full));
  });

  it('contains no item/env uids, runtime or machine-local state', () => {
    // Root rows keep their uids, as in upstream Bruno exports: older importers require them.
    expect(findAllKeys(exported, 'uid').filter((p) => !/\.root\.request\./.test(p))).toEqual([]);
    for (const key of ['pathname', 'partial', 'draft', 'loading', 'depth', 'collapsed', 'processEnvVariables', 'mountStatus', 'size']) {
      expect(findAllKeys(exported, key), key).toEqual([]);
    }
    expect(exported.exportedUsing).toBe('Bruno for Obsidian');
    expect(exported.version).toBe('1');
  });

  it('is accepted by the Bruno importer (schema-valid)', async () => {
    await expect(processBrunoCollection(viaJson(exported))).resolves.toBeTruthy();
  });

  it('keeps every request and folder with full content', () => {
    const byPath = flatten(exported.items);
    const fixtureFolderNames = fixture.folders.map((f) => f.root?.meta?.name || f.dir.split('/').pop());
    for (const name of fixtureFolderNames) {
      expect(Object.values(byPath).some((i: any) => i.type === 'folder' && i.name === name), name).toBe(true);
    }
    for (const req of fixture.requests) {
      const item: any = Object.values(byPath).find((i: any) => i.name === req.item.name);
      expect(item, req.item.name).toBeTruthy();
      expect(item.type).toBe(req.item.type.replace('-request', ''));
      expect(item.seq).toBe(req.item.seq);
      expect(item.request.url).toBe(req.item.request.url);
      if (req.item.request.method) expect(item.request.method).toBe(req.item.request.method);
      const headerNames = (req.item.request.headers || []).map((h: any) => h.name);
      expect(item.request.headers.map((h: any) => h.name)).toEqual(headerNames);
      expect(item.request.body.mode).toBe(req.item.request.body.mode);
      if (req.item.request.script?.req) expect(item.request.script.req).toBe(req.item.request.script.req);
      if (req.item.request.tests) expect(item.request.tests).toBe(req.item.request.tests);
      if (req.item.request.docs) expect(item.request.docs).toBe(req.item.request.docs);
      expect(item.request.auth.mode).toBe(req.item.request.auth.mode);
      expect(item.examples?.length || 0).toBe(req.item.examples?.length || 0);
    }
  });

  it('round-trips: import → write .bru files → parse gives the same requests', async () => {
    const imported: any = await processBrunoCollection(viaJson(exported));
    const reparsed = flatten(imported.items);
    for (const [p, item] of Object.entries<any>(reparsed)) {
      if (item.type === 'folder') continue;
      const bru = filestore.stringifyRequest(item, { format: 'bru' });
      const back = filestore.parseRequest(bru, { format: 'bru' });
      const original: any = flatten(full.items)[p];
      expect(back.request.url, p).toBe(original.request.url);
      expect(back.request.body.mode, p).toBe(original.request.body.mode);
      expect(back.name, p).toBe(original.name);
    }
  });
});

describe('Bruno export: rich specifics', () => {
  let exported: any;
  beforeAll(async () => {
    const { full } = await setup(richCollection);
    exported = viaJson(buildBrunoExport(full));
  });

  it('blanks secret environment values only', () => {
    const vars = exported.environments[0].variables;
    expect(vars.find((v: any) => v.name === 'token').value).toBe('');
    expect(vars.find((v: any) => v.name === 'baseUrl').value).toBe('http://localhost:3000');
  });

  it('keeps collection and folder roots', () => {
    expect(exported.root.request.auth.mode).toBe('bearer');
    expect(exported.root.request.headers[0].name).toBe('X-Client');
    expect(exported.root.docs).toContain('Collection docs');
    const users = exported.items.find((i: any) => i.name === 'Users');
    expect(users.root.request.auth.basic.username).toBe('admin');
    expect(users.root.request.script.req).toContain('folder pre');
  });

  it('importer accepts exports whose root rows lack uids (e.g. hand-edited or from other tools)', async () => {
    const stripped = viaJson(exported);
    const strip = (root: any) => {
      for (const h of root?.request?.headers || []) delete h.uid;
      for (const v of root?.request?.vars?.req || []) delete v.uid;
    };
    strip(stripped.root);
    stripped.items.forEach((i: any) => strip(i.root));
    await expect(processBrunoCollection(stripped)).resolves.toBeTruthy();
  });

  it('keeps OAuth1 / EdgeGrid credentials and multipart content types', () => {
    const all = flatten(exported.items);
    expect(all['Auth/OAuth1'].request.auth.oauth1).toMatchObject({ consumerKey: 'ck', accessTokenSecret: 'ats' });
    expect(all['Auth/EdgeGrid'].request.auth.akamaiEdgegrid).toMatchObject({ accessToken: 'eat', baseURL: 'https://akab.example.com' });
    expect(all['Users/Admin/Upload avatar'].request.body.multipartForm[1]).toMatchObject({ type: 'file', contentType: 'image/png' });
  });

  it('replaces tabs in JSON bodies, keeps examples', () => {
    const create = flatten(exported.items)['Users/Create user'];
    expect(create.request.body.json).not.toContain('\t');
    const getUser = flatten(exported.items)['Users/Get user'];
    expect(getUser.examples[0].response.status).toBe(200);
    expect(getUser.examples[0].type).toBe('http');
  });
});

describe('Postman export', () => {
  const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
  let postman: any;
  let warnings: string[];
  let full: any;
  let all: Record<string, any>;

  beforeAll(async () => {
    const ctx = await setup(richCollection);
    full = ctx.full;
    const result = await buildPostmanExport(full, ctx.invoke);
    postman = viaJson(result.collection);
    warnings = result.warnings;
    all = flatten(postman.item);
  });

  const h = (key: string, value: string, disabled = false) => ({ key, value, disabled, type: 'default' });
  const p = (key: string, value: any, type = 'string') => ({ key, value, type });
  const authParams = (item: any) => Object.fromEntries(item.request.auth[item.request.auth.type].map((x: any) => [x.key, x.value]));

  it('is a real Postman v2.1 collection, not Bruno JSON', () => {
    expect(postman.info.schema).toBe(POSTMAN_SCHEMA);
    expect(postman.info.name).toBe('Rich API');
    expect(postman.items).toBeUndefined();
    expect(Array.isArray(postman.item)).toBe(true);
  });

  it('drops gRPC/WebSocket requests and reports them', () => {
    expect(getPostmanUnsupportedTypes(full).sort()).toEqual(['WebSocket', 'gRPC']);
    expect(all['Realtime/Socket']).toBeUndefined();
    expect(all['Realtime/Greeter']).toBeUndefined();
    expect(all['Realtime']).toBeTruthy();
  });

  it('keeps folder hierarchy in sidebar order (seq)', () => {
    // seq ties are broken by name, like the sidebar does
    expect(postman.item.map((i: any) => i.name)).toEqual(['Echo text', 'Realtime', 'GraphQL users', 'Users', 'Health', 'Auth', 'Sparql']);
    const users = postman.item.find((i: any) => i.name === 'Users');
    expect(users.item.map((i: any) => i.name)).toEqual(['Admin', 'Create user', 'Get user']);
  });

  it('converts URL, params, scripts and examples', () => {
    const getUser = all['Users/Get user'];
    expect(getUser.request.method).toBe('GET');
    expect(getUser.request.url.raw).toBe('{{baseUrl}}/users/:id?expand=roles&lang=ru');
    expect(getUser.request.url.query).toEqual([
      { key: 'expand', value: 'roles' },
      { key: 'lang', value: 'ru' }
    ]);
    expect(getUser.request.url.variable).toEqual([{ key: 'id', value: '42' }]);
    expect(getUser.request.description).toBe('Returns a single user');
    const pre = getUser.event.find((e: any) => e.listen === 'prerequest');
    const test = getUser.event.find((e: any) => e.listen === 'test');
    expect(pre.script.exec.join('\n')).toContain('pm.request.headers');
    expect(test.script.exec.join('\n')).toContain('pm.test');
    expect(getUser.response[0].code).toBe(200);
    expect(getUser.response[0].body).toBe('{"id":42,"name":"Ann"}');
  });

  describe('headers (collection/folder headers copied into requests)', () => {
    it('request headers override inherited ones by name', () => {
      expect(all['Users/Get user'].request.header).toEqual([
        h('X-Client', 'bruno-obsidian'),
        h('X-Level', 'collection'),
        h('X-Folder', 'users'),
        h('Accept', 'application/json'),
        h('X-Debug', '1', true)
      ]);
    });

    it('deeper folders override shallower ones, disabled rows stay disabled', () => {
      expect(all['Users/Admin/Login form'].request.header).toEqual([
        h('X-Client', 'bruno-obsidian'),
        h('Accept', '*/*'),
        h('X-Level', 'collection'),
        h('X-Folder', 'admin'),
        h('X-Off', '1', true)
      ]);
      expect(all['Auth/Digest'].request.header).toEqual([
        h('X-Client', 'bruno-obsidian'),
        h('Accept', '*/*'),
        h('X-Level', 'auth-folder')
      ]);
    });

    it('top-level requests get collection headers', () => {
      expect(all['Health'].request.header.map((x: any) => x.key)).toEqual(['X-Client', 'Accept', 'X-Level']);
    });
  });

  describe('auth', () => {
    it('collection and folder auth are exported; inherit omits auth', () => {
      expect(postman.auth).toEqual({ type: 'bearer', bearer: [p('token', '{{token}}')] });
      const users = postman.item.find((i: any) => i.name === 'Users');
      expect(users.auth).toEqual({ type: 'basic', basic: [p('username', 'admin'), p('password', 'secret')] });
      expect(users.item.find((i: any) => i.name === 'Admin').auth).toBeUndefined();
      expect(postman.item.find((i: any) => i.name === 'Auth').auth).toEqual({ type: 'noauth' });
      expect(all['Users/Get user'].request.auth).toBeUndefined();
      expect(all['Auth/Inherit'].request.auth).toBeUndefined();
      expect(all['Health'].request.auth).toEqual({ type: 'noauth' });
    });

    it('bearer, basic, apikey (header and query)', () => {
      expect(all['Users/Admin/Import XML'].request.auth).toEqual({ type: 'bearer', bearer: [p('token', 'xml-token')] });
      expect(authParams(all['Users/Create user'])).toEqual({ key: 'X-Api-Key', value: '{{apiKey}}', in: 'header' });
      expect(authParams(all['Auth/ApiKey query'])).toEqual({ key: 'api_key', value: 'k1', in: 'query' });
    });

    it('digest, ntlm, awsv4, edgegrid, oauth1', () => {
      expect(authParams(all['Auth/Digest'])).toEqual({ username: 'du', password: 'dp' });
      expect(authParams(all['Auth/NTLM'])).toEqual({ username: 'nu', password: 'np', domain: 'CORP' });
      expect(authParams(all['Auth/AWS'])).toEqual({ accessKey: 'AKIA', secretKey: 'sk', sessionToken: 'st', region: 'eu-west-1', service: 's3' });
      expect(all['Auth/EdgeGrid'].request.auth.type).toBe('edgegrid');
      expect(authParams(all['Auth/EdgeGrid'])).toMatchObject({ accessToken: 'eat', clientToken: 'ect', clientSecret: 'ecs', baseURL: 'https://akab.example.com', headersToSign: 'X-A' });
      expect(authParams(all['Auth/OAuth1'])).toMatchObject({
        consumerKey: 'ck', consumerSecret: 'cs', token: 'at', tokenSecret: 'ats', signatureMethod: 'HMAC-SHA1', addParamsToHeader: true
      });
    });

    it('oauth2 grant types', () => {
      expect(authParams(all['Auth/OAuth2 password'])).toMatchObject({
        grant_type: 'password_credentials', username: 'ou', password: 'op',
        accessTokenUrl: 'https://idp.example.com/token', clientId: 'cid', clientSecret: 'csecret', scope: 'read write',
        client_authentication: 'body', addTokenTo: 'queryParams'
      });
      expect(authParams(all['Auth/OAuth2 code PKCE'])).toMatchObject({
        grant_type: 'authorization_code_with_pkce', authUrl: 'https://idp.example.com/auth', redirect_uri: 'https://app/cb',
        client_authentication: 'header', addTokenTo: 'header', challengeAlgorithm: 'S256'
      });
      expect(authParams(all['Auth/OAuth2 client']).grant_type).toBe('client_credentials');
    });

    it('WSSE becomes explicit No Auth with a warning', () => {
      expect(all['Auth/WSSE'].request.auth).toEqual({ type: 'noauth' });
      expect(warnings).toEqual(['WSSE auth is not supported by Postman, exported as "No Auth": Auth/WSSE']);
    });
  });

  it('converts every body mode', () => {
    expect(all['Users/Create user'].request.body.mode).toBe('raw');
    expect(all['Users/Create user'].request.body.options.raw.language).toBe('json');
    expect(JSON.parse(all['Users/Create user'].request.body.raw)).toEqual({ name: 'Ann', roles: ['admin'] });
    expect(all['Users/Admin/Login form'].request.body.urlencoded).toEqual([
      { key: 'username', value: 'admin', disabled: false, type: 'default' },
      { key: 'remember', value: 'true', disabled: true, type: 'default' }
    ]);
    expect(all['Users/Admin/Upload avatar'].request.body).toEqual({
      mode: 'formdata',
      formdata: [
        { key: 'caption', disabled: false, type: 'text', value: 'me' },
        { key: 'avatar', disabled: false, type: 'file', src: 'files/me.png', contentType: 'image/png' },
        { key: 'extra', disabled: true, type: 'file', src: ['a.txt', 'b.txt'] }
      ]
    });
    expect(all['Users/Admin/Upload binary'].request.body).toEqual({ mode: 'file', file: { src: 'files/data.bin' } });
    expect(all['Sparql'].request.body).toEqual({ mode: 'raw', raw: 'SELECT * WHERE { ?s ?p ?o }', options: { raw: { language: 'text' } } });
    expect(all['Users/Admin/Import XML'].request.body.options.raw.language).toBe('xml');
    expect(all['Echo text'].request.body.raw).toBe('hello\nworld');
    expect(all['GraphQL users'].request.body.mode).toBe('graphql');
    expect(all['GraphQL users'].request.body.graphql.query).toContain('users(first: $n)');
    expect(all['Health'].request.body).toBeUndefined();
  });

  it('collects {{variables}} as collection variables', () => {
    const keys = postman.variable.map((v: any) => v.key);
    expect(keys).toEqual(expect.arrayContaining(['baseUrl', 'token', 'apiKey', 'apiVersion']));
  });

  it('round-trips through the Postman importer', async () => {
    const back = await converters.postmanToBruno(viaJson(postman));
    const b = flatten(back.items);
    expect(Object.keys(b).sort()).toEqual(Object.keys(all).sort());
    expect(b['Users/Get user'].request.url).toBe('{{baseUrl}}/users/:id?expand=roles&lang=ru');
    expect(b['Users/Get user'].request.headers.map((x: any) => x.name)).toEqual(['X-Client', 'X-Level', 'X-Folder', 'Accept', 'X-Debug']);
    expect(back.root.request.auth).toMatchObject({ mode: 'bearer', bearer: { token: '{{token}}' } });
    expect(b['Users'].root.request.auth).toMatchObject({ mode: 'basic', basic: { username: 'admin', password: 'secret' } });
    expect(b['Users/Get user'].request.auth.mode).toBe('inherit');
    expect(b['Auth/Digest'].request.auth).toMatchObject({ mode: 'digest', digest: { username: 'du', password: 'dp' } });
    expect(b['Auth/AWS'].request.auth.awsv4).toMatchObject({ accessKeyId: 'AKIA', secretAccessKey: 'sk', region: 'eu-west-1', service: 's3' });
    expect(b['Auth/OAuth2 password'].request.auth.oauth2).toMatchObject({ grantType: 'password', username: 'ou', credentialsPlacement: 'body' });
    expect(b['Auth/OAuth2 code PKCE'].request.auth.oauth2).toMatchObject({ grantType: 'authorization_code', pkce: true, callbackUrl: 'https://app/cb' });
    expect(b['Users/Admin/Upload avatar'].request.body.multipartForm[1]).toMatchObject({ type: 'file', name: 'avatar', value: ['files/me.png'] });
  });

  it('does not mutate the collection it is given', () => {
    const before = JSON.stringify(full);
    buildPostmanSource(full);
    buildBrunoExport(full);
    expect(JSON.stringify(full)).toBe(before);
  });
});

describe('Postman export: edge collection', () => {
  it('handles Cyrillic names, empty folders and collections without a root', async () => {
    const { full, invoke } = await setup(edgeCollection);
    const { collection, warnings } = await buildPostmanExport(full, invoke);
    const postman = viaJson(collection);
    expect(warnings).toEqual([]);
    expect(postman.auth).toBeUndefined();
    expect(postman.info.name).toBe('Неватом: обмен?');
    expect(postman.item.map((i: any) => i.name)).toEqual(['Обновляем токен', 'Пользователи', 'Пустая папка', 'Работа с очередями']);
    expect(postman.item.find((i: any) => i.name === 'Пустая папка').item).toEqual([]);
    expect(flatten(postman.item)['Работа с очередями/Удаление событий'].request.method).toBe('DELETE');
  });
});

describe('file names', () => {
  it('produces names that are valid on every OS', () => {
    expect(getExportFileName('Неватом: обмен?')).toBe('Неватом- обмен-.json');
    expect(getExportFileName('a/b\\c', '_postman')).toBe('a-b-c_postman.json');
    expect(getExportFileName('')).toBe('collection.json');
  });
});
