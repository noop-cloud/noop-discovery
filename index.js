const App = require('./lib/app')

/**
 *
 * @param {string} root - root directory to discover
 * @param {function} done - c
 */
module.exports = (root, done) => {
  const app = new App(root)
  app.discover((err) => {
    if (err) return done(err)
    done(null, app)
  })
}
/**
 * @callback discoverCallback
 * @param {Error}
 * @param {App}
 */
