/// <reference path="../pb_data/types.d.ts" />

// Per-computer login-state copies are no longer used (the user, 2026-11-03: every computer opens the
// latest one; 测试模式 keeps tests off the cloud). No account can list, read, add, change or delete
// them any more; the collection and the copies already in it stay as they are (nothing deleted).
// Apps 0.5.55–0.5.57 still ask for them: reading fails and they open the latest, uploading their own
// copy fails and is only logged, so they behave like 0.5.58.
migrate((app) => {
  const states = app.findCollectionByNameOrId("team_device_states")
  states.listRule = null
  states.viewRule = null
  states.createRule = null
  states.updateRule = null
  states.deleteRule = null
  app.save(states)
}, (app) => {
  const OWNER = '@request.auth.role = "owner"'
  const ACTIVE = '@request.auth.disabled = false'
  const states = app.findCollectionByNameOrId("team_device_states")
  states.listRule = OWNER + " || (" + ACTIVE + " && user = @request.auth.id)"
  states.viewRule = OWNER + " || (" + ACTIVE + " && user = @request.auth.id)"
  states.createRule = ACTIVE + " && @request.body.user = @request.auth.id"
  states.updateRule = ACTIVE + " && user = @request.auth.id && @request.body.user:isset = false"
    + " && @request.body.profile:isset = false && @request.body.device:isset = false"
  states.deleteRule = OWNER + " || (" + ACTIVE + " && user = @request.auth.id)"
  app.save(states)
})
