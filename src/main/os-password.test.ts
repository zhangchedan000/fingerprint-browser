import { describe, expect, it } from 'vitest'
import { answerFrom, chromeTime, OsPasswordCheck } from './os-password'

describe("Chrome's blank Windows password check", () => {
  it('writes times as Chrome does: microseconds since 1601', () => {
    expect(chromeTime(0)).toBe('11644473600000000')
    // Chrome 156 on the Win11 test PC stored 13427226617725779 (2026-06-29T17:10:17.725Z and 779 µs).
    expect(chromeTime(Date.UTC(2026, 5, 29, 17, 10, 17, 725))).toBe('13427226617725000')
  })

  it('stores the password change time a minute ahead, with the blank answer', () => {
    const now = Date.UTC(2026, 9, 31, 5, 0, 0)
    expect(answerFrom('age=86400 blank=0\r\n', now)).toEqual({ os_password_blank: false, os_password_last_changed: chromeTime(now - 86_400_000 + 60_000) })
    expect(answerFrom('age=5 blank=1', now)?.os_password_blank).toBe(true)
    expect(answerFrom('', now)).toBeUndefined()
    expect(answerFrom('Exception calling "LogonUser"', now)).toBeUndefined()
  })

  it('checks once for every profile of a launcher run, and gives up quietly', async () => {
    let runs = 0
    const check = new OsPasswordCheck(async () => { runs++; return 'age=10 blank=0' }, () => 0)
    const answers = await Promise.all([check.answer(), check.answer(), check.answer()])
    expect(runs).toBe(1)
    expect(answers.every((answer) => answer === answers[0] && answer?.os_password_blank === false)).toBe(true)
    expect(await new OsPasswordCheck(async () => { throw new Error('no ADSI') }).answer()).toBeUndefined()
  })
})
