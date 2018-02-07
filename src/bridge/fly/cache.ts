import { registerBridge, Context } from '../'
import { ivm } from '../../'
import log from '../../log'
import { Trace } from '../../trace'
import { Config } from '../../config';

const errCacheStoreUndefined = new Error("cacheStore is not defined in the config.")

registerBridge('flyCacheSet', function (ctx: Context, config: Config) {
  return function cacheSet(key: string, value: string, ttl: number, callback: ivm.Reference<Function>) {
    let k = "cache:" + ctx.meta.get('app').id + ":" + key
    let t = Trace.tryStart("cacheSet", ctx.trace)

    if (!config.cacheStore)
      return callback.apply(null, [errCacheStoreUndefined.toString()])

    config.cacheStore.set(k, value, ttl).then((ok) => {
      t.end({ size: value.length, key: key })
      callback.apply(null, [null, ok])
    }).catch((err) => {
      log.error(err)
      t.end()
      callback.apply(null, [err.toString()])
    })
  }
})

registerBridge('flyCacheExpire', function (ctx: Context, config: Config) {
  return function cacheExpire(key: string, ttl: number, callback: ivm.Reference<Function>) {
    let t = Trace.tryStart("cacheExpire", ctx.trace)
    let k = "cache:" + ctx.meta.get('app').id + ":" + key

    if (!config.cacheStore)
      return callback.apply(null, [errCacheStoreUndefined.toString()])

    config.cacheStore.expire(k, ttl).then((ok) => {
      t.end({ key: key })
      callback.apply(null, [null, ok])
    }).catch((err) => {
      t.end()
      callback.apply(null, [err.toString()])
    })
  }
})

registerBridge('flyCacheGetString', function (ctx: Context, config: Config) {
  return function cacheGetString(key: string, callback: ivm.Reference<Function>) {
    let t = Trace.tryStart("cacheGet", ctx.trace)
    let k = "cache:" + ctx.meta.get('app').id + ":" + key

    if (!config.cacheStore)
      return callback.apply(null, [errCacheStoreUndefined.toString()])
  
    config.cacheStore.get(k).then((buf) => {
      const size = buf ? buf.byteLength : 0
      const ret = buf ? buf.toString() : null
      t.end({ size: size, key: key })
      callback.apply(null, [null, ret])
    }).catch((err) => {
      t.end()
      callback.apply(null, [err.toString()])
    })
  }
})