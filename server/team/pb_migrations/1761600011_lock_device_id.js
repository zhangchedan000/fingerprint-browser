/// <reference path="../pb_data/types.d.ts" />

// A window in use is held by one computer, not just one account (the user, 2026-11-07: the same
// account on another computer cannot open a window that is open here). team_locks.device_id is the
// fixed id the app makes on each computer; "device" stays that computer's name to show.
// Locks taken before this (and by apps that send no id) have an empty id: only another empty id
// matches it, so older apps behave as before among themselves.
migrate((app) => {
  const locks = app.findCollectionByNameOrId("team_locks")
  locks.fields.add(new TextField({ name: "device_id", max: 100 }))
  app.save(locks)
}, (app) => {
  const locks = app.findCollectionByNameOrId("team_locks")
  locks.fields.removeByName("device_id")
  app.save(locks)
})
