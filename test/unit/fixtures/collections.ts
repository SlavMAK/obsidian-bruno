/**
 * Test collections for export. Requests are described in app format, written
 * to .bru with the real @usebruno/filestore and parsed back, so they look
 * exactly like what the extension reads from disk.
 */

const kv = (name: string, value: string, extra: Record<string, unknown> = {}) => ({ name, value, enabled: true, ...extra });

const baseRequest = (overrides: Record<string, any> = {}) => ({
  method: 'GET',
  url: '',
  params: [],
  headers: [],
  auth: { mode: 'inherit' },
  body: { mode: 'none' },
  script: {},
  vars: {},
  assertions: [],
  tests: '',
  docs: '',
  ...overrides
});

export interface FixtureRequest {
  file: string; // relative path inside the collection
  item: Record<string, any>;
}

export interface FixtureFolder {
  dir: string;
  root?: Record<string, any>;
}

export interface FixtureCollection {
  name: string;
  root?: Record<string, any>;
  folders: FixtureFolder[];
  requests: FixtureRequest[];
  environments: any[];
}


const authRequest = (name: string, seq: number, auth: any) => ({
  file: `Auth/${name}.bru`,
  item: { type: 'http-request', name, seq, request: baseRequest({ url: `{{baseUrl}}/auth/${seq}`, auth }) }
});

const oauth2Base = {
  accessTokenUrl: 'https://idp.example.com/token',
  refreshTokenUrl: 'https://idp.example.com/refresh',
  clientId: 'cid',
  clientSecret: 'csecret',
  scope: 'read write',
  credentialsPlacement: 'body',
  credentialsId: 'credentials',
  tokenPlacement: 'url',
  tokenHeaderPrefix: 'Bearer',
  tokenQueryKey: 'access_token',
  autoFetchToken: true,
  autoRefreshToken: true
};

