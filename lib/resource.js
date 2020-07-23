const minimist = require('minimist')

const resourceTypes = {
  s3: {
    settings: {}
  },
  mysql: {
    settings: {}
  },
  dynamodb: {
    settings: {
      hashKeyName: {
        required: true
      },
      hashKeyType: {
        required: true,
        enum: ['S', 'N', 'B']
      },
      rangeKeyName: {},
      rangeKeyType: {
        enum: ['S', 'N', 'B']
      }
    }
  },
  postgresql: {
    settings: {}
  }
}

class ResourceError extends Error {
  constructor (...args) {
    super(...args)
    this.name = 'ResourceError'
  }
}

class Resource {
  constructor (name) {
    this.name = name
    this.type = null
    this.settings = {}
    this.componentParams = {}
    this.directives = []
  }

  validate (done) {
    // TODO actually validate params against resourceTypes schemas
    const props = resourceTypes[this.type]
    const errors = []
    if (!props) {
      return done(new ResourceError(`Unknown resource type '${this.type}'`))
    }
    this.directives.forEach((directive) => {
      if (!directive.params.setting) return false
      const settings = (typeof directive.params.setting === 'string') ? [directive.params.setting] : directive.params.setting
      settings.forEach((setting) => {
        const match = /^(.+)=(.+)$/.exec(setting)
        if (!match) {
          // TODO surface as a warning on malformed setting
          return false
        }
        const key = match[1]
        const value = match[2]
        if (!props.settings[key]) return false
        if (this.settings[key] === value) {
          return true
        } else if (this.settings[key] && this.settings[key] !== value) {
          console.log('DANGER WILL ROBINSON!')
          // TODO surface warning on setting declaration conflict
        } else {
          this.settings[key] = value
        }
      })
    })
    Object.keys(props.settings).forEach((paramName) => {
      const param = props.settings[paramName]
      if (param.required && !this.settings[paramName]) {
        return errors.push(new ResourceError(`Missing required resource setting '${paramName}' for resource '${this.name}'`))
      }
      if (this.settings[paramName] && param.enum && param.enum.indexOf(this.settings[paramName]) === -1) {
        return errors.push(new ResourceError(`Invalid resource setting value '${this.settings[paramName]}' for '${paramName}'`))
      }
    })
    if (!this.type) {
      return done(new ResourceError(`Resource '${name} missing type`))
    }
    done((errors.length) ? errors[0] : null)
  }
}

Resource.register = (component, directive, done) => {
  const name = directive.params.name
  const app = component.app
  const resource = app.resources[name] || new Resource(name)
  resource.directives.push(directive)
  app.resources[name] = resource
  if (!resource.type && directive.params.type) {
    resource.type = directive.params.type
  } else if (resource.type && directive.params.type && resource.type !== directive.params.type) {
    return done(new ResourceError(`Resource '${name}' already declared as type '${resource.type}'`))
  }
  done(null, resource)
}

module.exports = Resource
