import { vi } from 'vitest'

// Unit tests never log on to Windows (CI runs them on Windows): no answer, so no profile gets one.
vi.mock('./src/main/os-password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./src/main/os-password')>()
  return { ...actual, osPasswordCheck: new actual.OsPasswordCheck(async () => '') }
})
