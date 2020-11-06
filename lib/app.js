const path = require('path')
const async = require('async')
const crypto = require('crypto')
const fs = require('fs')
const Manifest = require('./manifest')

class Application {
  constructor (rootPath, watch) {
    this.id = crypto.createHash('sha256').update(rootPath).digest('hex').substr(0, 8)
    this.rootPath = rootPath
    this.components = {}
    this.resources = {}
    this.routes = []
    this.manifests = []
    this.ignoreFiles = []
  }

  discover (done) {
    async.auto({
      findFiles: (done) => {
        this.recursiveSearch(this.rootPath, done).then((files) => {
          done(null, files)
        })
      },
      findManifests: ['findFiles', (results, done) => {
        async.filter(results.findFiles, (file, done) => {
          if (path.parse(file).base !== 'Noopfile') {
            this.ignoreFiles.push(file)
          }
          done(null, path.parse(file).base === 'Noopfile')
        }, (err, results) => {
          if (err) {
            done(err)
          } else {
            done(null, results)
          }
        })
      }],
      parseManifests: ['findManifests', (results, done) => {
        async.each(results.findManifests, (manifestFile, done) => {
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
      }]
    }, done)
  }

  recursiveSearch (dir, done) {
    return fs.promises.readdir(dir, { withFileTypes: true })
      .then((files) => (
        Promise.all(files.map((file) => {
          if (file.isDirectory() && !(file.name === '.git' && dir === this.rootPath)) {
            return this.recursiveSearch(path.resolve(dir, file.name), done)
          } else if (file.name === 'Noopfile' || file.name === '.gitignore') {
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

  reload (done) {
    this.components = {}
    this.resources = {}
    this.routes = []
    this.manifests = []
    this.discover(done)
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
