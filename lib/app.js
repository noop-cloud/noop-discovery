const path = require('path')
const async = require('async')
const chokidar = require('chokidar')
const crypto = require('crypto')
const fs = require('fs')
const ignore = require('ignore')
const Manifest = require('./manifest')
const EventEmitter = require('events').EventEmitter

class Application extends EventEmitter {
  constructor (rootPath, watch) {
    super()
    this.id = crypto.createHash('sha256').update(rootPath).digest('hex').substr(0, 8)
    this.rootPath = rootPath
    this.watch = watch
    this.watcher = null
    this.components = {}
    this.resources = {}
    this.routes = []
    this.manifests = []
    this.ignoring = {}
    this.watching = {}
  }

  discover (done) {
    async.auto({
      findFiles: (done) => {
        this.recursiveSearch(this.rootPath, done).then((files) => {
          done(null, files)
        })
      },
      parseIgnore: ['findFiles', (results, done) => {
        async.filter(results.findFiles, (file, done) => {
          const { base } = path.parse(file)
          if (this.watch) {
            if (base === 'Noopfile') {
              done(null, true)
            } else {
              this.parseIgnore(file, done)
            }
          } else {
            done(null, base === 'Noopfile')
          }
        }, (err, results) => {
          if (err) {
            done(err)
          } else {
            done(null, results)
          }
        })
      }],
      parseManifests: ['parseIgnore', (results, done) => {
        async.each(results.parseIgnore, (manifestFile, done) => {
          const manifest = new Manifest(manifestFile, this)
          this.manifests.push(manifest)
          manifest.discover(done)
        }, done)
      }],
      validateComponents: ['parseManifests', (results, done) => {
        async.each(this.components, (component, done) => {
          component.validate(done)
          if (this.watch) {
            this.parseComponents(component, done)
          }
        }, done)
      }],
      validateResources: ['validateComponents', (results, done) => {
        async.each(this.resources, (resource, done) => {
          resource.validate(done)
        }, done)
      }],
      watchers: ['validateResources', (results, done) => {
        if (this.watch) {
          this.setupWatch(done)
        } else {
          done()
        }
      }]
    }, done)
  }

  recursiveSearch (dir, done) {
    return fs.promises.readdir(dir, { withFileTypes: true })
      .then((files) => (
        Promise.all(files.map((file) => {
          if (file.isDirectory() && !(file.name === '.git' && dir === this.rootPath)) {
            return this.recursiveSearch(path.resolve(dir, file.name), done)
          } else if (file.name === 'Noopfile' || file.name === '.gitignore' || file.name === '.dockerignore') {
            return path.resolve(dir, file.name)
          } else {
            return false
          }
        }))
      ))
      .then((foundFiles) => foundFiles.filter(Boolean))
      .then((filteredFiles) => [].concat.apply([], filteredFiles))
      .catch((err) => done(err))
  }

  parseIgnore (file, done) {
    fs.readFile(file, (err, data) => {
      if (err) return done(err)
      const files = new Set()
      data.toString().split(/\r?\n/).forEach(line => {
        const trimmed = line.trim()
        if (trimmed.length && !trimmed.startsWith('#')) {
          files.add(trimmed)
        }
      })
      if (files.size > 0) {
        this.ignoring[file] = { ig: ignore().add(Array.from(files)) }
      }
      done(null, false)
    })
  }

  parseComponents (component, done) {
    const files = new Set()
    let copyAll = false
    component.directives.forEach((directive) => {
      if ((directive.cmd === 'ADD' || directive.cmd === 'COPY') && (directive.args.length === 2)) {
        if (!copyAll) {
          if (directive.args[0] === '.') {
            copyAll = true
          } else {
            files.add(directive.args[0])
          }
        }
      }
    })
    if (files.size) {
      const ig = ignore().add(copyAll ? '*' : Array.from(files))
      if (component.rootPath in this.watching) {
        this.watching[component.rootPath][component.name] = { ig }
      } else {
        this.watching[component.rootPath] = { [component.name]: { ig } }
      }
    }
  }

  reload (done) {
    this.components = {}
    this.resources = {}
    this.routes = []
    this.manifests = []
    if (this.watcher) {
      this.watcher.close().then(() => {
        this.watcher = null
        this.ignoring = {}
        this.watching = {}
        this.discover(done)
      })
    } else {
      this.discover(done)
    }
  }

