const recursive = require('recursive-readdir')
const path = require('path')
const async = require('async')
const filewatcher = require('filewatcher')
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
    this.watcher = filewatcher()
    this.components = {}
    this.resources = {}
    this.routes = []
    this.manifests = []
    this.directories = {}
    this.files = []
    this.ignoring = {}
    this.watching = {}
  }

  discover (done) {
    async.auto({
      findFiles: (done) => {
        recursive(this.rootPath, ['**/.git/**', '**/.git/.*'], (err, files) => {
          if (err) return done(err)
          const parseFiles = []
          files.forEach((file) => {
            const { base } = path.parse(file)
            if (base === 'Noopfile' || base === '.gitignore' || base === '.dockerignore') parseFiles.push(file)
            this.files.push(file)
          })
          done(null, parseFiles)
        })
      },
      parseFiles: ['findFiles', (results, done) => {
        async.filter(results.findFiles, (file, done) => {
          if (this.watch) {
            this.parseFile(file, done)
          } else {
            done(null, path.parse(file).base === 'Noopfile')
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

  parseFile (file, done) {
    fs.readFile(file, (err, data) => {
      if (err) return done(err)
      const files = []
      const { base, dir } = path.parse(file)
      data.toString().split(/\r?\n/).forEach(line => {
        const trimmed = line.trim()
        if (trimmed.length && !trimmed.startsWith('#')) {
          if (base === 'Noopfile') {
            const split = trimmed.replace(/  +/g, ' ').split(' ')
            if (split.length === 3 && (split[0] === 'ADD' || split[0] === 'COPY')) {
              files.push(split[1])
            }
          } else {
            files.push(trimmed)
          }
        }
      })
      this[base === 'Noopfile' ? 'watching' : 'ignoring'][file] = { dir: dir + '/', files, ig: ignore().add(files) }
      done(null, base === 'Noopfile')
    })
  }

  reload (done) {
    this.components = {}
    this.resources = {}
    this.routes = []
    this.manifests = []
    this.directories = {}
    this.files = []
    this.ignoring = {}
    this.watching = {}
    this.discover(done)
  }

  setupWatch (done) {
    async.auto({
      findWatchLocations: (done) => {
        const location = new Set()
        this.files.forEach((file) => {
          if (this.checkfile(file, done)) {
            location.add(file)
            location.add(path.parse(file).dir)
          }
        })
        done(null, location)
      },
      watchLocations: ['findWatchLocations', (results, done) => {
        results.findWatchLocations.forEach((file) => {
          if (this.checkfile(file, done)) this.watcher.add(file)
        })
      }]
    }, done)

    this.watcher.on('change', (file, stats) => {
      const pathInfo = path.parse(file)
      const modifiedComponents = Object.keys(this.components).map((componentName) => {
        if (file.startsWith(this.components[componentName].rootPath)) {
          return this.components[componentName]
        }
      }).filter(Boolean)

      const emit = () => {
        if (pathInfo.base === 'Noopfile') {
          this.emit('manifestChange', file)
        } else if (modifiedComponents.length) {
          modifiedComponents.forEach((component) => {
            this.emit('componentChange', component.name, file)
          })
        }
      }

      if (stats.isFile()) {
        emit()
      } else {
        fs.promises.readdir(file)
          .then(files => {
            if (this.directories[file] !== files.length) {
              this.directories[file] = files.length
              emit()
            }
          })
      }
    })
    done()
  }

  checkfile (file, done) {
    const { base } = path.parse(file)
    if (base === 'Noopfile') return true
    for (const key in this.ignoring) {
      const { dir, ig } = this.ignoring[key]
      if (file.startsWith(dir)) {
        if (ig.ignores(file.slice(dir.length))) {
          return false
        }
      }
    }
    for (const key in this.watching) {
      const { dir, files, ig } = this.watching[key]
      if (file.startsWith(dir)) {
        if (files.includes('.') || ig.ignores(file.slice(dir.length))) {
          const parentDir = path.parse(file).dir
          if (!(parentDir in this.directories)) {
            this.setDirCount(parentDir)
          }
          return true
        }
      }
    }
    return false
  }

  setDirCount (dir, done) {
    if (!(dir in this.directories)) {
      fs.readdir(dir, (err, files) => {
        if (err) return done(err)
        this.directories[dir] = files.length
      })
    }
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
