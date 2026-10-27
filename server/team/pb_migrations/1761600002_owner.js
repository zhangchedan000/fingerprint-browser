/// <reference path="../pb_data/types.d.ts" />

// Every window is a cloud window now, members' own ones included. owner is who created it:
// the owner account sees and manages all; a member sees their own and those assigned to them,
// may change their own, and only uploads the login state of assigned ones.
migrate((app) => {
  const OWNER = '@request.auth.role = "owner"'
  const ACTIVE = '@request.auth.disabled = false'
  const MINE = 'owner = @request.auth.id'
  const ASSIGNED = 'assignees.id ?= @request.auth.id'
  const DATA_ONLY = '@request.body.source_id:isset = false && @request.body.name:isset = false'
    + ' && @request.body.note:isset = false && @request.body.config:isset = false'
    + ' && @request.body.assignees:isset = false && @request.body.config_rev:isset = false'

  const users = app.findCollectionByNameOrId("users")
  const profiles = app.findCollectionByNameOrId("team_profiles")
  profiles.fields.add(new RelationField({ name: "owner", collectionId: users.id, maxSelect: 1, cascadeDelete: false }))
  profiles.listRule = OWNER + " || (" + ACTIVE + " && (" + MINE + " || " + ASSIGNED + "))"
  profiles.viewRule = profiles.listRule
  profiles.createRule = OWNER + " || (" + ACTIVE + " && @request.body.owner = @request.auth.id && @request.body.assignees:isset = false)"
  profiles.updateRule = OWNER
    + " || (" + ACTIVE + " && " + MINE + " && @request.body.owner:isset = false && @request.body.assignees:isset = false)"
    + " || (" + ACTIVE + " && " + ASSIGNED + " && " + DATA_ONLY + " && @request.body.owner:isset = false)"
  profiles.deleteRule = OWNER
  app.save(profiles)

  const locks = app.findCollectionByNameOrId("team_locks")
  locks.listRule = OWNER + " || holder = @request.auth.id || profile.owner = @request.auth.id || profile.assignees.id ?= @request.auth.id"
  locks.viewRule = locks.listRule
  app.save(locks)
}, (app) => {
  const profiles = app.findCollectionByNameOrId("team_profiles")
  profiles.fields.removeByName("owner")
  app.save(profiles)
})
