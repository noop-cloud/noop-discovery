# noop-discovery
Noop application source code discovery library. This library is hosted publicly on NPM.

The library exports a single function with three parameters.
- `rootPath` {string} - path to scan for Noop App
- `done` {callback} - yields {err} and {app}


## Quickstart
```
npm install noop-discovery --save
```

```javascript
const discovery = require('noop-discovery')

discovery('/project/root', (err, app) => {
  if (err) console.log('bort', err)
  app.on('manifestChange', (manifestFile) => {})
  app.on('componentChange', (componentName) => {})
})

```
