import * as http from 'http';
import { ivm } from './'
import * as url from 'url';
import * as net from 'net';
import * as fs from 'fs';
import { Config } from './config'
import log from './log'
import { Trace } from './trace';
import mksuid from "mksuid"
import * as httpUtils from './utils/http'
import { Readable, Writable, Transform } from 'stream'
import { AppStore } from './app/store'
import { Context } from './context'
import { App } from './app'

import EventEmitter = require('events')
import { DefaultContextStore } from './default_context_store';

const proxiedHttp = require('findhit-proxywrap').proxy(http, { strict: false })
const { version } = require('../package.json');

import { bufferToStream, transferInto } from './utils/buffer'
import { ProxyStream } from './bridge/proxy_stream';

const defaultFetchDispatchTimeout = 1000
const defaultFetchEndTimeout = 5000

const hopHeaders = [
	// From RFC 2616 section 13.5.1
	"Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"TE",
	"Trailers",
	"Transfer-Encoding",
	"Upgrade",

	// We don't want to trigger upstream HTTPS redirect
	"Upgrade-Insecure-Requests"
]

export interface RequestMeta {
	app: App,
	startedAt: [number, number], //process.hrtime() ya know
	endedAt?: [number, number],
	id: string,
	originalURL: string,
}

declare module 'http' {
	interface IncomingMessage {
		meta: RequestMeta
		ctx?: Context
	}
}

export interface ServerOptions {
	serverHeader?: string
	isTLS?: boolean
	onRequest?: Function
	fetchDispatchTimeout?: number
	fetchEndTimeout?: number
}

const defaultServerHeader = `fly (${version})`

export class Server extends EventEmitter {
	server: http.Server
	config: Config
	options: ServerOptions

	constructor(config: Config, options?: ServerOptions) {
		super()
		this.config = config
		this.options = Object.assign({}, {
			fetchDispatchTimeout: defaultFetchDispatchTimeout,
			fetchEndTimeout: defaultFetchEndTimeout,
			serverHeader: defaultServerHeader
		}, options || {})
		this.server = proxiedHttp.createServer(this.handleRequest.bind(this));
	}

