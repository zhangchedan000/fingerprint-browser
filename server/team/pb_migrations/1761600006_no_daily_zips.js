/// <reference path="../pb_data/types.d.ts" />

// No daily zip of pb_data any more: the database and login states are copied to R2 and the
// standby server as they change (r2_utils.js), and a zip on the same disk adds nothing. The old
// automatic zips are removed by the next full pass; backups made by hand in the app stay.
migrate((app) => {
  const settings = app.settings()
  settings.backups.cron = ""
  app.save(settings)
}, (app) => {
  const settings = app.settings()
  settings.backups.cron = "0 19 * * *"
  settings.backups.cronMaxKeep = 7
  app.save(settings)
})
