/// <reference path="../pb_data/types.d.ts" />

// Login states per computer. team_profiles.data stays the window's latest login state (whoever
// closed it last); each computer an account opens a window on also keeps its own copy here, so the
// same account signed in on two computers does not overwrite the other one's sign-ins: a computer
// opens its own copy when the latest one came from the same account on another computer.
// team_profiles.data_device says which computer uploaded the latest one.
migrate((app) => {
  const OWNER = '@request.auth.role = "owner"'
  const ACTIVE = '@request.auth.disabled = false'
  const users = app.findCollectionByNameOrId("users")
  const profiles = app.findCollectionByNameOrId("team_profiles")
  profiles.fields.add(new TextField({ name: "data_device", max: 100 }))
  profiles.fields.add(new TextField({ name: "data_device_name", max: 200 }))
  app.save(profiles)

  const states = new Collection({
    type: "base",
    name: "team_device_states",
    // Each account sees its own copies; the owner sees all (to restore one for a member).
    listRule: OWNER + " || (" + ACTIVE + " && user = @request.auth.id)",
    viewRule: OWNER + " || (" + ACTIVE + " && user = @request.auth.id)",
    // The hooks also require the window's lock (as for team_profiles.data).
    createRule: ACTIVE + " && @request.body.user = @request.auth.id",
    updateRule: ACTIVE + " && user = @request.auth.id && @request.body.user:isset = false"
      + " && @request.body.profile:isset = false && @request.body.device:isset = false",
    deleteRule: null,
    fields: [
      { type: "relation", name: "profile", collectionId: profiles.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "relation", name: "user", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      // A fixed id made by the app on each computer, and that computer's name to show.
      { type: "text", name: "device", required: true, max: 100 },
      { type: "text", name: "device_name", max: 200 },
      { type: "file", name: "data", maxSelect: 1, maxSize: 2147483648, protected: true },
      { type: "number", name: "data_rev", onlyInt: true, min: 0 },
      { type: "text", name: "data_sha256", max: 64 },
      { type: "number", name: "data_size", onlyInt: true, min: 0 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_team_device_states_key ON team_device_states (profile, user, device)"]
  })
  app.save(states)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("team_device_states"))
  const profiles = app.findCollectionByNameOrId("team_profiles")
  profiles.fields.removeByName("data_device")
  profiles.fields.removeByName("data_device_name")
  app.save(profiles)
})