  setupWatch (done) {
    this.watcher = chokidar.watch(this.rootPath, {
      ignored: (path) => this.checkIgnoreStatus(path)
    }).on('all', (event, file) => {
      const { base } = path.parse(file)
      if (base === 'Noopfile' || base === '.gitignore' || base === '.dockerignore') {
        this.emit('manifestChange', file)
      } else {
        const modifiedComponents = []
        for (const manifestPath in this.watching) {
          if (file.startsWith(manifestPath)) {
            for (const component in this.watching[manifestPath]) {
              if (this.watching[manifestPath][component].ig.ignores(file.slice(manifestPath.length))) {
                modifiedComponents.push(this.components[component])
              }
            }
          }
        }
        if (modifiedComponents.length) {
          modifiedComponents.forEach((component) => {
            this.emit('componentChange', component.name, file)
          })
        }
      }
    })
    done()
  }

  checkIgnoreStatus (file) {
    if (file.includes('/.git/')) return true
    if (file === this.rootPath || path.parse(file).base === 'Noopfile') return false
    for (const key in this.ignoring) {
      const keyDir = path.parse(key).dir + '/'
      if (file.startsWith(keyDir)) {
        if (this.ignoring[key].ig.ignores(file.slice(keyDir.length))) {
          return true
        }
      }
    }
    for (const key in this.watching) {
      if (file.startsWith(key)) {
        for (const component in this.watching[key]) {
          if (this.watching[key][component].ig.ignores(file.slice(key.length))) {
            return false
          }
        }
      }
    }
    return true
  }

  simple () { // deprecated
    return {
      Noopfiles: this.manifests.map((manifest) => {
        return manifest.filePath.substring(this.rootPath.length)
      }),
      Components: Object.keys(this.components).map((componentName) => {
        const component = this.components[componentName]
        return {
          Name: component.name,
          Type: component.type,
          Variables: component.env,
          Port: component.port,
          Root: component.rootPath.substring(this.rootPath.length),
          Resources: component.resources.map((resource) => { return resource.name }),
          Declaration: `${component.directives[0].file}:${component.directives[0].lineNumber}`.substring(this.rootPath.length),
          Dockerfile: component.dockerfile
        }
      }),
      Resources: Object.keys(this.resources).map((resourceName) => {
        const resource = this.resources[resourceName]
        return {
          Name: resource.name,
          Type: resource.type,
          Parameters: resource.params,
          Declarations: resource.directives.map((directive) => {
            return `${directive.file}:${directive.lineNumber}`.substring(this.rootPath.length)
          })
        }
      }),
      Routes: this.routes.map((route) => {
        return {
          Pattern: route.pattern,
          Method: route.method,
          Internal: route.internal,
          Component: route.component.name,
          Declaration: `${route.directive.file}:${route.directive.lineNumber}`.substring(this.rootPath.length)
        }
      })
    }
  }

  toJSON () {
    return {
      noopfiles: this.manifests.map((manifest) => {
        return manifest.filePath.substring(this.rootPath.length)
      }),
      components: Object.keys(this.components).map((componentName) => {
        const component = this.components[componentName]
        return {
          name: component.name,
          type: component.type,
          variables: component.variables,
          settings: component.settings,
          rootPath: component.rootPath.substring(this.rootPath.length),
          resources: component.resources.map((resource) => { return resource.name }),
          declaration: `${component.directives[0].file}:${component.directives[0].lineNumber}`.substring(this.rootPath.length),
          dockerfile: component.dockerfile
        }
      }),
      resources: Object.keys(this.resources).map((resourceName) => {
        const resource = this.resources[resourceName]
        return {
          name: resource.name,
          type: resource.type,
          settings: resource.settings,
          declarations: resource.directives.map((directive) => {
            return `${directive.file}:${directive.lineNumber}`.substring(this.rootPath.length)
          })
        }
      }),
      routes: this.routes.map((route) => {
        return {
          pattern: route.pattern,
          method: route.method,
          private: route.private,
          condition: route.condition,
          component: route.component.name,
          declaration: `${route.directive.file}:${route.directive.lineNumber}`.substring(this.rootPath.length)
        }
      })
    }
  }
}

module.exports = Application
