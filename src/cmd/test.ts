import * as fs from 'fs'
import * as path from 'path'

import glob = require('glob')
import { root } from './root'

const scripts = [
  require.resolve("mocha/mocha"),
  require.resolve('../../v8env/testing/setup'),
].map((filename) => {
  return {
    filename: filename,
    code: fs.readFileSync(filename).toString()
  }
})

const runPath = require.resolve("../../v8env/testing/run")

interface TestArgs {
  paths?: string[]
}

root
  .subCommand<any, TestArgs>("test [paths...]")
  .description("Run unit tests, defaults to {test,spec}/**/*.{test,spec}.js")
  .action((opts, args, rest) => {
    const { ivm } = require('../')
    const { v8Env } = require('../v8env')
    const { FileStore } = require('../app/stores/file')
    const { getWebpackConfig, buildAppWithConfig } = require('../utils/build')
    const { createContext } = require('../context')
    const { runtimeConfig } = require("../config")

    const cwd = process.cwd()

    let paths = args.paths && args.paths.length ?
      [].concat.apply([],
        args.paths.map((f) =>
          glob.sync(f).map((gf) =>
            path.resolve(cwd, gf)
          )
        )
      ) :
      glob.sync('./test/**/*.+(spec|test).js');

    if (paths.length === 0) {
      console.log("No test files found")
      return
    }

    let conf = getWebpackConfig(cwd)
    conf.entry = paths

    const appStore = new FileStore(cwd, { noWatch: true, noSource: true })

    buildAppWithConfig(conf, { watch: false }, async (err: Error, code: string) => {
      if (err)
        throw err

      try {
        await v8Env.waitForReadiness()
        const iso = new ivm.Isolate({ snapshot: v8Env.snapshot })
        const ctx = await createContext(runtimeConfig, iso)

        const app = await appStore.getAppByHostname()

        ctx.meta = new Map<string, any>([
          ['app', app]
        ])

        await ctx.set('_mocha_done', new ivm.Reference(function (failures: number) {
          if (failures)
            return process.exit(1)
          process.exit()
        }))

        for (let script of scripts) {
          const compiled = await iso.compileScript(script.code, script)
          await compiled.run(ctx.ctx)
        }

        const bundleScript = await iso.compileScript(code, { filename: 'bundle.js' })
        await bundleScript.run(ctx.ctx)

        ctx.set('app', new ivm.ExternalCopy({ id: app.id, config: app.config }).copyInto())

        const runScript = await iso.compileScript(fs.readFileSync(runPath).toString(), { filename: runPath })
        await runScript.run(ctx.ctx)
      } catch (err) {
        console.error(err)
      }
    })
  })

