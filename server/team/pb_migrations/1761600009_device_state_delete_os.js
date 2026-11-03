/// <reference path="../pb_data/types.d.ts" />

// Per-computer login-state copies (1761600008): a copy can be deleted (the owner: anyone's; a member:
// their own; the window and the other copies stay), and each copy says which system the computer runs
// (device_os, e.g. "Windows 11 Pro 25H2", read from the computer's registry by the app; empty for
// copies uploaded by older apps until that computer uploads again).
migrate((app) => {
  const states = app.findCollectionByNameOrId("team_device_states")
  states.deleteRule = '@request.auth.role = "owner" || (@request.auth.disabled = false && user = @request.auth.id)'
  states.fields.add(new TextField({ name: "device_os", max: 200 }))
  app.save(states)
}, (app) => {
  const states = app.findCollectionByNameOrId("team_device_states")
  states.deleteRule = null
  states.fields.removeByName("device_os")
  app.save(states)
})