	async start() {
		this.server.on('listening', () => {
			this.emit('listening')
			log.info("Server listening on", this.config.port);
			// set permissions
			if (typeof this.config.port === "string") {
				fs.chmod(this.config.port.toString(), 0o777, () => { });
			}
		});

		// double-check EADDRINUSE
		this.server.on('error', (e: any) => {
			if (typeof this.config.port === "string") {
				if (e.code !== 'EADDRINUSE') throw e;
				net.connect({ path: this.config.port.toString() }, () => {
					// really in use: re-throw
					log.error(this.config.port.toString(), "socket already in use")
					this.emit('error', e)
				}).on('error', (e: any) => {
					if (e.code !== 'ECONNREFUSED') throw e;
					// not in use: delete it and re-listen
					fs.unlinkSync(this.config.port.toString());
					this.server.listen(this.config.port.toString());
				});
			} else {
				this.emit('error', e)
			}
		});

		this.server.listen(this.config.port);
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
		const startedAt = process.hrtime()
		const requestID = mksuid()
		const trace = Trace.start("httpRequest")
		if (request.url === undefined) // wtf
			return

		if (request.headers.host === undefined)
			return

		if (request.url == undefined) { // that can't really happen?
			return
		}

		if (!this.config.appStore) {
			throw new Error("please define an appStore")
		}

		let finalHeaders: http.OutgoingHttpHeaders = {}

		if (this.options.serverHeader)
			response.setHeader("Server", this.options.serverHeader)

		request.headers['x-request-id'] = requestID

		let app: any
		const tapp = trace.start("getApp")
		try {
			app = await this.config.appStore.getAppByHostname(request.headers.host, tapp)
		} catch (err) {
			log.error("error getting app", err)
			response.writeHead(500)
			response.end()
			return
		} finally {
			tapp.end()
		}

		log.info("checked app for", request.headers.host)

		if (!app) {
			if (await this.runRequestHook(null, request, response))
				return
			response.writeHead(404)
			response.end()
			return
		}

		const scheme = this.options.isTLS ? 'https:' : 'http:'
		const fullURL = httpUtils.fullURL(scheme, request)

		request.meta = {
			id: requestID,
			app: app,
			startedAt: startedAt,
			originalURL: fullURL,
		}
		this.emit('request', request)

		try {

			if (!app.source) {
				if (await this.runRequestHook(null, request, response))
					return
				response.writeHead(400)
				response.end("app has no source")
				return
			}

			if (!this.config.contextStore)
				this.config.contextStore = new DefaultContextStore()

			let t = trace.start("acquireContext")
			let ctx = await this.config.contextStore.getContext(this.config, app, t)
			t.end()
			ctx.trace = trace

			if (await this.runRequestHook(ctx, request, response)) {
				this.config.contextStore.putContext(ctx)
				return
			}

			let flyDepth = 0
			let flyDepthHeader = <string>request.headers["x-fly-depth"]
			if (flyDepthHeader) {
				log.debug("got depth header: ", flyDepthHeader)
				flyDepth = parseInt(flyDepthHeader)
				if (isNaN(flyDepth) || flyDepth < 0) {
					flyDepth = 0
				}
			}

			ctx.meta = new Map<string, any>([
				...ctx.meta,
				['app', app],

				['requestID', requestID],
				['originalScheme', scheme],
				['originalHost', request.headers.host],
				['originalPath', request.url],
				['originalURL', fullURL],
				['flyDepth', flyDepth]
			])

			ctx.set('app', new ivm.ExternalCopy({ id: app.id, config: app.config }).copyInto())

			let fireEvent = await ctx.get("fireEvent")

			request.pause()

			let reqForV8 = new ivm.ExternalCopy({
				method: request.method,
				headers: httpUtils.headersForWeb(request.rawHeaders),
				remoteAddr: request.connection.remoteAddress
			}).copyInto()

			t = Trace.tryStart("fetchEvent", ctx.trace)
			ctx.trace = t
			let cbCalled = false
			await new Promise((resolve, reject) => { // mainly to make try...finally work
				fireEvent.apply(undefined, [
					"fetch",
					fullURL,
					reqForV8,
					new ProxyStream(request).ref,
					new ivm.Reference((err: any, res: any, resBody: ArrayBuffer | ivm.Reference<ProxyStream>) => {
						if (cbCalled) {
							return // this can't happen twice
						}
						cbCalled = true
						t.end()
						ctx.trace = t.parent

						if (err) {
							log.error("error from fetch callback:", err)
							response.writeHead(500)
							response.end("Error: " + err)
							// release ctx
							if (this.config.contextStore)
								this.config.contextStore.putContext(ctx)
							return
						}

						for (let n in res.headers) {
							try {
								const niceName = httpUtils.normalizeHeader(n)
								const val = res.headers[n]
								response.setHeader(niceName, val)
								finalHeaders[niceName] = val
							} catch (err) {
								log.error("error setting header", err)
							}
						}

						for (let n of hopHeaders)
							response.removeHeader(n)


						if (this.options.serverHeader)
							response.setHeader("Server", this.options.serverHeader)

						response.writeHead(res.status)

						let resProm: Promise<void>

						if(resBody instanceof ivm.Reference){
							let res = resBody.deref().stream
							resProm = handleResponse(res, response)
						} else if (resBody) {
							resProm = handleResponse(bufferToStream(Buffer.from(resBody)), response)
						} else {
							resProm = Promise.resolve()
						}

						resProm.then(() => {
							request.meta.endedAt = process.hrtime()
							response.end() // we are done. triggers 'finish' event
							resolve()
							let finalResponse = {
								status: 200,
								statusText: "OK",
								ok: true,
								url: fullURL,
								headers: {}
							}

							finalResponse.status = res.status
							finalResponse.statusText = res.statusText
							finalResponse.ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 400
							finalResponse.headers = finalHeaders
							fireEvent.apply(undefined, [
								"fetchEnd",
								fullURL,
								reqForV8,
								new ivm.ExternalCopy(finalResponse),
								null,
								new ivm.Reference(() => { // done callback
									log.debug("finished all fetchEnd")
									if (this.config.contextStore)
										this.config.contextStore.putContext(ctx)
								})
							], { timeout: this.options.fetchEndTimeout })
						})
					})
				], { timeout: this.options.fetchDispatchTimeout })
			})

		} catch (e) {
			log.error("error...", e, e.stack)
			response.statusCode = 500
			response.end("Critical error.")
		} finally {
			trace.end()
			this.emit('requestEnd', request, response, trace)
		}
	}

	async runRequestHook(ctx: Context | null, req: http.IncomingMessage, res: http.ServerResponse) {
		if (this.options.onRequest) {
			await this.options.onRequest(ctx, req, res)
			return res.finished
		}
	}

	stop() {
		return new Promise((resolve, reject) => {
			this.server.close(() => {
				log.info("closed server")
				resolve()
			})
		})
	}
}

function handleResponse(src: Readable, dst: Writable): Promise<void> {
	return new Promise(function (resolve, reject) {
		setImmediate(() => {
			src.pipe(dst)
				.on("finish", function () {
					resolve()
				}).on("error", reject)
		})
	})
}