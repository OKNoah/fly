import { registerBridge } from './'

import { ivm, Context } from '../'
import log from "../log"
import * as http from 'http'
import * as https from 'https'
import { URL, parse as parseURL, format as formatURL } from 'url'
import { fullURL } from '../utils/http'
import { transferInto } from '../utils/buffer'
import { ProxyStream } from './proxy_stream'

import { Trace } from '../trace'
import { FileNotFound } from '../file_store';
import { Bridge } from './bridge';


const fetchAgent = new http.Agent({ keepAlive: true });
const fetchHttpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false })

registerBridge('fetch', function fetchBridge(ctx: Context, bridge: Bridge, urlStr: string, init: any, body: ArrayBuffer, cb: ivm.Reference<Function>) {
  log.info("native fetch with url:", urlStr)
  log.silly("fetch init: ", JSON.stringify(init))
  let t = Trace.tryStart('fetch', ctx.trace)
  ctx.addCallback(cb)
  init || (init = {})
  const u = parseURL(urlStr)

  if (u.protocol === 'file:') {
    if (!ctx.meta.app) {
      ctx.tryCallback(cb, ["no app configured, should not happen!"])
      return
    }
    if (!bridge.fileStore) {
      ctx.tryCallback(cb, ["no file store configured, should not happen!"])
      return
    }

    if (init.method && init.method != 'GET') {
      ctx.tryCallback(cb, ["only GET allowed on file:// URIs"])
      return
    }

    try {
      bridge.fileStore.createReadStream(urlStr.replace("file://", "")).then((stream) => {
        stream.pause()
        ctx.applyCallback(cb, [null,
          new ivm.ExternalCopy({
            status: 200,
            statusText: "OK",
            ok: true,
            url: urlStr,
            headers: {}
          }).copyInto({ release: true }),
          new ProxyStream(stream).ref
        ])
      }).catch((err) => {
        ctx.tryCallback(cb, [err.toString()])
      })
    } catch (e) {
      // Might throw FileNotFound
      ctx.tryCallback(cb, [e.toString()])
    }
    return
  }

  let depth = ctx.meta.flyDepth || 0

  log.silly("fetch depth: ", depth)
  if (depth >= 3) {
    log.error("too much recursion: ", depth)
    ctx.tryCallback(cb, ["Too much recursion"])
    return
  }

  if (!u.host)
    u.host = ctx.meta.originalHost
  if (!u.protocol)
    u.protocol = ctx.meta.originalScheme

  const httpFn = u.protocol == 'http:' ? http.request : https.request
  const httpAgent = u.protocol == 'http:' ? fetchAgent : fetchHttpsAgent

  let method = init.method || "GET"
  let headers = Object.assign({},
    // defaults
    {
      origin: `${ctx.meta.originalScheme}//${ctx.meta.originalHost}`
    },
    // user-supplied
    init.headers || {},
    // override
    {
      'x-fly-depth': (depth + 1).toString()
    }
  )

  let req: http.ClientRequest;

  let path = u.pathname
  if (u.query != null) {
    path = path + "?" + u.query
  }
  req = httpFn({
    agent: httpAgent,
    protocol: u.protocol,
    path: path,
    hostname: u.hostname,
    host: u.host,
    port: u.port,
    method: method,
    headers: headers,
    timeout: 5000
  })


  req.on("response", function (res: http.IncomingMessage) {
    log.silly(`Fetch response: ${res.statusCode} ${urlStr} ${JSON.stringify(res.headers)}`)
    try {
      res.pause()

      ctx.applyCallback(cb, [
        null,
        new ivm.ExternalCopy({
          status: res.statusCode,
          statusText: res.statusMessage,
          ok: res.statusCode && res.statusCode >= 200 && res.statusCode < 400,
          url: urlStr,
          headers: res.headers
        }).copyInto({ release: true }),
        new ProxyStream(res).ref
      ])


    } catch (err) {
      log.error("caught error", err)
      ctx.tryCallback(cb, [err.toString()])
    }
  })

  req.on("error", function (err) {
    log.error("error requesting http resource", err)
    ctx.tryCallback(cb, [err.toString()])
  })

  setImmediate(() =>
    req.end(body && Buffer.from(body) || null)
  )

  return cb
})