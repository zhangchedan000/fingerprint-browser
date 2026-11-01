/// <reference path="../pb_data/types.d.ts" />

// The activation codes (TEAM_SETUP_CODE) of the team's servers, so the owner's app on any computer
// can switch between them with one click (control.pb.js /api/team/server-codes). No API rules:
// only the hooks read and write them, and only the owner gets them. They travel with the database
// (standby server, R2) like everything else.
migrate((app) => {
  const codes = new Collection({
    type: "base",
    name: "team_server_codes",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "text", name: "url", required: true, max: 200 },
      { type: "text", name: "code", required: true, max: 200 },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_team_server_codes_url ON team_server_codes (url)"]
  })
  app.save(codes)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("team_server_codes"))
})
