/* global Response, registerMiddleware */
import { logger } from '../logger'

async function echo (req) {
  logger.debug('echo middleware')
  logger.debug('settings:', typeof this.settings, this.settings.constructor.name, JSON.stringify(this.settings))
  let body = this.settings.get('body') || req.url
  let contentType = this.settings.get('contentType') || 'text/html'
  let status = this.settings.get('status')

  if (!status) {
    status = parseInt(req.url.match(/[^/]+\/?$/)[0]) || 200
  }
  return new Response(
    body,
    {
      headers: {
        'content-type': contentType
      },
      status: status
    }
  )
}

export default function registerFlyEcho () {
  registerMiddleware('fly-echo', (function () {
    return echo
  }()))
}
