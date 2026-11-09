/**
 * Fills in what @usebruno/converters' brunoToPostman leaves out or gets wrong:
 *  - auth: only bearer/basic/apikey were mapped, `inherit` became `noauth`
 *    (which in Postman *disables* the parent's auth), apikey lost its placement,
 *    bearer was emitted as an object instead of a v2.1 parameter list;
 *  - collection/folder auth was dropped;
 *  - collection/folder headers were dropped: Postman has no such level, so they
 *    are copied into every request below them (Bruno's merge order, deeper wins);
 *  - multipart file fields, binary file bodies and SPARQL bodies were emptied.
 *
 * Operates on the converter's output, walking it in lockstep with the source
 * it was produced from (see buildPostmanSource, which guarantees the shapes match).
 */
import get from 'lodash/get';

type PostmanParam = { key: string; value: any; type: string };

const param = (key: string, value: any, type = 'string'): PostmanParam => ({
  key,
  value: value ?? '',
  type: typeof value === 'boolean' ? 'boolean' : type
});

const params = (entries: Record<string, any>): PostmanParam[] =>
  Object.entries(entries)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => param(k, v));

export const UNSUPPORTED_AUTH_MODES: Record<string, string> = {
  wsse: 'WSSE'
};

const OAUTH2_GRANT_TYPES: Record<string, string> = {
  authorization_code: 'authorization_code',
  client_credentials: 'client_credentials',
  password: 'password_credentials',
  implicit: 'implicit'
};

const toPostmanOAuth2 = (o: any = {}) => {
  let grantType = OAUTH2_GRANT_TYPES[o.grantType] || o.grantType || 'client_credentials';
  if (grantType === 'authorization_code' && o.pkce) grantType = 'authorization_code_with_pkce';

  return [
    param('grant_type', grantType),
    ...params({
      authUrl: o.authorizationUrl,
      accessTokenUrl: o.accessTokenUrl,
      refreshTokenUrl: o.refreshTokenUrl,
      redirect_uri: o.callbackUrl,
      clientId: o.clientId,
      clientSecret: o.clientSecret,
      scope: o.scope,
      state: o.state,
      username: o.username,
      password: o.password,
      headerPrefix: o.tokenHeaderPrefix
    }),
    param('client_authentication', o.credentialsPlacement === 'body' ? 'body' : 'header'),
    param('addTokenTo', o.tokenPlacement === 'url' ? 'queryParams' : 'header'),
    ...(grantType === 'authorization_code_with_pkce' ? [param('challengeAlgorithm', 'S256')] : [])
  ];
};

/**
 * Bruno auth → Postman auth.
 * `undefined` means "omit the auth key", which is how Postman spells inherit.
 */
export const toPostmanAuth = (auth: any, level: 'collection' | 'folder' | 'request'): any => {
  const mode = auth?.mode;
  if (!mode || mode === 'inherit') return undefined;
  // A collection without auth is just absent auth in Postman.
  if (mode === 'none') return level === 'collection' ? undefined : { type: 'noauth' };

  switch (mode) {
    case 'basic':
      return { type: 'basic', basic: [param('username', auth.basic?.username), param('password', auth.basic?.password)] };
    case 'bearer':
      return { type: 'bearer', bearer: [param('token', auth.bearer?.token)] };
    case 'apikey':
      return {
        type: 'apikey',
        apikey: [
          param('key', auth.apikey?.key),
          param('value', auth.apikey?.value),
          param('in', auth.apikey?.placement === 'queryparams' ? 'query' : 'header')
        ]
      };
    case 'digest':
      return { type: 'digest', digest: [param('username', auth.digest?.username), param('password', auth.digest?.password)] };
    case 'ntlm':
      return {
        type: 'ntlm',
        ntlm: [param('username', auth.ntlm?.username), param('password', auth.ntlm?.password), param('domain', auth.ntlm?.domain)]
      };
    case 'awsv4':
      return {
        type: 'awsv4',
        awsv4: [
          param('accessKey', auth.awsv4?.accessKeyId),
          param('secretKey', auth.awsv4?.secretAccessKey),
          param('sessionToken', auth.awsv4?.sessionToken),
          param('region', auth.awsv4?.region),
          param('service', auth.awsv4?.service)
        ]
      };
    case 'akamai-edgegrid': {
      const a = auth.akamaiEdgegrid || {};
      return {
        type: 'edgegrid',
        edgegrid: params({
          accessToken: a.accessToken,
          clientToken: a.clientToken,
          clientSecret: a.clientSecret,
          baseURL: a.baseURL,
          nonce: a.nonce,
          timestamp: a.timestamp,
          headersToSign: a.headersToSign
        })
      };
    }
    case 'oauth1': {
      const a = auth.oauth1 || {};
      return {
        type: 'oauth1',
        oauth1: [
          ...params({
            consumerKey: a.consumerKey,
            consumerSecret: a.consumerSecret,
            token: a.accessToken,
            tokenSecret: a.accessTokenSecret,
            signatureMethod: a.signatureMethod,
            callback: a.callbackUrl,
            verifier: a.verifier,
            timestamp: a.timestamp,
            nonce: a.nonce,
            version: a.version,
            realm: a.realm,
            privateKey: a.privateKeyType === 'text' ? a.privateKey : undefined
          }),
          param('addParamsToHeader', (a.placement || 'header') === 'header'),
          param('includeBodyHash', !!a.includeBodyHash)
        ]
      };
    }
    case 'oauth2':
      return { type: 'oauth2', oauth2: toPostmanOAuth2(auth.oauth2) };
    default:
      // No Postman equivalent (WSSE): explicit "no auth" rather than silently inheriting the parent's.
      return { type: 'noauth' };
  }
};

