# XR Application

## Application format

Please create HTML containing a normal A-FRAME scene. Some elements in the html are inserted into the scene.

The link to the application you want to use is in `<div id='applications' style='display:none'>` to `</div>` in [../index.html](../index.html) Please add it to.

## usually

The following will be loaded:

- Element with `id='app'` (You can change it by adding #foobar etc. to the URL when loading)
- `script` elements (those with the same id or URL are loaded only once)

## Environment

The following will be loaded:

- Element with `id='env'` (You can change it by adding #foobar etc. to the URL when loading)
- `script` elements (those with the same id or URL are loaded only once)
- `background` and `fog` attribute values of `a-scene`

## vrapp component

The `vrapp` component is added on load.
Please obtain an instance from `this.el.components.vrapp` etc. and use it.

You can access functionality within your workspace via the vrapp component.

### API

There is no documentation yet, so please refer to the [types.t.ts](../js/types.d.ts) file.

- vrapp.services.appManager : AppManager instance
- vrapp.services.storage : Provides access to storage
- vrapp.saveFile(content, options) : Show file save UI, save blob to storage, return `Promise<FileInfo>`
- vrapp.selectFile(options) : Show file selection UI and return `Promise<FileInfo>`

### Events

- 'app-start': Fires when the application starts (after the element is added to the scene)
- 'app-save-state': Fires when application information is persisted