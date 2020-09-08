const recursive = require('recursive-readdir')
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
        recursive(this.rootPath, ['**/.git/**'], (err, files) => {
          if (err) return done(err)
          const parseFiles = []
          files.forEach((file) => {
            const { base } = path.parse(file)
            if (base === 'Noopfile' || base === '.gitignore' || base === '.dockerignore') parseFiles.push(file)
          })
          done(null, parseFiles)
        })
      },
      parseFiles: ['findFiles', (results, done) => {
        async.filter(results.findFiles, (file, done) => {
          const { base } = path.parse(file)
          if (this.watch) {
            if (base === 'Noopfile') {
              this.parseManifest(file, done)
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
      parseManifests: ['parseFiles', (results, done) => {
        async.each(results.parseFiles, (manifestFile, done) => {
          const manifest = new Manifest(manifestFile, this)
          this.manifests.push(manifest)
          manifest.discover(done)
        }, done)
      }],
      validateComponents: ['parseManifests', (results, done) => {
        async.each(this.components, (component, done) => {
          component.validate(done)
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

  parseManifest (file, done) {
    fs.readFile(file, (err, data) => {
      if (err) return done(err)
      const components = {}
      let componentName = ''
      let componentFiles = new Set()
      let copyAll = false
      const handleFiles = () => {
        if (componentName.length) {
          components[componentName] = { ig: ignore().add(copyAll ? '*' : Array.from(componentFiles)) }
        }
      }
      data.toString().split(/\r?\n/).forEach(line => {
        const trimmed = line.trim()
        if (trimmed.length && !trimmed.startsWith('#')) {
          const split = trimmed.replace(/  +/g, ' ').split(' ')
          if (split.length === 3 && split[0] === 'COMPONENT') {
            handleFiles()
            componentName = split[1]
            componentFiles = new Set()
            copyAll = false
          }
          if (split.length === 3 && (split[0] === 'ADD' || split[0] === 'COPY')) {
            if (!copyAll) {
              if (split[1] === '.') {
                copyAll = true
              } else {
                componentFiles.add(split[1])
              }
            }
          }
        }
      })
      handleFiles()
      if (Object.keys(components).length) {
        this.watching[file] = components
      }
      done(null, true)
    })
  }

  reload (done) {
    this.watcher.close().then(() => {
      this.watcher = null
      this.components = {}
      this.resources = {}
      this.routes = []
      this.manifests = []
      this.ignoring = {}
      this.watching = {}
      this.discover(done)
    })
  }

  setupWatch (done) {
    this.watcher = chokidar.watch(this.rootPath, {
      ignored: (path) => this.checkIgnoreStatus(path, done),
      alwaysStat: true
    }).on('all', (event, file) => {
      if (path.parse(file).base === 'Noopfile') {
        this.emit('manifestChange', file)
      } else {
        const modifiedComponents = []
        for (const manifestPath in this.watching) {
          const rootPath = path.parse(manifestPath).dir
          if (file.startsWith(rootPath) && file !== rootPath) {
            for (const component in this.watching[manifestPath]) {
              if (this.watching[manifestPath][component].ig.ignores(file.slice(rootPath.length + 1))) {
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

  checkIgnoreStatus (file, done) {
    if (file.includes('/.git/')) return true
    if (file === this.rootPath || path.parse(file).base === 'Noopfile') return false
    for (const key in this.ignoring) {
      const keyDir = path.parse(key).dir
      if (file.startsWith(keyDir)) {
        if (this.ignoring[key].ig.ignores(file.slice(keyDir.length + 1))) {
          return true
        }
      }
    }
    for (const key in this.watching) {
      const keyDir = path.parse(key).dir
      if (file.startsWith(keyDir)) {
        for (const component in this.watching[key]) {
          if (this.watching[key][component].ig.ignores(file.slice(keyDir.length + 1))) {
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
