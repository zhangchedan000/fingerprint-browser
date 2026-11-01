/// <reference path="../pb_data/types.d.ts" />

// A backup of pb_data every day at 03:00 Beijing time (19:00 UTC); the last 7 are kept.
migrate((app) => {
  const settings = app.settings()
  settings.backups.cron = "0 19 * * *"
  settings.backups.cronMaxKeep = 7
  app.save(settings)
}, (app) => {
  const settings = app.settings()
  settings.backups.cron = ""
  app.save(settings)
})