export const authRequests: FixtureRequest[] = [
  authRequest('Digest', 1, { mode: 'digest', digest: { username: 'du', password: 'dp' } }),
  authRequest('NTLM', 2, { mode: 'ntlm', ntlm: { username: 'nu', password: 'np', domain: 'CORP' } }),
  authRequest('AWS', 3, {
    mode: 'awsv4',
    awsv4: { accessKeyId: 'AKIA', secretAccessKey: 'sk', sessionToken: 'st', service: 's3', region: 'eu-west-1', profileName: '' }
  }),
  authRequest('OAuth2 password', 4, { mode: 'oauth2', oauth2: { grantType: 'password', username: 'ou', password: 'op', ...oauth2Base } }),
  authRequest('OAuth2 code PKCE', 5, {
    mode: 'oauth2',
    oauth2: { grantType: 'authorization_code', callbackUrl: 'https://app/cb', authorizationUrl: 'https://idp.example.com/auth', pkce: true, ...oauth2Base, credentialsPlacement: 'basic_auth_header', tokenPlacement: 'header' }
  }),
  authRequest('OAuth2 client', 6, { mode: 'oauth2', oauth2: { grantType: 'client_credentials', ...oauth2Base } }),
  authRequest('OAuth1', 7, {
    mode: 'oauth1',
    oauth1: { consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats', signatureMethod: 'HMAC-SHA1', placement: 'header', includeBodyHash: false, version: '1.0' }
  }),
  authRequest('EdgeGrid', 8, {
    mode: 'akamai-edgegrid',
    akamaiEdgegrid: { accessToken: 'eat', clientToken: 'ect', clientSecret: 'ecs', baseURL: 'https://akab.example.com', headersToSign: 'X-A' }
  }),
  authRequest('WSSE', 9, { mode: 'wsse', wsse: { username: 'wu', password: 'wp' } }),
  authRequest('ApiKey query', 10, { mode: 'apikey', apikey: { key: 'api_key', value: 'k1', placement: 'queryparams' } }),
  authRequest('Inherit', 11, { mode: 'inherit' })
];

/** Everything the Bruno format can hold, incl. types Postman cannot. */
export const richCollection: FixtureCollection = {
  name: 'Rich API',
  root: {
    request: {
      auth: { mode: 'bearer', bearer: { token: '{{token}}' } },
      headers: [kv('X-Client', 'bruno-obsidian'), kv('Accept', '*/*'), kv('X-Level', 'collection')],
      script: { req: 'bru.setVar("startedAt", Date.now());', res: '' },
      vars: { req: [kv('apiVersion', 'v2')] },
      tests: ''
    },
    docs: '# Rich API\nCollection docs'
  },
  folders: [
    {
      dir: 'Users',
      root: {
        meta: { name: 'Users', seq: 2 },
        request: {
          auth: { mode: 'basic', basic: { username: 'admin', password: 'secret' } },
          headers: [kv('X-Folder', 'users')],
          script: { req: 'console.log("folder pre");' }
        },
        docs: 'Users folder docs'
      }
    },
    {
      dir: 'Users/Admin',
      root: { meta: { name: 'Admin', seq: 1 }, request: { headers: [kv('X-Folder', 'admin'), { name: 'X-Off', value: '1', enabled: false }] } }
    },
    {
      dir: 'Auth',
      root: { meta: { name: 'Auth', seq: 4 }, request: { auth: { mode: 'none' }, headers: [kv('X-Level', 'auth-folder')] } }
    },
    { dir: 'Realtime', root: { meta: { name: 'Realtime', seq: 1 } } }
  ],
  requests: [
    {
      file: 'Health.bru',
      item: {
        type: 'http-request',
        name: 'Health',
        seq: 3,
        request: baseRequest({ url: '{{baseUrl}}/health', auth: { mode: 'none' } })
      }
    },
    {
      file: 'Users/Get user.bru',
      item: {
        type: 'http-request',
        name: 'Get user',
        seq: 2,
        request: baseRequest({
          url: '{{baseUrl}}/users/:id?expand=roles&lang=ru',
          params: [
            kv('expand', 'roles', { type: 'query' }),
            kv('lang', 'ru', { type: 'query' }),
            kv('id', '42', { type: 'path' })
          ],
          headers: [kv('Accept', 'application/json'), { name: 'X-Debug', value: '1', enabled: false }],
          vars: { req: [kv('userId', '42')], res: [kv('userName', 'res.body.name')] },
          assertions: [kv('res.status', 'eq 200')],
          script: { req: 'req.setHeader("X-Trace", "abc");', res: 'bru.setVar("uid", res.body.id);' },
          tests: 'test("status is 200", function() {\n  expect(res.status).to.equal(200);\n});',
          docs: 'Returns a single user'
        }),
        examples: [
          {
            name: 'Found',
            description: 'User exists',
            type: 'http-request',
            request: {
              url: '{{baseUrl}}/users/42',
              method: 'GET',
              headers: [kv('Accept', 'application/json')],
              params: [],
              body: { mode: 'none' }
            },
            response: {
              status: 200,
              statusText: 'OK',
              headers: [kv('Content-Type', 'application/json')],
              body: { type: 'json', content: '{"id":42,"name":"Ann"}' }
            }
          }
        ]
      }
    },
    {
      file: 'Users/Create user.bru',
      item: {
        type: 'http-request',
        name: 'Create user',
        seq: 1,
        request: baseRequest({
          method: 'POST',
          url: '{{baseUrl}}/users',
          headers: [kv('Content-Type', 'application/json')],
          body: { mode: 'json', json: '{\n\t"name": "Ann",\n  "roles": ["admin"]\n}' },
          auth: { mode: 'apikey', apikey: { key: 'X-Api-Key', value: '{{apiKey}}', placement: 'header' } }
        })
      }
    },
    {
      file: 'Users/Admin/Login form.bru',
      item: {
        type: 'http-request',
        name: 'Login form',
        seq: 1,
        request: baseRequest({
          method: 'POST',
          url: '{{baseUrl}}/login',
          body: {
            mode: 'formUrlEncoded',
            formUrlEncoded: [kv('username', 'admin'), { name: 'remember', value: 'true', enabled: false }]
          }
        })
      }
    },
    {
      file: 'Users/Admin/Upload avatar.bru',
      item: {
        type: 'http-request',
        name: 'Upload avatar',
        seq: 2,
        request: baseRequest({
          method: 'PUT',
          url: '{{baseUrl}}/users/42/avatar',
          body: {
            mode: 'multipartForm',
            multipartForm: [
              kv('caption', 'me', { type: 'text' }),
              kv('avatar', ['files/me.png'] as any, { type: 'file', contentType: 'image/png' }),
              { name: 'extra', value: ['a.txt', 'b.txt'], type: 'file', enabled: false }
            ]
          }
        })
      }
    },
    {
      file: 'Users/Admin/Import XML.bru',
      item: {
        type: 'http-request',
        name: 'Import XML',
        seq: 3,
        request: baseRequest({
          method: 'POST',
          url: '{{baseUrl}}/import',
          body: { mode: 'xml', xml: '<users><user id="1"/></users>' },
          auth: { mode: 'bearer', bearer: { token: 'xml-token' } }
        })
      }
    },
    {
      file: 'Users/Admin/Upload binary.bru',
      item: {
        type: 'http-request',
        name: 'Upload binary',
        seq: 4,
        request: baseRequest({
          method: 'POST',
          url: '{{baseUrl}}/blob',
          body: {
            mode: 'file',
            file: [
              { filePath: 'files/other.bin', contentType: 'application/octet-stream', selected: false },
              { filePath: 'files/data.bin', contentType: 'application/octet-stream', selected: true }
            ]
          }
        })
      }
    },
    {
      file: 'Sparql.bru',
      item: {
        type: 'http-request',
        name: 'Sparql',
        seq: 5,
        request: baseRequest({ method: 'POST', url: '{{baseUrl}}/sparql', body: { mode: 'sparql', sparql: 'SELECT * WHERE { ?s ?p ?o }' } })
      }
    },
    ...authRequests,
    {
      file: 'Echo text.bru',
      item: {
        type: 'http-request',
        name: 'Echo text',
        seq: 1,
        request: baseRequest({
          method: 'PATCH',
          url: 'https://echo.example.com/text',
          body: { mode: 'text', text: 'hello\nworld' }
        })
      }
    },
    {
      file: 'GraphQL users.bru',
      item: {
        type: 'graphql-request',
        name: 'GraphQL users',
        seq: 2,
        request: baseRequest({
          method: 'POST',
          url: '{{baseUrl}}/graphql',
          body: {
            mode: 'graphql',
            graphql: { query: 'query Users($n: Int) { users(first: $n) { id } }', variables: '{"n": 5}' }
          }
        })
      }
    },
    {
      file: 'Realtime/Socket.bru',
      item: {
        type: 'ws-request',
        name: 'Socket',
        seq: 1,
        request: {
          url: 'wss://ws.example.com/feed',
          headers: [],
          auth: { mode: 'none' },
          body: { mode: 'ws', ws: [{ name: 'hello', type: 'json', content: '{"op":"sub"}' }] },
          script: {},
          vars: {},
          assertions: [],
          tests: '',
          docs: ''
        }
      }
    },
    {
      file: 'Realtime/Greeter.bru',
      item: {
        type: 'grpc-request',
        name: 'Greeter',
        seq: 2,
        request: {
          url: 'grpc://grpc.example.com:443',
          method: '/helloworld.Greeter/SayHello',
          methodType: 'unary',
          headers: [],
          auth: { mode: 'none' },
          body: { mode: 'grpc', grpc: [{ name: 'message 1', content: '{"name":"x"}' }] },
          script: {},
          vars: {},
          assertions: [],
          tests: '',
          docs: ''
        }
      }
    }
  ],
  environments: [
    {
      name: 'Local',
      variables: [
        { name: 'baseUrl', value: 'http://localhost:3000', enabled: true, secret: false, type: 'text' },
        { name: 'token', value: 'super-secret-token', enabled: true, secret: true, type: 'text' }
      ]
    }
  ]
};

/** Edge cases: unsafe name, Cyrillic, empty folder, no root, minimal requests. */
export const edgeCollection: FixtureCollection = {
  name: 'Неватом: обмен?',
  folders: [
    { dir: 'Пустая папка' },
    { dir: 'Работа с очередями' }
  ],
  requests: [
    {
      file: 'Пользователи.bru',
      item: {
        type: 'http-request',
        name: 'Пользователи',
        seq: 2,
        request: baseRequest({ url: 'https://crm.example.ru/rest/user.get?FILTER[ACTIVE]=Y', params: [kv('FILTER[ACTIVE]', 'Y', { type: 'query' })] })
      }
    },
    {
      file: 'Обновляем токен.bru',
      item: {
        type: 'http-request',
        name: 'Обновляем токен',
        seq: 1,
        request: baseRequest({ method: 'POST', url: '{{host}}/oauth/token', auth: { mode: 'none' } })
      }
    },
    {
      file: 'Работа с очередями/Удаление событий.bru',
      item: {
        type: 'http-request',
        name: 'Удаление событий',
        seq: 1,
        request: baseRequest({ method: 'DELETE', url: '{{host}}/queue/events' })
      }
    }
  ],
  environments: []
};

export const fixtures = [richCollection, edgeCollection];
