/// <reference path="../pb_data/types.d.ts" />

// Team accounts: one owner, members created by the owner, shared windows assigned to members,
// one holder per window at a time, and a log the owner reads. Writes to locks and logs go
// through pb_hooks only.
migrate((app) => {
  const OWNER = '@request.auth.role = "owner"'
  // A member's token outlives disabling them, so every member rule checks the flag too.
  const MEMBER = '@request.auth.disabled = false && assignees.id ?= @request.auth.id'

  const users = app.findCollectionByNameOrId("users")
  users.fields.add(new TextField({ name: "username", required: true, min: 2, max: 64, pattern: "^[^\\s@]+$" }))
  users.fields.add(new SelectField({ name: "role", required: true, maxSelect: 1, values: ["owner", "member"] }))
  users.fields.add(new BoolField({ name: "disabled" }))
  users.fields.getByName("email").required = false
  users.addIndex("idx_users_username", true, "username COLLATE NOCASE", "")
  users.passwordAuth.identityFields = ["username"]
  users.authRule = "disabled = false"
  users.listRule = OWNER + " || id = @request.auth.id"
  users.viewRule = OWNER + " || id = @request.auth.id"
  // Owners are created by the setup route only.
  users.createRule = OWNER + ' && @request.body.role = "member"'
  users.updateRule = '(' + OWNER + ' && role = "member" && (@request.body.role:isset = false || @request.body.role = "member"))'
    + ' || (id = @request.auth.id && @request.body.role:isset = false && @request.body.disabled:isset = false)'
  users.deleteRule = OWNER + ' && role = "member"'
  // Lets the owner reset a member's password without the old one.
  users.manageRule = OWNER + ' && role = "member"'
  app.save(users)

  const profiles = new Collection({
    type: "base",
    name: "team_profiles",
    listRule: OWNER + " || (" + MEMBER + ")",
    viewRule: OWNER + " || (" + MEMBER + ")",
    createRule: OWNER,
    // Members may only upload the login state; the hooks check the lock and the revision.
    updateRule: OWNER + " || (" + MEMBER
      + " && @request.body.source_id:isset = false"
      + " && @request.body.name:isset = false && @request.body.note:isset = false"
      + " && @request.body.config:isset = false && @request.body.assignees:isset = false"
      + " && @request.body.config_rev:isset = false)",
    deleteRule: OWNER,
    fields: [
      { type: "text", name: "name", required: true, max: 200 },
      { type: "text", name: "note", max: 2000 },
      // The owner's local window id, so sharing the same window again updates this record.
      { type: "text", name: "source_id", max: 100 },
      { type: "json", name: "config", maxSize: 2000000 },
      { type: "number", name: "config_rev", onlyInt: true, min: 0 },
      { type: "relation", name: "assignees", collectionId: users.id, maxSelect: 999, cascadeDelete: false },
      { type: "file", name: "data", maxSelect: 1, maxSize: 2147483648, protected: true },
      { type: "number", name: "data_rev", onlyInt: true, min: 0 },
      { type: "text", name: "data_sha256", max: 64 },
      { type: "number", name: "data_size", onlyInt: true, min: 0 },
      { type: "relation", name: "data_by", collectionId: users.id, maxSelect: 1, cascadeDelete: false },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true }
    ],
    indexes: ["CREATE INDEX idx_team_profiles_source ON team_profiles (source_id)"]
  })
  app.save(profiles)

  const locks = new Collection({
    type: "base",
    name: "team_locks",
    listRule: OWNER + " || holder = @request.auth.id || profile.assignees.id ?= @request.auth.id",
    viewRule: OWNER + " || holder = @request.auth.id || profile.assignees.id ?= @request.auth.id",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "profile", collectionId: profiles.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "relation", name: "holder", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "text", name: "device", max: 200 },
      // Unix milliseconds; a lock past this time is free to take.
      { type: "number", name: "expires", onlyInt: true, required: true },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_team_locks_profile ON team_locks (profile)"]
  })
  app.save(locks)

  const logs = new Collection({
    type: "base",
    name: "team_logs",
    listRule: OWNER,
    viewRule: OWNER,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "user", collectionId: users.id, maxSelect: 1, cascadeDelete: false },
      // Names are copied so a log line still reads after the member or window is deleted.
      { type: "text", name: "user_name", max: 200 },
      { type: "relation", name: "profile", collectionId: profiles.id, maxSelect: 1, cascadeDelete: false },
      { type: "text", name: "profile_name", max: 200 },
      { type: "text", name: "action", required: true, max: 40 },
      { type: "json", name: "detail", maxSize: 20000 },
      { type: "text", name: "ip", max: 100 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false }
    ],
    indexes: [
      "CREATE INDEX idx_team_logs_created ON team_logs (created)",
      "CREATE INDEX idx_team_logs_user ON team_logs (user)",
      "CREATE INDEX idx_team_logs_profile ON team_logs (profile)"
    ]
  })
  app.save(logs)
}, (app) => {
  for (const name of ["team_logs", "team_locks", "team_profiles"]) {
    app.delete(app.findCollectionByNameOrId(name))
  }
  const users = app.findCollectionByNameOrId("users")
  users.removeIndex("idx_users_username")
  for (const name of ["username", "role", "disabled"]) users.fields.removeByName(name)
  users.fields.getByName("email").required = true
  users.passwordAuth.identityFields = ["email"]
  app.save(users)
})
