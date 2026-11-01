/// <reference path="../pb_data/types.d.ts" />

// Each account's own proxy library and 网络加速 (node sources and settings), so a new computer
// or a restored server brings them back. One record per account, only its owner reads or writes it.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const own = "@request.auth.id != '' && user = @request.auth.id"
  const workspaces = new Collection({
    type: "base",
    name: "team_workspaces",
    listRule: own,
    viewRule: own,
    createRule: own,
    updateRule: own,
    deleteRule: null,
    fields: [
      { type: "relation", name: "user", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "json", name: "data", maxSize: 5 * 1024 * 1024 },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_team_workspaces_user ON team_workspaces (user)"]
  })
  app.save(workspaces)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("team_workspaces"))
})
