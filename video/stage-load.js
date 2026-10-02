// Loads the scene file named by ?short=<id> (scenes/<id>.js); render.mjs waits for window.renderAt and window.stageReady.
const shortId = new URLSearchParams(location.search).get('short')
if (!/^[a-z0-9-]+$/.test(shortId || '')) throw new Error(`Missing or invalid ?short= (${shortId})`)
const script = document.createElement('script')
script.src = `scenes/${shortId}.js`
document.body.appendChild(script)
