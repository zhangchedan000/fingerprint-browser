/// <reference path="../pb_data/types.d.ts" />

// Invite codes: the owner makes one per person in the app; it signs up one member and is then
// used up. Read and written through pb_hooks/invites.pb.js only.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const invites = new Collection({
    type: "base",
    name: "team_invites",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      // Upper case letters and digits without the dashes shown to people.
      { type: "text", name: "code", required: true, max: 32 },
      { type: "text", name: "note", max: 200 },
      // Unix milliseconds.
      { type: "number", name: "expires", onlyInt: true, required: true },
      { type: "relation", name: "used_by", collectionId: users.id, maxSelect: 1, cascadeDelete: false },
      { type: "text", name: "used_name", max: 200 },
      { type: "number", name: "used_at", onlyInt: true },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_team_invites_code ON team_invites (code)"]
  })
  app.save(invites)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("team_invites"))
})