const toPostmanHeader = (h: any) => ({
  key: h.name || '',
  value: h.value || '',
  disabled: !h.enabled,
  type: 'default'
});

/** Collection → folders → request, the order Bruno applies headers in; deeper levels win by name. */
const mergeInheritedHeaders = (inherited: any[][], own: any[] = []) => {
  const byName = new Map<string, any>();
  for (const level of inherited) {
    for (const h of level || []) {
      if (!h?.name) continue;
      const key = h.name.toLowerCase();
      byName.delete(key); // keep the deeper one's position too
      byName.set(key, h);
    }
  }
  const overridden = new Set(own.filter((h) => h?.enabled && h?.name).map((h) => h.name.toLowerCase()));
  return [...[...byName.values()].filter((h) => !overridden.has(h.name.toLowerCase())), ...own];
};

const toPostmanBody = (body: any, fallback: any) => {
  switch (body?.mode) {
    case 'multipartForm':
      return {
        mode: 'formdata',
        formdata: (body.multipartForm || []).map((f: any) => {
          const field: any = { key: f.name || '', disabled: !f.enabled };
          if (f.type === 'file') {
            const src = (Array.isArray(f.value) ? f.value : [f.value]).filter(Boolean);
            field.type = 'file';
            field.src = src.length === 1 ? src[0] : src;
          } else {
            field.type = 'text';
            field.value = f.value ?? '';
          }
          if (f.contentType) field.contentType = f.contentType;
          return field;
        })
      };
    case 'file': {
      const files = body.file || [];
      const selected = files.find((f: any) => f.selected) || files[0];
      return selected?.filePath ? { mode: 'file', file: { src: selected.filePath } } : undefined;
    }
    case 'sparql':
      return { mode: 'raw', raw: body.sparql || '', options: { raw: { language: 'text' } } };
    default:
      return fallback;
  }
};

const fixBody = (pmRequest: any, body: any) => {
  if (!pmRequest || !body || body.mode === 'none') return;
  const fixed = toPostmanBody(body, pmRequest.body);
  if (fixed) pmRequest.body = fixed;
  else delete pmRequest.body;
};

const setAuth = (target: any, auth: any) => {
  if (auth) target.auth = auth;
  else delete target.auth;
};

export interface EnhanceResult {
  collection: any;
  warnings: string[];
}

export const enhancePostmanExport = (source: any, postman: any): EnhanceResult => {
  const warnings: string[] = [];
  const warnAuth = (auth: any, where: string) => {
    const label = UNSUPPORTED_AUTH_MODES[auth?.mode];
    if (label) warnings.push(`${label} auth is not supported by Postman, exported as "No Auth": ${where}`);
  };

  const collectionAuth = get(source, 'root.request.auth');
  warnAuth(collectionAuth, 'collection');
  setAuth(postman, toPostmanAuth(collectionAuth, 'collection'));

  const walk = (srcItems: any[] = [], pmItems: any[] = [], headerChain: any[][], pathPrefix: string) => {
    const expectedName = (s: any) => s.name || (s.type === 'folder' ? 'Untitled Folder' : 'Untitled Request');
    if (srcItems.length !== pmItems.length || srcItems.some((s, i) => expectedName(s) !== pmItems[i]?.name)) {
      throw new Error('Postman export: converter output does not match the source tree');
    }
    srcItems.forEach((src, i) => {
      const pm = pmItems[i];
      const where = pathPrefix ? `${pathPrefix}/${src.name}` : src.name;

      if (src.type === 'folder') {
        const folderAuth = get(src, 'root.request.auth');
        warnAuth(folderAuth, where);
        setAuth(pm, toPostmanAuth(folderAuth, 'folder'));
        walk(src.items, pm.item, [...headerChain, get(src, 'root.request.headers', [])], where);
        return;
      }

      const req = src.request || {};
      warnAuth(req.auth, where);
      setAuth(pm.request, toPostmanAuth(req.auth, 'request'));
      pm.request.header = mergeInheritedHeaders(headerChain, req.headers || []).map(toPostmanHeader);
      fixBody(pm.request, req.body);

      (src.examples || []).forEach((example: any, j: number) => {
        fixBody(pm.response?.[j]?.originalRequest, example?.request?.body);
      });
    });
  };

  walk(source.items, postman.item, [get(source, 'root.request.headers', [])], '');
  return { collection: postman, warnings };
};
