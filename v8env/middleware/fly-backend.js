/* global Response, registerMiddleware */
import { FlyBackend } from '../fly-backend'
import { logger } from '../logger'

function backendFetch (req) {
  logger.info('backend:', req)
  if (!(this.settings instanceof Object) && !this.settings.backend) {
    return new Response('no backend found', {
      status: 500
    })
  }

  const config = this.settings.get('backend')
  const b = FlyBackend.getBackend(config)
  return b.fetch(req)
}

export default function registerFlyBackend () {
  registerMiddleware('fly-backend', (function () {
    return backendFetch
  }()))
}
