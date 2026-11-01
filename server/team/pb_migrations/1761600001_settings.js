/// <reference path="../pb_data/types.d.ts" />

// Behind Nginx Proxy Manager: take the member's address from its headers for the log.
migrate((app) => {
  const settings = app.settings()
  settings.meta.appName = "Prism Team"
  settings.trustedProxy.headers = ["X-Real-IP", "X-Forwarded-For"]
  settings.trustedProxy.useLeftmostIP = true
  app.save(settings)
}, (app) => {
  const settings = app.settings()
  settings.trustedProxy.headers = []
  app.save(settings)
})
