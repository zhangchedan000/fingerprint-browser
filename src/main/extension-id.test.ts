import { describe, expect, it } from 'vitest'
import { extensionIdForKey, extensionIdForPath } from './extension-id'

// The values of Chromium's components/crx_file/id_util_unittest.cc.
const PUBLIC_KEY_INFO = Buffer.from(
  '30819f300d06092a864886f70d010101050003818d0030818902818100b87f2b20dc7c9b0cdc5161990d360fd466880855'
  + '84d53abf2ba464857b0c04133f8df4bc380d49fe6bc45ab040533ad766090f9e367430da8a314f1f1450d7c7209417de4e'
  + 'b9575e7e0ae5b2657a894eb647ff1cbdb73813af4785843233f31749bfe996d0d6146f138dc5fc2c72baacea7e185356a6'
  + '83a2ce9393e71f0fe60f0203010001', 'hex')

describe('extension IDs', () => {
  it('come from the manifest key as in Chromium', () => {
    expect(extensionIdForKey(PUBLIC_KEY_INFO.toString('base64'))).toBe('melddjfinppjdikinhbgehiennejpfhp')
  })

  it('come from the folder path as in Chromium', () => {
    expect(extensionIdForPath('/path/to/file.ext', 'win32')).toBe('jjlkojfgbeklddcpckipekckcmgcbfjn')
    expect(extensionIdForPath('/path/to/file.ext', 'linux')).toBe('lnkgfdknojmdambfcanadbhmfjfljobb')
    // The drive letter counts in upper case.
    expect(extensionIdForPath('c:\\x\\ext', 'win32')).toBe(extensionIdForPath('C:\\x\\ext', 'win32'))
  })
})
